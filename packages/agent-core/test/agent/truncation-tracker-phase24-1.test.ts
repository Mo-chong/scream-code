import { expect, it } from 'vitest';
import { TruncationTracker } from '#/agent/turn/truncation-tracker';

it('register + hasUnrecovered + markRecovered works (Phase24 baseline)', () => {
  const t = new TruncationTracker({ maxStepAge: 10, maxConsecutiveBlocks: 3 });
  expect(t.hasUnrecovered()).toBe(false);
  t.register('tool:call-1', 'Read', 5);
  expect(t.hasUnrecovered()).toBe(true);
  expect(t.pendingKeys()).toEqual(['tool:call-1']);
  expect(t.markRecovered('tool:call-1')).toBe(true);
  expect(t.hasUnrecovered()).toBe(false);
});

it('incrementBlockAndCheck resets on success before threshold', () => {
  const t = new TruncationTracker({ maxConsecutiveBlocks: 3 });
  expect(t.consecutiveBlocks).toBe(0);
  expect(t.incrementBlockAndCheck()).toBe(false); // 1
  expect(t.consecutiveBlocks).toBe(1);
  expect(t.incrementBlockAndCheck()).toBe(false); // 2
  expect(t.consecutiveBlocks).toBe(2);
  // partial recover resets counter
  t.register('tool:x', 'Read', 1);
  t.markRecovered('tool:x');
  expect(t.consecutiveBlocks).toBe(0);
});

it('incrementBlockAndCheck triggers forceResume at maxConsecutiveBlocks', () => {
  const t = new TruncationTracker({ maxConsecutiveBlocks: 3 });
  t.register('tool:x', 'Read', 1); // needed for hasUnrecovered
  expect(t.incrementBlockAndCheck()).toBe(false); // 1
  expect(t.incrementBlockAndCheck()).toBe(false); // 2
  t.register('tool:y', 'Write', 2);
  t.register('tool:z', 'Edit', 3);
  const result = t.incrementBlockAndCheck(); // 3 → forceResume
  expect(result).toBe(true);
  // forceResume clears everything
  expect(t.hasUnrecovered()).toBe(false);
  expect(t.consecutiveBlocks).toBe(0);
});

it('dispose clears static current', () => {
  const t1 = new TruncationTracker();
  TruncationTracker.current = t1;
  expect(TruncationTracker.current).toBe(t1);
  t1.dispose();
  expect(TruncationTracker.current).toBeUndefined();
});

it('prune respects configurable maxStepAge', () => {
  const t = new TruncationTracker({ maxStepAge: 3 });
  t.register('tool:old', 'Read', 1);
  t.register('tool:new', 'Write', 9);
  t.prune(11); // cutoff = 11-3 = 8, entry at step 1 should be pruned, step 9 survives
  expect(t.pendingKeys()).toEqual(['tool:new']);
});

it('forceResume with reason clears pending and resets reminded', () => {
  const t = new TruncationTracker({ maxConsecutiveBlocks: 3 });
  t.register('tool:a', 'Read', 1);
  t.register('tool:b', 'Read', 2);
  t.markReminded();
  expect(t.remindedThisTurn).toBe(true);
  expect(t.hasUnrecovered()).toBe(true);
  t.forceResume('test-reason');
  expect(t.hasUnrecovered()).toBe(false);
  expect(t.remindedThisTurn).toBe(false);
  expect(t.consecutiveBlocks).toBe(0);
});

it('constructor with no config uses default values (Phase24 compat)', () => {
  const t = new TruncationTracker();
  t.register('tool:x', 'Read', 1);
  expect(t.hasUnrecovered()).toBe(true);
  // maxStepAge defaults to 20, so step 1 won't be pruned at step 10
  t.prune(10);
  expect(t.pendingKeys()).toEqual(['tool:x']);
  // maxConsecutiveBlocks defaults to 0 (disabled)
  expect(t.incrementBlockAndCheck()).toBe(false);
  expect(t.consecutiveBlocks).toBe(1);
});
