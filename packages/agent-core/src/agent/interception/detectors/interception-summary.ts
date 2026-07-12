/**
 * InterceptionSummary Detector
 *
 * 在回合快结束时注入拦截系统运行概况摘要。
 * 替代 turn/index.ts 中 injectInterceptionSummary() 的 this.inject() bypass。
 *
 * 消费 ctx.triggerHistory（由 InterceptionManager 维护）。
 * 纯函数 — 只检测，不输出。
 */

import type { DetectorFn, RawSignal } from '../types';

export const interceptionSummaryDetector: DetectorFn = (ctx): RawSignal | null => {
  // 只在后期步数注入（step ≥ 30），避免每步都发
  if (ctx.step < 30) return null;

  // 只在有触发历史的步注入（避免空摘要）
  const entries = Object.entries(ctx.triggerHistory).filter(([, v]) => v > 0);
  if (entries.length === 0) return null;

  const summary = entries
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([k, v]) => `${k}(${v}次)`)
    .join(' ');

  return {
    rootCause: 'log_info',
    priority: 'P4_info',
    confidence: 0.5,
    message: `本轮拦截概况: ${summary}`,
    escalation: 'hint',
    phase: 'post_step',
  };
};
