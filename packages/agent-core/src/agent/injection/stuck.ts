/**
 * StuckInjector — 检测 AI 钻牛角尖模式后通过残差系统注入文档导航。
 * Phase21 替代方案：取代旧 system-ref.ts 的无脑周期注入。
 * 迁移自 turn/injectors/stuck.ts (路径 B → 路径 A)
 *
 * 检测模式（按优先级）：
 * 1. 同一文件连续编辑 ≥3 步 — 提示看文档
 * 2. 同一工具连续报错 ≥2 步 — 提示看 pitfalls
 *
 * 残差门控由 DynamicInjector 基类 + Router 统一调度。
 */

import { DynamicInjector, type ResidualConfig } from './injector';
import type { InjectContext } from './router';

const STUCK_VARIANT = 'system_ref_stuck';

function countConsecutive(arr: string[]): number {
  if (arr.length === 0) return 0;
  const target = arr[0];
  let count = 1;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === target) count++;
    else break;
  }
  return count;
}

function trim(arr: string[], max: number): void {
  while (arr.length > max) arr.pop();
}

export class StuckInjector extends DynamicInjector {
  /** 变体标识符 */
  override readonly injectionVariant = STUCK_VARIANT;

  get name(): string { return STUCK_VARIANT; }
  get description(): string { return '检测同文件连续编辑≥3步或同工具连续报错≥2步，注入文档导航'; }
  get priority(): number { return 60; }

  /** 文件编辑历史（最近 30 次） */
  private editFileHistory: string[] = [];
  /** 工具报错历史（最近 30 次） */
  private errorHistory: string[] = [];

  override getResidualConfig(): ResidualConfig {
    return { weight: 0.6, decayPerStep: 0.88, threshold: 0.25, minStepGap: 3 };
  }

  override onContextClear(): void {
    this.editFileHistory = [];
    this.errorHistory = [];
  }
  override onContextCompacted(_count: number): void {
    this.editFileHistory = [];
    this.errorHistory = [];
  }

  protected override getInjection(): string | undefined {
    // 不再依赖 stuckContext — 直接从 context.history 读取工具记录
    const history = this.agent.context?.history;
    if (!history || history.length === 0) return undefined;

    // 取最近 20 条 tool 消息（完整数据，未被 maskToolObservations 遮蔽）
    const toolMsgs: any[] = [];
    for (let i = history.length - 1; i >= 0 && toolMsgs.length < 20; i--) {
      const msg = history[i] as any;
      if (msg.role === 'tool') toolMsgs.unshift(msg);
    }
    if (toolMsgs.length === 0) return undefined;

    // ── 1. 更新历史 ──
    for (const msg of toolMsgs) {
      const text = msg.content?.[0]?.text ?? '';
      if (!text) continue;

      // 检测文件编辑：从 Edit/Write 结果提取文件名
      const fileMatch = text.match(/['\u201C]([\w\/\\\-\.]+)['\u201D]|file ['\u201C]([\w\/\\\-\.]+)['\u201D]/i);
      if (fileMatch) {
        const file = fileMatch[1] || fileMatch[2] || 'unknown';
        this.editFileHistory.unshift(file);
      }

      // 检测报错
      if (/error|fail|not found|exit code \d|TypeError/i.test(text)) {
        this.errorHistory.unshift(text.slice(0, 100));
      }
    }
    trim(this.editFileHistory, 30);
    trim(this.errorHistory, 30);

    // ── 2. 检测 stuck 模式（按优先级）──
    let stuckMsg: string | null = null;

    // 模式 1：同一文件连续编辑 ≥3 步
    const consecutiveFile = countConsecutive(this.editFileHistory);
    if (consecutiveFile >= 3) {
      stuckMsg =
        `You've edited the same file for ${consecutiveFile} consecutive steps. `
        + `If stuck, the SYSTEM/ docs may help.`;
    }

    // 模式 2：同一工具连续报错 ≥2 步
    if (!stuckMsg) {
      const consecutiveError = countConsecutive(this.errorHistory);
      if (consecutiveError >= 2) {
        stuckMsg =
          `Same tool error ${consecutiveError}x in a row. `
          + `Check SYSTEM/pitfalls.md for known solutions.`;
      }
    }

    return stuckMsg ?? undefined;
  }
}
