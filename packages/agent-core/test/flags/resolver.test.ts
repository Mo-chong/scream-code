import { describe, expect, it } from 'vitest';

import {
  FLAG_DEFINITIONS,
  MASTER_ENV,
  FlagResolver,
  type FlagDefinitionInput,
  type FlagId,
} from '../../src/flags';
import { parseNumberEnv } from '../../src/config/resolve';

// Controlled fake definitions to assert the precedence matrix precisely (independent of the
// real registry contents).
const DEFS = [
  {
    id: 'a-on-default',
    env: 'SCREAM_CODE_EXPERIMENTAL_A',
    default: true,
    surface: 'core',
  },
  {
    id: 'b-off-default',
    env: 'SCREAM_CODE_EXPERIMENTAL_B',
    default: false,
    surface: 'tui',
  },
] as const satisfies readonly FlagDefinitionInput[];

type Env = Record<string, string | undefined>;

function make(env: Env) {
  const resolver = new FlagResolver(env, DEFS);
  // The fake ids are not part of the real FlagId union, so cast to FlagId when calling.
  return (id: string) => resolver.enabled(id as FlagId);
}

describe('FlagResolver', () => {
  it('L3 default: returns the registry default when env is empty', () => {
    const enabled = make({});
    expect(enabled('a-on-default')).toBe(true);
    expect(enabled('b-off-default')).toBe(false);
  });

  it('L2 per-feature on (lenient truthy values)', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      expect(make({ SCREAM_CODE_EXPERIMENTAL_B: v })('b-off-default')).toBe(true);
    }
  });

  it('L2 per-feature off (lenient falsy values) overrides default=true', () => {
    for (const v of ['0', 'false', 'no', 'off']) {
      expect(make({ SCREAM_CODE_EXPERIMENTAL_A: v })('a-on-default')).toBe(false);
    }
  });

  it('L2 unparseable value falls back to default', () => {
    expect(make({ SCREAM_CODE_EXPERIMENTAL_B: 'maybe' })('b-off-default')).toBe(false);
    expect(make({ SCREAM_CODE_EXPERIMENTAL_A: 'maybe' })('a-on-default')).toBe(true);
  });

  it('L1 master switch: every flag is on when enabled (including default=false)', () => {
    const enabled = make({ [MASTER_ENV]: '1' });
    expect(enabled('a-on-default')).toBe(true);
    expect(enabled('b-off-default')).toBe(true);
  });

  it('L1 master switch beats an L2 per-feature off (D2)', () => {
    const enabled = make({ [MASTER_ENV]: '1', SCREAM_CODE_EXPERIMENTAL_A: '0' });
    expect(enabled('a-on-default')).toBe(true);
  });

  it('master switch is inactive for lenient falsy values', () => {
    const enabled = make({ [MASTER_ENV]: '0' });
    expect(enabled('b-off-default')).toBe(false);
  });

  it('reads the env name declared in the registry (the declared name works, others do not)', () => {
    expect(make({ SCREAM_CODE_EXPERIMENTAL_B: '1' })('b-off-default')).toBe(true);
    // The name mechanically derived from the id must not take effect (env is explicitly ..._B).
    expect(make({ SCREAM_CODE_EXPERIMENTAL_B_OFF_DEFAULT: '1' })('b-off-default')).toBe(false);
  });

  it('unknown id resolves to false (defensive)', () => {
    expect(make({})('not-a-real-flag')).toBe(false);
  });
});

describe('asNumber', () => {
  it('returns the registry numDefault when env is empty', () => {
    const r = new FlagResolver({}, [
      { id: 'num-flag', env: 'SCREAM_CODE_NUM_TEST', default: true, numDefault: 42, surface: 'internal' },
    ]);
    expect(r.asNumber('num-flag' as FlagId)).toBe(42);
  });

  it('returns 0 when no numDefault and no env value', () => {
    const r = new FlagResolver({}, [
      { id: 'no-num', env: 'SCREAM_CODE_NO_NUM', default: true, surface: 'internal' },
    ]);
    expect(r.asNumber('no-num' as FlagId)).toBe(0);
  });

  it('returns 0 for an unknown id', () => {
    const r = new FlagResolver({}, []);
    expect(r.asNumber('not-a-flag' as FlagId)).toBe(0);
  });

  it('env variable overrides the registry numDefault', () => {
    const r = new FlagResolver({ SCREAM_CODE_NUM_OVERRIDE: '16' }, [
      { id: 'override-flag', env: 'SCREAM_CODE_NUM_OVERRIDE', default: true, numDefault: 8, surface: 'internal' },
    ]);
    expect(r.asNumber('override-flag' as FlagId)).toBe(16);
  });

  it('env variable with unparseable value falls back to numDefault', () => {
    const r = new FlagResolver({ SCREAM_CODE_NUM_BAD: 'not-a-number' }, [
      { id: 'bad-env', env: 'SCREAM_CODE_NUM_BAD', default: true, numDefault: 8, surface: 'internal' },
    ]);
    expect(r.asNumber('bad-env' as FlagId)).toBe(8);
  });

  it('returns 0 when numDefault is explicitly 0 and env is unset', () => {
    const r = new FlagResolver({}, [
      { id: 'zero-flag', env: 'SCREAM_CODE_ZERO_FLAG', default: true, numDefault: 0, surface: 'internal' },
    ]);
    expect(r.asNumber('zero-flag' as FlagId)).toBe(0);
  });

  it('env=0 overrides numDefault=8 and returns 0', () => {
    const r = new FlagResolver({ SCREAM_CODE_ENV_ZERO: '0' }, [
      { id: 'env-zero', env: 'SCREAM_CODE_ENV_ZERO', default: true, numDefault: 8, surface: 'internal' },
    ]);
    expect(r.asNumber('env-zero' as FlagId)).toBe(0);
  });

  it('env=16 overrides numDefault=8', () => {
    const r = new FlagResolver({ SCREAM_CODE_ENV_SIXTEEN: '16' }, [
      { id: 'env-sixteen', env: 'SCREAM_CODE_ENV_SIXTEEN', default: true, numDefault: 8, surface: 'internal' },
    ]);
    expect(r.asNumber('env-sixteen' as FlagId)).toBe(16);
  });

  it('env="" empty string falls back to numDefault', () => {
    const r = new FlagResolver({ SCREAM_CODE_EMPTY: '' }, [
      { id: 'empty-env', env: 'SCREAM_CODE_EMPTY', default: true, numDefault: 8, surface: 'internal' },
    ]);
    expect(r.asNumber('empty-env' as FlagId)).toBe(8);
  });

  it('env="  " whitespace-only falls back to numDefault', () => {
    const r = new FlagResolver({ SCREAM_CODE_WS: '  ' }, [
      { id: 'ws-env', env: 'SCREAM_CODE_WS', default: true, numDefault: 8, surface: 'internal' },
    ]);
    expect(r.asNumber('ws-env' as FlagId)).toBe(8);
  });

  it('env=99 overrides numDefault=42', () => {
    const r = new FlagResolver({ SCREAM_CODE_NUM_99: '99' }, [
      { id: 'num99', env: 'SCREAM_CODE_NUM_99', default: true, numDefault: 42, surface: 'internal' },
    ]);
    expect(r.asNumber('num99' as FlagId)).toBe(99);
  });
});

describe('FLAG_DEFINITIONS invariants', () => {
  it('every env satisfies: prefix / unique / not the master switch', () => {
    const seenEnv = new Set<string>();
    const seenId = new Set<string>();
    const defs: readonly FlagDefinitionInput[] = FLAG_DEFINITIONS;
    for (const def of defs) {
      // internal flags use their own env prefix (e.g. SCREAM_CODE_MICRO_BATCH_SIZE).
      if (def.surface === 'internal') continue;
      expect(def.env.startsWith('SCREAM_CODE_EXPERIMENTAL_')).toBe(true);
      expect(def.env).not.toBe(MASTER_ENV);
      expect(def.id).not.toBe('flag'); // reserved: would collide with the master switch
      expect(seenEnv.has(def.env)).toBe(false);
      expect(seenId.has(def.id)).toBe(false);
      seenEnv.add(def.env);
      seenId.add(def.id);
    }
  });

  it('registered flags with numDefault must use internal surface', () => {
    const defs: readonly FlagDefinitionInput[] = FLAG_DEFINITIONS;
    for (const def of defs) {
      if (def.numDefault !== undefined) {
        expect(def.surface).toBe('internal');
      }
    }
  });
});

describe('parseNumberEnv', () => {
  it('returns undefined for undefined input', () => {
    expect(parseNumberEnv(undefined)).toBeUndefined();
  });
  it('returns undefined for empty string', () => {
    expect(parseNumberEnv('')).toBeUndefined();
  });
  it('returns undefined for whitespace-only string', () => {
    expect(parseNumberEnv('  ')).toBeUndefined();
  });
  it('returns 0 for "0"', () => {
    expect(parseNumberEnv('0')).toBe(0);
  });
  it('returns 42 for "42"', () => {
    expect(parseNumberEnv('42')).toBe(42);
  });
  it('trims and parses " 99 "', () => {
    expect(parseNumberEnv(' 99 ')).toBe(99);
  });
  it('returns undefined for non-numeric "abc"', () => {
    expect(parseNumberEnv('abc')).toBeUndefined();
  });
});
