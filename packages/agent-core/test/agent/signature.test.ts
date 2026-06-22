/**
 * Unit tests for signature.ts — pure function tests only.
 *
 * These test the BottleNeck layer (compressStep) and helper functions.
 * No agent, no context, no turn loop — pure function in, deterministic out.
 */

import { describe, expect, it } from 'vitest';
import { compressStep, buildContextSnapshot } from '../../src/agent/turn/signature';

describe('signature / compressStep', () => {
  it('Edit only → hasKnowledgeTools=false, hasActionTools=true', () => {
    const sig = compressStep({ Edit: 2 }, 'done');
    expect(sig.hasKnowledgeTools).toBe(false);
    expect(sig.hasActionTools).toBe(true);
    expect(sig.outputLength).toBe(4);
  });

  it('Read + Edit → hasKnowledgeTools=true', () => {
    const sig = compressStep({ Read: 1, Edit: 1 }, '');
    expect(sig.hasKnowledgeTools).toBe(true);
    expect(sig.hasActionTools).toBe(true);
  });

  it('LSP call → hasKnowledgeTools=true', () => {
    const sig = compressStep({ LSP: 1 }, '');
    expect(sig.hasKnowledgeTools).toBe(true);
  });

  it('Grep call → hasKnowledgeTools=true', () => {
    const sig = compressStep({ Grep: 1 }, '');
    expect(sig.hasKnowledgeTools).toBe(true);
  });

  it('WebSearch call → hasKnowledgeTools=true', () => {
    const sig = compressStep({ WebSearch: 1 }, '');
    expect(sig.hasKnowledgeTools).toBe(true);
  });

  it('MemoryLookup → hasKnowledgeTools=true', () => {
    const sig = compressStep({ MemoryLookup: 1 }, '');
    expect(sig.hasKnowledgeTools).toBe(true);
  });

  it('FetchURL → hasKnowledgeTools=true', () => {
    const sig = compressStep({ FetchURL: 1 }, '');
    expect(sig.hasKnowledgeTools).toBe(true);
  });

  it('Write only → hasActionTools=true', () => {
    const sig = compressStep({ Write: 1 }, 'content');
    expect(sig.hasActionTools).toBe(true);
    expect(sig.hasKnowledgeTools).toBe(false);
  });

  it('Bash only → hasActionTools=true, hasVerificationTools=true', () => {
    const sig = compressStep({ Bash: 1 }, '');
    expect(sig.hasActionTools).toBe(true);
    expect(sig.hasVerificationTools).toBe(true);
  });

  it('empty step → all false, outputLength 0', () => {
    const sig = compressStep({}, '');
    expect(sig.hasKnowledgeTools).toBe(false);
    expect(sig.hasActionTools).toBe(false);
    expect(sig.hasVerificationTools).toBe(false);
    expect(sig.markerTokenFound).toBe(false);
    expect(sig.outputLength).toBe(0);
  });

  it('marker token "根据文档" detected', () => {
    const sig = compressStep({ Edit: 1 }, '根据文档显示，这个 API 已废弃');
    expect(sig.markerTokenFound).toBe(true);
  });

  it('marker token "According to the documentation" detected', () => {
    const sig = compressStep({}, 'According to the documentation, this is correct');
    expect(sig.markerTokenFound).toBe(true);
  });

  it('normal text no markers', () => {
    const sig = compressStep({}, 'I fixed the bug by updating the config');
    expect(sig.markerTokenFound).toBe(false);
  });

  it('partial marker match on substring triggers', () => {
    const sig = compressStep({}, '根据文档 是唯一的前缀');
    expect(sig.markerTokenFound).toBe(true);
  });

  it('toolCounts records all tools correctly', () => {
    const sig = compressStep({ Edit: 3, Read: 1, Grep: 2 }, '');
    expect(sig.toolCounts).toEqual({ Edit: 3, Read: 1, Grep: 2 });
  });
});

describe('signature / buildContextSnapshot', () => {
  it('has knowledge tools → recentKnowledgeSteps=1, stepNormRate=0.70', () => {
    const snap = buildContextSnapshot({ Read: 1 }, 1);
    expect(snap.recentKnowledgeSteps).toBe(1);
    expect(snap.stepNormRate).toBe(0.70);
    expect(snap.turnStepNumber).toBe(1);
  });

  it('no knowledge tools → recentKnowledgeSteps=0, stepNormRate=0.25', () => {
    const snap = buildContextSnapshot({ Edit: 1 }, 3);
    expect(snap.recentKnowledgeSteps).toBe(0);
    expect(snap.stepNormRate).toBe(0.25);
    expect(snap.turnStepNumber).toBe(3);
  });

  it('step 0 starting state', () => {
    const snap = buildContextSnapshot({}, 0);
    expect(snap.recentKnowledgeSteps).toBe(0);
    expect(snap.deliveryPhase).toBe(false);
  });
});
