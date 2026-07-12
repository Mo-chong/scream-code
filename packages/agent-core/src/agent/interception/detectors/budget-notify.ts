/**
 * BudgetNotify Detector
 *
 * 检测注入预算是否处于降级状态，并通知 AI。
 * 消费 ctx.qualitySignals 中的 budget 相关信号。
 *
 * 纯函数 — 只检测，不输出。
 */

import type { DetectorFn, RawSignal } from '../types';

export const budgetNotifyDetector: DetectorFn = (ctx): RawSignal | null => {
  const signals = ctx.qualitySignals;
  if (!signals || signals.length === 0) return null;

  // 检测 budget 降级信号
  const hasBudgetDegradation = signals.some(
    (s) => typeof s === 'string' && (s.includes('budget') || s.includes('degradation'))
  );

  if (!hasBudgetDegradation) return null;

  return {
    rootCause: 'quality_degrade',
    priority: 'P4_info',
    confidence: 0.5,
    message: '注入预算正在降级，回复质量可能受影响。建议精简输出、聚焦关键信息。',
    escalation: 'hint',
    phase: 'post_step',
  };
};
