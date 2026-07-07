interface RoundRecord {
  tokensUsed: number;
  timestamp: number;
}

/**
 * 动态自适应 Compaction 阈值预测器
 * Phase 26: 根据最近 N 轮实际 token 增长率预测下一次压缩时机
 */
export class GrowthPredictor {
  private recentRounds: RoundRecord[] = [];
  private readonly maxRounds = 10;
  private readonly safetyFactor = 1.2;
  /** EMA 平滑因子 α (0-1), 值越小历史权重越大 */
  private readonly emaAlpha = 0.4;

  recordRound(tokensUsed: number): void {
    this.recentRounds.push({ tokensUsed, timestamp: Date.now() });
    if (this.recentRounds.length > this.maxRounds) {
      this.recentRounds.shift();
    }
  }

  predictNextGrowth(): number {
    if (this.recentRounds.length < 2) return 0;
    const recent = this.recentRounds.slice(-5);

    // 计算每步 delta 并归一化时间间隔
    const deltas: { delta: number; intervalMs: number }[] = [];
    for (let i = 1; i < recent.length; i++) {
      const delta = recent[i].tokensUsed - recent[i - 1].tokensUsed;
      const intervalMs = recent[i].timestamp - recent[i - 1].timestamp;
      deltas.push({ delta, intervalMs: Math.max(intervalMs, 1) });
    }

    // 使用 EMA 替代简单平均：对突发 spikes 更鲁棒
    let ema = deltas[0].delta;
    for (let i = 1; i < deltas.length; i++) {
      ema = this.emaAlpha * deltas[i].delta + (1 - this.emaAlpha) * ema;
    }

    return Math.max(0, Math.ceil(ema * this.safetyFactor));
  }

  shouldCompact(currentUsage: number, maxSize: number): boolean {
    const predicted = currentUsage + this.predictNextGrowth();
    return predicted > maxSize * 0.85;
  }
}