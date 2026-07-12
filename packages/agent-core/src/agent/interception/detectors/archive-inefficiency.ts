import type { DetectorFn, RawSignal } from '../types';

/**
 * archiveInefficiencyDetector — 检测低效取回行为
 *
 * 模式：当前步骤中 AI 同时调用了多次 Read（同文件或不同文件），
 * 或者 triggerHistory 显示已多次提醒 → 引导使用 archive_recover。
 *
 * Phase39 辅助检测，训练 AI 优先使用 archive_recover 而非重复 Read。
 */
export const archiveInefficiencyDetector: DetectorFn = (ctx): RawSignal | null => {
  const tools = ctx.lastToolCalls;
  if (!tools || tools.length < 2) return null;

  // Count Read calls in this step
  const reads = tools.filter((tc: any) => (tc?.name ?? '') === 'Read');
  if (reads.length < 2) return null;

  // Check for same-file reads
  const filePaths = reads
    .map((tc: any) => (tc?.args as any)?.path)
    .filter(Boolean) as string[];
  const uniqueFiles = new Set(filePaths);
  const hasDuplicateRead = filePaths.length > uniqueFiles.size;
  const hasMultipleReads = reads.length >= 2;

  if (!hasDuplicateRead && !hasMultipleReads) return null;

  const prevTriggers = ctx.triggerHistory?.['archive_inefficient'] ?? 0;
  const confidence = Math.min((hasDuplicateRead ? 0.5 : 0.3) + prevTriggers * 0.15, 1);

  const detail = hasDuplicateRead
    ? `同一步中重复 Read 同一文件: ${[...new Set(filePaths.filter(f => filePaths.filter((p: string) => p === f).length > 1))].join(', ')}`
    : `单步 ${reads.length} 次 Read: ${filePaths.join(', ')}`;

  return {
    rootCause: 'archive_inefficient',
    priority: prevTriggers >= 2 ? 'P2_quality' : 'P3_signal',
    confidence,
    message: `${detail} — 已读文件优先用 archive_recover 取回`,
    escalation: prevTriggers >= 2 ? 'nudge' : 'hint',
    phase: 'post_step',
  };
};
