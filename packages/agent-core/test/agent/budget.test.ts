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
    expect(budget.canInject(100, 'B')).toBe(true);
  });

  it('canInject returns false when over perTurn limit (B)', () => {
    const budget = new InjectBudget();
    budget.beginStep(1); // stepNorm=1.50, perStep cap = 225
    budget.record(490);  // B perTurn = 500
    // perTurn cap = 500 × degradation(0) = 500
    // turnTokens=490, adding 20 = 510 > 500
    expect(budget.canInject(20, 'B')).toBe(false);
  });

  it('canInject returns false when over perStep limit', () => {
    const budget = new InjectBudget();
    budget.beginStep(1);
    // stepNorm=1.50, degradation=1.0
    // B perStep cap = floor(150 × 1.50 × 1.0) = 225
    budget.record(220);
    // 220 + 20 = 240 > 225
    expect(budget.canInject(20, 'B')).toBe(false);
  });

  // ── Weight level differentiation ──
  it('S level can inject more than D level', () => {
    const budget = new InjectBudget();
    budget.beginStep(1);
    // S: perTurn=800, perStep = floor(250×1.5) = 375
    // D: perTurn=200, perStep = floor(80×1.5) = 120
    expect(budget.canInject(250, 'S')).toBe(true);  // 250 < 800 && 250 < 375
    expect(budget.canInject(250, 'D')).toBe(false); // 250 > 200 perTurn
  });

  it('higher step number tightens perStep cap', () => {
    const budget = new InjectBudget();
    budget.beginStep(1);
    // B perStep effective = floor(150 × 1.50 × 1.0) = 225
    budget.record(200);
    expect(budget.canInject(50, 'B')).toBe(false); // 250 > 225

    // step 10: perStep effective = floor(150 × 1.09 × 1.0) = 163
    budget.beginStep(10);
    budget.record(150);
    expect(budget.canInject(20, 'B')).toBe(false); // 170 > 163
  });

  it('step 1 has higher perStep cap than step 5', () => {
    const budget = new InjectBudget();
    // step 1: factor=1.50, cap=225
    budget.beginStep(1);
    expect(budget.canInject(200, 'B')).toBe(true);  // 200 < 225
    expect(budget.canInject(250, 'B')).toBe(false);

    // step 5: factor=1.17, cap=175
    budget.beginStep(5);
    expect(budget.canInject(200, 'B')).toBe(false); // 200 > 175
  });

  // ── degradationFactor ──
  it('degradationFactor reduces B perTurn cap at variantCount=6', () => {
    const budget = new InjectBudget();
    budget.beginStep(1);
    budget.syncVariantCount(6);
    // B perTurn effective = floor(500 × 0.4) = 200
    // B perStep effective = floor(150 × 1.50 × 0.4) = 90
    budget.record(90);  // perStep now at 90
    expect(budget.canInject(110, 'B')).toBe(false); // perTurn 200 > 90+110=200? 200! fail
  });

  it('degradationFactor at variantCount=0 does not reduce caps', () => {
    const budget = new InjectBudget();
    budget.beginStep(1);
    budget.syncVariantCount(0);
    // B perTurn = 500, B perStep = floor(150 × 1.5) = 225
    // perTurn already checked above; test perStep
    budget.record(200);
    expect(budget.canInject(50, 'B')).toBe(false); // 250 > 225
    expect(budget.canInject(20, 'B')).toBe(true);  // 220 <= 225
  });

  // ── beginStep resets step counter ──
  it('beginStep resets step tokens but not turn tokens', () => {
    const budget = new InjectBudget();
    budget.beginStep(1);
    budget.record(100);
    expect(budget.stepUsage).toBe(100);
    expect(budget.turnUsage).toBe(100);

    budget.beginStep(2);
    expect(budget.stepUsage).toBe(0);  // reset
    expect(budget.turnUsage).toBe(100); // preserved
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
      perTurnMax: { S: 100, A: 80, B: 60, C: 40, D: 20 },
    });
    budget.beginStep(1);
    // B perTurn = 60, B perStep = floor(150 × 1.5) = 225
    expect(budget.canInject(50, 'B')).toBe(true);  // 50 < 60 && 50 < 225
    expect(budget.canInject(70, 'B')).toBe(false); // 70 > 60
    // S perTurn = 100, S perStep = floor(250 × 1.5) = 375
    expect(budget.canInject(90, 'S')).toBe(true);  // 90 < 100 && 90 < 375
    expect(budget.canInject(150, 'S')).toBe(false); // 150 > 100
  });
});
