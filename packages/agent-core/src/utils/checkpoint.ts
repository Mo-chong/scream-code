import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CheckpointManager — tool-edit safety net.
 *
 * Snapshots file content before every Edit/Write and restores on /rewind.
 * Storage: Map<turnNumber, Map<filePath, content>>, persisted per session.
 */

interface FileSnap {
  /** file content before edit; null = file did not exist */
  content: string | null;
}

export class CheckpointManager {
  private checkpoints = new Map<number, Map<string, FileSnap>>();
  private _currentTurn = 0;

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
    turnMap.set(filePath, { content });
  }

  /**
   * Restore all files that were edited at or after `fromTurn`.
   * Returns list of files restored.
   */
  restoreFromTurn(fromTurn: number): string[] {
    const restored: string[] = [];
    const earliest = new Map<string, string | null>();

    // Collect the earliest snapshot per file across checkpoints >= fromTurn
    for (const [turn, snaps] of this.checkpoints) {
      if (turn < fromTurn) continue;
      for (const [path, snap] of snaps) {
        if (!earliest.has(path)) earliest.set(path, snap.content);
      }
    }

    // Restore: write back content or delete file
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
      } catch (e) {
        // skip files that can't be restored (e.g. locked or path invalid)
      }
    }

    return restored;
  }

  get currentTurn() {
    return this._currentTurn;
  }
}
