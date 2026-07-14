/**
 * PermissionEnforcer Detector
 *
 * 检测工具权限拦截事件（由 permission/index.ts 决策）。
 * 消费 ctx.guardResult。
 *
 * 纯函数 — 只检测，不输出。
 */

import type { DetectorFn, RawSignal } from '../types';

export const permissionEnforcerDetector: DetectorFn = (ctx): RawSignal | null => {
  const guard = ctx.guardResult;
  if (!guard || guard.rule === 0) return null;

  // Guard Rule 1 (confabulation block) → P0_block
  if (guard.rule === 1 && guard.block) {
    return {
      rootCause: 'confabulation',
      priority: 'critical',
      confidence: 0.95,
      message: guard.feedback || '检测到虚构内容，已阻断。',
      escalation: 'block',
      phase: 'pre_step',
    };
  }

  // Guard Rule 2 (claim without evidence) → critical
  if (guard.rule === 2) {
    return {
      rootCause: 'edit_discipline',
      priority: 'critical',
      confidence: 0.7,
      message: guard.feedback || '声称发现内容但无工具调用证据。请先用 Read/Grep/LSP 验证。',
      escalation: 'hint',
      phase: 'post_step',
    };
  }

  // Guard Rule 3 (claim edit without write) → critical
  if (guard.rule === 3) {
    return {
      rootCause: 'edit_discipline',
      priority: 'critical',
      confidence: 0.7,
      message: guard.feedback || '声称已修改但无 Edit/Write 调用。',
      escalation: 'hint',
      phase: 'post_step',
    };
  }

  // Guard Rule 4 (memory without code tools) → normal
  if (guard.rule === 4) {
    return {
      rootCause: 'quality_degrade',
      priority: 'normal',
      confidence: 0.6,
      message: guard.feedback || '使用记忆信息但未用 Read/Grep 确认当前代码。',
      escalation: 'hint',
      phase: 'post_step',
    };
  }

  return null;
};
