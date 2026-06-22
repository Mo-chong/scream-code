/**
 * Unit tests for ConfabulationDetector — pure function tests.
 *
 * Tests the residual detection algorithm without any agent or turn infrastructure.
 */

import { describe, expect, it } from 'vitest';
import { detectConfabulation } from '../../src/agent/turn/detectors/confabulation';
import type { StepSignature, ContextSnapshot } from '../../src/agent/turn/signature';

function makeSig(overrides: Partial<StepSignature> = {}): StepSignature {
  return {
    toolCounts: {},
    hasKnowledgeTools: false,
    hasActionTools: false,
    hasVerificationTools: false,
    markerTokenFound: false,
    outputLength: 0,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    recentKnowledgeSteps: 0,
    recentKnowledgeDepth: -1,
    stepNormRate: 0.25,
    deliveryPhase: false,
    turnStepNumber: 0,
    ...overrides,
  };
}

describe('detectConfabulation', () => {
  // ── Identity path ──
  it('has knowledge tools → confidence 0', () => {
    const sig = makeSig({ hasKnowledgeTools: true });
    const ctx = makeCtx({});
    const result = detectConfabulation(sig, ctx);
    expect(result.confidence).toBe(0);
    expect(result.reason).toMatch(/identity/);
  });

  // ── Delivery phase ──
  it('delivery phase → confidence 0', () => {
    const sig = makeSig({ hasKnowledgeTools: false });
    const ctx = makeCtx({ deliveryPhase: true });
    const result = detectConfabulation(sig, ctx);
    expect(result.confidence).toBe(0);
    expect(result.reason).toMatch(/delivery/);
  });

  // ── Normal cases (confidence 0) ──
  it('short output, no markers, no action tools → confidence 0', () => {
    const sig = makeSig({ outputLength: 50 });
    const ctx = makeCtx({});
    expect(detectConfabulation(sig, ctx).confidence).toBe(0);
  });

  it('action tools + short output → confidence 0', () => {
    const sig = makeSig({ hasActionTools: true, outputLength: 50 });
    const ctx = makeCtx({});
    expect(detectConfabulation(sig, ctx).confidence).toBe(0);
  });

  // ── Low confidence (1) ──
  it('marker token but short output → confidence 1', () => {
    const sig = makeSig({ markerTokenFound: true, outputLength: 50 });
    const ctx = makeCtx({});
    const result = detectConfabulation(sig, ctx);
    expect(result.confidence).toBe(1);
    expect(result.detail).toMatch(/authority marker/);
  });

  // ── Medium confidence (2) ──
  it('verbose output without knowledge tools → confidence 2', () => {
    const sig = makeSig({ outputLength: 250 });
    const ctx = makeCtx({});
    const result = detectConfabulation(sig, ctx);
    expect(result.confidence).toBe(2);
    expect(result.detail).toMatch(/verbose output/);
  });

  it('marker token + verbose output → confidence 3 (signals 1+2 cumulative)', () => {
    const sig = makeSig({ markerTokenFound: true, outputLength: 250 });
    const ctx = makeCtx({});
    const result = detectConfabulation(sig, ctx);
    expect(result.confidence).toBe(3);
  });

  it('action tools + long output (200) → only signal 3 triggers → confidence 1', () => {
    const sig = makeSig({ hasActionTools: true, outputLength: 200 });
    const ctx = makeCtx({});
    const result = detectConfabulation(sig, ctx);
    expect(result.confidence).toBe(1);
  });

  // ── High confidence (3) ──
  it('verbose output + marker tokens → confidence 3', () => {
    const sig = makeSig({ markerTokenFound: true, outputLength: 250, hasActionTools: true });
    const ctx = makeCtx({});
    const result = detectConfabulation(sig, ctx);
    expect(result.confidence).toBe(3);
    expect(result.detail).toMatch(/verbose output/);
    expect(result.detail).toMatch(/authority marker/);
    expect(result.detail).toMatch(/action-only/);
  });

  it('verbose + markers + action tools → confidence 3', () => {
    const sig = makeSig({
      markerTokenFound: true,
      outputLength: 300,
      hasActionTools: true,
    });
    const ctx = makeCtx({});
    const result = detectConfabulation(sig, ctx);
    expect(result.confidence).toBe(3);
  });

  // ── Edge cases ──
  it('boundary outputLength=200 → not verbose (not >= 200 trigger)', () => {
    const sig = makeSig({ outputLength: 200 });
    const ctx = makeCtx({});
    const result = detectConfabulation(sig, ctx);
    // 200 is not > 200 for signal 1, and action tool + >150 is not met
    expect(result.confidence).toBe(0);
  });

  it('boundary outputLength=201 → verbose trigger', () => {
    const sig = makeSig({ outputLength: 201 });
    const ctx = makeCtx({});
    const result = detectConfabulation(sig, ctx);
    expect(result.confidence).toBe(2);
  });

  it('action only + outputLength 151 → signal 3 trigger → confidence 1', () => {
    const sig = makeSig({ hasActionTools: true, outputLength: 151 });
    const ctx = makeCtx({});
    const result = detectConfabulation(sig, ctx);
    expect(result.confidence).toBe(1);
  });
});
