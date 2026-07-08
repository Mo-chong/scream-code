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
    return { weight: 30, decayPerStep: 0.88, threshold: 0.5, minStepGap: 3 };
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
    const ctx = this._lastInjectContext;
    if (!ctx?.stuckContext) return undefined;

    const { stepToolCounts, getFileEditCount } = ctx.stuckContext!;

    // ── 1. 更新历史 ──
    const toolKeys = Object.keys(stepToolCounts);
    const editToolKeys = toolKeys.filter(k => k.startsWith('edit_'));
    const errorToolKeys = toolKeys.filter(k => k.startsWith('error_') && (stepToolCounts[k] ?? 0) > 0);

    for (const k of editToolKeys) {
      this.editFileHistory.unshift(k);
    }
    for (const k of errorToolKeys) {
      this.errorHistory.unshift(k);
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
