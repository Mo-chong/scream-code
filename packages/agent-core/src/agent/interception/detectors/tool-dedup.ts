/**
 * ToolDedup Detector
 *
 * 检测连续相同的工具调用（重复调用同一工具+同一参数）。
 * 消费 ctx.lastToolCalls。
 *
 * 纯函数 — 只检测，不输出。
 */

import type { DetectorFn, RawSignal } from '../types';

export const toolDedupDetector: DetectorFn = (ctx): RawSignal | null => {
  const tools = ctx.lastToolCalls;
  if (!tools || tools.length < 2) return null;

  const last = tools[tools.length - 1] as any;
  const prev = tools[tools.length - 2] as any;
  if (!last || !prev) return null;

  // 检查连续两个 tool call 是否同种工具
  const lastName = last?.name ?? '';
  const prevName = prev?.name ?? '';
  if (lastName !== prevName || !lastName) return null;

  // 检查参数是否相同（取前两个参数名作为指纹）
  const lastArgs = last?.args ?? {};
  const prevArgs = prev?.args ?? {};
  const lastKey = Object.keys(lastArgs).slice(0, 2).map(k => `${k}=${String(lastArgs[k]).slice(0, 40)}`).join('&');
  const prevKey = Object.keys(prevArgs).slice(0, 2).map(k => `${k}=${String(prevArgs[k]).slice(0, 40)}`).join('&');

  if (lastKey === prevKey && lastKey.length > 0) {
    return {
      rootCause: 'log_info',
      priority: 'P4_info',
      confidence: 0.7,
      message: `检测到连续相同工具调用: ${lastName}。可能陷入循环。`,
      escalation: 'hint',
      phase: 'post_step',
    };
  }

  return null;
};
