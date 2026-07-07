import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryMemoStore } from '../../src/store.js';
import { createMemoryMemo } from '../../src/models.js';
import type { MemoryMemo } from '../../src/models.js';

function makeEntry(overrides: Partial<MemoryMemo> = {}): MemoryMemo {
  return createMemoryMemo({
    userNeed: 'General need for the project',
    approach: 'General approach taken here',
    outcome: '完成',
    whatFailed: 'none',
    whatWorked: 'none',
    extractionSource: 'exit',
    sourceSessionId: 'test-session',
    sourceSessionTitle: 'Test Session',
    ...overrides,
  });
}

describe('store classify → demote integration', () => {
  let tmpDir: string;
  let store: MemoryMemoStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'scream-memory-int-'));
    store = new MemoryMemoStore(tmpDir);
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a critical memo (matching "bug") and valueTier is critical', async () => {
    const entry = makeEntry({ userNeed: 'I found a bug in the auth module today' });
    await store.append(entry);
    const saved = await store.get(entry.id);
    expect(saved).toBeTruthy();
    expect(saved!.valueTier).toBe('critical');
  });

  it('writes a valuable memo (matching "performance") and valueTier is valuable', async () => {
    const entry = makeEntry({ userNeed: 'I improved the query performance by adding an index' });
    await store.append(entry);
    const saved = await store.get(entry.id);
    expect(saved).toBeTruthy();
    expect(saved!.valueTier).toBe('valuable');
  });

  it('writes a memo with short userNeed (other fields push length > 30 → normal)', async () => {
    const entry = makeEntry({ userNeed: 'short' }); // approach + outcome = >30 chars, no keywords
    await store.append(entry);
    const saved = await store.get(entry.id);
    expect(saved).toBeTruthy();
    expect(saved!.valueTier).toBe('normal');
  });

  it('writes a normal memo (long text, no keywords)', async () => {
    const entry = makeEntry({ userNeed: 'the weather outside is nice today for a walk' });
    await store.append(entry);
    const saved = await store.get(entry.id);
    expect(saved).toBeTruthy();
    expect(saved!.valueTier).toBe('normal');
  });

  it('does not overwrite externally-set valueTier', async () => {
    const entry = makeEntry({ userNeed: 'some meeting notes for today', valueTier: 'critical' });
    await store.append(entry);
    const saved = await store.get(entry.id);
    expect(saved!.valueTier).toBe('critical');
  });

  it('auto-tags a memo with inferred tags', async () => {
    const entry = makeEntry({ userNeed: 'I fixed the memory leak in the db connection pool' });
    await store.append(entry);
    const saved = await store.get(entry.id);
    expect(saved).toBeTruthy();
    expect(saved!.tags).toBeDefined();
    expect(saved!.tags!.some(t => t.includes('bug'))).toBe(true);
    expect(saved!.tags!.some(t => t.includes('db'))).toBe(true);
  });

  it('does not crash on empty/normal-only entries', async () => {
    const entry = makeEntry({ userNeed: 'none', whatFailed: 'none', whatWorked: 'n/a' });
    await expect(store.append(entry)).resolves.not.toThrow();
    const saved = await store.get(entry.id);
    expect(saved).toBeTruthy();
  });

  it('preserves valueTier after update', async () => {
    const entry = makeEntry({ userNeed: 'Testing update preserves valueTier', valueTier: 'critical' });
    await store.append(entry);

    // Read back after append — tier must be preserved
    let saved = await store.get(entry.id);
    expect(saved!.valueTier).toBe('critical');

    // Update the memo (keep valueTier in the patch)
    await store.update(entry.id, { userNeed: 'Updated user need for testing' });

    // Read back after update — tier must still be preserved
    saved = await store.get(entry.id);
    expect(saved!.valueTier).toBe('critical');
    expect(saved!.userNeed).toBe('Updated user need for testing');
  });

  it('can change valueTier via update', async () => {
    const entry = makeEntry({ userNeed: 'Testing valueTier change via update' });
    await store.append(entry);
    let saved = await store.get(entry.id);
    // After append without explicit tier, auto-classifier decides (likely 'normal' for this text)
    const originalTier = saved!.valueTier;

    // Promote via update
    await store.update(entry.id, { valueTier: 'critical' });

    saved = await store.get(entry.id);
    expect(saved!.valueTier).toBe('critical');
  });
});
