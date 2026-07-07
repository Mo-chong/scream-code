const TRUE_BOOLEAN_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_BOOLEAN_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);

export interface ResolveConfigValueInput<T> {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly envKey: string;
  readonly configValue?: T;
  readonly defaultValue: T;
  readonly parseEnv: (value: string | undefined) => T | undefined;
}

export function resolveConfigValue<T>(input: ResolveConfigValueInput<T>): T {
  return (
    input.parseEnv(input.env?.[input.envKey]) ??
    input.configValue ??
    input.defaultValue
  );
}

/**
 * Parse an env variable string as a boolean. Returns `true` for "1", "true", "yes";
 * `false` for "0", "false", "no"; `undefined` when unset, empty, or unrecognised
 * (safe fallback — no coercion to default). Used by `FlagResolver.asBoolean()`.
 */
export function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return undefined;
  if (TRUE_BOOLEAN_ENV_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_ENV_VALUES.has(normalized)) return false;
  return undefined;
}

/**
 * Parse a string env variable as a finite number. Returns `undefined` when
 * the value is missing, empty, or not a finite number (e.g. `"abc"` → `undefined`,
 * `"0"` → `0`, `""` → `undefined`). Used by `FlagResolver.asNumber()` for
 * `internal`-surface numeric flags.
 */
export function parseNumberEnv(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}
