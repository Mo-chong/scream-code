import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CheckpointManager — tool-edit safety net with bidirectional rewind/forward.
 *
 * Snapshots file content before every Edit/Write, records the result after,
 * so you can rewind (restore before) and forward (restore after) at will.
 *
 *     Turn 3: Edit app.ts
 *       snapshot('app.ts')   → stores "before" (original)
 *       execute Edit
 *       recordAfter('app.ts') → stores "after" (AI's edit result)
 *
 *     /rewind  → restoreFromTurn(3) → app.ts ← "before" (original)
 *     /forward → forwardToLatest()  → app.ts ← "after" (AI's edit result)
 */

interface FileSnap {
  /** file content before edit; null = file did not exist */
  before: string | null;
  /** file content after edit; null = file was deleted */
  after: string | null;
}

export class CheckpointManager {
  private checkpoints = new Map<number, Map<string, FileSnap>>();
  /** Saved current-file state during restore; used by forwardToLatest() */
  private redoStack: Map<string, string | null> | null = null;
  private _currentTurn = 0;
  private _hasRestored = false;

  /** Call at turn start. */
  beginTurn(turn: number) {
    this._currentTurn = turn;
    if (!this.checkpoints.has(turn)) {
      this.checkpoints.set(turn, new Map());
    }
  }

  /** Snapshot a file before it is written. Safe to call multiple times for same path within a turn (only first snapshot is kept). */
  snapshot(filePath: string) {
    const turnMap = this.checkpoints.get(this._currentTurn)!;
    if (turnMap.has(filePath)) return; // already snapshotted this turn

    let content: string | null;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      content = null; // file did not exist
    }
    turnMap.set(filePath, { before: content, after: null });
  }

  /** Record the file content after the tool executed. Must be called once per snapshot. */
  recordAfter(filePath: string) {
    // Walk checkpoints backward to find the snapshot for this file in current or recent turns
    for (let turn = this._currentTurn; turn >= 0; turn--) {
      const turnMap = this.checkpoints.get(turn);
      if (!turnMap) continue;
      const snap = turnMap.get(filePath);
      if (snap && snap.after === null) {
        let content: string | null;
        try {
          content = readFileSync(filePath, 'utf-8');
        } catch {
          content = null; // file was deleted
        }
        snap.after = content;
        return;
      }
    }
  }

  /**
   * Restore all files that were edited at or after `fromTurn`.
   * Saves current file states to redoStack for forwardToLatest().
   * Returns list of files restored.
   */
  restoreFromTurn(fromTurn: number): string[] {
    const earliest = new Map<string, string | null>();
    const current = new Map<string, string | null>();

    // Collect the earliest "before" snapshot per file across checkpoints >= fromTurn
    for (const [turn, snaps] of this.checkpoints) {
      if (turn < fromTurn) continue;
      for (const [path, snap] of snaps) {
        if (!earliest.has(path)) {
          earliest.set(path, snap.before);
        }
      }
    }

    // Save current file content to redoStack before overwriting
    const redo = new Map<string, string | null>();
    for (const [path] of earliest) {
      try {
        redo.set(path, readFileSync(path, 'utf-8'));
      } catch {
        redo.set(path, null); // file doesn't exist now
      }
    }
    this.redoStack = redo;
    this._hasRestored = true;

    // Restore: write back "before" content or delete file
    const restored: string[] = [];
    for (const [path, content] of earliest) {
      try {
        if (content === null) {
          if (existsSync(path)) unlinkSync(path);
        } else {
          const dir = path.substring(0, path.lastIndexOf('\\'));
          if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(path, content, 'utf-8');
        }
        restored.push(path);
      } catch {
        // skip files that can't be restored (locked, path invalid, etc.)
      }
    }

    return restored;
  }

  /**
   * Forward to the latest "after" state (undoes the last restoreFromTurn).
   * Only callable after at least one restoreFromTurn.
   * Returns list of files forwarded.
   */
  forwardToLatest(): string[] {
    if (!this._hasRestored || !this.redoStack) return [];

    const forwarded: string[] = [];
    for (const [path, content] of this.redoStack) {
      try {
        if (content === null) {
          if (existsSync(path)) unlinkSync(path);
        } else {
          const dir = path.substring(0, path.lastIndexOf('\\'));
          if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(path, content, 'utf-8');
        }
        forwarded.push(path);
      } catch {
        // skip files that can't be restored
      }
    }

    this.redoStack = null;
    this._hasRestored = false;
    return forwarded;
  }

  get currentTurn() {
    return this._currentTurn;
  }

  get hasRestored() {
    return this._hasRestored;
  }
}
