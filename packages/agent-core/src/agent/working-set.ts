const DECAY_TURNS = 10;

type ProjectKind = 'node' | 'rust' | 'python' | 'go' | 'unknown';

interface WorkingSetEntry {
  readonly path: string;
  lastTurn: number;
  lastReadTurn?: number;
  verified: boolean;
}

interface ProjectFingerprint {
  readonly kind: ProjectKind;
  readonly packageFile?: string;
}

const VERIFICATION_COMMANDS: Record<ProjectKind, readonly string[]> = {
  node: ['pnpm test', 'pnpm lint', 'pnpm typecheck'],
  rust: ['cargo test', 'cargo clippy'],
  python: ['pytest', 'python -m pytest'],
  go: ['go test ./...', 'go vet ./...'],
  unknown: [],
};

/**
 * Tracks file paths the agent has recently read, edited, or searched.
 *
 * The set is injected into each turn as a system reminder so the model can
 * prioritize files it is already working with instead of re-reading unchanged
 * files. Entries decay after they have not been touched for 10 turns.
 *
 * A `verified` flag tracks whether a touched file still has unverified changes.
 * Writing or editing a path resets it to unverified; running a verification
 * command (build/test/lint) marks paths verified. This feeds the convergence
 * gate in TurnFlow so the agent cannot stop while changes are unverified.
 *
 * A separate `lastReadTurn` tracks when a path was last read. Edit tools can
 * warn when the model attempts to edit a file that has not been read recently,
 * reducing anchor mismatches caused by stale reads.
 */
export class WorkingSet {
  private entries = new Map<string, WorkingSetEntry>();

  touch(path: string, turn: number): void {
    if (path.length === 0) return;
    const normalized = path.replaceAll('\\', '/');
    const existing = this.entries.get(normalized);
    this.entries.set(normalized, {
      path: normalized,
      lastTurn: turn,
      lastReadTurn: existing?.lastReadTurn,
      verified: false,
    });
  }

  markRead(path: string, turn: number): void {
    if (path.length === 0) return;
    const normalized = path.replaceAll('\\', '/');
    const existing = this.entries.get(normalized);
    if (existing !== undefined) {
      this.entries.set(normalized, { ...existing, lastTurn: turn, lastReadTurn: turn });
    } else {
      this.entries.set(normalized, {
        path: normalized,
        lastTurn: turn,
        lastReadTurn: turn,
        verified: true,
      });
    }
  }

  markVerified(path: string): void {
    const normalized = path.replaceAll('\\', '/');
    const entry = this.entries.get(normalized);
    if (entry !== undefined) {
      this.entries.set(normalized, { ...entry, verified: true });
    }
  }

  markAllVerified(): void {
    for (const [key, entry] of this.entries) {
      this.entries.set(key, { ...entry, verified: true });
    }
  }

  getUnverifiedPaths(): string[] {
    return [...this.entries.values()]
      .filter((entry) => !entry.verified)
      .map((entry) => entry.path)
      .toSorted();
  }

  /**
   * Returns the turn number of the most recent Read for a path, or undefined
   * if the path has never been read. Used by EditTool to warn about stale edits.
   */
  lastReadTurn(path: string): number | undefined {
    const normalized = path.replaceAll('\\', '/');
    return this.entries.get(normalized)?.lastReadTurn;
  }

  decay(currentTurn: number): void {
    const cutoff = currentTurn - DECAY_TURNS;
    for (const [key, entry] of this.entries) {
      if (entry.lastTurn < cutoff) {
        this.entries.delete(key);
      }
    }
  }

  /**
   * Heuristically determines the project type from the working set and
   * suggests a list of verification commands. The suggestions are ordered
   * from most specific (tests) to broadest (typecheck). Empty if there are
   * no unverified paths.
   */
  suggestVerificationCommands(_workspaceRoot = '.'): string[] {
    const unverified = this.getUnverifiedPaths();
    if (unverified.length === 0) return [];

    const fingerprint = this.detectProjectKind();
    const commands = [...VERIFICATION_COMMANDS[fingerprint.kind]];
    return commands.length > 0 ? commands : ['Run the appropriate build/test command for this project'];
  }

  private detectProjectKind(): ProjectFingerprint {
    // Fast path: infer from the paths in the working set.
    for (const entry of this.entries.values()) {
      const path = entry.path.toLowerCase();
      if (path.endsWith('package.json') || path.includes('/package.json')) {
        return { kind: 'node', packageFile: entry.path };
      }
      if (path.endsWith('cargo.toml') || path.includes('/cargo.toml')) {
        return { kind: 'rust', packageFile: entry.path };
      }
      if (path.endsWith('pyproject.toml') || path.includes('/pyproject.toml')) {
        return { kind: 'python', packageFile: entry.path };
      }
      if (path.endsWith('go.mod') || path.includes('/go.mod')) {
        return { kind: 'go', packageFile: entry.path };
      }
    }
    return { kind: 'unknown' };
  }

  getPaths(): string[] {
    return [...this.entries.keys()].toSorted();
  }

  clear(): void {
    this.entries.clear();
  }
}
