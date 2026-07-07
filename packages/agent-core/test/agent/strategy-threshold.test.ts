import { describe, expect, it } from 'vitest';
import { DefaultCompactionStrategy, DEFAULT_COMPACTION_CONFIG } from '../../src/agent/compaction/strategy';

describe('DefaultCompactionStrategy shouldCompact thresholds', () => {
  it('falls back to triggerRatio when predictor has no data', () => {
    const strategy = new DefaultCompactionStrategy(
      () => 1000,
      { ...DEFAULT_COMPACTION_CONFIG, triggerRatio: 0.75 },
    );
    // 800/1000=0.8 > 0.75 → true
    expect(strategy.shouldCompact(800)).toBe(true);
    // 700/1000=0.7 < 0.75 → false
    expect(strategy.shouldCompact(700)).toBe(false);
  });

  it('predictor triggers compaction before triggerRatio threshold', () => {
    const strategy = new DefaultCompactionStrategy(
      () => 2000,
      { ...DEFAULT_COMPACTION_CONFIG, triggerRatio: 0.75 },
    );
    // 喂数据模拟高增长
    strategy.recordRound(100);
    strategy.recordRound(400);  // +300
    strategy.recordRound(700);  // +300
    strategy.recordRound(1000); // +300
    strategy.recordRound(1300); // +300

    // current 1400, predicted ~360 → 1400+360=1760 > 1700 (2000*0.85) → predictor trigger
    // 但 current/2000 = 0.7 < 0.75，纯静态不会触发
    expect(strategy.shouldCompact(1400)).toBe(true);
  });

  it('predictor returns false keeps strategy using triggerRatio', () => {
    const strategy = new DefaultCompactionStrategy(
      () => 1000,
      { ...DEFAULT_COMPACTION_CONFIG, triggerRatio: 0.75 },
    );
    // 喂稳定数据，预测增长很低
    strategy.recordRound(100);
    strategy.recordRound(105); // +5
    strategy.recordRound(110); // +5

    // current 850, predicted ~6 → 856 < 850 (1000*0.85), so predictor says no
    // 但 850/1000 = 0.85 > 0.75，triggerRatio 触发
    expect(strategy.shouldCompact(850)).toBe(true);
  });

  it('predictor suppresses compaction when growth is flat', () => {
    const strategy = new DefaultCompactionStrategy(
      () => 1000,
      { ...DEFAULT_COMPACTION_CONFIG, triggerRatio: 0.75 },
    );
    strategy.recordRound(700);
    strategy.recordRound(710); // +10
    strategy.recordRound(715); // +5
    strategy.recordRound(720); // +5

    // current 749, predicted ~8 → 757 < 850, predictor says no
    // 749/1000 = 0.749 < 0.75, triggerRatio 也不触发
    expect(strategy.shouldCompact(749)).toBe(false);

    // current 800, predicted ~8 → 808 < 850, predictor says no
    // 800/1000 = 0.8 > 0.75, triggerRatio 触发
    expect(strategy.shouldCompact(800)).toBe(true);
  });
});