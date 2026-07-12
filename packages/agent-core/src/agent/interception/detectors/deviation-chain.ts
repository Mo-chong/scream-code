/**
 * DeviationChain Detector
 *
 * 检测偏差链状态（上回合因偏差链被拦截）。
 * 消费 ctx.lastTurnHadDeviation（由 turn/index.ts handleAfterStep 设置）。
 *
 * 替代 turn/index.ts injectCrossTurnFlags 中的：
 *   this.crossTurnFlags.lastTurnHadDeviation → this.inject() bypass
 *
 * 纯函数 — 只检测，不输出。
 */

import type { DetectorFn, RawSignal } from '../types';

export const deviationChainDetector: DetectorFn = (ctx): RawSignal | null => {
  if (!ctx.lastTurnHadDeviation) return null;

  return {
    rootCause: 'edit_discipline',
    priority: 'P1_discipline',
    confidence: 0.8,
    message: '上回合因偏差链被拦截。本回合如涉及修改代码，请先查 LSP.references。',
    escalation: 'hint',
    phase: 'pre_step',
  };
};
