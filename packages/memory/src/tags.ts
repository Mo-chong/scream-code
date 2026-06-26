// extractKeywords no longer needed — generateTags is deprecated

/**
 * Minimal store interface used by processTags for embedding-based tag
 * recommendation (Phase 1+). Avoids circular dependency with store.ts.
 */
export interface ProcessTagsStore {
  getEmbeddingEngine(): { readonly available: boolean } | undefined;
}

/**
 * Context passed to processTags for tag generation and enrichment.
 */
export interface ProcessTagsContext {
  /** Existing distinct tags in the store (used for synonym merging in Phase 3+). */
  existingTags?: string[];
  /** Full text of the memo (used for fallback tag generation when LLM skips tags). */
  fullText?: string;
  /** Memory store reference (used for embedding-based tag recommendation in Phase 1+). */
  store?: ProcessTagsStore;
}

/**
 * Normalize a tag list: lowercase, trim, deduplicate, drop empties,
 * and cap at `max` entries.
 */
export function normalizeTags(tags: unknown, max = 5): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toLowerCase();
    if (tag.length === 0 || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= max) break;
  }
  return result;
}

/** @deprecated Algorithm-based tag generation is harmful. Kept as export for compat, returns []. */
export function generateTags(_text: string, _max = 5): string[] {
  return [];
}

/**
 * Smart tag merging: concept tags (>=4 chars) take priority over short tags.
 * This prevents algorithm noise from crowding out meaningful LLM-written tags.
 *
 * Unlike normalizeTags which is a dumb head-chopper, smartTags separates
 * tags by quality tier and preserves concept tags first.
 */
export function smartTags(
  tags: string[],
  options?: {
    maxConcepts?: number;
    maxTotal?: number;
    existingCorpus?: string[];
  },
): string[] {
  const { maxConcepts = 10, maxTotal = 20, existingCorpus } = options ?? {};

  // Phase 1: filter stopwords/blacklist, separate concepts from shorts
  const concepts: string[] = [];
  const shorts: string[] = [];

  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const t = tag.trim().toLowerCase();
    if (t.length === 0) continue;
    if (TAG_CONFIG.BLACKLIST.has(t)) continue;
    // We don't filter by STOP_WORDS here — tags are LLM-written concepts, not raw text tokens
    if (t.length >= 4) concepts.push(t);
    else shorts.push(t);
  }

  // Phase 2: synonym merge against existing corpus (only for concepts)
  const merged = (existingCorpus?.length ?? 0) > 0
    ? deduplicateAgainstCorpus(concepts, existingCorpus!)
    : concepts;

  // Phase 3: deduplicate and assemble
  const seen = new Set<string>();
  const result: string[] = [];

  for (const t of merged) {
    if (result.length >= maxConcepts) break;
    if (!seen.has(t)) { seen.add(t); result.push(t); }
  }
  for (const t of shorts) {
    if (result.length >= maxTotal) break;
    if (!seen.has(t)) { seen.add(t); result.push(t); }
  }

  return result;
}

/**
 * Unified tag processing entry point.
 * All tag paths (MemoryWrite, Exit Extraction, Compaction, Dream) call this.
 *
 * Steps:
 *   1: basic sanitize via normalizeTags (lowercase, trim, dedup)
 *   2: if empty after sanitize → return [] (no algorithm fallback)
 *   3: bilingual expansion — split "A/B" tags into "A" and "B"
 *   4: smart merge via smartTags — concept tags (>=4 chars) first, shorts second
 *
 * Tags come ONLY from LLM input. Algorithm-generated tags are harmful and removed.
 */
export async function processTags(
  rawTags: unknown,
  context: ProcessTagsContext = {},
): Promise<string[]> {
  // Step 1: basic sanitize (lowercase, trim, dedup) — use large cap, smartTags handles real limiting
  const sanitized = normalizeTags(rawTags, 999);

  // Fallback: LLM didn't provide tags — return empty. Algorithm-generated tags are harmful.
  if (sanitized.length === 0) {
    return [];
  }

  // Phase 7: bilingual expansion — split "A/B" tags into "A" and "B"
  // so both the Chinese and English forms exist independently in the DB.
  // TagOverlap is an exact Set.has() match, so having both forms means
  // both a Chinese query ("容量守卫") and an English query ("capacity-guard")
  // will score on this memo's tags.
  const expanded: string[] = [];
  for (const tag of sanitized) {
    const slashIdx = tag.indexOf('/');
    if (slashIdx > 0 && slashIdx < tag.length - 1) {
      const left = tag.slice(0, slashIdx).trim();
      const right = tag.slice(slashIdx + 1).trim();
      if (left.length > 0) expanded.push(left);
      if (right.length > 0) expanded.push(right);
    } else {
      expanded.push(tag);
    }
  }

  // Step 3: smart merge — concept tags first, shorts second
  const merged = smartTags(expanded, {
    existingCorpus: context.existingTags,
  });

  // Step 4: strip reserved system tags — these must ONLY be assigned by human
  return merged.filter((t) => !RESERVED_TAGS.has(t));
}

/**
 * Recommend tags by finding semantically similar memos via embedding
 * and collecting their most common tags. No algorithm fallback —
 * returns [] when embedding engine is unavailable.
 */
export async function recommendTagsFromEmbedding(
  text: string,
  store: ProcessTagsStore,
  max = 5,
): Promise<string[]> {
  // Get the embedding engine (may be undefined if fastembed is not configured)
  // We use optional chaining: ProcessTagsStore.getEmbeddingEngine() returns a
  // minimal interface with `available`. The real store.ts's method returns the
  // full EmbeddingEngine which extends it.
  const engine = store.getEmbeddingEngine() as { available: boolean; embedBatch?(texts: string[]): Promise<Float32Array[] | null>; cosineSimilarity?(a: Float32Array, b: Float32Array): number } | undefined;
  if (!engine?.available || !engine.embedBatch || !engine.cosineSimilarity) {
    return [];  // No embedding engine: LLM must provide tags directly
  }

  const vecs = await engine.embedBatch([text]);
  if (!vecs || vecs.length === 0) return [];
  const queryVec = vecs[0]!;

  // This is a placeholder for the embedding-based tag recommendation.
  // Phase 1+ can implement the full centroid-comparison algorithm:
  // 1. Read all memos with tags from the store
  // 2. For each distinct tag, find memos with that tag
  // 3. Compute centroid embedding per tag (average of memo embeddings)
  // 4. Compare queryVec against each centroid via cosine similarity
  // 5. Return top-3 matching tags
  //
  // For now, return empty to avoid LLM tag bypass.
  // Phase 1+ can implement full centroid-comparison when store.read() is available.
  return [];
}

/**
 * Reserved system status tags that must ONLY be assigned by human
 * (manual MemoryWrite / direct DB edit).
 *
 * All automated pipelines (extraction, consolidation, Dream, compaction)
 * MUST strip these from their output. They encode semantic state that
 * only a human operator can correctly assign:
 *   - baohu  (保护):  immunizes from Dream consolidation
 *   - chundu (纯度):  behavior-rule injection tag + demote immunity
 *   - ding   (钉):    pin a memo (formerly demote immunity)
 *   - yongjiu(永久):  long-term preservation
 */
export const RESERVED_TAGS = new Set(['baohu', 'chundu', 'ding', 'yongjiu']);

// ── Phase 2: TAG_CONFIG ────────────────────────────────────────────

export const TAG_CONFIG = {
  // Synonym merging (Phase 3)
  SYNONYM_JACCARD_THRESHOLD: 0.6,

  // Blacklist (Phase 3)
  BLACKLIST: new Set([
    '问题', '解决', '完成', 'none',
    'bug', 'fix', '修复', '修复了', '处理',
    '测试', 'test', '测试了',
  ]),

  // Dynamic budget (Phase 2)
  MAX_TAGS_DEFAULT: 5,        // Used by normalizeTags (edit tool, archive)
  MIN_TAGS: 2,                 // Only used by computeTagBudget (deprecated)
  MAX_TAGS_ABSOLUTE: 8,        // Legacy — no longer used by processTags
  TAG_BUDGET_RICHNESS_LENGTH: 200,
  TAG_BUDGET_SCARCITY_FACTOR: 0.02,

  // ResNet freshness (Phase 5)
  TAG_FRESHNESS_DECAY: 0.95,
  TAG_FRESHNESS_THRESHOLD: 0.3,

  // Deviation chain (Phase 4)
  BAD_TAG_CONSECUTIVE_LIMIT: 2,

  // Quality scoring (Phase 6)
  QUALITY_BLACKLIST_PENALTY: -0.3,
  QUALITY_PROJECT_SPECIFIC_BONUS: 0.1,
  QUALITY_SINGLE_TAG_PENALTY: -0.2,
} as const;

// ── Phase 2: Dynamic Tag Budget ─────────────────────────────────────

/** @deprecated Smart tags handles budget internally. Kept for external callers. */
export function computeTagBudget(text: string, existingDistinctCount: number): number {
  const textLen = text.length;
  const textRichness = Math.min(1, textLen / TAG_CONFIG.TAG_BUDGET_RICHNESS_LENGTH);
  const scarcity = Math.max(0.4, 1 - existingDistinctCount * TAG_CONFIG.TAG_BUDGET_SCARCITY_FACTOR);
  const budget = Math.round(3 + textRichness * scarcity * 3);
  return Math.max(TAG_CONFIG.MIN_TAGS, Math.min(TAG_CONFIG.MAX_TAGS_ABSOLUTE, budget));
}

// ── Phase 3: Synonym Merging + Blacklist ───────────────────────────

/**
 * Compute Jaccard similarity between two strings (character-level).
 */
export function computeJaccardSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const intersection = [...a].filter(c => b.includes(c)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Deduplicate new tags against an existing corpus of distinct tags.
 * Tags that exceed the Jaccard threshold are replaced by the existing
 * match (canonical form wins).
 */
export function deduplicateAgainstCorpus(
  newTags: string[],
  existingDistinctTags: string[],
): string[] {
  if (existingDistinctTags.length === 0) return newTags;
  return newTags.map(tag => {
    const match = existingDistinctTags.find(
      e => computeJaccardSimilarity(tag, e) > TAG_CONFIG.SYNONYM_JACCARD_THRESHOLD,
    );
    return match ?? tag;
  });
}

// ── Phase 2: Validation Functions ───────────────────────────────────

/**
 * Validate a single tag. Returns validity and suggestion when applicable.
 */
export function validateTag(
  tag: string,
  existingTags?: string[],
): { valid: boolean; reason?: string; suggestion?: string } {
  if (TAG_CONFIG.BLACKLIST.has(tag)) {
    return { valid: false, reason: '黑名单词', suggestion: '使用具体技术名词' };
  }
  if (tag.length < 2) {
    return { valid: false, reason: '标签过短', suggestion: '使用完整技术名词' };
  }
  if (tag.length > 30) {
    return { valid: false, reason: '标签过长', suggestion: '缩写为短技术名词' };
  }
  if (existingTags) {
    const similar = existingTags.find(
      e => computeJaccardSimilarity(tag, e) > TAG_CONFIG.SYNONYM_JACCARD_THRESHOLD,
    );
    if (similar) {
      return { valid: true, reason: '有同义标签', suggestion: similar };
    }
  }
  return { valid: true };
}

/**
 * Score the overall quality of a tag set. Returns 0-1 score and warnings.
 */
export function computeTagSetQuality(
  tags: string[],
  context?: { projectTagCloud?: Set<string> },
): { score: number; warnings: string[] } {
  let score = 1.0;
  const warnings: string[] = [];
  for (const tag of tags) {
    if (TAG_CONFIG.BLACKLIST.has(tag)) {
      score += TAG_CONFIG.QUALITY_BLACKLIST_PENALTY;
      warnings.push(`黑名单词: ${tag}`);
    }
    if (tag.length < 3) {
      score -= 0.1;
      warnings.push(`标签过短: ${tag}`);
    }
    if (context?.projectTagCloud?.has(tag)) {
      score += TAG_CONFIG.QUALITY_PROJECT_SPECIFIC_BONUS;
    }
  }
  if (tags.length === 0) { score = 0; warnings.push('无标签'); }
  if (tags.length === 1) { score += TAG_CONFIG.QUALITY_SINGLE_TAG_PENALTY; warnings.push('仅一个标签'); }
  return { score: Math.max(0, Math.min(1, score)), warnings };
}
