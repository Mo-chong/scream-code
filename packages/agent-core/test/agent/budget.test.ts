/**
 * Unit tests for InjectBudget — pure function tests.
 *
 * Tests the budget management algorithm without any agent or turn infrastructure.
 * Follows the same pattern as intent.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { InjectBudget } from '../../src/agent/turn/injectors/budget';
import type { WeightLevel } from '../../src/agent/turn/variant-registry';

describe('InjectBudget', () => {
  // ── Identity path: no injection → budget 0 ──
  it('fresh instance has zero usage', () => {
    const budget = new InjectBudget();
    expect(budget.turnUsage).toBe(0);
    expect(budget.stepUsage).toBe(0);
  });

  // ── Basic perTurn limits ──
  it('canInject returns true when under perTurn limit', () => {
    const budget = new InjectBudget();
    budget.beginStep(1); // stepNorm=1.50
    expect(budget.canInject(100, 'normal')).toBe(true);
  });

  it('canInject returns false when over perTurn limit (normal)', () => {
    const budget = new InjectBudget();
    budget.beginStep(1); // stepNorm=1.50, perStep cap = 225
    budget.record(490);  // normal perTurn = 500
    expect(budget.canInject(20, 'normal')).toBe(false);
  });

  it('canInject returns false when over perStep limit', () => {
    const budget = new InjectBudget();
    budget.beginStep(1);
    budget.record(220);
    expect(budget.canInject(20, 'normal')).toBe(false);
  });

  // ── Weight level differentiation ──
  it('critical level can inject more than debug level', () => {
    const budget = new InjectBudget();
    budget.beginStep(1);
    expect(budget.canInject(250, 'critical')).toBe(true);
    expect(budget.canInject(250, 'debug')).toBe(false);
  });

  it('higher step number tightens perStep cap', () => {
    const budget = new InjectBudget();
    budget.beginStep(1);
    budget.record(200);
    expect(budget.canInject(50, 'normal')).toBe(false);

    budget.beginStep(10);
    budget.record(150);
    expect(budget.canInject(20, 'normal')).toBe(false);
  });

  it('step 1 has higher perStep cap than step 5', () => {
    const budget = new InjectBudget();
    budget.beginStep(1);
    expect(budget.canInject(200, 'normal')).toBe(true);
    expect(budget.canInject(250, 'normal')).toBe(false);

    budget.beginStep(5);
    expect(budget.canInject(200, 'normal')).toBe(false);
  });

  // ── degradationFactor ──
  it('degradationFactor reduces normal perTurn cap at variantCount=6', () => {
    const budget = new InjectBudget();
    budget.beginStep(1);
    budget.syncVariantCount(6);
    budget.record(90);
    expect(budget.canInject(110, 'normal')).toBe(false);
  });

  it('degradationFactor at variantCount=0 does not reduce caps', () => {
    const budget = new InjectBudget();
    budget.beginStep(1);
    budget.syncVariantCount(0);
    budget.record(200);
    expect(budget.canInject(50, 'normal')).toBe(false);
    expect(budget.canInject(20, 'normal')).toBe(true);
  });

  // ── beginStep resets step counter ──
  it('beginStep resets step tokens but not turn tokens', () => {
    const budget = new InjectBudget();
    budget.beginStep(1);
    budget.record(100);
    expect(budget.stepUsage).toBe(100);
    expect(budget.turnUsage).toBe(100);

    budget.beginStep(2);
    expect(budget.stepUsage).toBe(0);
    expect(budget.turnUsage).toBe(100);
  });

  // ── reset resets everything ──
  it('reset clears all counters', () => {
    const budget = new InjectBudget();
    budget.beginStep(1);
    budget.record(150);
    budget.syncVariantCount(3);
    expect(budget.turnUsage).toBeGreaterThan(0);
    expect(budget.stepUsage).toBeGreaterThan(0);

    budget.reset();
    expect(budget.turnUsage).toBe(0);
    expect(budget.stepUsage).toBe(0);
  });

  // ── Custom config ──
  it('accepts custom perTurn config overrides', () => {
    const budget = new InjectBudget({
      perTurnMax: { critical: 100, normal: 60, debug: 20 },
    });
    budget.beginStep(1);
    expect(budget.canInject(50, 'normal')).toBe(true);
    expect(budget.canInject(70, 'normal')).toBe(false);
    expect(budget.canInject(90, 'critical')).toBe(true);
    expect(budget.canInject(150, 'critical')).toBe(false);
  });
});
