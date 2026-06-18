const DECAY_TURNS = 10;

interface WorkingSetEntry {
  readonly path: string;
  lastTurn: number;
}

/**
 * Tracks file paths the agent has recently read, edited, or searched.
 *
 * The set is injected into each turn as a system reminder so the model can
 * prioritize files it is already working with instead of re-reading unchanged
 * files. Entries decay after they have not been touched for 10 turns.
 */
export class WorkingSet {
  private entries = new Map<string, WorkingSetEntry>();

  touch(path: string, turn: number): void {
    if (path.length === 0) return;
    const normalized = path.replaceAll('\\', '/');
    this.entries.set(normalized, { path: normalized, lastTurn: turn });
  }

  decay(currentTurn: number): void {
    const cutoff = currentTurn - DECAY_TURNS;
    for (const [key, entry] of this.entries) {
      if (entry.lastTurn < cutoff) {
        this.entries.delete(key);
      }
    }
  }

  getPaths(): string[] {
    return [...this.entries.keys()].toSorted();
  }

  clear(): void {
    this.entries.clear();
  }
}
