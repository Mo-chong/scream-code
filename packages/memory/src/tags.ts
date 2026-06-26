import { extractKeywords } from './scoring.js';

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

/**
 * Generate a small set of semantic tags from free-form text.
 * Falls back to keyword extraction when the caller does not supply tags.
 */
export function generateTags(text: string, max = 5): string[] {
  const keywords = extractKeywords(text);
  return normalizeTags(keywords, max);
}

/**
 * Unified tag processing entry point.
 * All tag paths (MemoryWrite, Exit Extraction, Compaction, Dream) call this.
 *
 * Phases:
 *   0: normalizes + fallback generateTags
 *   1: embedding recommendation when store available
 *   2: dynamic budget via computeTagBudget
 *   3: synonym merging + blacklist filter
 *   4+: (deviation chain handled externally in store.ts)
 */
export async function processTags(
  rawTags: unknown,
  context: ProcessTagsContext = {},
): Promise<string[]> {
  // Use MAX_TAGS_ABSOLUTE as the intermediate cap so the dynamic budget (Phase 2)
  // can actually expand beyond the default max of 5.
  let tags = normalizeTags(rawTags, TAG_CONFIG.MAX_TAGS_ABSOLUTE);

  // Fallback: generate or recommend tags when LLM didn't produce any
  if (tags.length === 0 && context.fullText) {
    if (context.store) {
      tags = await recommendTagsFromEmbedding(context.fullText, context.store);
    } else {
      tags = generateTags(context.fullText);
    }
  }

  // Phase 3: synonym merging — deduplicate against existing corpus
  if (context.existingTags && context.existingTags.length > 0) {
    tags = deduplicateAgainstCorpus(tags, context.existingTags);
  }

  // Phase 3: blacklist filter
  tags = tags.filter(t => !TAG_CONFIG.BLACKLIST.has(t));

  // Phase 2: dynamic budget — compute max tag count
  if (context.fullText) {
    const existingCount = context.existingTags?.length ?? 0;
    const budget = computeTagBudget(context.fullText, existingCount);
    tags = tags.slice(0, budget);
  }

  // Phase 7: bilingual expansion — split "A/B" tags into "A" and "B"
  // so both the Chinese and English forms exist independently in the DB.
  // TagOverlap is an exact Set.has() match, so having both forms means
  // both a Chinese query ("容量守卫") and an English query ("capacity-guard")
  // will score on this memo's tags.
  const expanded: string[] = [];
  for (const tag of tags) {
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
  tags = normalizeTags(expanded, TAG_CONFIG.MAX_TAGS_ABSOLUTE);

  return tags;
}

/**
 * Recommend tags by finding semantically similar memos via embedding
 * and collecting their most common tags. Falls back to generateTags
 * when the embedding engine is unavailable.
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
    return generateTags(text, max);
  }

  const vecs = await engine.embedBatch([text]);
  if (!vecs || vecs.length === 0) return generateTags(text, max);
  const queryVec = vecs[0]!;

  // This is a placeholder for the embedding-based tag recommendation.
  // Phase 1+ can implement the full centroid-comparison algorithm:
  // 1. Read all memos with tags from the store
  // 2. For each distinct tag, find memos with that tag
  // 3. Compute centroid embedding per tag (average of memo embeddings)
  // 4. Compare queryVec against each centroid via cosine similarity
  // 5. Return top-3 matching tags
  //
  // For now, fall back to keyword-based generation to keep the change
  // self-contained without adding a store.read() dependency here.
  return generateTags(text, max);
}

// ── Phase 2: TAG_CONFIG ────────────────────────────────────────────

export const TAG_CONFIG = {
  // Synonym merging (Phase 3)
  SYNONYM_JACCARD_THRESHOLD: 0.6,

  // Blacklist (Phase 3)
  BLACKLIST: new Set([
    '问题', '解决', '完成', 'none',
    'bug', 'fix', '修复', '修复了', '处理',
  ]),

  // Dynamic budget (Phase 2)
  MAX_TAGS_DEFAULT: 5,
  MIN_TAGS: 2,
  MAX_TAGS_ABSOLUTE: 8,
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

/**
 * Compute a dynamic tag budget based on text richness and existing
 * distinct tag count. Prevents both over-tagging and under-tagging.
 */
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
