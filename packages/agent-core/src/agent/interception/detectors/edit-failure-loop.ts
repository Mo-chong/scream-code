/**
 * EditFailureLoop Detector
 *
 * 检测 Edit 失败循环：同一文件在同一步中被连续 Edit 多次（参数不同但路径相同）。
 * 这表明 AI 可能在盲目重试而不先 Read 确认内容。
 *
 * 纯函数 — 只检测，不输出。
 */

import type { DetectorFn, RawSignal } from '../types';

export const editFailureLoopDetector: DetectorFn = (ctx): RawSignal | null => {
  const tools = ctx.lastToolCalls;
  if (!tools || tools.length < 2) return null;

  // 找 Edit 调用
  const editCalls = tools.filter(t => t.name === 'Edit');
  if (editCalls.length < 2) return null;

  // 提取路径
  const paths: string[] = [];
  for (const t of editCalls) {
    const args = (t as any).args;
    if (args?.path) paths.push(args.path);
  }
  if (paths.length < 2) return null;

  // 检查是否有两个 Edit 指向同一文件
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (paths[i] === paths[j]) {
        return {
          rootCause: 'stuck_loop',
          priority: 'P1_discipline',
          confidence: 0.75,
          message: `同一文件连续 Edit ${paths[i]} 多次。如第一次失败，请先 Read 确认当前内容再重试。`,
          escalation: 'hint',
          phase: 'post_step',
        };
      }
    }
  }

  return null;
};
