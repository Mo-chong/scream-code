import type { MemoryMemoSummary } from './models.js';
import {
  computeJaccardSimilarity,
  computeTagSetQuality,
  TAG_CONFIG,
} from './tags.js';

export interface TagGenerationStats {
  totalMemos: number;
  totalTags: number;
  avgTagsPerMemo: number;
  distinctTagsCount: number;
  blacklistHitCount: number;
  blacklistHitRate: number;
  synonymConflictPairs: number;
  projectSpecificRatio: number;
  staleTagCount: number;
  trend: 'improving' | 'stable' | 'degrading';
}

/**
 * Compute aggregate tag generation statistics from a set of memos.
 * Used by Dream consolidation and monitoring panels.
 *
 * Phase 6: Quality statistics + feedback loop.
 */
export function computeTagStats(
  memos: MemoryMemoSummary[],
  options?: { projectTagCloud?: Set<string> },
): TagGenerationStats {
  const allTags = memos.flatMap((m) => m.tags ?? []);
  const distinctTags = new Set(allTags);
  const blacklistHits = allTags.filter((t) => TAG_CONFIG.BLACKLIST.has(t)).length;

  // Synonym conflict detection: count pairs that exceed Jaccard threshold
  const distinctArray = [...distinctTags];
  let synonymPairs = 0;
  for (let i = 0; i < distinctArray.length; i++) {
    for (let j = i + 1; j < distinctArray.length; j++) {
      if (
        computeJaccardSimilarity(distinctArray[i]!, distinctArray[j]!) >
        TAG_CONFIG.SYNONYM_JACCARD_THRESHOLD
      ) {
        synonymPairs++;
      }
    }
  }

  // Freshness statistics
  const staleCount = memos.filter((m) => {
    if (!m.tags?.length) return false;
    const daysSince = (Date.now() - m.recordedAt) / 86400000;
    return (
      Math.pow(TAG_CONFIG.TAG_FRESHNESS_DECAY, daysSince) <
      TAG_CONFIG.TAG_FRESHNESS_THRESHOLD
    );
  }).length;

  // Project-specific ratio: tags that appear in the project tag cloud
  const projectCloud = options?.projectTagCloud;
  const projectSpecificTags =
    projectCloud && projectCloud.size > 0
      ? allTags.filter((t) => projectCloud.has(t)).length
      : 0;

  return {
    totalMemos: memos.length,
    totalTags: allTags.length,
    avgTagsPerMemo: memos.length > 0 ? allTags.length / memos.length : 0,
    distinctTagsCount: distinctTags.size,
    blacklistHitCount: blacklistHits,
    blacklistHitRate: allTags.length > 0 ? blacklistHits / allTags.length : 0,
    synonymConflictPairs: synonymPairs,
    projectSpecificRatio:
      allTags.length > 0 ? projectSpecificTags / allTags.length : 0,
    staleTagCount: staleCount,
    trend: 'stable', // Simple default; future versions can compare snapshots
  };
}

/**
 * Convenience: run computeTagSetQuality on every memo and return aggregate
 * warning counts for the whole store.
 */
export function computeStoreQualityWarnings(
  memos: MemoryMemoSummary[],
  options?: { projectTagCloud?: Set<string> },
): { score: number; totalWarnings: number; memoWarnings: Map<string, string[]> } {
  let totalScore = 0;
  let totalWarnings = 0;
  const memoWarnings = new Map<string, string[]>();

  for (const memo of memos) {
    const { score, warnings } = computeTagSetQuality(memo.tags ?? [], options);
    totalScore += score;
    if (warnings.length > 0) {
      totalWarnings += warnings.length;
      memoWarnings.set(memo.id, warnings);
    }
  }

  return {
    score: memos.length > 0 ? totalScore / memos.length : 0,
    totalWarnings,
    memoWarnings,
  };
}
