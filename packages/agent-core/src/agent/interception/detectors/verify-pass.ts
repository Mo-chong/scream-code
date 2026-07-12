/**
 * VerifyPass Detector
 *
 * 验证通过后产生正向确认信号（仅恢复场景：之前有验证失败历史时触发）。
 * 简单"验证通过"的即时消息由 turn/index.ts L1462 的原有 this.inject() 处理。
 * 本 detector 负责跨轮恢复信号（InterceptionManager 的 triggerHistory）。
 *
 * 纯函数 — 只检测，不输出。
 */

import type { DetectorFn, RawSignal } from '../types';

export const verifyPassDetector: DetectorFn = (ctx): RawSignal | null => {
  // 只处理恢复场景：之前有验证失败历史
  const priorFails = ctx.behaviorViolations?.['verify_discipline'] ?? 0;
  if (priorFails === 0) return null;

  // 检查上一步工具调用是否是成功的验证命令
  const tools = ctx.lastToolCalls;
  if (!tools || tools.length === 0) return null;

  const tc = tools[tools.length - 1] as any;
  const tcName = tc?.name ?? '';
  const isError = tc?.result?.isError === true;

  if (tcName === 'Bash' && !isError) {
    return {
      rootCause: 'verify_discipline',
      priority: 'P3_signal',
      confidence: 0.8,
      message: `[恢复] 验证通过。之前曾连续触发 ${priorFails} 次验证问题，本轮已修复。`,
      escalation: 'hint',
      phase: 'post_step',
    };
  }

  return null;
};
