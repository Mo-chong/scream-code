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
 *
 * v3 新增：任务级聚合（高置信度时显示任务标题）。
 * 信号来源：文件路径(50%) + 搜索模式(30%) + reasoning(20%)。
 * 置信度 >0.6 才显示，宁缺毋滥。
 */

import { DynamicInjector, type ResidualConfig } from './injector';
import type { Agent } from '..';
import type { ContextMessage } from '../context/types';

const THRESHOLD_MEDIUM = 50_000;
const THRESHOLD_HIGH = 100_000;
const VARIANT = 'archival_summary';

/** 每轮最多扫尾部的消息数 */
const MAX_SCAN = 80;

// ─── 任务域推断 ──────────────────────────────────────────

/** 域名 → 显示标题 */
interface DomainInfo {
  id: string;
  label: string;
}

/** 域映射：一级目录名 → domain */
const DIR_DOMAIN: Record<string, string> = {
  auth: 'auth',
  login: 'auth',
  api: 'api',
  route: 'api',
  controller: 'api',
  component: 'ui',
  page: 'ui',
  view: 'ui',
  test: 'test',
  spec: 'test',
  e2e: 'test',
  docker: 'deploy',
  deploy: 'deploy',
  ci: 'deploy',
  config: 'config',
  db: 'db',
  model: 'db',
  migration: 'db',
  schema: 'db',
  util: 'util',
  helper: 'util',
  lib: 'util',
  middleware: 'middleware',
  hook: 'hook',
  store: 'state',
  reducer: 'state',
  style: 'style',
  css: 'style',
};

/** 文件名关键词 → domain */
const FILE_KEYWORD_DOMAIN: Record<string, string> = {
  login: 'auth',
  auth: 'auth',
  token: 'auth',
  session: 'auth',
  jwt: 'auth',
  oauth: 'auth',
  dockerfile: 'deploy',
  docker: 'deploy',
  makefile: 'deploy',
  webpack: 'build',
  vite: 'build',
  jest: 'test',
  vitest: 'test',
  'package.json': 'config',
  'tsconfig': 'config',
};

/** 搜索模式关键词 → domain */
const SEARCH_KEYWORD_DOMAIN: Record<string, string> = {
  jwt: 'auth',
  token: 'auth',
  password: 'auth',
  login: 'auth',
  session: 'auth',
  docker: 'deploy',
  deploy: 'deploy',
  test: 'test',
  jest: 'test',
  webpack: 'build',
  'package.json': 'config',
};

/** 推理关键词 → domain */
const REASONING_KEYWORD_DOMAIN: Record<string, string> = {
  auth: 'auth',
  login: 'auth',
  token: 'auth',
  authenticate: 'auth',
  permission: 'auth',
  deploy: 'deploy',
  docker: 'deploy',
  test: 'test',
  'unit test': 'test',
  'e2e': 'test',
  build: 'build',
  config: 'config',
  api: 'api',
  route: 'api',
  component: 'ui',
  ui: 'ui',
  style: 'style',
  db: 'db',
  database: 'db',
  migration: 'db',
  model: 'db',
  middleware: 'middleware',
  hook: 'hook',
  state: 'state',
  refactor: 'refactor',
  fix: 'fix',
};

/** 域名 → 显示标题 */
const DOMAIN_LABELS: Record<string, string> = {
  auth: '认证/权限',
  api: 'API 端点',
  ui: 'UI 组件',
  test: '测试',
  deploy: '部署/CI',
  config: '配置',
  db: '数据库',
  model: '数据模型',
  util: '工具函数',
  middleware: '中间件',
  hook: 'React Hooks',
  state: '状态管理',
  style: '样式',
  build: '构建',
  refactor: '重构',
  fix: '修复',
};

// ─── 信号聚合 ─────────────────────────────────────────────

interface TaskSignal {
  domain: string;
  weight: number;
  source: string;
}

/**
 * 从操作列表中收集任务信号，做加权投票。
 * 只有置信度 >0.6 时才返回确定的域。
 */
function inferTaskDomain(ops: ToolOp[]): { domain: string; confidence: number } | null {
  const signals: TaskSignal[] = [];

  for (const op of ops) {
    // 信号1：文件路径（权重 0.5）
    if (op.path) {
      const parts = op.path.replace(/\\/g, '/').split('/');
      // 一级目录
      if (parts.length >= 2) {
        const dir = parts[0]?.toLowerCase() ?? '';
        if (dir && DIR_DOMAIN[dir]) {
          signals.push({ domain: DIR_DOMAIN[dir]!, weight: 0.5, source: `path:${op.path}` });
        }
      }
      // 文件名关键词
      const filename = parts[parts.length - 1]?.toLowerCase() ?? '';
      for (const [kw, domain] of Object.entries(FILE_KEYWORD_DOMAIN)) {
        if (filename.includes(kw)) {
          signals.push({ domain, weight: 0.4, source: `file:${filename}` });
          break;
        }
      }
    }

    // 信号2：搜索模式（权重 0.3）
    if (op.type === 'Grep' || op.type === 'LSP') {
      const lower = (op.desc ?? '').toLowerCase();
      for (const [kw, domain] of Object.entries(SEARCH_KEYWORD_DOMAIN)) {
        if (lower.includes(kw)) {
          signals.push({ domain, weight: 0.3, source: `search:${kw}` });
          break;
        }
      }
    }

    // 信号3：reasoning（权重 0.2）
    const reasoning = (op.desc ?? '').split(' — ')[1] ?? '';
    if (reasoning) {
      const lowerR = reasoning.toLowerCase();
      for (const [kw, domain] of Object.entries(REASONING_KEYWORD_DOMAIN)) {
        if (lowerR.includes(kw)) {
          signals.push({ domain, weight: 0.2, source: `reason:${kw}` });
          break;
        }
      }
    }
  }

  if (signals.length === 0) return null;

  // 按域名聚合加权
  const scoreMap = new Map<string, number>();
  for (const s of signals) {
    scoreMap.set(s.domain, (scoreMap.get(s.domain) ?? 0) + s.weight);
  }

  // 排序取最高
  const sorted = [...scoreMap.entries()].sort((a, b) => b[1] - a[1]);
  const [topDomain, topScore] = sorted[0]!;

  // 置信度 = 最高分 / 总分
  const totalScore = [...scoreMap.values()].reduce((a, b) => a + b, 0);
  const confidence = totalScore > 0 ? topScore / totalScore : 0;

  // 阈值：>0.6 才显示
  if (confidence > 0.6) {
    return { domain: topDomain, confidence };
  }

  return null;
}

// ─── 摘要构建 ─────────────────────────────────────────────

interface ToolOp {
  type: 'Read' | 'Write' | 'Edit' | 'Grep' | 'Bash' | 'LSP' | string;
  path?: string;
  desc?: string;
}

export class ArchivalSummaryInjector extends DynamicInjector {
  private _lastSummaryTurn = 0;

  constructor(protected override readonly agent: Agent) {
    super(agent);
  }

  override get injectionVariant(): string { return VARIANT; }

  override getResidualConfig(): ResidualConfig {
    return { weight: 0, decayPerStep: 0, threshold: 0, minStepGap: 0 };
  }

  protected override getInjection(): string | undefined {
    const history = this.agent.context.history;
    const tokenCount = this.agent.context.tokenCount;
    const currentStep = this._lastInjectContext?.currentStep ?? 0;

    if (tokenCount < THRESHOLD_MEDIUM) return undefined;

    let stepGap = 1;
    if (tokenCount < THRESHOLD_HIGH) stepGap = 3;
    if (currentStep - this._lastSummaryTurn < stepGap) return undefined;
    this._lastSummaryTurn = currentStep;

    return buildArchivalSummary(history);
  }

  override onContextClear(): void {
    super.onContextClear();
    this._lastSummaryTurn = 0;
  }
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

  // 任务级聚合：高置信度时显示任务标题
  const task = inferTaskDomain(ops);
  if (task) {
    const label = DOMAIN_LABELS[task.domain] ?? task.domain;
    lines.push(`📋 任务：${label}（置信度 ${Math.round(task.confidence * 100)}%）`);
    lines.push('');
  }

  // 文件操作（Read/Write/Edit）
  const fileOps = (byType.get('Read') ?? []).concat(byType.get('Write') ?? []).concat(byType.get('Edit') ?? []);
  if (fileOps.length > 0) {
    // 按路径分组，同路径合并 reasoning
    const byPath = new Map<string, ToolOp[]>();
    for (const op of fileOps) {
      const key = op.path ?? op.desc ?? '';
      const list = byPath.get(key) ?? [];
      list.push(op);
      byPath.set(key, list);
    }
    lines.push(`📂 文件操作（共 ${fileOps.length} 条）`);
    const entries = Array.from(byPath.entries());
    for (const [key, ops] of entries.slice(-5)) {
      if (ops.length === 1) {
        lines.push(`  · ${ops[0].desc ?? ops[0].type}`);
      } else {
        // 同一文件多次操作 → 合并 reasoning 后缀
        const reasons: string[] = [];
        for (const op of ops) {
          const parts = (op.desc ?? '').split(' — ');
          if (parts.length > 1) reasons.push(parts.slice(1).join(' — ').trim());
          else reasons.push(parts[0]?.trim() ?? op.type);
        }
        const uniqueReasons = [...new Set(reasons)];
        lines.push(`  · ${key} (${ops.length}次)${uniqueReasons.length > 1 ? ' — ' + uniqueReasons.filter(Boolean).join(' / ') : ''}`);
      }
    }
    if (entries.length > 5) lines.push(`  · ... 及另外 ${entries.length - 5} 组`);
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
