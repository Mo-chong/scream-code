interface RoundRecord {
  tokensUsed: number;
  timestamp: number;
}

interface CacheRecord {
  hitTokens: number;
  missTokens: number;
  timestamp: number;
}

/**
 * 动态自适应 Compaction 阈值预测器 + 缓存命中率趋势预测
 * Phase 26: 根据最近 N 轮实际 token 增长率预测下一次压缩时机
 * [优化C]: 追踪缓存命中率变化，提供缓存感知路由的依据
 */
export class GrowthPredictor {
  private recentRounds: RoundRecord[] = [];
  private readonly maxRounds = 10;
  private readonly safetyFactor = 1.2;
  /** EMA 平滑因子 α (0-1), 值越小历史权重越大 */
  private readonly emaAlpha = 0.4;

  // ── [优化C] 缓存命中率追踪 ──
  private cacheHistory: CacheRecord[] = [];
  private readonly maxCacheRecords = 10;
  /** 缓存命中率 EMA 平滑因子 */
  private readonly cacheEmaAlpha = 0.3;
  private _cachedHitRatioEma: number | null = null;

  recordRound(tokensUsed: number): void {
    this.recentRounds.push({ tokensUsed, timestamp: Date.now() });
    if (this.recentRounds.length > this.maxRounds) {
      this.recentRounds.shift();
    }
  }

  /** 记录缓存命中/未命中数据，用于预测命中率趋势 */
  recordCacheResult(hitTokens: number, missTokens: number): void {
    this.cacheHistory.push({ hitTokens, missTokens, timestamp: Date.now() });
    if (this.cacheHistory.length > this.maxCacheRecords) {
      this.cacheHistory.shift();
    }
    // 实时更新 EMA
    const total = hitTokens + missTokens;
    if (total > 0) {
      const ratio = hitTokens / total;
      this._cachedHitRatioEma = this._cachedHitRatioEma === null
        ? ratio
        : this.cacheEmaAlpha * ratio + (1 - this.cacheEmaAlpha) * this._cachedHitRatioEma;
    }
  }

  /** 返回平滑后的缓存命中率预测 (0-1)，无数据时返回 1（假设缓存有效） */
  getPredictedHitRatio(): number {
    if (this._cachedHitRatioEma !== null) return this._cachedHitRatioEma;
    if (this.cacheHistory.length > 0) return 0.5; // 有历史但刚重置，保守估计
    return 1; // 无数据时假设缓存有效
  }

  predictNextGrowth(): number {
    if (this.recentRounds.length < 2) return 0;
    const recent = this.recentRounds.slice(-5);

    // 计算每步 delta 并归一化时间间隔
    const deltas: { delta: number; intervalMs: number }[] = [];
    for (let i = 1; i < recent.length; i++) {
      const cur = recent[i]!;
      const prev = recent[i - 1]!;
      deltas.push({
        delta: cur.tokensUsed - prev.tokensUsed,
        intervalMs: Math.max(cur.timestamp - prev.timestamp, 1),
      });
    }

    // 使用 EMA 替代简单平均：对突发 spikes 更鲁棒
    if (deltas.length === 0) return 0;
    let ema = deltas[0]!.delta;
    for (let i = 1; i < deltas.length; i++) {
      const d = deltas[i]!;
      ema = this.emaAlpha * d.delta + (1 - this.emaAlpha) * ema;
    }

    return Math.max(0, Math.ceil(ema * this.safetyFactor));
  }

  shouldCompact(currentUsage: number, maxSize: number): boolean {
    const predicted = currentUsage + this.predictNextGrowth();
    return predicted > maxSize * 0.85;
  }
}