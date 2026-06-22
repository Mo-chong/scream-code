/**
 * Unit tests for anti_confabulation injector.
 *
 * Pure function tests — no agent context, just detection result → inject behavior.
 */

import { describe, expect, it } from 'vitest';
import { injectAntiConfabulation } from '../../src/agent/turn/injectors/anti_confabulation';
import type { DetectionResult } from '../../src/agent/turn/detectors/confabulation';

describe('injectAntiConfabulation', () => {
  it('confidence < 2 → no injection', () => {
    const result: DetectionResult = { confidence: 1, reason: 'low' };
    const dedup = new Set<string>();
    const calls: Array<{ text: string }> = [];
    const append = (text: string) => { calls.push({ text }); };

    injectAntiConfabulation(result, dedup, append as any);

    expect(calls).toHaveLength(0);
    expect(dedup.has('anti_confabulation')).toBe(false);
  });

  it('confidence 2 → injects gentle hint', () => {
    const result: DetectionResult = { confidence: 2, reason: 'medium', detail: 'verbose output' };
    const dedup = new Set<string>();
    const calls: Array<{ text: string; meta: any }> = [];
    const append = (text: string, meta: any) => { calls.push({ text, meta }); };

    injectAntiConfabulation(result, dedup, append as any);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('检测到可能的证据缺口');
    expect(calls[0]!.meta.variant).toBe('anti_confabulation');
    expect(dedup.has('anti_confabulation')).toBe(true);
  });

  it('confidence 3 → injects MUST/NEVER reminder', () => {
    const result: DetectionResult = { confidence: 3, reason: 'high', detail: 'marker tokens' };
    const dedup = new Set<string>();
    const calls: Array<{ text: string }> = [];
    const append = (text: string) => { calls.push({ text }); };

    injectAntiConfabulation(result, dedup, append as any);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('MUST verify');
    expect(calls[0]!.text).toContain('NEVER fabricate');
  });

  it('same step does not inject twice (dedup)', () => {
    const result: DetectionResult = { confidence: 2, reason: 'medium' };
    const dedup = new Set<string>();
    const calls: Array<{ text: string }> = [];

    // First call
    injectAntiConfabulation(result, dedup, (text) => calls.push({ text }) as any);
    // Second call with same dedup set
    injectAntiConfabulation(result, dedup, (text) => calls.push({ text }) as any);

    expect(calls).toHaveLength(1);
  });

  it('dedup from other injectors does not interfere', () => {
    const result: DetectionResult = { confidence: 2, reason: 'medium' };
    const dedup = new Set<string>(['prepare_edit']); // unrelated variant
    const calls: Array<{ text: string }> = [];

    injectAntiConfabulation(result, dedup, (text) => calls.push({ text }) as any);

    expect(calls).toHaveLength(1); // should still inject
  });

  it('inject function receives correct meta kind', () => {
    const result: DetectionResult = { confidence: 2, reason: 'medium' };
    const dedup = new Set<string>();
    let capturedMeta: any = null;

    injectAntiConfabulation(
      result,
      dedup,
      (text, meta) => { capturedMeta = meta; },
    );

    expect(capturedMeta).toEqual({
      kind: 'injection',
      variant: 'anti_confabulation',
    });
  });
});
