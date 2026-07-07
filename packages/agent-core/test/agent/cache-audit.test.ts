import { describe, expect, it } from 'vitest';

import { computeCacheMetrics, CacheMetrics } from '../../src/agent/usage/audit-log';

describe('computeCacheMetrics', () => {
  it('returns 0 hitRatio when all tokens are miss', () => {
    const result = computeCacheMetrics({
      cacheHitTokens: 0,
      cacheMissTokens: 1000,
    } as any);
    expect(result.hitRatio).toBe(0);
    expect(result.hitTokens).toBe(0);
    expect(result.missTokens).toBe(1000);
  });

  it('returns 1 hitRatio when all tokens are hit', () => {
    const result = computeCacheMetrics({
      cacheHitTokens: 1500,
      cacheMissTokens: 0,
    } as any);
    expect(result.hitRatio).toBe(1);
    expect(result.hitTokens).toBe(1500);
    expect(result.missTokens).toBe(0);
  });

  it('returns 0 hitRatio when no cache data is present', () => {
    const result = computeCacheMetrics({} as any);
    expect(result.hitRatio).toBe(0);
    expect(result.hitTokens).toBe(0);
    expect(result.missTokens).toBe(0);
  });

  it('computes correct ratio for mixed hit/miss', () => {
    const result = computeCacheMetrics({
      cacheHitTokens: 300,
      cacheMissTokens: 700,
    } as any);
    expect(result.hitRatio).toBeCloseTo(0.3, 5);
    expect(result.hitTokens).toBe(300);
    expect(result.missTokens).toBe(700);
  });

  it('handles zero total tokens gracefully', () => {
    const result = computeCacheMetrics({
      cacheHitTokens: 0,
      cacheMissTokens: 0,
    } as any);
    expect(result.hitRatio).toBe(0);
  });
});