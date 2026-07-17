/**
 * MaskingStats — maskToolObservations 每轮执行的可观测统计。
 *
 * 独立文件，零额外依赖。避免 TUI footer import 时拉入整个 loop/ 子系统。
 */

export interface MaskingStats {
  total: number;
  preservedError: number;
  resolvedError: number;
  preservedStructured: number;
  compressed: number;
  snipped: number;
  fullyMasked: number;
  bytesSaved: number;
  codegraphStripped: number;
}

export const emptyMaskingStats = (): MaskingStats => ({
  total: 0,
  preservedError: 0,
  resolvedError: 0,
  preservedStructured: 0,
  compressed: 0,
  snipped: 0,
  fullyMasked: 0,
  bytesSaved: 0,
  codegraphStripped: 0,
});

/**
 * Per-turn masking stats accumulator.
 * Consumer: turn/index.ts (reset + pass to audit log), footer.ts (read-only display).
 * Mutation: turn-step.ts every step overwrites (snapshot, not cumulative).
 */
export const maskingStats: { perTurn: MaskingStats } = {
  perTurn: emptyMaskingStats(),
};
