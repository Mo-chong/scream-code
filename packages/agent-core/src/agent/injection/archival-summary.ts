/**
 * ArchivalSummaryInjector — 上下文蒸馏塔·归档层（第三层）
 *
 * 在上下文较大时（>50K token），将已遮蔽/已压缩的旧工具结果按逻辑分组
 * 生成结构化摘要，通过 appendSystemReminder 追加到尾部。
 *
 * 触发时机：
 *   - tokenCount < 50K → 不触发（保真层+压缩层足够）
 *   - tokenCount 50K-100K → 每 3 步触发一次
 *   - tokenCount > 100K → 每步触发
 *
 * 缓存安全：默认 AFTER_TOOL_CALL → appendSystemReminder 追加尾部。
 */

import { DynamicInjector, type ResidualConfig } from './injector';
import type { Agent } from '..';
import type { ContextMessage } from '../context/types';

const THRESHOLD_MEDIUM = 50_000;
const THRESHOLD_HIGH = 100_000;
const VARIANT = 'archival_summary';

/** 每轮最多扫尾部的消息数 */
const MAX_SCAN = 80;

export class ArchivalSummaryInjector extends DynamicInjector {
  private _lastSummaryTurn = 0;

  constructor(protected override readonly agent: Agent) {
    super(agent);
  }

  override get injectionVariant(): string { return VARIANT; }

  override getResidualConfig(): ResidualConfig {
    // 由我们自己控制频率，不做残差限制
    return { weight: 0, decayPerStep: 0, threshold: 0, minStepGap: 0 };
  }

  protected override getInjection(): string | undefined {
    const history = this.agent.context.history;
    const tokenCount = this.agent.context.tokenCount;
    const currentStep = this._lastInjectContext?.currentStep ?? 0;

    // 触发条件
    if (tokenCount < THRESHOLD_MEDIUM) return undefined;

    // 频率控制
    let stepGap = 1; // >100K 每步
    if (tokenCount < THRESHOLD_HIGH) {
      stepGap = 3; // 50K-100K 每 3 步
    }
    if (currentStep - this._lastSummaryTurn < stepGap) return undefined;
    this._lastSummaryTurn = currentStep;

    return buildArchivalSummary(history);
  }

  override onContextClear(): void {
    super.onContextClear();
    this._lastSummaryTurn = 0;
  }
}

// ─── 摘要构建 ─────────────────────────────────────────────

interface ToolOp {
  type: 'Read' | 'Write' | 'Edit' | 'Grep' | 'Bash' | 'LSP' | string;
  path?: string;
  desc?: string;
}

function buildArchivalSummary(history: readonly ContextMessage[]): string | undefined {
  // 从尾部向前扫描最近的 tool calls
  const ops: ToolOp[] = [];
  let hasError = false;

  const start = Math.max(0, history.length - MAX_SCAN);
  for (let i = history.length - 1; i >= start; i--) {
    const msg = history[i];
    if (!msg || msg.role !== 'assistant') continue;

    for (const tc of msg.toolCalls ?? []) {
      const name = tc.name ?? '';
      if (!name) continue;

      let path: string | undefined;
      let desc: string | undefined;

      try {
        const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments ?? {};
        path = typeof args.path === 'string' ? args.path : undefined;

        // 从参数和 reasoning 提取描述
        if (name === 'Read' && path) desc = `Read ${path}`;
        else if (name === 'Write' && path) desc = `Write ${path}`;
        else if (name === 'Edit' && path) desc = `Edit ${path}`;
        else if (name === 'Grep') desc = `Grep "${args.pattern ?? ''}"`;
        else if (name === 'Bash') {
          const cmd = typeof args.command === 'string' ? args.command.slice(0, 60) : '';
          desc = `Bash ${cmd}`;
          if (/error|fail|exit code [1-9]/i.test(cmd)) hasError = true;
        } else if (name === 'LSP') {
          desc = `LSP ${args.operation ?? ''} ${args.path ?? ''}`;
        } else {
          desc = name;
        }

        // 加 reasoning 摘要（如果有）
        if (args.reasoning && typeof args.reasoning === 'string') {
          const r = args.reasoning.slice(0, 40);
          if (!desc?.includes(r)) desc = (desc ?? '') + ` — ${r}`;
        }
      } catch {
        desc = name;
      }

      ops.push({ type: name, path, desc });
    }
  }

  if (ops.length === 0) return undefined;

  // 按类型分组
  const byType = new Map<string, ToolOp[]>();
  for (const op of ops) {
    const list = byType.get(op.type) ?? [];
    list.push(op);
    byType.set(op.type, list);
  }

  const lines: string[] = ['<归档摘要>'];

  // 文件操作（Read/Write/Edit）
  const fileOps = (byType.get('Read') ?? []).concat(byType.get('Write') ?? []).concat(byType.get('Edit') ?? []);
  if (fileOps.length > 0) {
    // 去重同文件
    const seen = new Set<string>();
    const unique: ToolOp[] = [];
    for (const op of fileOps) {
      const key = op.path ?? op.desc ?? '';
      if (!seen.has(key)) { seen.add(key); unique.push(op); }
    }
    lines.push(`📂 文件操作（共 ${unique.length} 条）`);
    for (const op of unique.slice(-5)) { // 最多 5 条
      lines.push(`  · ${op.desc ?? op.type}`);
    }
    if (unique.length > 5) lines.push(`  · ... 及另外 ${unique.length - 5} 条`);
  }

  // Bash 操作
  const bashOps = byType.get('Bash') ?? [];
  if (bashOps.length > 0) {
    const success = bashOps.filter(o => !/error|fail|exit code [1-9]/i.test(o.desc ?? ''));
    const failed = bashOps.filter(o => /error|fail|exit code [1-9]/i.test(o.desc ?? ''));
    if (failed.length > 0) {
      lines.push(`❌ 执行错误（${failed.length} 个）`);
      for (const op of failed.slice(-3)) lines.push(`  · ${op.desc ?? 'Bash'}`);
    }
    if (success.length > 0) {
      lines.push(`✅ 执行成功（${success.length} 个）`);
    }
  }

  // 搜索操作
  const searchOps = (byType.get('Grep') ?? []).concat(byType.get('LSP') ?? []);
  if (searchOps.length > 0) {
    lines.push(`🔍 搜索（${searchOps.length} 次）`);
    for (const op of searchOps.slice(-3)) lines.push(`  · ${op.desc ?? op.type}`);
  }

  // 待处理
  if (hasError) {
    lines.push(`⏳ 有待处理的错误 — 请检查上方执行错误详情`);
  }

  lines.push('</归档摘要>');
  return lines.join('\n');
}
