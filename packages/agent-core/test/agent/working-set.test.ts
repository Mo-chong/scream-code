import { describe, expect, it } from 'vitest';
import {
  DECAY_TURNS,
  VERIFICATION_COMMANDS,
  type VerificationRecord,
  WorkingSet,
} from '../../src/agent/working-set.js';

describe('WorkingSet', () => {
  describe('verification deduplication', () => {
    it('records a passed verification and finds it within the dedup window', () => {
      const ws = new WorkingSet();
      const record = ws.recordVerification('pnpm test', '/work', 0, 'ok', 1);
      expect(record.passed).toBe(true);
      expect(record.output).toBe('ok');
      expect(record.turnId).toBe(1);
      expect(ws.getVerificationCount()).toBe(1);

      const found = ws.findRecentVerification('pnpm test', '/work', 'ok');
      expect(found).not.toBeNull();
      expect(found?.command).toBe(record.command);
    });

    it('normalizes commands before matching', () => {
      const ws = new WorkingSet();
      ws.recordVerification('  pnpm  test  ;', '/work', 0, 'ok', 1);
      expect(ws.findRecentVerification('pnpm test', '/work', 'ok')).not.toBeNull();
    });

    it('does not match when output changes', () => {
      const ws = new WorkingSet();
      ws.recordVerification('pnpm test', '/work', 0, 'ok', 1);
      expect(ws.findRecentVerification('pnpm test', '/work', 'not ok')).toBeNull();
    });

    it('does not match failed verifications', () => {
      const ws = new WorkingSet();
      ws.recordVerification('pnpm test', '/work', 1, 'failed', 1);
      expect(ws.findRecentVerification('pnpm test', '/work', 'failed')).toBeNull();
    });

    it('does not match commands outside the dedup window', () => {
      const ws = new WorkingSet();
      const record: VerificationRecord = {
        command: 'pnpm test',
        cwd: '/work',
        exitCode: 0,
        output: '',
        outputDigest: '0',
        timestamp: Date.now() - 61_000,
        turnId: 1,
        passed: true,
      };
      // @ts-expect-error private field access for testing
      ws.verifications = [record];
      expect(ws.findRecentVerification('pnpm test', '/work', '')).toBeNull();
    });

    it('prunes stale records when adding a new one', () => {
      const ws = new WorkingSet();
      const old: VerificationRecord = {
        command: 'pnpm old',
        cwd: '/work',
        exitCode: 0,
        output: '',
        outputDigest: '0',
        timestamp: Date.now() - 61_000,
        turnId: 1,
        passed: true,
      };
      // @ts-expect-error private field access for testing
      ws.verifications = [old];
      ws.recordVerification('pnpm new', '/work', 0, 'ok', 2);
      expect(ws.getVerificationCount()).toBe(1);
    });

    it('clears all verifications on request', () => {
      const ws = new WorkingSet();
      ws.recordVerification('pnpm test', '/work', 0, 'ok', 1);
      ws.clearVerifications();
      expect(ws.getVerificationCount()).toBe(0);
    });
  });

  describe('verification skip candidate', () => {
    it('returns a candidate when command passed recently and no edits occurred', () => {
      const ws = new WorkingSet();
      ws.recordVerification('pnpm test', '/work', 0, 'ok', 5);
      const candidate = ws.findSkipCandidate('pnpm test', '/work', 6);
      expect(candidate).not.toBeNull();
      expect(candidate?.output).toBe('ok');
    });

    it('does not skip when an unverified file was touched after the record', () => {
      const ws = new WorkingSet();
      ws.recordVerification('pnpm test', '/work', 0, 'ok', 5);
      ws.touch('src/index.ts', 6);
      expect(ws.findSkipCandidate('pnpm test', '/work', 6)).toBeNull();
    });

    it('skips when a verified file was touched after the record', () => {
      const ws = new WorkingSet();
      ws.recordVerification('pnpm test', '/work', 0, 'ok', 5);
      ws.markRead('src/index.ts', 6);
      expect(ws.findSkipCandidate('pnpm test', '/work', 6)).not.toBeNull();
    });

    it('does not skip failed verifications', () => {
      const ws = new WorkingSet();
      ws.recordVerification('pnpm test', '/work', 1, 'failed', 5);
      expect(ws.findSkipCandidate('pnpm test', '/work', 6)).toBeNull();
    });

    it('normalizes commands when finding skip candidates', () => {
      const ws = new WorkingSet();
      ws.recordVerification('  pnpm  test  ;', '/work', 0, 'ok', 1);
      expect(ws.findSkipCandidate('pnpm test', '/work', 2)).not.toBeNull();
    });
  });

  describe('path tracking', () => {
    it('marks edited paths as unverified', () => {
      const ws = new WorkingSet();
      ws.touch('src/index.ts', 1);
      expect(ws.getUnverifiedPaths()).toContain('src/index.ts');
    });

    it('marks read paths as verified by default', () => {
      const ws = new WorkingSet();
      ws.markRead('src/index.ts', 1);
      expect(ws.getUnverifiedPaths()).toHaveLength(0);
    });

    it('decays old entries', () => {
      const ws = new WorkingSet();
      ws.touch('src/index.ts', 1);
      ws.decay(1 + DECAY_TURNS + 1);
      expect(ws.getUnverifiedPaths()).toHaveLength(0);
    });
  });

  describe('verification command suggestions', () => {
    it('suggests node commands for package.json', () => {
      const ws = new WorkingSet();
      ws.touch('package.json', 1);
      expect(ws.suggestVerificationCommands()).toEqual([...VERIFICATION_COMMANDS.node]);
    });

    it('returns empty when no unverified paths', () => {
      const ws = new WorkingSet();
      ws.markRead('package.json', 1);
      expect(ws.suggestVerificationCommands()).toHaveLength(0);
    });
  });
});
