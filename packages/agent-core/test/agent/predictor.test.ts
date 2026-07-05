import { describe, expect, it } from 'vitest';

import { GrowthPredictor } from '../../src/agent/compaction/predictor';

describe('GrowthPredictor', () => {
  it('predicts 0 growth with empty history', () => {
    const p = new GrowthPredictor();
    expect(p.predictNextGrowth()).toBe(0);
  });

  it('predicts 0 growth with only one data point', () => {
    const p = new GrowthPredictor();
    p.recordRound(100);
    expect(p.predictNextGrowth()).toBe(0);
  });

  it('predicts near-average growth after several stable rounds', () => {
    const p = new GrowthPredictor();
    p.recordRound(100);  // grow=0 (first)
    p.recordRound(200);  // +100
    p.recordRound(300);  // +100
    p.recordRound(400);  // +100
    p.recordRound(500);  // +100
    // EMA with α=0.4: all deltas=100, ema converges to 100, ×1.2 = 120
    expect(p.predictNextGrowth()).toBe(120);
  });

  it('reacts to sudden growth spike', () => {
    const p = new GrowthPredictor();
    p.recordRound(100);
    p.recordRound(100);
    p.recordRound(100);
    p.recordRound(200);  // +100
    p.recordRound(500);  // +300
    // EMA α=0.4: ema=0→0→40→144, ×1.2 ≈ 173
    expect(p.predictNextGrowth()).toBe(173);
  });

  it('shouldCompact triggers when predicted growth exceeds 85% threshold', () => {
    const p = new GrowthPredictor();
    // Simulate high-growth pattern: each round +300
    p.recordRound(100);
    p.recordRound(400);  // +300
    p.recordRound(700);  // +300
    p.recordRound(1000); // +300
    p.recordRound(1300); // +300

    // current=1200, predicted~360 → 1200+360=1560 > 1700*0.85=1445 → true
    // current=1100, predicted~360 → 1100+360=1460 > 1445 → true
    // current=1000, predicted~360 → 1000+360=1360 > 1445 → false
    expect(p.shouldCompact(1200, 1700)).toBe(true);
    expect(p.shouldCompact(1100, 1700)).toBe(true);
    expect(p.shouldCompact(1000, 1700)).toBe(false);
  });

  it('shouldCompact returns false with no history (predicts 0)', () => {
    const p = new GrowthPredictor();
    // shouldCompact falls back to checking current > max*0.85
    // current + 0 > 1000*0.85=850? →
    // 900 > 850 = true, 800 > 850 = false
    expect(p.shouldCompact(900, 1000)).toBe(true);
    expect(p.shouldCompact(800, 1000)).toBe(false);
  });
});