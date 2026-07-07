import type { MemoryMemo, MemoryMemoSummary } from './models.js';
import { createMemoryMemo, toSummary } from './models.js';
import type { MemoryMemoStore } from './store.js';
import { STOP_WORDS, isDuplicate } from './scoring.js';
import { normalizeTags, processTags, RESERVED_TAGS, TAG_CONFIG } from './tags.js';

/**
 * Merge tags from multiple memos with priority for consensus tags.
 * Tags appearing in more memos rank higher.
 */
export function unionWithPriority(
  tagArrays: string[][],
  maxTags: number = 12,
): string[] {
  const freq = new Map<string, number>();
  for (const arr of tagArrays) {
    const seen = new Set<string>();
    for (const tag of arr) {
      const normalized = tag.trim().toLowerCase();
      if (normalized.length === 0 || seen.has(normalized)) continue;
      seen.add(normalized);
      freq.set(normalized, (freq.get(normalized) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, maxTags)
    .map(([tag]) => tag)
    .filter((t) => !RESERVED_TAGS.has(t));
}

export interface DuplicateGroup {
  /** Memos identified as duplicates/similar. */
  memos: MemoryMemoSummary[];
  /** Suggested merged memo content. */
  merged: {
    userNeed: string;
    approach: string;
    outcome: string;
    whatFailed: string;
    whatWorked: string;
    tags?: string[];
  };
  /** Reason this group was flagged. */
  reason: string;
}

export interface RelatedGroup {
  /** Memos that share a topic anchor but are not duplicates. */
  memos: MemoryMemoSummary[];
  /** Shared anchor such as a compound identifier or CJK 2-gram. */
  topic: string;
  /** Human-readable explanation for the grouping. */
  reason: string;
}

export interface ConsolidationPlan {
  duplicateGroups: DuplicateGroup[];
  /** Memos that share a topic but are distinct enough to keep separate. */
  relatedGroups: RelatedGroup[];
  /** Memos that appear to be resolved (outcome indicates completion). */
  resolved: MemoryMemoSummary[];
  /** Memos that appear stale (no updates > 30 days). */
  stale: MemoryMemoSummary[];
  summary: {
    totalMemos: number;
    duplicatesFound: number;
    relatedGroupsFound: number;
    resolvedFound: number;
    staleFound: number;
    memosAfterConsolidation: number;
    /** Number of protected (baohu-tagged) memos skipped. */
    skippedProtected: number;
  };
}

/** Tags that immunize a memo from all consolidation (merge, delete, archive). */
const PROTECTED_TAGS = ['baohu', 'chundu', 'ding', 'yongjiu'];

const STALE_DAYS = 30;

/**
 * Analyze all memos and produce a consolidation plan.
 *
 * Pure logic — no LLM call. Uses keyword similarity to find near-duplicate
 * memos, flags resolved/stale entries.
 */
export async function buildConsolidationPlan(
  store: MemoryMemoStore,
  options?: { projectDir?: string; includeArchive?: boolean },
): Promise<ConsolidationPlan> {
  const allMemos: MemoryMemo[] = [];
  for await (const memo of store.read(options)) {
    allMemos.push(memo);
  }
  // If includeArchive is set, also scan cold-tier memos for dedup/stale
  if (options?.includeArchive) {
    for await (const memo of store.readArchived(options)) {
      allMemos.push(memo);
    }
  }

  // Protected memos (tagged 'baohu' or 'chundu') are immune from merge/delete/stale.
  const protectedCount = allMemos.filter(m => m.tags?.some(t => PROTECTED_TAGS.includes(t))).length;
  const active = allMemos.filter(m => !m.tags?.some(t => PROTECTED_TAGS.includes(t)));

  const summaries = active.map(toSummary);
  const duplicateGroups = findDuplicateGroups(summaries);
  const relatedGroups = findRelatedGroups(summaries, duplicateGroups);
  const resolved = findResolved(summaries);
  const stale = findStale(summaries, STALE_DAYS);

  const dedupedCount = duplicateGroups.reduce((acc, g) => acc + g.memos.length - 1, 0);

  return {
    duplicateGroups,
    relatedGroups,
    resolved,
    stale,
    summary: {
      totalMemos: allMemos.length,
      duplicatesFound: dedupedCount,
      relatedGroupsFound: relatedGroups.length,
      resolvedFound: resolved.length,
      staleFound: stale.length,
      memosAfterConsolidation:
        allMemos.length - dedupedCount - resolved.length - stale.length,
      skippedProtected: protectedCount,
    },
  };
}

/**
 * Apply a consolidation plan: delete duplicates, resolved, and stale memos,
 * appending merged replacements for duplicates.
 */
export async function applyConsolidation(
  store: MemoryMemoStore,
  plan: ConsolidationPlan,
): Promise<{ deleted: number; created: number }> {
  let deleted = 0;
  let created = 0;

  // ── 1. 归档 resolved/stale 的经验（append + demote 代替 delete）──
  if (plan.resolved.length > 0) {
    const worked = plan.resolved
      .filter((m) => m.whatWorked)
      .map((m) => m.whatWorked)
      .join('; ');
    const failed = plan.resolved
      .filter((m) => m.whatFailed)
      .map((m) => m.whatFailed)
      .join('; ');
    if (worked || failed) {
      const archive = createMemoryMemo({
        sourceSessionId: plan.resolved[0]!.sourceSessionId,
        userNeed: '已解决任务的经验归档（dream 整理）',
        approach: '多次尝试后解决',
        outcome: '已完成',
        whatWorked: worked || 'none',
        whatFailed: failed || 'none',
        tags: await processTags(plan.resolved.flatMap((m) => m.tags ?? [])),
        extractionSource: 'compaction',
      });
      await store.append(archive);
      created++;
    }
  }
  if (plan.stale.length > 0) {
    const worked = plan.stale
      .filter((m) => m.whatWorked)
      .map((m) => m.whatWorked)
      .join('; ');
    const failed = plan.stale
      .filter((m) => m.whatFailed)
      .map((m) => m.whatFailed)
      .join('; ');
    if (worked || failed) {
      const archive = createMemoryMemo({
        sourceSessionId: plan.stale[0]!.sourceSessionId,
        userNeed: '过期记忆的经验归档（dream 整理）',
        approach: '距今超过30天未使用',
        outcome: '已归档',
        whatWorked: worked || 'none',
        whatFailed: failed || 'none',
        tags: await processTags(plan.stale.flatMap((m) => m.tags ?? [])),
        extractionSource: 'compaction',
      });
      await store.append(archive);
      created++;
    }
  }

  // ── 2. Demote resolved/stale instead of deleting (hot→cold move) ──
  for (const memo of plan.resolved) {
    if (store.demote !== undefined) {
      await store.demote(memo.id);
      deleted++;
    } else {
      await store.delete(memo.id);
      deleted++;
    }
  }
  for (const memo of plan.stale) {
    if (store.demote !== undefined) {
      await store.demote(memo.id);
      deleted++;
    } else {
      await store.delete(memo.id);
      deleted++;
    }
  }

  // ── 2. 合并 duplicates：先建 merged 再删 originals（防崩溃）──
  for (const group of plan.duplicateGroups) {
    const newest = group.memos.reduce((a, b) =>
      a.recordedAt > b.recordedAt ? a : b,
    );
    // Union with priority: consensus tags across duplicates rank highest
    const mergedTags = unionWithPriority(
      group.memos.map((m) => m.tags ?? []),
      12,
    );
    const merged = createMemoryMemo({
      sourceSessionId: newest.sourceSessionId,
      sourceSessionTitle: newest.sourceSessionTitle,
      userNeed: group.merged.userNeed,
      approach: group.merged.approach,
      outcome: group.merged.outcome,
      whatFailed: group.merged.whatFailed,
      whatWorked: group.merged.whatWorked,
      tags: group.merged.tags ?? mergedTags,
      extractionSource: 'compaction',
    });
    // 先 append merged，确保崩溃时新记录已落盘
    await store.append(merged);
    created++;
  }

  // ── 3. 删除 originals of duplicates（merged 已安全落盘，崩溃可恢复）──
  for (const group of plan.duplicateGroups) {
    for (const memo of group.memos) {
      await store.delete(memo.id);
      deleted++;
    }
  }

  return { deleted, created };
}

function findDuplicateGroups(memos: MemoryMemoSummary[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const used = new Set<string>();

  for (let i = 0; i < memos.length; i++) {
    const first = memos[i];
    if (!first || used.has(first.id)) continue;

    const cluster: MemoryMemoSummary[] = [first];

    for (let j = i + 1; j < memos.length; j++) {
      const candidate = memos[j];
      if (!candidate || used.has(candidate.id)) continue;

      // Weighted multi-field dedup with userNeed short-circuit and synonym expansion
      const isSimilar = cluster.some((m) => isDuplicate(m, candidate));

      if (isSimilar) {
        cluster.push(candidate);
      }
    }

    if (cluster.length > 1) {
      for (const m of cluster) used.add(m.id);
      groups.push(buildDuplicateGroup(cluster));
    }
  }

  return groups;
}

/**
 * Split a whatFailed / whatWorked field into individual claims.
 * Handles multiple Chinese/English delimiters for real-world sentence patterns.
 */
function splitClaims(text: string): string[] {
  if (!text || text === 'none' || text === '无') return [];
  // 🛠️ P1-4: Split on Chinese/English sentence delimiters including Chinese comma
  return text
    .split(/[;；。.!！?？，,\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

/**
 * Extract significant words for contradiction detection:
 * ASCII words >= 3 chars + CJK 2-grams.
 */
function extractSignificantWords(text: string): string[] {
  const words: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    if (m[0].length >= 3) words.push(m[0]);
  }
  for (const m of lower.matchAll(/[一-鿿]+/g)) {
    const run = m[0];
    for (let i = 0; i < run.length - 1; i++) {
      words.push(run.slice(i, i + 2));
    }
  }
  return words;
}

/**
 * Check whether `claim` overlaps with any claim in `against`.
 * 2+ shared significant words = overlap; 1 word is enough for single-word claims.
 */
// 🛠️ P3-12: minimum word matches to consider a claims overlap (was hardcoded 2)
const CLAIMS_OVERLAP_MIN_MATCH = 2;

function claimsOverlap(claim: string, against: Set<string>): boolean {
  const words = extractSignificantWords(claim);
  // Single word never counts as overlap — too ambiguous
  if (words.length <= 1) return false;
  for (const other of against) {
    const otherLower = other.toLowerCase();
    const matched = words.filter((w) => otherLower.includes(w.toLowerCase())).length;
    if (matched >= CLAIMS_OVERLAP_MIN_MATCH) return true;
  }
  return false;
}

function buildDuplicateGroup(cluster: MemoryMemoSummary[]): DuplicateGroup {
  const sorted = [...cluster].toSorted((a, b) => b.recordedAt - a.recordedAt);
  const newest = sorted[0]!;

  // Split into newer/older halves by median time. When claims contradict
  // across time periods, newer stance wins (newer experience overrides older).
  const mid = Math.ceil(sorted.length / 2);
  const newer = sorted.slice(0, mid);
  const newerFailedClaims = new Set(newer.flatMap((m) => splitClaims(m.whatFailed)));
  const newerWorkedClaims = new Set(newer.flatMap((m) => splitClaims(m.whatWorked)));

  const failures = new Set<string>();
  const successes = new Set<string>();

  for (const memo of cluster) {
    for (const claim of splitClaims(memo.whatFailed)) {
      // Drop if a newer memo says this problem was solved
      if (!claimsOverlap(claim, newerWorkedClaims)) {
        failures.add(claim);
      }
    }
    for (const claim of splitClaims(memo.whatWorked)) {
      // Drop if a newer memo says this approach failed
      if (!claimsOverlap(claim, newerFailedClaims)) {
        successes.add(claim);
      }
    }
  }

  // Determine best outcome: prefer completion indicators
  const outcomes = cluster.map((m) => m.outcome);
  const hasDone = outcomes.some((o) => o.includes('完成') || o.toLowerCase().includes('done'));
  const bestOutcome = hasDone ? '完成' : newest.outcome;

  return {
    memos: cluster,
    merged: {
      userNeed: newest.userNeed,
      approach: `合并 ${cluster.length} 条相关记录。最新方案: ${newest.approach}`,
      outcome: bestOutcome,
      whatFailed: failures.size > 0 ? [...failures].join('; ') : 'none',
      whatWorked: successes.size > 0 ? [...successes].join('; ') : 'none',
    },
    reason: `发现 ${cluster.length} 条相似记录（多字段加权相似度 >= 45%）`,
  };
}

/**
 * Extract topic anchors from memo text.
 *
 * Compound identifiers like `sample-project` are strong signals and kept whole.
 * ASCII words >= 3 chars are kept when not stopwords. CJK runs are tokenized
 * into 2-grams so that pure-Chinese themes like "用户认证" can still form
 * groups without relying on noisy single-character Jaccard overlap.
 */
function extractTopicAnchors(text: string): string[] {
  const lower = text.toLowerCase();
  const anchors = new Set<string>();

  // Compound identifiers containing - or _
  for (const match of lower.matchAll(/[a-z0-9]+[-_][a-z0-9]+(?:[-_][a-z0-9]+)*/g)) {
    const token = match[0];
    if (token.length >= 5) {
      anchors.add(token);
    }
  }

  // Plain ASCII/alphanumeric runs
  for (const match of lower.matchAll(/[a-z0-9]+/g)) {
    const token = match[0];
    if (token.length >= 3 && !STOP_WORDS.has(token)) {
      anchors.add(token);
    }
  }

  // CJK 2-grams
  for (const match of lower.matchAll(/[一-鿿㐀-䶿]+/g)) {
    const run = match[0];
    for (let i = 0; i < run.length - 1; i++) {
      anchors.add(run.slice(i, i + 2));
    }
  }

  return [...anchors];
}

function findRelatedGroups(
  memos: MemoryMemoSummary[],
  duplicateGroups: DuplicateGroup[],
): RelatedGroup[] {
  const used = new Set<string>();
  for (const group of duplicateGroups) {
    for (const memo of group.memos) {
      used.add(memo.id);
    }
  }

  const available = memos.filter((m) => !used.has(m.id));
  const anchorIndex = new Map<string, MemoryMemoSummary[]>();

  for (const memo of available) {
    const text = `${memo.userNeed} ${memo.approach} ${memo.whatFailed} ${memo.whatWorked}`;
    const anchors = extractTopicAnchors(text);
    for (const anchor of anchors) {
      const list = anchorIndex.get(anchor) ?? [];
      if (!list.some((m) => m.id === memo.id)) {
        list.push(memo);
      }
      anchorIndex.set(anchor, list);
    }
  }

  const groups: RelatedGroup[] = [];
  const assigned = new Set<string>();

  // Strongest groups (anchors appearing in the most memos) come first.
  const sortedAnchors = [...anchorIndex.entries()]
    .filter(([, list]) => list.length >= 2)
    .toSorted((a, b) => b[1].length - a[1].length);

  for (const [anchor, candidates] of sortedAnchors) {
    const groupMemos = candidates.filter((m) => !assigned.has(m.id));
    if (groupMemos.length >= 2) {
      groups.push({
        memos: groupMemos,
        topic: anchor,
        reason: `发现 ${groupMemos.length} 条围绕 ${anchor} 的记录`,
      });
      for (const m of groupMemos) {
        assigned.add(m.id);
      }
    }
  }

  return groups;
}

function isOutcomeCompleted(outcome: string): boolean {
  const lower = outcome.toLowerCase();
  return (
    lower.includes('完成') ||
    lower.includes('done') ||
    lower.includes('completed') ||
    lower.includes('成功') ||
    lower.includes('success')
  );
}

function findResolved(memos: MemoryMemoSummary[]): MemoryMemoSummary[] {
  return memos.filter(
    (m) =>
      isOutcomeCompleted(m.outcome) &&
      // Only flag memos older than 7 days as "resolved"
      (Date.now() - m.recordedAt) > 7 * 24 * 60 * 60 * 1000,
  );
}

function findStale(
  memos: MemoryMemoSummary[],
  staleDays: number,
): MemoryMemoSummary[] {
  const threshold = Date.now() - staleDays * 24 * 60 * 60 * 1000;
  return memos.filter(
    (m) =>
      m.recordedAt < threshold &&
      !isOutcomeCompleted(m.outcome) &&
      !m.outcome.includes('blocked'),
  );
}

/**
 * Phase 5: Find memos whose tags have become "stale" (low freshness)
 * based on the ResNet decay formula. Returns stale tag entries that
 * Dream consolidation can suggest refreshing.
 */
export function findStaleTags(
  memos: MemoryMemoSummary[],
  options?: { threshold?: number; decay?: number },
): Array<{
  memoId: string;
  oldTags: string[];
  daysSince: number;
  freshness: number;
}> {
  const threshold = options?.threshold ?? TAG_CONFIG.TAG_FRESHNESS_THRESHOLD;
  const decay = options?.decay ?? TAG_CONFIG.TAG_FRESHNESS_DECAY;
  const stale: Array<{
    memoId: string;
    oldTags: string[];
    daysSince: number;
    freshness: number;
  }> = [];
  for (const memo of memos) {
    if (!memo.tags?.length) continue;
    const daysSince = (Date.now() - memo.recordedAt) / 86400000;
    const freshness = Math.pow(decay, daysSince);
    if (freshness < threshold) {
      stale.push({ memoId: memo.id, oldTags: memo.tags, daysSince, freshness });
    }
  }
  return stale;
}
