/**
 * AttentionMonitor Detector
 *
 * 检测 AI 注意力信号 [DONE]/[NEED]/[CONFIRM]。
 * 消费两个来源：
 *   1. parseAttentionSignals() 提取的 crossTurnFlags.attentionSignals
 *   2. AI 回复文本中的 [DONE]/[NEED]/[CONFIRM] 正则（兜底）
 *
 * 替代 turn/index.ts injectCrossTurnFlags() 中的 3 个 this.inject()。
 * 纯函数 — 只检测，不输出。
 */

import type { DetectorFn, RawSignal } from '../types';

const DONE_PATTERN = /\[DONE\]/i;
const NEED_PATTERN = /\[NEED\]/i;
const CONFIRM_PATTERN = /\[CONFIRM\]/i;

export const attentionMonitorDetector: DetectorFn = (ctx): RawSignal | null => {
  // 检测最近工具调用中是否已有验证操作（用于 [DONE] 判断）
  const hasRecentVerification = ctx.lastToolCalls?.some(
    (tc: any) => tc?.name === 'runTool' || tc?.name?.toLowerCase().includes('verify')
      || tc?.name?.toLowerCase().includes('build') || tc?.name?.toLowerCase().includes('test')
  );

  // 来源1: parseAttentionSignals 提取的结构化信号
  const sig = ctx.attentionSignals;
  if (sig?.done) {
    if (hasRecentVerification) {
      // [DONE] + 已验证过 → 无反馈（决策表规则）
      return null;
    }
    return {
      rootCause: 'attention_signal',
      priority: 'normal',
      confidence: 0.9,
      message: '你报告了 [DONE]，请先用构建/测试/检查工具验证后再确认完成，不要凭空声称。',
      escalation: 'hint',
      phase: 'post_step',
    };
  }
  if (sig?.need) {
    return {
      rootCause: 'attention_signal',
      priority: 'normal',
      confidence: 0.7,
      message: '你报告了 [NEED]，请说明：当前目标、已尝试的方法、具体卡在哪一步。我会给你针对性引导。',
      escalation: 'hint',
      phase: 'post_step',
    };
  }
  if (sig?.confirm) {
    return {
      rootCause: 'attention_signal',
      priority: 'normal',
      confidence: 0.6,
      message: '你报告了 [CONFIRM]，请根据已有信息自行判断并继续推进。不确定时直接用工具验证假设，不必等用户确认。',
      escalation: 'hint',
      phase: 'post_step',
    };
  }

  // 来源2: AI 回复正则匹配（兜底）
  const aiResponse = ctx.lastAIResponse;
  if (!aiResponse) return null;

  if (DONE_PATTERN.test(aiResponse)) {
    return {
      rootCause: 'attention_signal',
      priority: 'normal',
      confidence: 0.8,
      message: '你报告了 [DONE]，请先用构建/测试/检查工具验证后再确认完成，不要凭空声称。',
      escalation: 'hint',
      phase: 'post_step',
    };
  }
  if (NEED_PATTERN.test(aiResponse)) {
    return {
      rootCause: 'attention_signal',
      priority: 'normal',
      confidence: 0.6,
      message: '你报告了 [NEED]，请说明：当前目标、已尝试的方法、具体在哪一步。我会针对性引导。',
      escalation: 'hint',
      phase: 'post_step',
    };
  }
  if (CONFIRM_PATTERN.test(aiResponse)) {
    return {
      rootCause: 'attention_signal',
      priority: 'normal',
      confidence: 0.5,
      message: '你报告了 [CONFIRM]，请根据已有信息自行判断并继续推进。不确定时直接用工具验证假设。',
      escalation: 'hint',
      phase: 'post_step',
    };
  }

  return null;
};
