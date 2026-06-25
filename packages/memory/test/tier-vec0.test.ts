/**
 * Full-dimension integration tests for hot/cold tier and vec0.
 *
 * Covers: demote / promote / autoPromoteHits / autoDemoteIfNeeded /
 *         searchByVectorVec0 tier filters / vec0 lifecycle /
 *         baohu protection / delete → vec0 cleanup
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MemoryMemoStore } from '../src/store.js';
import { createMemoryMemo, type MemoryMemo } from '../src/models.js';

function makeMemo(overrides: Partial<MemoryMemo> = {}): MemoryMemo {
  return createMemoryMemo({
    userNeed: 'Test need',
    approach: 'Test approach',
    outcome: '完成',
    whatFailed: 'none',
    whatWorked: 'none',
    extractionSource: 'compaction',
    sourceSessionId: 'test-session',
    sourceSessionTitle: 'Test Session',
    ...overrides,
  });
}

/**
 * Write a random 384-dim embedding into memory_embeddings + upsertVec0
 * so vec0 queries can find the memo at the specified tier.
 */
async function seedEmbedding(
  store: MemoryMemoStore,
  memoId: string,
  tier: 'HOT' | 'ARCHIVED' = 'HOT',
): Promise<void> {
  const db = (store as any).db as DatabaseSync;
  // Produce deterministic but unique vector per memoId so equal vectors
  // also work for distance-based search tests.
  const embed = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    // Use a simple hash of memoId to make vectors different per memo
    embed[i] = ((memoId.charCodeAt(i % memoId.length) || 42) / 255) * 2 - 1;
  }
  db.prepare(
    `INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding_json, model, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(memoId, JSON.stringify([...embed]), 'test', Date.now());

  // Grab the memo from hot or cold tier
  let memoData: Record<string, unknown> | undefined;
  memoData = db.prepare('SELECT * FROM memos WHERE id = ?').get(memoId) as
    Record<string, unknown> | undefined;
  if (memoData === undefined) {
    memoData = db.prepare('SELECT * FROM memos_archive WHERE id = ?').get(memoId) as
      Record<string, unknown> | undefined;
  }
  if (memoData) {
    // Convert stored row back to MemoryMemo shape
    const memo: MemoryMemo = {
      id: String(memoData['id']),
      sourceSessionId: String(memoData['source_session_id']),
      sourceSessionTitle:
        typeof memoData['source_session_title'] === 'string'
          ? memoData['source_session_title']
          : undefined,
      userNeed: String(memoData['user_need']),
      approach: String(memoData['approach']),
      outcome: String(memoData['outcome']),
      whatFailed: String(memoData['what_failed']),
      whatWorked: String(memoData['what_worked']),
      extractionSource: memoData['extraction_source'] as 'compaction' | 'exit' | 'manual',
      recordedAt: Number(memoData['recorded_at']),
      projectDir: String(memoData['project_dir'] ?? ''),
      tags: parseTagsSimple(memoData['tags']),
    };
    (store as any).upsertVec0(memoId, embed, memo, tier);
  }
}

function parseTagsSimple(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const p = JSON.parse(value);
    return Array.isArray(p) ? p.filter((t: unknown) => typeof t === 'string') : undefined;
  } catch {
    return undefined;
  }
}

describe('Hot/Cold tier + vec0 integration', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;
  let db: DatabaseSync;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-tier-test-'));
    store = new MemoryMemoStore(tmpDir);
    await store.init();
    db = (store as any).db as DatabaseSync;
  });

  afterEach(async () => {
    // Close before rm to release WAL/SHM locks
    store.close();
    // Best-effort cleanup — EBUSY on Windows is pre-existing
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ── vec0 basic lifecycle ──

  it('hasVec0 returns false when no embeddings exist', () => {
    expect(store.hasVec0()).toBe(false);
  });

  it('hasVec0 returns true after upsert', async () => {
    const memo = makeMemo();
    await store.append(memo);
    await seedEmbedding(store, memo.id);
    expect(store.hasVec0()).toBe(true);
  });

  // ── demote ──

  it('demote moves a memo from hot (memos) to cold (memos_archive)', async () => {
    const memo = makeMemo({ id: 'd1' });
    await store.append(memo);
    await seedEmbedding(store, memo.id);

    const ok = await store.demote(memo.id);
    expect(ok).toBe(true);

    // No longer in hot tier
    expect(await store.get(memo.id)).toBeUndefined();

    // Present in archive
    const archived = await (store as any).getArchived(memo.id);
    expect(archived).toBeDefined();
    expect(archived.id).toBe(memo.id);
    expect(archived.archivedAt).toBeGreaterThan(0);
  });

  it('demote refuses baohu-tagged memos (immune)', async () => {
    const memo = makeMemo({ id: 'baohu1', tags: ['baohu'] });
    await store.append(memo);

    const ok = await store.demote(memo.id);
    expect(ok).toBe(false);
    // Still in hot tier
    expect(await store.get(memo.id)).toBeDefined();
  });

  it('demote also refuses chundu-tagged memos (merged from behavior-rule)', async () => {
    const memo = makeMemo({ id: 'chundu-demote', tags: ['chundu'] });
    await store.append(memo);

    const ok = await store.demote(memo.id);
    expect(ok).toBe(false);
    expect(await store.get(memo.id)).toBeDefined();
  });

  it('demote preserves vec0 entry with ARCHIVED tier', async () => {
    const memo = makeMemo({ id: 'd-vec0' });
    await store.append(memo);
    await seedEmbedding(store, memo.id);

    await store.demote(memo.id);

    const q = new Float32Array(384);
    // Should be findable via ARCHIVED tier
    const arch = store.searchByVectorVec0(q, {
      k: 20, scoreTier: 'ARCHIVED', distanceCutoff: 100,
    });
    expect(arch.some((r) => r.memo_id === memo.id)).toBe(true);

    // Should NOT appear in HOT tier search
    const hot = store.searchByVectorVec0(q, {
      k: 20, scoreTier: 'HOT', distanceCutoff: 100,
    });
    expect(hot.some((r) => r.memo_id === memo.id)).toBe(false);
  });

  it('demote works for memo without embedding (graceful skip)', async () => {
    const memo = makeMemo({ id: 'no-emb' });
    await store.append(memo);
    // No seedEmbedding call — no embedding exists

    const ok = await store.demote(memo.id);
    expect(ok).toBe(true);
    expect(await store.get(memo.id)).toBeUndefined();

    const archived = await (store as any).getArchived(memo.id);
    expect(archived).toBeDefined();
  });

  // ── promote ──

  it('promote moves memo from archive back to hot tier', async () => {
    const memo = makeMemo({ id: 'p1' });
    await store.append(memo);
    await seedEmbedding(store, memo.id);
    await store.demote(memo.id);

    const ok = await store.promote(memo.id);
    expect(ok).toBe(true);

    // Back in hot tier
    expect(await store.get(memo.id)).toBeDefined();

    // Removed from archive
    const archived = await (store as any).getArchived(memo.id);
    expect(archived).toBeUndefined();
  });

  it('promote sets vec0 tier to HOT after move', async () => {
    const memo = makeMemo({ id: 'p-vec0' });
    await store.append(memo);
    await seedEmbedding(store, memo.id);
    await store.demote(memo.id);
    await store.promote(memo.id);

    const q = new Float32Array(384);
    const hot = store.searchByVectorVec0(q, {
      k: 20, scoreTier: 'HOT', distanceCutoff: 100,
    });
    expect(hot.some((r) => r.memo_id === memo.id)).toBe(true);

    const arch = store.searchByVectorVec0(q, {
      k: 20, scoreTier: 'ARCHIVED', distanceCutoff: 100,
    });
    expect(arch.some((r) => r.memo_id === memo.id)).toBe(false);
  });

  it('promote returns false for non-archived memo', async () => {
    const ok = await store.promote('nonexistent-id');
    expect(ok).toBe(false);
  });

  // ── autoPromoteHits ──

  it('autoPromoteHits promotes immediately when hot tier has room', async () => {
    const memo = makeMemo({ id: 'ap-room' });
    await store.append(memo);
    await seedEmbedding(store, memo.id);
    await store.demote(memo.id);

    // Hot tier is empty (< HOT_MAX_SIZE) → promote on first hit
    const n = await store.autoPromoteHits([memo.id]);
    expect(n).toBe(1);
    expect(await store.get(memo.id)).toBeDefined();
  });

  it('autoPromoteHits promotes after hit_count reaches PROMOTE_HIT_COUNT when hot is full', async () => {
    // Fill hot tier to capacity
    for (let i = 0; i < 105; i++) {
      await store.append(makeMemo({ id: `fill-promote-${i}` }));
    }
    const target = makeMemo({ id: 'ap-threshold' });
    await store.append(target);
    await seedEmbedding(store, target.id);
    await store.demote(target.id);

    // First hit: hot tier full, newCount=1 < PROMOTE_HIT_COUNT(2) → skip
    const n1 = await store.autoPromoteHits([target.id]);
    expect(n1).toBe(0);
    expect(await store.get(target.id)).toBeUndefined();

    // Second hit: newCount=2 >= PROMOTE_HIT_COUNT → promote
    const n2 = await store.autoPromoteHits([target.id]);
    expect(n2).toBe(1);
    expect(await store.get(target.id)).toBeDefined();
  });

  it('autoPromoteHits handles unknown ids gracefully', async () => {
    const n = await store.autoPromoteHits(['no-such-id']);
    expect(n).toBe(0);
  });

  // ── autoDemoteIfNeeded ──

  it('autoDemoteIfNeeded demotes old memos with low ResNet factor', async () => {
    const old = makeMemo({
      id: 'old-demote',
      recordedAt: Date.now() - 100 * 24 * 60 * 60 * 1000, // 100 days
      tags: [], // default D=0.85, 0.85^100 ≈ 1e-7 < DEMOTE_RESNET_THRESHOLD(0.3)
    });
    await store.append(old);
    await seedEmbedding(store, old.id);

    const n = await store.autoDemoteIfNeeded();
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await store.get(old.id)).toBeUndefined();
  });

  it('autoDemoteIfNeeded spares baohu-tagged hot memos', async () => {
    const memo = makeMemo({
      id: 'baohu-auto',
      recordedAt: Date.now() - 200 * 24 * 60 * 60 * 1000,
      tags: ['baohu'],
    });
    await store.append(memo);

    await store.autoDemoteIfNeeded();
    // baohu — should still be in hot tier
    expect(await store.get(memo.id)).toBeDefined();
  });

  it('autoDemoteIfNeeded also spares chundu-tagged hot memos', async () => {
    const memo = makeMemo({
      id: 'chundu-auto',
      recordedAt: Date.now() - 200 * 24 * 60 * 60 * 1000,
      tags: ['chundu'],
    });
    await store.append(memo);

    await store.autoDemoteIfNeeded();
    // chundu — should still be in hot tier
    expect(await store.get(memo.id)).toBeDefined();
  });

  it('autoDemoteIfNeeded caps hot tier at HOT_MAX_SIZE', async () => {
    // Fill just above HOT_MAX_SIZE
    const count = 105;
    for (let i = 0; i < count; i++) {
      await store.append(makeMemo({ id: `cap-${i}`, recordedAt: Date.now() - i * 1000 }));
    }

    const demoted = await store.autoDemoteIfNeeded();
    expect(demoted).toBeGreaterThanOrEqual(5); // should at least demote the excess

    const remaining: MemoryMemo[] = [];
    for await (const m of store.read()) {
      remaining.push(m);
    }
    // Should be at or near HOT_MAX_SIZE
    expect(remaining.length).toBeLessThanOrEqual(105);
  });

  it('autoDemoteIfNeeded returns 0 when nothing needs demotion', async () => {
    const memo = makeMemo({ id: 'fresh' });
    await store.append(memo);

    const n = await store.autoDemoteIfNeeded();
    expect(n).toBe(0);
    expect(await store.get(memo.id)).toBeDefined();
  });

  // ── searchByVectorVec0 tier filters ──

  it('searchByVectorVec0 filters correctly by scoreTier', async () => {
    const hotM = makeMemo({ id: 'only-hot' });
    const coldM = makeMemo({ id: 'only-cold' });
    await store.append(hotM);
    await store.append(coldM);
    await seedEmbedding(store, hotM.id, 'HOT');
    await seedEmbedding(store, coldM.id, 'ARCHIVED');

    const q = new Float32Array(384);
    const hotRes = store.searchByVectorVec0(q, {
      k: 20, scoreTier: 'HOT', distanceCutoff: 100,
    });
    const hotIds = hotRes.map((r) => r.memo_id);
    expect(hotIds).toContain('only-hot');
    expect(hotIds).not.toContain('only-cold');

    const coldRes = store.searchByVectorVec0(q, {
      k: 20, scoreTier: 'ARCHIVED', distanceCutoff: 100,
    });
    const coldIds = coldRes.map((r) => r.memo_id);
    expect(coldIds).toContain('only-cold');
    expect(coldIds).not.toContain('only-hot');
  });

  it('searchByVectorVec0 returns empty for non-matching tier filter', async () => {
    const res = store.searchByVectorVec0(new Float32Array(384), {
      k: 20, scoreTier: 'HOT', distanceCutoff: 100,
    });
    expect(res).toEqual([]);
  });

  it('searchByVectorVec0 respects distanceCutoff', async () => {
    const memo = makeMemo({ id: 'dist-test' });
    await store.append(memo);
    await seedEmbedding(store, memo.id);

    // cutoff=0 → no results (distances are > 0)
    const none = store.searchByVectorVec0(new Float32Array(384), {
      k: 20, distanceCutoff: 0,
    });
    expect(none.some((r) => r.memo_id === memo.id)).toBe(false);

    // cutoff=100 → everything matches
    const all = store.searchByVectorVec0(new Float32Array(384), {
      k: 20, distanceCutoff: 100,
    });
    expect(all.some((r) => r.memo_id === memo.id)).toBe(true);
  });

  it('searchByVectorVec0 respects projectDir filter', async () => {
    const projA = makeMemo({ id: 'proj-a', projectDir: '/workspace/a' });
    const projB = makeMemo({ id: 'proj-b', projectDir: '/workspace/b' });
    await store.append(projA);
    await store.append(projB);
    await seedEmbedding(store, projA.id, 'HOT');
    await seedEmbedding(store, projB.id, 'HOT');

    const q = new Float32Array(384);
    const aRes = store.searchByVectorVec0(q, {
      k: 20, projectDir: '/workspace/a', distanceCutoff: 100,
    });
    expect(aRes.some((r) => r.memo_id === 'proj-a')).toBe(true);
    expect(aRes.some((r) => r.memo_id === 'proj-b')).toBe(false);
  });

  // ── delete vec0 lifecycle ──

  it('delete removes memo from vec0 index', async () => {
    const memo = makeMemo({ id: 'del-vec' });
    await store.append(memo);
    await seedEmbedding(store, memo.id);

    await store.delete(memo.id);

    const q = new Float32Array(384);
    const all = store.searchByVectorVec0(q, { k: 200, distanceCutoff: 100 });
    expect(all.some((r) => r.memo_id === memo.id)).toBe(false);
  });

  // ── demote → promote → demote round-trip ──

  it('survives demote→promote→demote round-trip', async () => {
    const memo = makeMemo({ id: 'roundtrip' });
    await store.append(memo);
    await seedEmbedding(store, memo.id);

    // First demote
    await store.demote(memo.id);
    expect(await store.get(memo.id)).toBeUndefined();

    // Promote back
    await store.promote(memo.id);
    expect(await store.get(memo.id)).toBeDefined();

    // Demote again
    await store.demote(memo.id);
    expect(await store.get(memo.id)).toBeUndefined();

    // vec0 should be ARCHIVED after second demote
    const q = new Float32Array(384);
    const arch = store.searchByVectorVec0(q, {
      k: 20, scoreTier: 'ARCHIVED', distanceCutoff: 100,
    });
    expect(arch.some((r) => r.memo_id === memo.id)).toBe(true);
  });

  // ── memory-lookup style: hot first, cold fallback ──

  it('vec0 hot+cold fallback pattern works (like memory-lookup.ts)', async () => {
    // Simulate the two-phase search in memory-lookup.ts:
    // 1. Search HOT tier first
    // 2. If < 3 results, also search ARCHIVED and merge
    const hotM = makeMemo({ id: 'ml-hot' });
    const coldM = makeMemo({ id: 'ml-cold' });
    await store.append(hotM);
    await store.append(coldM);
    await seedEmbedding(store, hotM.id, 'HOT');
    await seedEmbedding(store, coldM.id, 'ARCHIVED');

    const q = new Float32Array(384);

    // Phase 1: HOT
    const hotRes = store.searchByVectorVec0(q, {
      k: 10, scoreTier: 'HOT', distanceCutoff: 100,
    });
    const hotIds = new Set(hotRes.map((r) => r.memo_id));
    expect(hotIds.has('ml-hot')).toBe(true);

    // Phase 2: if < 3 hot results, fallback to ARCHIVED
    if (hotRes.length < 3) {
      const coldRes = store.searchByVectorVec0(q, {
        k: 10, scoreTier: 'ARCHIVED', distanceCutoff: 100,
      });
      for (const r of coldRes) {
        if (!hotIds.has(r.memo_id)) {
          hotIds.add(r.memo_id);
        }
      }
    }
    // Should now have both hot and cold memos
    expect(hotIds.has('ml-hot')).toBe(true);
    expect(hotIds.has('ml-cold')).toBe(true);
  });
});

describe('consolidator → demote integration', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-tier-dream-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('applyConsolidation calls store.demote for resolved memos', async () => {
    // resolved = outcome "完成" + older than 7 days
    const resolved = createMemoryMemo({
      userNeed: '已解决的测试任务',
      approach: '方案A',
      outcome: '完成',
      whatFailed: 'none',
      whatWorked: '方案A有效',
      extractionSource: 'exit',
      sourceSessionId: 's1',
      recordedAt: Date.now() - 14 * 24 * 60 * 60 * 1000, // 14 days old
    });
    await store.append(resolved);

    const { buildConsolidationPlan, applyConsolidation } = await import('../src/consolidator.js');
    const plan = await buildConsolidationPlan(store);
    expect(plan.resolved.length).toBeGreaterThanOrEqual(1);

    const result = await applyConsolidation(store, plan);
    // resolved should be demoted (deleted from hot, present in archive)
    expect(await store.get(resolved.id)).toBeUndefined();

    // Check archive
    const archived = await (store as any).getArchived(resolved.id);
    expect(archived).toBeDefined();
    expect(archived.id).toBe(resolved.id);
  });
});
