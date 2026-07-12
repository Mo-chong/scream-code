/**
 * SceneMemory Detector
 *
 * 检测 AI 是否在用户提到"上次/以前"时未查记忆。
 * 替代 turn/index.ts detectSceneMemoryIssue() 的 this.inject() bypass。
 *
 * 纯函数 — 只检测，不输出。
 */

import type { DetectorFn, RawSignal } from '../types';

const MEMORY_KEYWORDS = /上次|以前|之前|前面|刚才|记忆|记得|历史/i;

export const sceneMemoryDetector: DetectorFn = (ctx): RawSignal | null => {
  const input = ctx.userInputText;
  if (!input || !MEMORY_KEYWORDS.test(input)) return null;

  // 用户提到了"上次/以前"，但 AI 没调 MemoryLookup
  if (!ctx.calledMemoryLookup) {
    return {
      rootCause: 'attention_signal',
      priority: 'P3_signal',
      confidence: 0.6,
      message: '用户提到了"上次/以前"相关的表述。请先调 MemoryLookup 查询历史记录，不要凭记忆回答。',
      escalation: 'hint',
      phase: 'post_step',
    };
  }

  return null;
};
