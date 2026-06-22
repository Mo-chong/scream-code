/**
 * Unit tests for repeatDecay + bypassBudget — pure function tests.
 *
 * Tests the Phase 6 additions without any agent or turn infrastructure.
 * Appended after budget.test.ts inline is possible but separate is cleaner.
 */

import { describe, expect, it } from 'vitest';
import { repeatDecay, type VariantRecord } from '../../src/agent/turn/variant-registry';
import { InjectBudget } from '../../src/agent/turn/injectors/budget';

describe('repeatDecay', () => {
  it('undefined record returns full', () => {
    expect(repeatDecay(undefined)).toBe('full');
  });

  it('first-time record (triggerCount=1) returns full', () => {
    expect(repeatDecay(makeRecord(1, null))).toBe('full');
  });

  it('triggerCount=4 with behaviorObserved returns full', () => {
    expect(repeatDecay(makeRecord(4, true))).toBe('full');
  });

  it('triggerCount=5 with behaviorObserved returns full', () => {
    // behaviorObserved overrides count
    expect(repeatDecay(makeRecord(10, true))).toBe('full');
  });

  it('triggerCount=5 with null behaviorObserved returns skip', () => {
    expect(repeatDecay(makeRecord(5, null))).toBe('skip');
  });

  it('triggerCount=10 with false behaviorObserved returns skip', () => {
    expect(repeatDecay(makeRecord(10, false))).toBe('skip');
  });

  it('triggerCount=4 with null behaviorObserved returns full (below threshold)', () => {
    expect(repeatDecay(makeRecord(4, null))).toBe('full');
  });
});

describe('bypassBudget', () => {
  it('bypassBudget makes canInject return true once', () => {
    const budget = new InjectBudget();
    budget.record(20000); // far over any limit
    expect(budget.canInject(100, 'D')).toBe(false); // blocked

    budget.bypassBudget();
    expect(budget.canInject(100, 'D')).toBe(true); // bypassed

    expect(budget.canInject(100, 'D')).toBe(false); // bypass consumed
  });

  it('bypassBudget does not persist state', () => {
    const budget = new InjectBudget();
    budget.record(9999);
    budget.bypassBudget();
    budget.canInject(100, 'D'); // consume bypass
    expect(budget.canInject(100, 'D')).toBe(false); // back to normal
  });
});

function makeRecord(triggerCount: number, behaviorObserved: boolean | null): VariantRecord {
  return {
    variant: 'test',
    level: 'B',
    stepInjected: 1,
    turnStep: 1,
    behaviorObserved,
    lastEscalatedAtStep: 0,
    triggerCount,
  };
}
