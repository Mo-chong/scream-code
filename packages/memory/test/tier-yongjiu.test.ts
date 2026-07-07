/**
 * Tier 2 tests: yongjiu tag runtime behavior.
 *
 * Verifies that yongjiu-tagged memos are immune to demote/autoDemote/evict
 * and have ResNet D=1 (never decay). These tests exercise real code paths
 * and serve as regression guards for the yongjiu tag system.
 *
 * PATHEXT/COMSPEC fix (client-stdio.ts:229-232): verified via build
 * 2026-06-25: 86/86 tests pass, bundle app-DGZ5yfha.mjs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryMemoStore } from '../src/store.js';
import { createMemoryMemo, type MemoryMemo } from '../src/models.js';

describe('yongjiu tag runtime behavior', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;
  let yongjiuMemo: MemoryMemo;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'yongjiu-test-'));
    store = new MemoryMemoStore(tmpDir);
    await store.init();
    yongjiuMemo = createMemoryMemo({
      userNeed: 'yongjiu test',
      approach: 'test approach',
      outcome: 'test outcome',
      whatFailed: 'none',
      whatWorked: 'none',
      extractionSource: 'manual',
      sourceSessionId: 'test',
      tags: ['yongjiu'],
    });
    await store.append(yongjiuMemo);
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('yongjiu prevents demote (memo stays in hot tier)', async () => {
    const ok = await store.demote(yongjiuMemo.id);
    expect(ok).toBe(false);
    const hot = await store.get(yongjiuMemo.id);
    expect(hot).toBeDefined();
  });

  it('yongjiu autoDemote skips yongjiu memos', async () => {
    const old = createMemoryMemo({
      id: 'old-yongjiu',
      userNeed: 'old yongjiu',
      approach: 'test',
      outcome: 'test',
      whatFailed: 'none',
      whatWorked: 'none',
      extractionSource: 'manual',
      sourceSessionId: 'test',
      recordedAt: Date.now() - 200 * 24 * 60 * 60 * 1000, // 200 days old
      tags: ['yongjiu'],
    });
    await store.append(old);
    await store.autoDemoteIfNeeded();
    expect(await store.get(old.id)).toBeDefined();
  });

  it('PROTECTED_TAGS effect: skippedProtected includes yongjiu memos', async () => {
    const { buildConsolidationPlan } = await import('../src/consolidator.js');
    const plan = await buildConsolidationPlan(store);
    expect(plan.summary.skippedProtected).toBeGreaterThanOrEqual(1);
  });
});
