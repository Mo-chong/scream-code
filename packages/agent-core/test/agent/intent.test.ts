/**
 * Unit tests for IntentDetector — pure function tests.
 *
 * Tests the intent detection algorithm without any agent or turn infrastructure.
 * Follows the same pattern as confabulation.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { detectIntent } from '../../src/agent/turn/detectors/intent';
import type { ContentPart } from '@scream-cli/ltod';

function makePrompt(text: string): readonly ContentPart[] {
  return [{ type: 'text', text }];
}

describe('detectIntent', () => {
  // ── Identity path: no match → null ──
  it('empty input returns null', () => {
    expect(detectIntent([])).toBeNull();
  });

  it('non-matching text returns null', () => {
    expect(detectIntent(makePrompt('hello world'))).toBeNull();
  });

  it('trivial input returns null', () => {
    expect(detectIntent(makePrompt('ok'))).toBeNull();
  });

  // ── intent_fix_bug ──
  it('fix_bug: single keyword → low confidence (B)', () => {
    const result = detectIntent(makePrompt('fix the login issue'));
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_fix_bug');
    expect(result!.confidence).toBe('low');
    expect(result!.weightLevel).toBe('B');
  });

  it('fix_bug: multiple keywords → high confidence (A)', () => {
    const result = detectIntent(makePrompt('fix login bug, user gets error on submit'));
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_fix_bug');
    expect(result!.confidence).toBe('high');
    expect(result!.weightLevel).toBe('A');
  });

  it('fix_bug: reproduction marker → high confidence (A)', () => {
    const result = detectIntent(makePrompt('reproduction steps for the crash bug'));
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_fix_bug');
    expect(result!.confidence).toBe('high');
    expect(result!.weightLevel).toBe('A');
  });

  // ── intent_refactor ──
  it('refactor: single keyword → low confidence (B)', () => {
    const result = detectIntent(makePrompt('refactor the auth module'));
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_refactor');
    expect(result!.confidence).toBe('low');
    expect(result!.weightLevel).toBe('B');
  });

  it('refactor: restructure keyword → low confidence (B)', () => {
    const result = detectIntent(makePrompt('restructure the database layer'));
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_refactor');
    expect(result!.confidence).toBe('low');
    expect(result!.weightLevel).toBe('B');
  });

  it('refactor: with test/doc exclude → no match', () => {
    const result = detectIntent(makePrompt('refactor the config test'));
    expect(result).toBeNull();
  });

  it('refactor: migration marker → high confidence (A)', () => {
    const result = detectIntent(makePrompt('migrate all callers from old API'));
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_refactor');
    expect(result!.confidence).toBe('high');
    expect(result!.weightLevel).toBe('A');
  });

  // ── intent_add_feature ──
  it('add_feature: single keyword → low confidence (B)', () => {
    const result = detectIntent(makePrompt('add caching'));
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_add_feature');
    expect(result!.confidence).toBe('low');
    expect(result!.weightLevel).toBe('B');
  });

  it('add_feature: multiple keywords → high confidence (A)', () => {
    const result = detectIntent(makePrompt('implement new feature to support caching'));
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_add_feature');
    expect(result!.confidence).toBe('high');
    expect(result!.weightLevel).toBe('A');
  });

  it('add_feature: with test exclude → no match', () => {
    const result = detectIntent(makePrompt('add new test for login'));
    expect(result).toBeNull();
  });

  // ── intent_review ──
  it('review: single keyword → low confidence (B)', () => {
    const result = detectIntent(makePrompt('review the auth module'));
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_review');
    expect(result!.confidence).toBe('low');
    expect(result!.weightLevel).toBe('B');
  });

  it('review: with override keywords → no match (excluded by fix/add)', () => {
    const result = detectIntent(makePrompt('review and fix the bug'));
    // fix 词更多 → intent_fix_bug 胜出
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_fix_bug');
  });

  it('review: review-only marker → high confidence (A)', () => {
    const result = detectIntent(makePrompt('only review the code'));
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_review');
    expect(result!.confidence).toBe('high');
    expect(result!.weightLevel).toBe('A');
  });

  // ── intent_research ──
  it('research: single keyword → low confidence (B)', () => {
    const result = detectIntent(makePrompt('research AI regulation'));
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_research');
    expect(result!.confidence).toBe('low');
    expect(result!.weightLevel).toBe('B');
  });

  it('research: multiple keywords → high confidence (A)', () => {
    const result = detectIntent(makePrompt('research and investigate deep learning models'));
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_research');
    expect(result!.confidence).toBe('high');
    expect(result!.weightLevel).toBe('A');
  });

  it('research: deep dive marker → high confidence (A)', () => {
    const result = detectIntent(makePrompt('research deep dive into transformer architecture'));
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_research');
    expect(result!.confidence).toBe('high');
    expect(result!.weightLevel).toBe('A');
  });

  // ── intent_document ──
  it('document: single keyword → low confidence (B)', () => {
    const result = detectIntent(makePrompt('write docs for the API'));
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_document');
    expect(result!.confidence).toBe('low');
    expect(result!.weightLevel).toBe('B');
  });

  it('document: multiple keywords → high confidence (A)', () => {
    const result = detectIntent(makePrompt('write user guide documentation with API reference'));
    expect(result).not.toBeNull();
    expect(result!.variant).toBe('intent_document');
    expect(result!.confidence).toBe('high');
    expect(result!.weightLevel).toBe('A');
  });

  // ── Best match: multi-intent input ──
  it('multiple intents: picks the one with most keyword matches', () => {
    // "fix" = 1 for fix_bug, "error" = 2 for fix_bug, "explore" = 1 for research
    const result = detectIntent(makePrompt('fix the error and explore alternatives'));
    expect(result).not.toBeNull();
    // fix_bug: "fix" + "error" = 2 keywords vs research: "explore" = 1
    expect(result!.variant).toBe('intent_fix_bug');
  });

  it('equal keyword counts: picks first-best (no crash on tie)', () => {
    // fix_bug: "fix" = 1, add_feature: "add" = 1, review excluded by "fix", document: "docs" = 1
    const result = detectIntent(makePrompt('fix and add new docs'));
    expect(result).not.toBeNull();
    // Should not crash. Any variant is acceptable — the test verifies stability.
    expect(['intent_fix_bug', 'intent_add_feature', 'intent_document']).toContain(result!.variant);
  });

  // ── Edge: guidance text presence ──
  it('all intents have B-level guidance text', () => {
    const variants = ['intent_fix_bug', 'intent_refactor', 'intent_add_feature',
      'intent_review', 'intent_research', 'intent_document'];
    for (const variant of variants) {
      // Use a match that produces low confidence (B)
      const keywordMap: Record<string, string> = {
        intent_fix_bug: 'fix this thing',     // 1 keyword → low
        intent_refactor: 'refactor the code', // 1 keyword → low (highThreshold=2)
        intent_add_feature: 'add the thing',  // 1 keyword → low
        intent_review: 'review the code',     // 1 keyword → low (highThreshold=2, excluded by excludePattern)
        intent_research: 'research this',      // 1 keyword → low
        intent_document: 'write docs',         // 1 keyword → low (highThreshold=2)
      };
      const result = detectIntent(makePrompt(keywordMap[variant]));
      expect(result).not.toBeNull();
      expect(result!.guidanceText).toContain('system-reminder');
      expect(result!.guidanceText).toContain(variant);
    }
  });

  it('all intents have A-level guidance text for high confidence', () => {
    const highVariants: Record<string, string> = {
      intent_fix_bug: 'fix the crashing bug with reproduction',
      intent_refactor: 'migrate all callers from old api',
      intent_add_feature: 'implement new feature support for caching',
      intent_review: 'only review the architecture',
      intent_research: 'research deep dive compare vs transformer',
      intent_document: 'write readme and api reference user guide',
    };
    for (const [variant, prompt] of Object.entries(highVariants)) {
      const result = detectIntent(makePrompt(prompt));
      expect(result, `${variant} should match`).not.toBeNull();
      expect(result!.guidanceText).toContain('MUST');
      expect(result!.guidanceText).toContain(variant);
    }
  });
});
