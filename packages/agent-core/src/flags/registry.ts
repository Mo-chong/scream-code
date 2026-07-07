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
  {
    id: 'micro-compaction',
    env: 'SCREAM_CODE_EXPERIMENTAL_MICRO_COMPACTION',
    default: true,
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
] as const satisfies readonly FlagDefinitionInput[];

/** Literal union of registered flag ids: micro-compaction | wolfpack | content-archive | file-action-audit | micro.batchSize */
export type FlagId = (typeof FLAG_DEFINITIONS)[number]['id'];
