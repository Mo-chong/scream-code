/**
 * Phase22.2 — Injector state collection.
 *
 * Exposes injector state as structured flat facts to the AI after each step.
 * Called from TurnFlow.handleAfterStep → result stored as system reminder
 * that feeds into the next turn's composeContextMessages.
 */

import type { VariantMeta } from '../variant-registry';

export interface VariantFact {
  /** 该变体整轮对话累计注入次数 */
  injectionCount: number;
  /** 上次注入的 step（-1 = 从未注入） */
  lastStep: number;
  /** 当前残差分数 R = W × D^Δs（保留两位小数） */
  residualScore: number;
  /** 指令等级 S/A/B/C/D */
  level: string;
}

export interface InjectorFactsSnapshot {
  variants: Record<string, VariantFact>;
  /** 本步注入预算剩余 */
  budgetRemaining: number;
  /** 本步已注入的变体数量 */
  stepInjectionCount: number;
}

/**
 * Collect injector state from the variant registry and injection manager,
 * and produce a structured flat-fact string that gets injected as a
 * system reminder before the next LLM call.
 */
export function collectInjectorFacts(
  variantRegistry: {
    getInjectionCount: (variant: string) => number;
    getLastStep: (variant: string) => number;
  },
  getScore: (variant: string, stepDelta: number) => number,
  currentStep: number,
  variantMeta: Record<string, VariantMeta>,
  budgetRemaining: number,
  stepInjectionCount: number,
): string {
  const snapshot: InjectorFactsSnapshot = {
    variants: {},
    budgetRemaining,
    stepInjectionCount,
  };

  for (const [variant, meta] of Object.entries(variantMeta)) {
    const injectionCount = variantRegistry.getInjectionCount(variant);
    const lastStep = variantRegistry.getLastStep(variant);
    const stepDelta = lastStep >= 0 ? currentStep - lastStep : currentStep;
    const residualScore = getScore(variant, stepDelta);

    snapshot.variants[variant] = {
      injectionCount,
      lastStep,
      residualScore: Math.round(residualScore * 100) / 100,
      level: JSON.parse(JSON.stringify(meta)).level ?? 'D',
    };
  }

  // Build structured flat-fact string
  const lines: string[] = ['【注入器状态】'];
  for (const [variant, f] of Object.entries(snapshot.variants).sort()) {
    lines.push(
      `  ${variant}: level=${f.level} count=${f.injectionCount} ` +
      `lastStep=${f.lastStep} score=${f.residualScore}`,
    );
  }
  lines.push(`  budget: ${snapshot.budgetRemaining} remaining, ${snapshot.stepInjectionCount} this step`);

  return lines.join('\n');
}
