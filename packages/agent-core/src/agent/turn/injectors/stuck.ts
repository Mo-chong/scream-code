/**
 * 痛点感知注入器 — 检测 AI 钻牛角尖模式后通过残差系统注入文档导航。
 * Phase21 替代方案：取代旧 system-ref.ts 的无脑周期注入。
 *
 * 检测模式（按优先级）：
 * 1. 同一文件连续编辑 ≥3 步 — 提示看文档
 * 2. 同一工具连续报错 ≥2 步 — 提示看 pitfalls
 * 3. 同一函数反复编辑 ≥3 次 — 提示看架构文档
 *
 * 所有注入走残差注意力系统 (system_ref_stuck, B0)。
 */

import { VARIANT_META } from '../variant-registry';

const STUCK_VARIANT = 'system_ref_stuck';

/**
 * 调用注入器。返回新的 stuckInjectedAtStep 值。
 *
 * @param inject         注入函数 ((text, meta) => void)
 * @param currentStep    当前 step 号
 * @param stuckInjectedAtStep  上次注入该变体的 step (-1 = 从未注入)
 * @param stepInjectedVariants 已注入变体集合 (用于 dedup)
 * @param editFileThisStep     本轮编辑的文件路径 (可选)
 * @param toolErrorThisStep    本轮工具报错信息 (可选)
 * @param editFileHistory      文件编辑历史 (最近 N 次)
 * @param errorHistory         工具报错历史 (最近 N 次)
 * @returns 新的 stuckInjectedAtStep
 */
export function injectStuckInjector(
  inject: (text: string, meta: { variant: string }) => void,
  currentStep: number,
  stuckInjectedAtStep: number,
  stepInjectedVariants: ReadonlySet<string>,
  editFileThisStep: string | undefined,
  toolErrorThisStep: string | undefined,
  editFileHistory: string[],
  errorHistory: string[],
): number {
  // ── 1. 更新历史 ──
  if (editFileThisStep) editFileHistory.unshift(editFileThisStep);
  if (toolErrorThisStep) errorHistory.unshift(toolErrorThisStep);

  trim(editFileHistory, 30);
  trim(errorHistory, 30);

  // ── 2. 检测 stuck 模式（按优先级）──
  let stuckMsg: string | null = null;

  // 模式 1：同一文件连续编辑 ≥3 步
  const consecutiveFile = countConsecutive(editFileHistory);
  if (consecutiveFile >= 3) {
    stuckMsg =
      `You've edited the same file for ${consecutiveFile} consecutive steps. `
      + `If stuck, the SYSTEM/ docs may help.`;
  }

  // 模式 2：同一工具连续报错 ≥2 步
  if (!stuckMsg) {
    const consecutiveError = countConsecutive(errorHistory);
    if (consecutiveError >= 2) {
      stuckMsg =
        `Same tool error ${consecutiveError}x in a row. `
        + `Check SYSTEM/pitfalls.md for known solutions.`;
    }
  }

  if (!stuckMsg) return stuckInjectedAtStep;

  // ── 3. 残差注意力门控 ──
  const meta = VARIANT_META[STUCK_VARIANT];
  if (!meta) return stuckInjectedAtStep;

  // dedup: 同一 step 已注入过该变体
  if (stepInjectedVariants.has(STUCK_VARIANT)) return stuckInjectedAtStep;

  // minStepGap: 距离上次注入至少 N 步
  if (stuckInjectedAtStep >= 0 && currentStep - stuckInjectedAtStep < meta.minStepGap) {
    return stuckInjectedAtStep;
  }

  // 残差衰减计算: R = weight × decayPerStep^Δstep
  const stepDelta = stuckInjectedAtStep >= 0
    ? currentStep - stuckInjectedAtStep
    : 0;  // 从未注入 → 满权重
  const residual = meta.weight * Math.pow(meta.decayPerStep, stepDelta);
  if (residual < meta.threshold) return stuckInjectedAtStep;

  // ── 4. 注入 ──
  inject(stuckMsg, { variant: STUCK_VARIANT });
  return currentStep;
}

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
