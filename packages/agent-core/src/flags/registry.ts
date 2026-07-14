import type { FlagDefinitionInput } from './types';

/**
 * Experimental feature flags. Empty by default — there are no experimental features yet.
 *
 * To add one, append an entry and gate the feature with `flags.enabled('my-feature')`:
 *   { id: 'my-feature', env: 'SCREAM_CODE_EXPERIMENTAL_MY_FEATURE', default: false, surface: 'both' }
 *
 * Keep the `as const satisfies` — it derives the literal `FlagId` union that gives `enabled()`
 * autocomplete and typo-checking. `env` must start with 'SCREAM_CODE_EXPERIMENTAL_', be unique, and
 * not equal the master switch 'SCREAM_CODE_EXPERIMENTAL_FLAG'; `id` must not be 'flag'.
 */
export const FLAG_DEFINITIONS = [
  /** @deprecated 废弃 v3 — 蒸馏塔归档层替代。0.1% token 换 6.5-44% 缓存断裂，ROI 负 */
  {
    id: 'micro-compaction',
    env: 'SCREAM_CODE_EXPERIMENTAL_MICRO_COMPACTION',
    default: false,
    surface: 'both',
  },
  {
    id: 'wolfpack',
    env: 'SCREAM_CODE_EXPERIMENTAL_WOLFPACK',
    default: false,
    surface: 'both',
  },
  {
    id: 'content-archive',
    env: 'SCREAM_CODE_EXPERIMENTAL_CONTENT_ARCHIVE',
    default: true,
    surface: 'both',
  },
  {
    id: 'file-action-audit',
    env: 'SCREAM_CODE_EXPERIMENTAL_FILE_ACTION_AUDIT',
    default: false,
    surface: 'both',
  },
  {
    id: 'micro.batchSize',
    env: 'SCREAM_CODE_MICRO_BATCH_SIZE',
    default: true,
    numDefault: 8,
    surface: 'internal',
  },
  {
    id: 'contentArchive.ttlMs',
    env: 'SCREAM_CODE_CONTENT_ARCHIVE_TTL_MS',
    default: true,
    numDefault: 14400000,
    surface: 'internal',
  },
  {
    id: 'mask.keepLastN',
    env: 'SCREAM_CODE_MASK_KEEP_LAST_N',
    default: true,
    numDefault: 3,
    surface: 'internal',
  },
] as const satisfies readonly FlagDefinitionInput[];

/** Literal union of registered flag ids: micro-compaction | wolfpack | content-archive | file-action-audit | micro.batchSize | contentArchive.ttlMs | mask.keepLastN */
export type FlagId = (typeof FLAG_DEFINITIONS)[number]['id'];
