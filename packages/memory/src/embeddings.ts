import { existsSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import type { MemoryMemo } from './models.js';

/**
 * Text used to generate embeddings for a memo.
 * Combines the most semantically meaningful fields.
 */
export function buildEmbeddingText(memo: MemoryMemo): string {
  return `${memo.userNeed} ${memo.approach} ${memo.whatWorked}`;
}

export interface EmbeddingEngine {
  /** Whether the engine loaded successfully. */
  readonly available: boolean;

  /**
   * Generate embeddings for a batch of texts.
   * Returns null if the engine failed to load or the model is unavailable.
   */
  embedBatch(texts: string[]): Promise<Float32Array[] | null>;

  /**
   * Compute cosine similarity between two vectors.
   */
  cosineSimilarity(a: Float32Array, b: Float32Array): number;

  /**
   * Proactively trigger model loading (downloads the model on first call).
   * Returns true if the engine is ready for embedding, false on failure.
   * Safe to call multiple times; failed loads can be retried.
   */
  ensureReady(): Promise<boolean>;
}

/** Minimal interface for the fastembed model — avoids importing fastembed at module level. */
interface FastembedModel {
  embed(
    textStrings: string[],
    batchSize?: number,
  ): AsyncGenerator<number[][], void, unknown>;
}

/**
 * Create an embedding engine backed by fastembed.
 * Pre-warms the model eagerly so first call is fast.
 * loadFailed is retryable — next embedBatch attempt re-loads.
 */
export function createFastEmbedEngine(): EmbeddingEngine {
  let embedder: FastembedModel | null = null;
  let initPromise: Promise<FastembedModel | null> | null = null;

  // Pre-warm: eagerly load the model on construction.
  // The Agent caller (agent/index.ts) creates the engine during startup,
  // so the model download/load happens in background before user interacts.
  initPromise = loadEmbedder().then(m => { embedder = m; return m; });

  return {
    get available(): boolean {
      return embedder !== null || initPromise !== null;
    },

    async embedBatch(texts: string[]): Promise<Float32Array[] | null> {
      if (texts.length === 0) return [];

      try {
        // Reuse existing initPromise; never start a second concurrent download.
        // Parallel loadEmbedder() calls corrupt the shared HF Hub cache.
        if (embedder === null) {
          if (initPromise === null) {
            initPromise = loadEmbedder();
          }
          embedder = await initPromise;
          initPromise = null; // consumed — next failure triggers fresh attempt
          if (embedder === null) {
            return null;
          }
        }

        const generator = embedder.embed(texts);

        const vectors: Float32Array[] = [];
        for await (const batch of generator) {
          for (const vec of batch) {
            vectors.push(new Float32Array(vec));
          }
        }
        return vectors.length > 0 ? vectors : null;
      } catch (e) {
        // loadFailed is retryable: clear initPromise so next call retries.
        // Surface the real error for diagnosis instead of silent null.
        process.stderr.write(`[embedBatch] error: ${e instanceof Error ? e.stack || e.message : String(e)}\n`);
        embedder = null;
        initPromise = null;
        return null;
      }
    },

    cosineSimilarity(a: Float32Array, b: Float32Array): number {
      if (a.length !== b.length || a.length === 0) return 0;
      let dot = 0;
      let normA = 0;
      let normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i]! * b[i]!;
        normA += a[i]! * a[i]!;
        normB += b[i]! * b[i]!;
      }
      const denom = Math.sqrt(normA) * Math.sqrt(normB);
      return denom === 0 ? 0 : dot / denom;
    },

    async ensureReady(): Promise<boolean> {
      if (embedder !== null) return true;
      try {
        initPromise ??= loadEmbedder();
        embedder = await initPromise;
        if (embedder === null) {
          initPromise = null;
          return false;
        }
        loadFailed = false;
        return true;
      } catch {
        initPromise = null;
        return false;
      }
    },
  };
}

import { createRequire } from 'node:module';

/** Timeout for FlagEmbedding.init() model download. 5min for cold cache on slow connections. */
const EMBED_INIT_TIMEOUT_MS = 300_000;

/**
 * Resolve the package root directory from import.meta.url.
 * packages/memory/dist/ → D:\AI\ScreamCode\ (monorepo root)
 */
function getScreamCodeRoot(): string {
  const pkgDir = path.dirname(fileURLToPath(import.meta.url));
  // packages/memory/dist/ => up 3 levels to monorepo root
  return path.resolve(pkgDir, '..', '..', '..');
}

/**
 * Absolute path to the project-local model cache directory.
 * e.g. D:\AI\ScreamCode\local_cache\
 */
function getLocalCacheDir(): string {
  return path.join(getScreamCodeRoot(), 'local_cache');
}

async function initWithTimeout<T>(
  factory: () => Promise<T>,
  label: string,
  ms: number = EMBED_INIT_TIMEOUT_MS,
): Promise<T> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
  );
  return await Promise.race([factory(), timer]);
}

/**
 * Clean all known model cache locations for BGESmallZH.
 * Called when TAR_BAD_ARCHIVE or zlib error indicates a corrupt partial download.
 * Cleans both the project-local cache and the global HF Hub / fastembed fallback caches.
 */
function cleanFastembedCache(): void {
  // 1. Project-local cache (where we point cacheDir to)
  const localDir = getLocalCacheDir();
  const localModelDir = path.join(localDir, 'fast-bge-small-zh-v1.5');
  try {
    if (existsSync(localModelDir)) {
      rmSync(localModelDir, { recursive: true, force: true });
      process.stderr.write(`[loadEmbedder] removed corrupt model cache: ${localModelDir}\n`);
    }
  } catch { /* best-effort */ }

  // 2. HuggingFace Hub cache
  const hfHubDefault = path.join(os.homedir(), '.cache', 'huggingface', 'hub');
  const hfHub = process.env['HF_HOME']
    ? path.join(process.env['HF_HOME'], 'hub')
    : hfHubDefault;
  const hfModelDir = path.join(hfHub, 'models--Xenova--bge-small-zh-v1.5');
  try {
    if (existsSync(hfModelDir)) {
      rmSync(hfModelDir, { recursive: true, force: true });
      process.stderr.write(`[loadEmbedder] removed corrupt model cache: ${hfModelDir}\n`);
    }
  } catch { /* best-effort */ }

  // 3. Fastembed fallback cache (~/.cache/fastembed/)
  const feDefault = path.join(os.homedir(), '.cache', 'fastembed');
  const feModelDir = path.join(feDefault, 'models--Xenova--bge-small-zh-v1.5');
  try {
    if (existsSync(feModelDir)) {
      rmSync(feModelDir, { recursive: true, force: true });
      process.stderr.write(`[loadEmbedder] removed corrupt model cache: ${feModelDir}\n`);
    }
  } catch { /* best-effort */ }
}

async function loadEmbedder(): Promise<FastembedModel | null> {
  // ═══ 根因修复：传绝对路径 cacheDir 给 fastembed ═══
  // fastembed v1.x 默认 'local_cache' 是相对路径基于 CWD 解析。
  // CWD != monorepo 根时路径错位 → tokenizer.json not found。
  const cacheDir = getLocalCacheDir();

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
      const model = await initWithTimeout(
        () => FlagEmbedding.init({
          model: EmbeddingModel.BGESmallZH,
          cacheDir,
        }),
        'FlagEmbedding.init(BGESmallZH)',
      );
      return model;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[loadEmbedder] attempt ${attempt}/${maxRetries} failed: ${errMsg}\n`);

      // Corrupt cache from partial download — clean and retry.
      const isCorruptCache = errMsg.includes('TAR_BAD_ARCHIVE')
        || errMsg.includes('Unrecognized archive')
        || errMsg.includes('zlib:')
        || errMsg.includes('tokenizer.json');
      if (isCorruptCache) {
        cleanFastembedCache();
        continue; // retry after cache cleanup
      }

      // On last attempt, try the createRequire fallback before giving up.
      // Note: fastembed v1.x restricts exports; createRequire resolve typically fails
      // for the package.json path. This is a best-effort fallback.
      if (attempt >= maxRetries) {
        try {
          const distRequire = createRequire(import.meta.url);
          const fePath = distRequire.resolve('fastembed');
          const { FlagEmbedding, EmbeddingModel } = await import(fePath);
          return await initWithTimeout(
            () => FlagEmbedding.init({
              model: EmbeddingModel.BGESmallZH,
              cacheDir,
            }),
            'FlagEmbedding.init(fallback)',
          );
        } catch (fallbackErr) {
          process.stderr.write(`[loadEmbedder] fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}\n`);
          return null;
        }
      }
    }
  }
  return null;
}
