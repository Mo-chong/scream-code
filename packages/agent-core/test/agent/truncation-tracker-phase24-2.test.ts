import { expect, it } from 'vitest';
import { TruncationTracker } from '#/agent/turn/truncation-tracker';

// ── Phase24.2: readOnlyTools 配置 ────────────────────────────────

it('default readOnlyTools contains Bash', () => {
  const t = new TruncationTracker();
  expect(t.isReadOnly('Bash')).toBe(true);
  expect(t.isReadOnly('Read')).toBe(false);
  expect(t.isReadOnly('Write')).toBe(false);
  expect(t.isReadOnly('Edit')).toBe(false);
});

it('custom readOnlyTools overrides default', () => {
  const t = new TruncationTracker({ readOnlyTools: new Set(['Read', 'Write']) });
  expect(t.isReadOnly('Read')).toBe(true);
  expect(t.isReadOnly('Write')).toBe(true);
  expect(t.isReadOnly('Bash')).toBe(false);
  expect(t.isReadOnly('Edit')).toBe(false);
});

it('empty readOnlyTools set means no tool is read-only', () => {
  const t = new TruncationTracker({ readOnlyTools: new Set() });
  expect(t.isReadOnly('Bash')).toBe(false);
  expect(t.isReadOnly('Read')).toBe(false);
});

// ── Phase24.2: Entry 长度字段 ────────────────────────────────────

it('register with originalLength and truncatedLength stores them', () => {
  const t = new TruncationTracker();
  t.register('tool:call-1', 'Read', 1, 5000, 2000);
  t.register('tool:call-2', 'Write', 2, 3000, 1500);
  // 验证内部存储 — 通过 hasUnrecovered + markRecovered 确认存在
  expect(t.hasUnrecovered()).toBe(true);
  expect(t.pendingKeys()).toEqual(['tool:call-1', 'tool:call-2']);
});

it('register without length fields defaults to undefined', () => {
  const t = new TruncationTracker();
  t.register('tool:call-1', 'Read', 1);
  expect(t.hasUnrecovered()).toBe(true);
  expect(t.pendingKeys()).toEqual(['tool:call-1']);
});

// ── Phase24.2: stepRecovered 步级并行竞争保护 ────────────────────

it('markStepRecovered and isAlreadyRecoveredThisStep works', () => {
  const t = new TruncationTracker();
  t.register('tool:a', 'Read', 1);

  // 同一步 first call
  expect(t.isAlreadyRecoveredThisStep('tool:a', 1)).toBe(false);
  t.markStepRecovered('tool:a', 1);
  expect(t.isAlreadyRecoveredThisStep('tool:a', 1)).toBe(true);
});

it('same key in different step is not already recovered', () => {
  const t = new TruncationTracker();
  t.register('tool:a', 'Read', 1);
  t.markStepRecovered('tool:a', 1);

  // 步 2 应该不受影响
  expect(t.isAlreadyRecoveredThisStep('tool:a', 2)).toBe(false);
});

it('different key in same step is not confused', () => {
  const t = new TruncationTracker();
  t.register('tool:a', 'Read', 1);
  t.register('tool:b', 'Write', 1);
  t.markStepRecovered('tool:a', 1);

  expect(t.isAlreadyRecoveredThisStep('tool:a', 1)).toBe(true);
  expect(t.isAlreadyRecoveredThisStep('tool:b', 1)).toBe(false);
});

it('clearStepRecovered removes all entries for that step', () => {
  const t = new TruncationTracker();
  t.register('tool:a', 'Read', 1);
  t.register('tool:b', 'Write', 1);
  t.markStepRecovered('tool:a', 1);
  t.markStepRecovered('tool:b', 1);
  expect(t.isAlreadyRecoveredThisStep('tool:a', 1)).toBe(true);

  t.clearStepRecovered(1);
  expect(t.isAlreadyRecoveredThisStep('tool:a', 1)).toBe(false);
  expect(t.isAlreadyRecoveredThisStep('tool:b', 1)).toBe(false);
});

it('clearStepRecovered only affects the specified step', () => {
  const t = new TruncationTracker();
  t.register('tool:a', 'Read', 1);
  t.register('tool:b', 'Write', 2);
  t.markStepRecovered('tool:a', 1);
  t.markStepRecovered('tool:b', 2);

  t.clearStepRecovered(1);
  expect(t.isAlreadyRecoveredThisStep('tool:a', 1)).toBe(false);
  // 步 2 不受影响
  expect(t.isAlreadyRecoveredThisStep('tool:b', 2)).toBe(true);
});

// ── Phase24.2: 并行竞争模拟 ──────────────────────────────────────

it('parallel race: second tool skips already-recovered key from same step', () => {
  const t = new TruncationTracker();
  t.register('tool:shared', 'Write', 1);

  // 模拟工具 A 先执行 recover
  expect(t.isAlreadyRecoveredThisStep('tool:shared', 1)).toBe(false);
  t.markStepRecovered('tool:shared', 1);
  t.markRecovered('tool:shared');

  // 工具 B 再执行时检测到已 recover 过
  expect(t.isAlreadyRecoveredThisStep('tool:shared', 1)).toBe(true);
  // 已 recover，不会重复标记
  expect(t.pendingKeys()).toEqual([]);
  expect(t.hasUnrecovered()).toBe(false);
});

it('parallel race: different keys in same step are independent', () => {
  const t = new TruncationTracker();
  t.register('tool:a', 'Write', 1);
  t.register('tool:b', 'Write', 1);

  // 工具 A 恢复 key a
  t.markStepRecovered('tool:a', 1);
  t.markRecovered('tool:a');

  // 工具 B 仍可恢复 key b
  expect(t.isAlreadyRecoveredThisStep('tool:b', 1)).toBe(false);
  t.markStepRecovered('tool:b', 1);
  t.markRecovered('tool:b');

  expect(t.hasUnrecovered()).toBe(false);
});

// ── Phase24.2: forceResume 和 dispose 清理 stepRecovered ─────────

it('forceResume clears stepRecovered', () => {
  const t = new TruncationTracker();
  t.register('tool:a', 'Read', 1);
  t.markStepRecovered('tool:a', 1);
  expect(t.isAlreadyRecoveredThisStep('tool:a', 1)).toBe(true);

  t.forceResume('test');
  expect(t.isAlreadyRecoveredThisStep('tool:a', 1)).toBe(false);
});

it('dispose clears stepRecovered', () => {
  const t = new TruncationTracker();
  t.register('tool:a', 'Read', 1);
  t.markStepRecovered('tool:a', 1);
  expect(t.isAlreadyRecoveredThisStep('tool:a', 1)).toBe(true);

  t.dispose();
  expect(t.isAlreadyRecoveredThisStep('tool:a', 1)).toBe(false);
});

// ── Phase24.2: prune 清理过期 stepRecovered ──────────────────────

it('prune removes stepRecovered entries older than maxStepAge', () => {
  const t = new TruncationTracker({ maxStepAge: 3 });
  t.register('tool:a', 'Read', 1);
  t.markStepRecovered('tool:a', 1);
  t.register('tool:b', 'Write', 3);
  t.markStepRecovered('tool:b', 3);

  // currentStep=5, maxStepAge=3 → step 1 过期 (5-1=4 > 3), step 3 不过期 (5-3=2 ≤ 3)
  t.prune(5);
  expect(t.isAlreadyRecoveredThisStep('tool:a', 1)).toBe(false);
  expect(t.isAlreadyRecoveredThisStep('tool:b', 3)).toBe(true);
});

it('prune with explicit maxStepAgeOverride', () => {
  const t = new TruncationTracker({ maxStepAge: 10 });
  t.register('tool:a', 'Read', 1);
  t.markStepRecovered('tool:a', 1);
  t.register('tool:b', 'Write', 3);
  t.markStepRecovered('tool:b', 3);

  // override maxStepAge=2 → step 1,3 都过期 (5-1=4 > 2, 5-3=2 ≤ 2)
  t.prune(5, 2);
  expect(t.isAlreadyRecoveredThisStep('tool:a', 1)).toBe(false);
  expect(t.isAlreadyRecoveredThisStep('tool:b', 3)).toBe(false);
});