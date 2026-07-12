import type { DetectorFn, RawSignal } from '../types';

/**
 * editRetryDetector — 检测 Edit 失败后重试
 *
 * 模式：当前步骤 AI 发起了 Edit 调用，且 triggerHistory 显示
 * edit_retry 已触发过（说明之前的 Edit 失败了）→ 建议先 Read。
 *
 * 审计数据：Edit 失败率 27.7%，是上下文浪费最大源头。
 * 此检测器帮助打断"Edit 失败→不 Read→再 Edit→再失败"循环。
 */
export const editRetryDetector: DetectorFn = (ctx): RawSignal | null => {
  const tools = ctx.lastToolCalls;
  if (!tools || tools.length === 0) return null;

  const edits = tools.filter((tc: any) => (tc?.name ?? '') === 'Edit');
  if (edits.length === 0) return null;

  const prevTriggers = ctx.triggerHistory?.['edit_retry'] ?? 0;
  if (prevTriggers === 0) return null; // First attempt, no history

  const editPaths = edits
    .map((tc: any) => (tc?.args as any)?.path)
    .filter(Boolean) as string[];
  const pathDetail = editPaths.length > 0 ? editPaths.join(', ') : '(unknown path)';

  const confidence = Math.min(0.4 + prevTriggers * 0.2, 1);

  return {
    rootCause: 'edit_retry',
    priority: prevTriggers >= 2 ? 'P1_discipline' : 'P2_quality',
    confidence,
    message: `Edit 失败后重试: ${pathDetail}（此前已失败 ${prevTriggers} 次）— 请先 Read 确认最新内容`,
    escalation: prevTriggers >= 2 ? 'warn' : 'nudge',
    phase: 'post_step',
  };
};
