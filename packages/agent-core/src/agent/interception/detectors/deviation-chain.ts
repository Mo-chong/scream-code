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
  // T1: 上回合因偏差链被拦截
  if (ctx.lastTurnHadDeviation) {
    return {
      rootCause: 'edit_discipline',
      priority: 'P1_discipline',
      confidence: 0.8,
      message: '上回合因偏差链被拦截。本回合如涉及修改代码，请先查 LSP.references。',
      escalation: 'hint',
      phase: 'pre_step',
    };
  }

  // T2: 上回合因 Guard Rule 1 (confabulation) 被阻断
  if (ctx.lastTurnHadGuardRule1) {
    return {
      rootCause: 'edit_discipline',
      priority: 'P1_discipline',
      confidence: 0.7,
      message: '上回合因虚构内容检测被阻断。本回合请严格遵守：每个声明必须有 Read/Grep/LSP 工具调用证据。',
      escalation: 'hint',
      phase: 'pre_step',
    };
  }

  return null;
};
