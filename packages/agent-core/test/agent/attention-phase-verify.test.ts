/**
 * Phase 1-3 Acceptance Tests for Attention Management
 * Verifies: position-aware injection strategy, conditional prompt assembly, post-compact recovery
 */
import { describe, it, expect } from 'vitest';
import { AttentionPositionStrategy } from '../../src/agent/injection/position-strategy';
import type { WeightLevel } from '../../src/agent/turn/variant-registry';

describe('Phase 1: Position-aware injection strategy', () => {
  it('S-level variant inserts at head', () => {
    const strat = new AttentionPositionStrategy();
    expect(strat.decidePosition('feedback_positive', 'S' as WeightLevel)).toBe('head');
    expect(strat.decidePosition('any_variant', 'S' as WeightLevel)).toBe('head');
  });

  it('A-level variant inserts at near_head', () => {
    const strat = new AttentionPositionStrategy();
    expect(strat.decidePosition('intent_fix_bug', 'A' as WeightLevel)).toBe('near_head');
  });

  it('feedback_/post_/step_after_ variants insert at near_head regardless of level', () => {
    const strat = new AttentionPositionStrategy();
    expect(strat.decidePosition('feedback_positive', 'B' as WeightLevel)).toBe('near_head');
    expect(strat.decidePosition('step_after_tool_call', 'C' as WeightLevel)).toBe('near_head');
    expect(strat.decidePosition('post_compaction', 'D' as WeightLevel)).toBe('near_head');
  });

  it('B/C/D-level non-special variants insert at tail', () => {
    const strat = new AttentionPositionStrategy();
    expect(strat.decidePosition('content_audit', 'B' as WeightLevel)).toBe('tail');
    expect(strat.decidePosition('soft_reminder', 'C' as WeightLevel)).toBe('tail');
    expect(strat.decidePosition('low_priority_note', 'D' as WeightLevel)).toBe('tail');
  });
});

describe('Phase 2: Boundary marker and conditional blocks in system.md', () => {
  it('system.md contains __SYSTEM_PROMPT_BOUNDARY__', async () => {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(
      new URL('../../src/profile/default/system.md', import.meta.url),
      'utf-8',
    );
    expect(content).toContain('__SYSTEM_PROMPT_BOUNDARY__');
  });

  it('system.md contains Nunjucks conditional blocks for HAS_SUBAGENT and HAS_SKILL_CONTENT', async () => {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(
      new URL('../../src/profile/default/system.md', import.meta.url),
      'utf-8',
    );
    expect(content).toContain('HAS_SUBAGENT');
    expect(content).toContain('HAS_SKILL_CONTENT');
  });
});

describe('Phase 3: post-compact notice in compaction source', () => {
  it('compaction/full.ts emits post_compact_notice variant', async () => {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(
      new URL('../../src/agent/compaction/full.ts', import.meta.url),
      'utf-8',
    );
    expect(content).toContain('post_compact_notice');
    expect(content).toContain('Context was compacted');
  });
});

describe('Phase 2: resolve.ts template variables', () => {
  it('resolve.ts contains HAS_SUBAGENT and HAS_SKILL_CONTENT', async () => {
    const fs = await import('node:fs/promises');
    const content = await fs.readFile(
      new URL('../../src/profile/resolve.ts', import.meta.url),
      'utf-8',
    );
    expect(content).toContain('HAS_SUBAGENT');
    expect(content).toContain('HAS_SKILL_CONTENT');
  });
});
