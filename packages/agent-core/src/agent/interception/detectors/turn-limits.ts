/**
 * TurnLimits Detector
 *
 * 检测回合上限相关信号（超步数 / 超时 / 工具调用上限）。
 * 消费 ctx.step（当前步数）。
 *
 * 纯函数 — 只检测，不输出。
 */

import type { DetectorFn, RawSignal } from '../types';

const MAX_STEPS_PER_TURN = 50;
const MAX_STEPS_WARN = 40;

export const turnLimitsDetector: DetectorFn = (ctx): RawSignal | null => {
  const step = ctx.step;

  if (step >= MAX_STEPS_PER_TURN) {
    return {
      rootCause: 'turn_limit',
      priority: 'P0_block',
      confidence: 0.95,
      message: `已达回合步数上限 (${step}/${MAX_STEPS_PER_TURN})。本回合即将终止。`,
      escalation: 'block',
      phase: 'pre_step',
    };
  }

  if (step >= MAX_STEPS_WARN) {
    return {
      rootCause: 'turn_limit',
      priority: 'P4_info',
      confidence: 0.6,
      message: `接近回合步数上限 (${step}/${MAX_STEPS_PER_TURN})。请尽快收尾。`,
      escalation: 'hint',
      phase: 'post_step',
    };
  }

  return null;
};
