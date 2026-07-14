/**
 * Confabulation Detector
 *
 * 检测 AI 虚构内容。消费 ctx.confabulationConfidence（由 turn/index.ts
 * detectConfabulation() 产生，跨轮次可用）。
 *
 * 替代已删除的 anti_confabulation.ts 注入器。
 * 纯函数 — 只检测，不输出。
 *
 * 与 Guard Rule 1 的关系：
 *   - confidence >= 3 → P0_block（直接阻断，同 Guard Rule 1）
 *   - confidence >= 2 → P1_discipline hint（注入证据纪律提醒）
 *   - confidence < 2 → 无信号
 */

import type { DetectorFn, RawSignal } from '../types';

export const confabulationDetector: DetectorFn = (ctx): RawSignal | null => {
  const confidence = ctx.confabulationConfidence;

  if (confidence >= 3) {
    return {
      rootCause: 'confabulation',
      priority: 'critical',
      confidence: 0.95,
      message: '检测到高置信度虚构：AI 声称的内容缺乏工具调用证据。每个声明必须先用 Read/Grep/LSP 证实。禁止凭空编造。',
      escalation: 'block',
      phase: 'pre_step',
    };
  }

  if (confidence >= 2) {
    return {
      rootCause: 'confabulation',
      priority: 'critical',
      confidence: 0.7,
      message: '检测到中等疑似虚构：输出与工具证据不匹配。当说"检查发现""可以看到"时，必须有 Read/Grep/LSP 工具调用证据。没有工具调用就声称什么是在编造。',
      escalation: 'hint',
      phase: 'post_step',
    };
  }

  return null;
};
