/**
 * TurnLimits Detector
 *
 * 检测回合上限相关信号（超步数 / 超时 / 工具调用上限）。
 * 消费 ctx.step（当前步数）。
 *
 * 纯函数 — 只检测，不输出。
 * Phase38l: step≥45 时注入收尾警告，避免 AI 突然被停。
 */

import type { DetectorFn, RawSignal } from '../types';

const MAX_STEPS_PER_TURN = 50;
const MAX_STEPS_WARN = 40;

export const turnLimitsDetector: DetectorFn = (ctx): RawSignal | null => {
  const step = ctx.step;

  if (step >= MAX_STEPS_PER_TURN) {
    return {
      rootCause: 'turn_limit',
      priority: 'critical',
      confidence: 0.95,
      message: `已达回合步数上限 (${step}/${MAX_STEPS_PER_TURN})。本回合即将终止。`,
      escalation: 'block',
      phase: 'pre_step',
    };
  }

  if (step >= MAX_STEPS_WARN) {
    if (step >= 45) {
      return {
        rootCause: 'turn_limit',
        priority: 'debug',
        confidence: 0.8,
        message: `已达 ${step}/${MAX_STEPS_PER_TURN} 步，回合即将终止。请在剩余步数内完成收尾——验证+提交。`,
        escalation: 'warn',
        phase: 'post_step',
      };
    }
    return {
      rootCause: 'turn_limit',
      priority: 'debug',
      confidence: 0.6,
      message: `接近回合步数上限 (${step}/${MAX_STEPS_PER_TURN})。请尽快收尾。`,
      escalation: 'hint',
      phase: 'post_step',
    };
  }

  return null;
};
