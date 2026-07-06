import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
 * Cache of created engines keyed by cacheDir.
 * Guarantees that all callers sharing the same cacheDir reuse the same engine
 * instance and the same in-flight model download/load — avoiding duplicate
 * downloads and file-corruption races when /memory and /knowledge both start
 * before the model is cached.
 */
const engineCache = new Map<string, EmbeddingEngine>();

/**
 * Create an embedding engine backed by fastembed.
 * Lazily loads the model on first use so startup is not blocked.
 * Engines are cached by cacheDir so repeated calls with the same cacheDir
 * return the same instance, sharing model state and download progress.
 * Pre-warms eagerly when created during agent startup so model download
 * happens in background before user interacts.
 * @param cacheDir Absolute path for model cache (e.g. ~/.scream-code/cache/fastembed).
 *                 Defaults to "local_cache" (CWD-relative) if not provided — prefer
 *                 passing an explicit path so the cache doesn't duplicate across CWDs.
 */
export function createFastEmbedEngine(cacheDir?: string): EmbeddingEngine {
  const key = cacheDir ?? '';
  const cached = engineCache.get(key);
  if (cached !== undefined) return cached;
  const engine = createFastEmbedEngineImpl(cacheDir);
  engineCache.set(key, engine);
  return engine;
}

function createFastEmbedEngineImpl(cacheDir?: string): EmbeddingEngine {
  let embedder: FastembedModel | null = null;
  let initPromise: Promise<FastembedModel | null> | null = null;

  // Pre-warm: eagerly load the model on construction.
  // The Agent caller (agent/index.ts) creates the engine during startup,
  // so the model download/load happens in background before user interacts.
  initPromise = loadEmbedder(cacheDir).then(m => { embedder = m; return m; });

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
          initPromise ??= loadEmbedder(cacheDir);
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
      if (embedder !== null) {
        loadFailed = false;
        return true;
      }
      try {
        // Reuse in-flight load, or start a fresh one. If a previous load
        // resolved to null (loadFailed), clear it first so we actually retry.
        if (loadFailed || initPromise === null) {
          initPromise = loadEmbedder(cacheDir);
        }
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

async function loadEmbedder(cacheDir?: string): Promise<FastembedModel | null> {
  // Fallback to absolute path when no cacheDir provided (local enhancement)
  const effectiveCacheDir = cacheDir ?? getLocalCacheDir();

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
      if (effectiveCacheDir !== undefined) {
        mkdirSync(effectiveCacheDir, { recursive: true });
      }
      const model = EmbeddingModel.BGESmallZH;
      const initOpts = effectiveCacheDir !== undefined
        ? { model, cacheDir: effectiveCacheDir }
        : { model };

      try {
        return await initWithTimeout(
          () => FlagEmbedding.init(initOpts as Parameters<typeof FlagEmbedding.init>[0]),
          'FlagEmbedding.init(BGESmallZH)',
        );
      } catch (initError: unknown) {
        const errMsg = initError instanceof Error ? initError.message : String(initError);
        process.stderr.write(`[loadEmbedder] attempt ${attempt}/${maxRetries} failed: ${errMsg}\n`);

        // Corrupt cache from partial download — clean and retry
        const isCorruptCache = errMsg.includes('TAR_BAD_ARCHIVE')
          || errMsg.includes('Unrecognized archive')
          || errMsg.includes('zlib:')
          || errMsg.includes('tokenizer.json');
        if (isCorruptCache) {
          cleanFastembedCache();
          continue;
        }

        // Missing sidecars — download from HF mirror and retry
        if (/Config file not found|Tokenizer file not found|Tokens map file not found/ui.test(errMsg)) {
          try {
            await ensureFastembedModelSidecars(String(model), effectiveCacheDir);
            return await initWithTimeout(
              () => FlagEmbedding.init(initOpts as Parameters<typeof FlagEmbedding.init>[0]),
              'FlagEmbedding.init(BGESmallZH, after sidecar)',
            );
          } catch {
            // fall through to retry/fallback
          }
        }

        // On last attempt, try createRequire fallback
        if (attempt >= maxRetries) {
          try {
            const distRequire = createRequire(import.meta.url);
            const fePath = distRequire.resolve('fastembed');
            const { FlagEmbedding, EmbeddingModel } = await import(fePath);
            return await initWithTimeout(
              () => FlagEmbedding.init({
                model: EmbeddingModel.BGESmallZH,
                cacheDir: effectiveCacheDir,
              }),
              'FlagEmbedding.init(fallback)',
            );
          } catch (fallbackErr) {
            process.stderr.write(`[loadEmbedder] fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}\n`);
            return null;
          }
        }
      }
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Small config/tokenizer files that fastembed expects alongside model.onnx.
 * If these are missing (e.g. GCS download partially failed), fastembed throws.
 * We download them from HuggingFace so the model can load — this covers the
 * case where the GCS tarball was incomplete but the HF repo is reachable.
 */
const FASTEMBED_SIDECARS = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
] as const;

const FASTEMBED_HF_REPOS: Record<string, string> = {
  'fast-bge-small-zh-v1.5': 'BAAI/bge-small-zh-v1.5',
};

async function ensureFastembedModelSidecars(model: string, cacheDir?: string): Promise<void> {
  const repo = FASTEMBED_HF_REPOS[model];
  if (repo === undefined) return;
  const baseDir = cacheDir ?? 'local_cache';
  const modelDir = join(baseDir, model);
  mkdirSync(modelDir, { recursive: true });

  for (const fileName of FASTEMBED_SIDECARS) {
    const target = join(modelDir, fileName);
    try {
      const { access } = await import('node:fs/promises');
      await access(target);
      continue; // file exists
    } catch {
      // file missing — download from HuggingFace
    }
    const hfUrl = `https://huggingface.co/${repo}/resolve/main/${fileName}`;
    try {
      const response = await fetch(hfUrl);
      if (!response.ok) continue;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(target, Buffer.from(await response.arrayBuffer()));
    } catch {
      // best-effort — if HF is also unreachable, just skip
    }
  }
}
