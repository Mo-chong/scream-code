import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'pathe';

import * as sqliteVec from '@photostructure/sqlite-vec';

import type { MemoryMemo, MemoryMemoListResult } from './models.js';
import { toSummary } from './models.js';
import { buildEmbeddingText, type EmbeddingEngine } from './embeddings.js';
import { computeTagSetQuality, TAG_CONFIG } from './tags.js';

const FILE_NAME = 'entries.jsonl';
const MIGRATION_MARKER = '.migrated';
const SQLITE_MIGRATION_MARKER = '.migrated-to-sqlite';
const VEC0_MIGRATION_MARKER = '.migrated-vec0';

// --- vec0 / hot-cold tier constants ---
const VEC0_DIMS = 512;
const HOT_MAX_SIZE = 100;
const DEMOTE_RESNET_THRESHOLD = 0.3;
const DEMOTE_DAYS_NO_HIT = 30;
const PROMOTE_HIT_COUNT = 2;
const PROMOTE_RESERVE_SPACE = 10;
const DEMOTE_BATCH_SIZE = 5;


export interface MemoryMemoStoreLogger {
  debug?: (message: string, ...args: unknown[]) => void;
  info?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
}

export class MemoryMemoStore {
  private readonly projectDir: string;
  private readonly jsonlPath: string;
  private readonly dbPath: string;
  private db: DatabaseSync | undefined;
  private initialized = false;
  private writeLock: Promise<unknown> = Promise.resolve();
  private embeddingEngine: EmbeddingEngine | undefined;
  private embeddingQueue = new Set<string>();
  private embeddingTimer: ReturnType<typeof setTimeout> | undefined;
  private embeddingFlushing = false;
  private embeddingDegraded = false;
  private embeddingConsecutiveFailures = 0;
  private lastEmbeddingError: Error | undefined;
  private lastAutoDemoteAt = 0;
  private static readonly AUTO_DEMOTE_INTERVAL_MS = 5 * 60 * 1000; // 5 min throttle
  private readonly log: MemoryMemoStoreLogger;

  /**
   * Phase 4: Deviation chain counter. Tracks consecutive low-quality tag
   * sets being written. When the limit is exceeded, new writes are still
   * accepted but the condition is exposed via isBadTaggingStreak() so
   * upstream callers can inject prompt-level intervention.
   */
  private consecutiveBadTagSets = 0;

  constructor(projectDir: string, log?: MemoryMemoStoreLogger) {
    this.projectDir = projectDir;
    this.jsonlPath = join(projectDir, 'memory', FILE_NAME);
    this.dbPath = join(projectDir, 'memory', 'memos.sqlite');
    this.log = log ?? {};
  }

  /**
   * Open the SQLite database and run schema migrations. Call this once after
   * construction before relying on reads/writes.
   *
   * Note on async SQLite: Node.js added the asynchronous `Database` class to
   * `node:sqlite` in v23.4.0 (experimental). This package currently supports
   * Node >=22.0.0 and uses `DatabaseSync` because the v22 type definitions do
   * not yet include `Database`. Once the project baseline moves to Node 23+ and
   * the types catch up, the synchronous calls here should be migrated to the
   * async API to avoid blocking the event loop on large operations.
   */
  private initPromise: Promise<void> | null = null;

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit();
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    if (this.initialized) return;
    await this.ensureDir();
    this.db = new DatabaseSync(this.dbPath, { allowExtension: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    sqliteVec.load(this.db);
    this.createSchema();
    await this.migrateFromJsonl();
    await this.migrateVec0();
    this.rebuildVec0IfNeeded();
    this.initialized = true;
  }

  /** Close the database handle and checkpoint WAL. */
  close(): void {
    if (this.db !== undefined) {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      this.db.close();
      this.db = undefined;
    }
    this.initialized = false;
    this.initPromise = null;
  }

  /** Iterate all memos from the database, newest first. Optionally filter by project directory. */
  async *read(options?: { projectDir?: string }): AsyncIterable<MemoryMemo> {
    await this.init();
    if (this.db === undefined) return;
    const projectDir = options?.projectDir;
    const stmt =
      projectDir === undefined
        ? this.db.prepare('SELECT * FROM memos ORDER BY recorded_at DESC')
        : this.db.prepare(
          // NOTE: `project_dir = ''` includes legacy memos from before per-project
          // filtering was introduced. This is intentional — project queries always
          // include global/legacy entries alongside the requested project.
            "SELECT * FROM memos WHERE project_dir = ? OR project_dir = '' ORDER BY recorded_at DESC",
          );
    // NOTE: stmt.all() materializes the entire result set. For large stores
    // this loads all rows into memory. Use paginated list() for bounded reads.
    const rows = (
      projectDir === undefined ? stmt.all() : stmt.all(projectDir)
    ) as Array<Record<string, unknown>>;
    for (const row of rows) {
      yield rowToMemo(row);
    }
  }

  /** Append a memo. */
  async append(entry: MemoryMemo): Promise<void> {
    return this.withWriteLock(() => this.appendInternal(entry));
  }

  /** Delete a memo by id. */
  async delete(id: string): Promise<boolean> {
    return this.withWriteLock(() => this.deleteInternal(id));
  }

  /** Get a single memo by ID. */
  async get(id: string): Promise<MemoryMemo | undefined> {
    await this.init();
    if (this.db === undefined) return undefined;
    const stmt = this.db.prepare('SELECT * FROM memos WHERE id = ?');
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row !== undefined ? rowToMemo(row) : undefined;
  }

  /**
   * Full-text search over memos using the FTS5 index.
   *
   * Returns raw candidates newest first. Callers that need ranking should pass
   * the results to `rankMemos`. An empty or whitespace-only query returns an
   * empty array.
   */
  async search(
    query: string,
    options?: { candidateLimit?: number; projectDir?: string },
  ): Promise<MemoryMemo[]> {
    await this.init();
    if (this.db === undefined) return [];
    const ftsQuery = buildFtsQuery(query);
    if (ftsQuery === undefined) return [];
    const limit = options?.candidateLimit ?? 200;
    const projectDir = options?.projectDir;
    const stmt =
      projectDir === undefined
        ? this.db.prepare(
            `SELECT m.* FROM memos m
         JOIN memos_fts f ON m.rowid = f.rowid
         WHERE f.memos_fts MATCH ?
         ORDER BY m.recorded_at DESC LIMIT ?`,
          )
        : this.db.prepare(
            `SELECT m.* FROM memos m
         JOIN memos_fts f ON m.rowid = f.rowid
         WHERE f.memos_fts MATCH ? AND (m.project_dir = ? OR m.project_dir = '')
         ORDER BY m.recorded_at DESC LIMIT ?`,
          );
    const rows = (
      projectDir === undefined ? stmt.all(ftsQuery, limit) : stmt.all(ftsQuery, projectDir, limit)
    ) as Array<Record<string, unknown>>;
    return rows.map(rowToMemo);
  }

  /** List memos with optional full-text search and pagination. */
  async list(options?: {
    search?: string;
    limit?: number;
    offset?: number;
    projectDir?: string;
  }): Promise<MemoryMemoListResult> {
    await this.init();
    if (this.db === undefined) return { memos: [], total: 0 };

    const search = options?.search?.toLowerCase().trim();
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const projectDir = options?.projectDir;

    if (search !== undefined && search.length > 0) {
      let candidates = await this.search(search, { projectDir });
      // Preserve the pre-SQLite behavior: keyword search is intersected with a
      // substring filter so the exact query string must appear somewhere in the
      // memo text.
      if (candidates.length === 0) {
        // Fallback: scan the full store so tags and wording not captured by the
        // FTS index are still considered.
        for await (const memo of this.read({ projectDir })) {
          candidates.push(memo);
        }
      }
      const filtered = candidates.filter((memo) => memoMatchesSearch(memo, search));
      const total = filtered.length;
      return { memos: filtered.slice(offset, offset + limit).map(toSummary), total };
    }

    const { rows, total } = this.listAll(limit, offset, projectDir);
    return { memos: rows.map(toSummary), total };
  }

  /**
   * One-time migration from per-workDir memory stores to a global store.
   * Reads `<screamHomeDir>/sessions/<workDirKey>/memory/entries.jsonl`
   * and appends valid entries to the global SQLite store.
   * Deletes the legacy per-session memory files afterwards and writes a marker
   * file so the migration only runs once.
   */
  static async migrateLegacyStores(screamHomeDir: string): Promise<void> {
    const target = new MemoryMemoStore(screamHomeDir);
    const markerPath = join(screamHomeDir, 'memory', MIGRATION_MARKER);

    try {
      await stat(markerPath);
      return; // already migrated
    } catch {
      // continue with migration
    }

    const sessionsDir = join(screamHomeDir, 'sessions');
    let sessionEntries: string[];
    try {
      sessionEntries = await readdir(sessionsDir, { withFileTypes: true })
        .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name));
    } catch {
      await writeFile(markerPath, '', 'utf8').catch(() => {});
      return;
    }

    const migratedIds = new Set<string>();
    for await (const memo of target.read()) {
      migratedIds.add(memo.id);
    }

    let migratedCount = 0;
    const legacyPaths: string[] = [];
    for (const sessionKey of sessionEntries) {
      const legacyPath = join(sessionsDir, sessionKey, 'memory', FILE_NAME);
      let stream: import('node:fs').ReadStream;
      try {
        stream = createReadStream(legacyPath, { encoding: 'utf8' });
      } catch {
        // Sync error (invalid path) — skip this file.
      }

      // Swallow async ENOENT errors when the legacy file does not exist.
      stream!.on('error', () => {});

      let line = '';
      try {
        for await (const chunk of stream!) {
          line += chunk;
          let newlineIndex = line.indexOf('\n');
          while (newlineIndex !== -1) {
            const rawLine = line.slice(0, newlineIndex).replace(/\r$/, '');
            line = line.slice(newlineIndex + 1);
            newlineIndex = line.indexOf('\n');

            const memo = target.parseLine(rawLine, 0);
            if (memo === undefined || migratedIds.has(memo.id)) continue;
            await target.append(memo);
            migratedIds.add(memo.id);
            migratedCount++;
          }
        }
      } catch {
        continue;
      }

      // Track the file for deletion only if we successfully read its stream.
      // We delete regardless of whether any new entries were migrated; the
      // global store is now the source of truth.
      legacyPaths.push(legacyPath);
    }

    // Delete legacy per-session memory files and empty memory directories.
    for (const legacyPath of legacyPaths) {
      await unlink(legacyPath).catch(() => {});
      await rmdir(dirname(legacyPath)).catch(() => {});
    }

    await writeFile(markerPath, `${migratedCount}\n`, 'utf8').catch(() => {});
    target.close();
  }

  /** @internal */
  parseLine(rawLine: string, _lineNumber: number): MemoryMemo | undefined {
    if (rawLine.length === 0) return undefined;
    try {
      const record = JSON.parse(rawLine) as Record<string, unknown>;
      if (record['type'] !== 'memory_memo' || !record['entry']) return undefined;
      const entry = record['entry'] as Record<string, unknown>;

      // Migrate v1 → v2 field names
      if (record['version'] === 1 || (entry['userRequirement'] !== undefined && entry['userNeed'] === undefined)) {
        const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
        return {
          id: str(entry['id']),
          sourceSessionId: str(entry['sourceSessionId']),
          sourceSessionTitle: str(entry['sourceSessionTitle'], undefined as unknown as string),
          userNeed: str(entry['userRequirement']),
          approach: str(entry['solution']),
          outcome: str(entry['completionStatus']),
          whatFailed: str(entry['problemsEncountered'], 'none'),
          whatWorked: 'none',
          extractionSource: entry['extractionSource'] === 'exit' ? 'exit' : 'compaction',
          recordedAt: typeof entry['recordedAt'] === 'number' ? entry['recordedAt'] : 0,
          projectDir: str(entry['projectDir']),
        };
      }

      // Validate v2 fields that have CHECK constraints
      const src = entry['extractionSource'];
      if (typeof src === 'string' && !['compaction', 'exit', 'manual'].includes(src)) {
        return undefined;
      }

      return entry as unknown as MemoryMemo;
    } catch {
      // Skip corrupted lines
      return undefined;
    }
  }

  private createSchema(): void {
    if (this.db === undefined) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memos (
        id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL,
        source_session_title TEXT,
        user_need TEXT NOT NULL,
        approach TEXT NOT NULL,
        outcome TEXT NOT NULL,
        what_failed TEXT NOT NULL DEFAULT 'none',
        what_worked TEXT NOT NULL DEFAULT 'none',
        extraction_source TEXT NOT NULL CHECK(extraction_source IN ('compaction', 'exit', 'manual')),
        recorded_at INTEGER NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]'
      );

      CREATE INDEX IF NOT EXISTS idx_memos_project_dir ON memos(project_dir);

      CREATE VIRTUAL TABLE IF NOT EXISTS memos_fts USING fts5(
        user_need,
        approach,
        what_failed,
        what_worked,
        source_session_title,
        content=''
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT PRIMARY KEY REFERENCES memos(id) ON DELETE CASCADE,
        embedding_json TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'bge-small-zh-v1.5',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_created_at ON memory_embeddings(created_at DESC);

      -- vec0 virtual table: all memos have a vector index here
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_memos USING vec0(
        memo_embedding float[${VEC0_DIMS}],
        project_dir TEXT partition key,
        extraction_source TEXT,
        recorded_at INTEGER,
        +memo_id TEXT,
        +score_tier TEXT,
        +user_need TEXT,
        +approach TEXT,
        +outcome TEXT
      );

      -- memos_archive: cold tier for infrequently used memos
      CREATE TABLE IF NOT EXISTS memos_archive (
        id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL,
        source_session_title TEXT,
        user_need TEXT NOT NULL,
        approach TEXT NOT NULL,
        outcome TEXT NOT NULL,
        what_failed TEXT NOT NULL DEFAULT 'none',
        what_worked TEXT NOT NULL DEFAULT 'none',
        extraction_source TEXT NOT NULL CHECK(extraction_source IN ('compaction', 'exit', 'manual')),
        recorded_at INTEGER NOT NULL,
        project_dir TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        archived_at INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        last_hit_at INTEGER NOT NULL DEFAULT 0,
        embedding_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_archive_archived_at ON memos_archive(archived_at DESC);
      CREATE INDEX IF NOT EXISTS idx_archive_project_dir ON memos_archive(project_dir);
    `);
    this.migrateSchema();
  }

  // Migrate schema: uses PRAGMA table_info column-existence checks rather
  // than PRAGMA user_version. Future migrations should adopt user_version
  // with a numbered migration runner for ordered, idempotent upgrades.
  private migrateSchema(): void {
    if (this.db === undefined) return;
    const info = this.db.prepare('PRAGMA table_info(memos)').all() as Array<{
      name: string;
    }>;
    const hasProjectDir = info.some((col) => col.name === 'project_dir');
    if (!hasProjectDir) {
      this.db.exec("ALTER TABLE memos ADD COLUMN project_dir TEXT NOT NULL DEFAULT ''");
    }
    const hasTags = info.some((col) => col.name === 'tags');
    if (!hasTags) {
      this.db.exec("ALTER TABLE memos ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
    }
    // Ensure indexes exist even for databases created before these indexes were added.
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memos_project_dir ON memos(project_dir);
      CREATE INDEX IF NOT EXISTS idx_memory_embeddings_created_at ON memory_embeddings(created_at DESC);
    `);
  }

  private async migrateFromJsonl(): Promise<void> {
    const markerPath = join(this.projectDir, 'memory', SQLITE_MIGRATION_MARKER);
    try {
      await stat(markerPath);
      return;
    } catch {
      // continue with migration
    }

    const memos: MemoryMemo[] = [];
    let stream: import('node:fs').ReadStream;
    try {
      stream = createReadStream(this.jsonlPath, { encoding: 'utf8' });
    } catch {
      // Sync error (invalid path) — nothing to migrate.
      await writeFile(markerPath, '', 'utf8').catch(() => {});
      return;
    }

    // Swallow async ENOENT errors when the legacy file does not exist.
    stream!.on('error', () => {});

    let line = '';
    try {
      for await (const chunk of stream!) {
        line += chunk;
        let newlineIndex = line.indexOf('\n');
        while (newlineIndex !== -1) {
          const rawLine = line.slice(0, newlineIndex).replace(/\r$/, '');
          line = line.slice(newlineIndex + 1);
          newlineIndex = line.indexOf('\n');
          const memo = this.parseLine(rawLine, 0);
          if (memo !== undefined) memos.push(memo);
        }
      }
    } catch {
      // Ignore read errors and migrate whatever we have.
    }

    if (memos.length > 0) {
      this.insertMany(memos);
    }

    await writeFile(markerPath, '', 'utf8').catch(() => {});
    // Keep the legacy file as a backup; remove the old in-memory index.
    await rename(this.jsonlPath, `${this.jsonlPath}.bak`).catch(() => {});
    await unlink(join(this.projectDir, 'memory', 'index.json')).catch(() => {});
  }

  /**
   * One-time migration: copy memory_embeddings → vec_memos for pre-existing
   * embeddings that were written before vec0 existed.
   */
  private async migrateVec0(): Promise<void> {
    if (this.db === undefined) return;
    const markerPath = join(this.projectDir, 'memory', VEC0_MIGRATION_MARKER);
    try {
      await stat(markerPath);
      return;
    } catch {
      // continue with migration
    }

    // Skip if vec0 already has entries (fresh DB).
    const row = this.db.prepare('SELECT COUNT(*) as count FROM vec_memos').get() as { count: number } | undefined;
    if ((row?.count ?? 0) > 0) {
      await writeFile(markerPath, '', 'utf8').catch(() => {});
      return;
    }

    // Iterate memory_embeddings and write each into vec0.
    const embRows = this.db.prepare(`
      SELECT e.memory_id, e.embedding_json, m.id, m.user_need, m.approach, m.outcome,
             m.extraction_source, m.recorded_at, m.project_dir, m.tags
      FROM memory_embeddings e
      JOIN memos m ON m.id = e.memory_id
    `).all() as Array<Record<string, unknown>>;

    if (embRows.length === 0) {
      await writeFile(markerPath, '', 'utf8').catch(() => {});
      return;
    }

    this.db.exec('BEGIN TRANSACTION');
    try {
      for (const row of embRows) {
        const memoId = String(row['memory_id']);
        const embedArr = JSON.parse(String(row['embedding_json'])) as number[];
        const vec = new Float32Array(embedArr);
        const memo: MemoryMemo = {
          id: memoId,
          sourceSessionId: '',
          sourceSessionTitle: undefined,
          userNeed: String(row['user_need'] ?? ''),
          approach: String(row['approach'] ?? ''),
          outcome: String(row['outcome'] ?? ''),
          whatFailed: 'none',
          whatWorked: 'none',
          extractionSource: (row['extraction_source'] as 'compaction' | 'exit' | 'manual') ?? 'compaction',
          recordedAt: Number(row['recorded_at'] ?? Date.now()),
          projectDir: String(row['project_dir'] ?? ''),
          tags: parseTags(row['tags']),
        };
        this.upsertVec0(memoId, vec, memo, 'HOT');
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.log.error?.('vec0 migration failed', { error });
    }

    await writeFile(markerPath, '', 'utf8').catch(() => {});
  }

  /**
   * If vec_memos has the wrong dimension (leftover from VEC0_DIMS=384),
   * rebuild it. Safe because vec_memos is currently 0 rows.
   */
  private rebuildVec0IfNeeded(): void {
    if (this.db === undefined) return;
    try {
      const row = this.db
        .prepare('SELECT COUNT(*) as cnt FROM vec_memos')
        .get() as { cnt: number } | undefined;
      if ((row?.cnt ?? 0) === 0) {
        this.db.exec('DROP TABLE IF EXISTS vec_memos');
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS vec_memos USING vec0(
            memo_embedding float[${VEC0_DIMS}],
            project_dir TEXT partition key,
            extraction_source TEXT,
            recorded_at INTEGER,
            +memo_id TEXT,
            +score_tier TEXT,
            +user_need TEXT,
            +approach TEXT,
            +outcome TEXT
          )
        `);
      }
    } catch {
      // Table may not exist yet (first init); fine, createSchema() handles it.
    }
  }

  private insertMany(memos: readonly MemoryMemo[]): void {
    if (this.db === undefined || memos.length === 0) return;
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO memos (
        id, source_session_id, source_session_title, user_need, approach,
        outcome, what_failed, what_worked, extraction_source, recorded_at, project_dir, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING rowid`,
    );
    const insertFts = this.db.prepare(
      `INSERT INTO memos_fts(rowid, user_need, approach, what_failed, what_worked, source_session_title)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN TRANSACTION');
    try {
      for (const memo of memos) {
        const row = insert.get(
          memo.id,
          memo.sourceSessionId,
          memo.sourceSessionTitle ?? null,
          memo.userNeed,
          memo.approach,
          memo.outcome,
          memo.whatFailed,
          memo.whatWorked,
          memo.extractionSource,
          memo.recordedAt,
          memo.projectDir ?? '',
          JSON.stringify(memo.tags ?? []),
        ) as { rowid: number };
        insertFts.run(
          row.rowid,
          toFtsText(memo.userNeed),
          toFtsText(memo.approach),
          toFtsText(memo.whatFailed),
          toFtsText(memo.whatWorked),
          toFtsText(memo.sourceSessionTitle ?? ''),
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw new Error(`Failed to migrate memos to SQLite: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  private async appendInternal(entry: MemoryMemo): Promise<void> {
    await this.init();
    if (this.db === undefined) return;
    const insert = this.db.prepare(
      `INSERT INTO memos (
        id, source_session_id, source_session_title, user_need, approach,
        outcome, what_failed, what_worked, extraction_source, recorded_at, project_dir, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING rowid`,
    );
    const insertFts = this.db.prepare(
      `INSERT INTO memos_fts(rowid, user_need, approach, what_failed, what_worked, source_session_title)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.exec('BEGIN TRANSACTION');
    try {
      const row = insert.get(
        entry.id,
        entry.sourceSessionId,
        entry.sourceSessionTitle ?? null,
        entry.userNeed,
        entry.approach,
        entry.outcome,
        entry.whatFailed,
        entry.whatWorked,
        entry.extractionSource,
        entry.recordedAt,
        entry.projectDir ?? '',
        JSON.stringify(entry.tags ?? []),
      ) as { rowid: number };
      insertFts.run(
        row.rowid,
        toFtsText(entry.userNeed),
        toFtsText(entry.approach),
        toFtsText(entry.whatFailed),
        toFtsText(entry.whatWorked),
        toFtsText(entry.sourceSessionTitle ?? ''),
      );
      this.db.exec('COMMIT');
      this.scheduleEmbedding(entry);

      // Independent capacity guard: evict oldest unprotected memos if HOT_MAX_SIZE exceeded.
      void this.enforceHotTierCap().catch((err) => {
        this.log.error?.('enforceHotTierCap failed', { error: err });
      });

      // Phase 4: deviation chain — track consecutive low-quality tag sets
      const quality = computeTagSetQuality(entry.tags ?? []);
      if (quality.score < 0.5) {
        this.consecutiveBadTagSets++;
      } else {
        this.consecutiveBadTagSets = 0;
      }
    } catch {
      this.db.exec('ROLLBACK');
      throw new Error('Failed to append memo');
    }
  }

  /** Update a memo by id. Returns true if the memo existed and was updated. */
  async update(id: string, patch: Partial<Omit<MemoryMemo, 'id'>>): Promise<boolean> {
    return this.withWriteLock(() => this.updateInternal(id, patch));
  }

  /** @internal */
  private async updateInternal(
    id: string,
    patch: Partial<Omit<MemoryMemo, 'id'>>,
  ): Promise<boolean> {
    await this.init();
    if (this.db === undefined) return false;

    const existing = await this.get(id);
    if (existing === undefined) return false;

    const updated: MemoryMemo = { ...existing, ...patch };
    const selectRow = this.db.prepare('SELECT rowid FROM memos WHERE id = ?');
    const update = this.db.prepare(
      `UPDATE memos SET
        rowid = (SELECT COALESCE(MAX(rowid), 0) + 1 FROM memos),
        source_session_id = ?,
        source_session_title = ?,
        user_need = ?,
        approach = ?,
        outcome = ?,
        what_failed = ?,
        what_worked = ?,
        extraction_source = ?,
        recorded_at = ?,
        project_dir = ?,
        tags = ?
      WHERE id = ?
      RETURNING rowid`,
    );
    const updateFts = this.db.prepare(
      `INSERT INTO memos_fts(rowid, user_need, approach, what_failed, what_worked, source_session_title)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const deleteFts = this.db.prepare(
      "INSERT INTO memos_fts(memos_fts, rowid) VALUES ('delete', ?)",
    );
    this.db.exec('BEGIN TRANSACTION');
    try {
      const oldRow = selectRow.get(id) as { rowid: number } | undefined;
      if (oldRow === undefined) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const row = update.get(
        updated.sourceSessionId,
        updated.sourceSessionTitle ?? null,
        updated.userNeed,
        updated.approach,
        updated.outcome,
        updated.whatFailed,
        updated.whatWorked,
        updated.extractionSource,
        updated.recordedAt,
        updated.projectDir ?? '',
        JSON.stringify(updated.tags ?? []),
        id,
      ) as { rowid: number } | undefined;
      if (row === undefined) {
        this.db.exec('ROLLBACK');
        return false;
      }
      deleteFts.run(oldRow.rowid);
      updateFts.run(
        row.rowid,
        toFtsText(updated.userNeed),
        toFtsText(updated.approach),
        toFtsText(updated.whatFailed),
        toFtsText(updated.whatWorked),
        toFtsText(updated.sourceSessionTitle ?? ''),
      );
      this.db.exec('COMMIT');
      return true;
    } catch {
      this.db.exec('ROLLBACK');
      throw new Error('Failed to update memo');
    }
  }

  private async deleteInternal(id: string): Promise<boolean> {
    await this.init();
    if (this.db === undefined) return false;
    const selectRow = this.db.prepare('SELECT rowid FROM memos WHERE id = ?');
    const row = selectRow.get(id) as { rowid: number } | undefined;
    if (row === undefined) return true;
    const deleteFts = this.db.prepare(
      "INSERT INTO memos_fts(memos_fts, rowid) VALUES ('delete', ?)",
    );
    const deleteMemo = this.db.prepare('DELETE FROM memos WHERE id = ?');
    this.db.exec('BEGIN TRANSACTION');
    try {
      deleteFts.run(row.rowid);
      deleteMemo.run(id);
      this.deleteVec0(id);
      this.db.exec('COMMIT');
      return true;
    } catch {
      this.db.exec('ROLLBACK');
      throw new Error('Failed to delete memo');
    }
  }

  /** Set the embedding engine. Call once after construction, before any writes. */
  setEmbeddingEngine(engine: EmbeddingEngine): void {
    this.embeddingEngine = engine;
  }

  /** Check whether the store has any vector embeddings. */
  hasEmbeddings(): boolean {
    if (this.db === undefined) return false;
    const row = this.db.prepare('SELECT COUNT(*) as count FROM memory_embeddings').get() as
      | { count: number }
      | undefined;
    return (row?.count ?? 0) > 0;
  }

  /** Access the embedding engine (may be undefined if not configured). */
  getEmbeddingEngine(): EmbeddingEngine | undefined {
    return this.embeddingEngine;
  }

  /**
   * Phase 4: Check whether the store is in a bad tagging streak
   * (consecutive low-quality tag sets). Callers can use this to
   * inject prompt-level intervention.
   */
  isBadTaggingStreak(): boolean {
    return this.consecutiveBadTagSets >= TAG_CONFIG.BAD_TAG_CONSECUTIVE_LIMIT;
  }

  // ── vec0 CRUD ────────────────────────────────────────────

  /** Check whether vec0 has any entries. */
  hasVec0(): boolean {
    if (this.db === undefined) return false;
    try {
      const row = this.db.prepare(
        "SELECT COUNT(*) as count FROM vec_memos WHERE memo_embedding IS NOT NULL LIMIT 1",
      ).get() as { count: number } | undefined;
      return (row?.count ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Upsert a memo's embedding into vec0.
   * vec0 does not support ON CONFLICT — delete then insert.
   */
  private upsertVec0(
    memoId: string,
    embedding: Float32Array,
    memo: MemoryMemo,
    scoreTier: 'HOT' | 'ARCHIVED' = 'HOT',
  ): void {
    if (this.db === undefined) return;
    this.deleteVec0(memoId);
    this.db
      .prepare(
        `INSERT INTO vec_memos(memo_embedding, project_dir, extraction_source, recorded_at, memo_id, score_tier, user_need, approach, outcome)
         VALUES (vec_f32(?), ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        new Uint8Array(embedding.buffer),
        memo.projectDir ?? '',
        memo.extractionSource,
        // node:sqlite binds JS number as FLOAT; vec0 metadata INTEGER column
        // requires actual integer binding.
        BigInt(memo.recordedAt),
        memoId,
        scoreTier,
        memo.userNeed,
        memo.approach,
        memo.outcome,
      );
  }

  /** Delete a memo's row from vec0. */
  private deleteVec0(memoId: string): void {
    if (this.db === undefined) return;
    this.db.prepare('DELETE FROM vec_memos WHERE memo_id = ?').run(memoId);
  }

  /** Update score_tier in vec0 (DELETE + re-INSERT using stored embedding). */
  private updateVec0Tier(memoId: string, tier: 'HOT' | 'ARCHIVED'): void {
    if (this.db === undefined) return;
    const embRow = this.db
      .prepare('SELECT embedding_json FROM memory_embeddings WHERE memory_id = ?')
      .get(memoId) as { embedding_json: string } | undefined;
    if (embRow === undefined) return;
    const memo = this.db
      .prepare('SELECT * FROM memos WHERE id = ?')
      .get(memoId) as Record<string, unknown> | undefined;
    if (memo === undefined) return;
    const vec = new Float32Array(JSON.parse(embRow.embedding_json) as number[]);
    this.upsertVec0(memoId, vec, rowToMemo(memo), tier);
  }

  /**
   * Search vec0 by vector similarity. Distance → similarity: 1 / (1 + distance).
   * Returns results sorted by distance (ascending).
   */
  searchByVectorVec0(
    queryEmbedding: Float32Array,
    options?: {
      k?: number;
      projectDir?: string;
      scoreTier?: 'HOT' | 'ARCHIVED';
      distanceCutoff?: number;
    },
  ): Array<{ memo_id: string; similarity: number }> {
    if (this.db === undefined) return [];
    const k = options?.k ?? 20;
    const distanceCutoff = options?.distanceCutoff ?? 2.0;

    let sql = `
      SELECT memo_id, distance
      FROM vec_memos
      WHERE memo_embedding MATCH ?
        AND k = ?
        AND distance < ?
    `;

    if (options?.projectDir !== undefined) {
      sql += ' AND project_dir = ?';
    }
    if (options?.scoreTier !== undefined) {
      sql += ' AND +score_tier = ?';
    }

    try {
      const stmt = this.db.prepare(sql);
      const bindings: unknown[] = [new Uint8Array(queryEmbedding.buffer), k, distanceCutoff];
      if (options?.projectDir !== undefined) {
        bindings.push(options.projectDir);
      }
      if (options?.scoreTier !== undefined) {
        bindings.push(options.scoreTier);
      }
      const rows = stmt.all(...(bindings as any[])) as Array<{
        memo_id: string;
        distance: number;
      }>;
      return rows.map((r) => ({
        memo_id: r.memo_id,
        similarity: 1 / (1 + r.distance),
      }));
    } catch {
      return [];
    }
  }

  // ── Hot / Cold tier (memos_archive) ─────────────────────

  private async appendToArchive(entry: MemoryMemo & { archivedAt: number; hitCount: number; lastHitAt: number; embeddingJson?: string }): Promise<void> {
    if (this.db === undefined) return;
    this.db
      .prepare(
        `INSERT INTO memos_archive (
          id, source_session_id, source_session_title, user_need, approach,
          outcome, what_failed, what_worked, extraction_source, recorded_at,
          project_dir, tags, archived_at, hit_count, last_hit_at, embedding_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.sourceSessionId,
        entry.sourceSessionTitle ?? null,
        entry.userNeed,
        entry.approach,
        entry.outcome,
        entry.whatFailed,
        entry.whatWorked,
        entry.extractionSource,
        entry.recordedAt,
        entry.projectDir ?? '',
        JSON.stringify(entry.tags ?? []),
        entry.archivedAt,
        entry.hitCount,
        entry.lastHitAt,
        entry.embeddingJson ?? null,
      );
  }

  private async getArchived(id: string): Promise<(MemoryMemo & { archivedAt: number; hitCount: number; lastHitAt: number; embeddingJson?: string }) | undefined> {
    if (this.db === undefined) return undefined;
    const row = this.db.prepare('SELECT * FROM memos_archive WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    const ej = row['embedding_json'];
    return {
      ...rowToMemo(row),
      archivedAt: Number(row['archived_at']),
      hitCount: Number(row['hit_count']),
      lastHitAt: Number(row['last_hit_at']),
      embeddingJson: typeof ej === 'string' && ej.length > 0 ? ej : undefined,
    };
  }

  private async deleteFromArchive(id: string): Promise<void> {
    if (this.db === undefined) return;
    this.db.prepare('DELETE FROM memos_archive WHERE id = ?').run(id);
  }

  private async updateArchiveHitCount(id: string, count: number, lastHitAt: number): Promise<void> {
    if (this.db === undefined) return;
    this.db.prepare('UPDATE memos_archive SET hit_count = ?, last_hit_at = ? WHERE id = ?').run(count, lastHitAt, id);
  }

  private async hotMemoCount(): Promise<number> {
    if (this.db === undefined) return 0;
    const row = this.db.prepare('SELECT COUNT(*) as count FROM memos').get() as { count: number } | undefined;
    return row?.count ?? 0;
  }

  private async getAllHotMemos(): Promise<MemoryMemo[]> {
    if (this.db === undefined) return [];
    const rows = this.db.prepare('SELECT * FROM memos').all() as Array<Record<string, unknown>>;
    return rows.map(rowToMemo);
  }

  // ── promote / demote ─────────────────────────────────

  /** Promote: move a memo from archive back to hot tier. */
  async promote(id: string): Promise<boolean> {
    await this.init();
    if (this.db === undefined) return false;
    const archived = await this.getArchived(id);
    if (archived === undefined) return false;
    const memo: MemoryMemo = {
      id: archived.id,
      sourceSessionId: archived.sourceSessionId,
      sourceSessionTitle: archived.sourceSessionTitle,
      userNeed: archived.userNeed,
      approach: archived.approach,
      outcome: archived.outcome,
      whatFailed: archived.whatFailed,
      whatWorked: archived.whatWorked,
      extractionSource: archived.extractionSource,
      recordedAt: archived.recordedAt,
      projectDir: archived.projectDir,
      tags: archived.tags,
    };
    await this.appendInternal(memo);
    await this.deleteFromArchive(id);

    // Restore embedding to memory_embeddings if archived had one.
    // ON DELETE CASCADE on memory_embeddings.memory_id → memos.id wiped
    // the row when demote() called deleteInternal(), so updateVec0Tier
    // would find no embedding. We saved it in memos_archive.embedding_json.
    if (archived.embeddingJson !== undefined) {
      this.db!
        .prepare(
          'INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding_json, model, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(id, archived.embeddingJson, 'bge-small-zh-v1.5', Date.now());
    }
    this.updateVec0Tier(id, 'HOT');
    return true;
  }

  /** Demote: move a memo from hot tier to archive. Serialized via withWriteLock. */
  async demote(id: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      await this.init();
      if (this.db === undefined) return false;
      const memo = await this.get(id);
      if (memo === undefined || (Array.isArray(memo.tags) && (memo.tags.includes('baohu') || memo.tags.includes('chundu') || memo.tags.includes('yongjiu')))) return false;

      // Save embedding before deleteInternal removes the memo (and its vec0 entry).
      const embRow = this.db
        .prepare('SELECT embedding_json FROM memory_embeddings WHERE memory_id = ?')
        .get(id) as { embedding_json: string } | undefined;

      const embeddingJson = embRow?.embedding_json;
      const archiveEntry = {
        ...memo,
        archivedAt: Date.now(),
        hitCount: 0,
        lastHitAt: 0,
        embeddingJson,
      };
      await this.appendToArchive(archiveEntry);
      await this.deleteInternal(id);

      // Re-insert vec0 with ARCHIVED tier so cold-layer vec0 search still works.
      if (embeddingJson !== undefined) {
        const vec = new Float32Array(JSON.parse(embeddingJson) as number[]);
        this.upsertVec0(id, vec, memo, 'ARCHIVED');
      }

      return true;
    });
  }

  /** Auto-demote: scan hot tier, demote cold entries. */
  async autoDemoteIfNeeded(): Promise<number> {
    await this.init();
    if (this.db === undefined) return 0;
    let demoted = 0;

    const hotMemos = await this.getAllHotMemos();

    for (const memo of hotMemos) {
      if (Array.isArray(memo.tags) && (memo.tags.includes('baohu') || memo.tags.includes('chundu') || memo.tags.includes('yongjiu'))) continue;

      const tags = new Set(memo.tags ?? []);
      const D = tags.has('baohu') ? 0.99 : tags.has('ding') ? 0.95 : tags.has('chundu') ? 1 : tags.has('yongjiu') ? 1 : 0.85;
      const daysSince = (Date.now() - memo.recordedAt) / (1000 * 60 * 60 * 24);
      const resNetFactor = Math.pow(D, daysSince);

      if (resNetFactor < DEMOTE_RESNET_THRESHOLD || daysSince >= DEMOTE_DAYS_NO_HIT) {
        await this.demote(memo.id);
        demoted++;
        if (demoted >= DEMOTE_BATCH_SIZE) break;
      }
    }

    // Cap hot tier size — evict lowest recorded_at first
    const currentCount = await this.hotMemoCount();
    if (currentCount > HOT_MAX_SIZE) {
      const remaining = hotMemos
        .filter((m) => !(Array.isArray(m.tags) && (m.tags.includes('baohu') || m.tags.includes('chundu') || m.tags.includes('yongjiu'))))
        .sort((a, b) => a.recordedAt - b.recordedAt) // oldest first
        .slice(0, currentCount - HOT_MAX_SIZE + PROMOTE_RESERVE_SPACE);
      for (const memo of remaining) {
        if (demoted >= DEMOTE_BATCH_SIZE) break;
        await this.demote(memo.id);
        demoted++;
      }
    }

    return demoted;
  }

  /**
   * Independent capacity guard: evicts oldest unprotected hot memos when
   * the hot tier exceeds HOT_MAX_SIZE. Does NOT depend on embedding engine.
   * Called from appendInternal after every new memo insertion.
   */
  private async enforceHotTierCap(): Promise<number> {
    await this.init();
    if (this.db === undefined) return 0;
    const currentCount = await this.hotMemoCount();
    if (currentCount <= HOT_MAX_SIZE) return 0;

    const hotMemos = await this.getAllHotMemos();
    const unprotected = hotMemos.filter(
      (m) => !(Array.isArray(m.tags) &&
        (m.tags.includes('baohu') || m.tags.includes('chundu') || m.tags.includes('yongjiu')))
    );
    const evictTargets = unprotected
      .sort((a, b) => a.recordedAt - b.recordedAt) // oldest first
      .slice(0, currentCount - HOT_MAX_SIZE + PROMOTE_RESERVE_SPACE);

    let demoted = 0;
    for (const memo of evictTargets) {
      if (demoted >= DEMOTE_BATCH_SIZE) break;
      await this.demote(memo.id);
      demoted++;
    }
    return demoted;
  }

  /** Auto-promote: when a vec0 search hits archived memos, bump hit count and promote if ready. */
  async autoPromoteHits(memoIds: string[]): Promise<number> {
    await this.init();
    if (this.db === undefined) return 0;
    let promoted = 0;

    for (const id of memoIds) {
      const archived = await this.getArchived(id);
      if (archived === undefined) continue;
      const newCount = archived.hitCount + 1;
      await this.updateArchiveHitCount(id, newCount, Date.now());

      const hotCount = await this.hotMemoCount();
      if (newCount >= PROMOTE_HIT_COUNT || hotCount < HOT_MAX_SIZE) {
        await this.promote(id);
        promoted++;
      }
    }

    return promoted;
  }

  /**
   * Search memos by vector similarity. Returns memos sorted by cosine
   * similarity (highest first). Falls back to empty if no embeddings exist.
   *
   * NOTE: candidates are ordered by created_at DESC, so only the newest
   * N embeddings are considered. Older but highly relevant memos may be
   * omitted when the store has more than candidateLimit embeddings.
   * This is a known limitation — see M-M5 in project review notes.
   * Performance notes:
   * - candidateLimit bounds the SQL query so we never load every embedding.
   * - recencyCutoffDays lets callers ignore very old memos.
   * - projectDir is pushed into the SQL JOIN so unrelated projects are not
   *   considered at all.
   */
  async searchByVector(
    queryEmbedding: Float32Array,
    options?: {
      candidateLimit?: number;
      projectDir?: string;
      recencyCutoffDays?: number;
    },
  ): Promise<Array<{ memo: MemoryMemo; score: number }>> {
    await this.init();
    if (this.db === undefined) return [];

    const limit = options?.candidateLimit ?? 200;
    const projectDir = options?.projectDir;
    const recencyCutoffDays = options?.recencyCutoffDays;
    const cutoffMs =
      recencyCutoffDays !== undefined && recencyCutoffDays > 0
        ? Date.now() - recencyCutoffDays * 24 * 60 * 60 * 1000
        : undefined;

    let rows: Array<{ memory_id: string; embedding_json: string }>;
    if (projectDir !== undefined) {
      const stmt =
        cutoffMs === undefined
          ? this.db.prepare(`
              SELECT e.memory_id, e.embedding_json
              FROM memory_embeddings e
              JOIN memos m ON m.id = e.memory_id
              WHERE (m.project_dir = ? OR m.project_dir = '')
              ORDER BY e.created_at DESC
              LIMIT ?
            `)
          : this.db.prepare(`
              SELECT e.memory_id, e.embedding_json
              FROM memory_embeddings e
              JOIN memos m ON m.id = e.memory_id
              WHERE (m.project_dir = ? OR m.project_dir = '')
                AND e.created_at > ?
              ORDER BY e.created_at DESC
              LIMIT ?
            `);
      rows = (cutoffMs === undefined
        ? stmt.all(projectDir, limit)
        : stmt.all(projectDir, cutoffMs, limit)) as Array<{
        memory_id: string;
        embedding_json: string;
      }>;
    } else {
      const stmt =
        cutoffMs === undefined
          ? this.db.prepare(
              'SELECT memory_id, embedding_json FROM memory_embeddings ORDER BY created_at DESC LIMIT ?',
            )
          : this.db.prepare(
              'SELECT memory_id, embedding_json FROM memory_embeddings WHERE created_at > ? ORDER BY created_at DESC LIMIT ?',
            );
      rows = (cutoffMs === undefined
        ? stmt.all(limit)
        : stmt.all(cutoffMs, limit)) as Array<{
        memory_id: string;
        embedding_json: string;
      }>;
    }

    if (rows.length === 0) return [];

    const scored: Array<{ id: string; score: number }> = [];
    for (const row of rows) {
      try {
        const vec = new Float32Array(JSON.parse(row.embedding_json) as number[]);
        const similarity = this.embeddingEngine?.cosineSimilarity(queryEmbedding, vec) ?? 0;
        if (similarity > 0) {
          scored.push({ id: row.memory_id, score: similarity });
        }
      } catch {
        // Skip corrupted embeddings
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const topScored = scored.slice(0, limit);

    const results: Array<{ memo: MemoryMemo; score: number }> = [];
    for (const { id, score } of topScored) {
      const row = this.db
        .prepare('SELECT * FROM memos WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (row !== undefined) {
        results.push({ memo: rowToMemo(row), score });
      }
    }

    return results;
  }

  /**
   * Schedule async embedding generation for a memo. Debounced — the actual
   * batch flush runs after a short quiet period. Never blocks the caller.
   */
  scheduleEmbedding(memo: MemoryMemo): void {
    if (this.embeddingEngine === undefined || !this.embeddingEngine.available) return;
    this.embeddingQueue.add(memo.id);
    if (this.embeddingTimer !== undefined) {
      clearTimeout(this.embeddingTimer);
    }
    // Debounce 2s — wait for a batch of writes to settle before flushing.
    this.embeddingTimer = setTimeout(() => {
      void this.flushEmbeddings();
    }, 2000);
  }

  /**
   * Flush queued embedding generation. Retries once on failure to tolerate
   * transient model-load contention, then marks embeddings as degraded and
   * logs the problem. Callers can still retrieve memos through keyword search.
   */
  private async flushEmbeddings(): Promise<void> {
    if (
      this.embeddingFlushing ||
      this.embeddingEngine === undefined ||
      !this.embeddingEngine.available
    ) {
      return;
    }

    this.embeddingFlushing = true;
    try {
      await this.init();
      if (this.db === undefined) return;

      const ids = [...this.embeddingQueue];
      this.embeddingQueue.clear();

      // Collect memos that still need embeddings.
      const pending: Array<{ id: string; text: string }> = [];
      for (const id of ids) {
        const row = this.db
          .prepare('SELECT id FROM memory_embeddings WHERE memory_id = ?')
          .get(id);
        if (row !== undefined) continue; // Already has embedding

        const memo = await this.get(id);
        if (memo !== undefined) {
          pending.push({ id, text: buildEmbeddingText(memo) });
        }
      }

      if (pending.length === 0) return;

      const vectors = await this.tryEmbedBatch(pending.map((p) => p.text));
      if (vectors === null || vectors.length !== pending.length) {
        this.markEmbeddingFailure(
          new Error(vectors === null ? 'embedBatch returned null' : 'embedding count mismatch'),
        );
        return;
      }

      this.clearEmbeddingFailure();

      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding_json, model, created_at) VALUES (?, ?, ?, ?)',
      );
      const now = Date.now();
      this.db.exec('BEGIN TRANSACTION');
      try {
        for (let i = 0; i < pending.length; i++) {
          insert.run(
            pending[i]!.id,
            JSON.stringify([...vectors[i]!]),
            'bge-small-zh-v1.5',
            now,
          );
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        this.markEmbeddingFailure(error instanceof Error ? error : new Error(String(error)));
      }

      // ── vec0 write ──
      // Write newly generated embeddings into vec0. Runs outside the embedding
      // INSERT transaction so a vec0 failure does not corrupt the batch.
      for (let i = 0; i < pending.length; i++) {
        const memo = this.db
          .prepare('SELECT * FROM memos WHERE id = ?')
          .get(pending[i]!.id) as Record<string, unknown> | undefined;
        if (memo !== undefined) {
          this.upsertVec0(pending[i]!.id, vectors[i]!, rowToMemo(memo), 'HOT');
        }
      }

      // Periodic auto-demote: cool hot tier after embeddings settle.
      // Throttled to avoid running on every single write.
      if (this.lastAutoDemoteAt + MemoryMemoStore.AUTO_DEMOTE_INTERVAL_MS < Date.now()) {
        this.autoDemoteIfNeeded().catch((err) => {
          this.log.error?.('autoDemoteIfNeeded failed', { error: err });
        }).then(() => {
          this.lastAutoDemoteAt = Date.now();
        });
      }
    } catch (error) {
      this.markEmbeddingFailure(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.embeddingFlushing = false;
    }
  }

  private async tryEmbedBatch(texts: string[]): Promise<Float32Array[] | null> {
    if (this.embeddingEngine === undefined) return null;
    // First attempt.
    try {
      const first = await this.embeddingEngine.embedBatch(texts);
      if (first !== null) return first;
    } catch {
      // Fall through to one retry.
    }
    // One immediate retry in case the failure was transient (e.g. model file
    // contention during parallel process startup).
    try {
      return await this.embeddingEngine.embedBatch(texts);
    } catch {
      return null;
    }
  }

  private markEmbeddingFailure(error: Error): void {
    this.embeddingDegraded = true;
    this.embeddingConsecutiveFailures += 1;
    this.lastEmbeddingError = error;
    this.log.warn?.('embedding flush failed', {
      error: error.message,
      consecutiveFailures: this.embeddingConsecutiveFailures,
    });
  }

  private clearEmbeddingFailure(): void {
    this.embeddingDegraded = false;
    this.embeddingConsecutiveFailures = 0;
    this.lastEmbeddingError = undefined;
  }

  /**
   * Runtime health of the embedding subsystem. When `degraded` is true, the
   * store still serves keyword search; only vector similarity is unavailable.
   */
  embeddingStatus(): {
    available: boolean;
    degraded: boolean;
    consecutiveFailures: number;
    lastError?: string;
  } {
    return {
      available: this.embeddingEngine !== undefined && this.embeddingEngine.available,
      degraded: this.embeddingDegraded,
      consecutiveFailures: this.embeddingConsecutiveFailures,
      lastError: this.lastEmbeddingError?.message,
    };
  }

  private listAll(limit: number, offset: number, projectDir?: string): { rows: MemoryMemo[]; total: number } {
    if (this.db === undefined) return { rows: [], total: 0 };
    const countStmt =
      projectDir === undefined
        ? this.db.prepare('SELECT COUNT(*) as total FROM memos')
        : this.db.prepare("SELECT COUNT(*) as total FROM memos WHERE project_dir = ? OR project_dir = ''");
    const countRow = (
      projectDir === undefined ? countStmt.get() : countStmt.get(projectDir)
    ) as { total: number } | undefined;
    const total = countRow?.total ?? 0;
    const stmt =
      projectDir === undefined
        ? this.db.prepare('SELECT * FROM memos ORDER BY recorded_at DESC LIMIT ? OFFSET ?')
        : this.db.prepare(
            "SELECT * FROM memos WHERE project_dir = ? OR project_dir = '' ORDER BY recorded_at DESC LIMIT ? OFFSET ?",
          );
    const rows = (
      projectDir === undefined ? stmt.all(limit, offset) : stmt.all(projectDir, limit, offset)
    ) as Array<Record<string, unknown>>;
    return { rows: rows.map(rowToMemo), total };
  }

  private async ensureDir(): Promise<void> {
    await mkdir(dirname(this.dbPath), { recursive: true });
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writeLock;
    const next = previous.then(fn, fn);
    this.writeLock = next;
    return next;
  }
}

function rowToMemo(row: Record<string, unknown>): MemoryMemo {
  const sourceSessionTitle = row['source_session_title'];
  const projectDir = row['project_dir'];
  return {
    id: String(row['id']),
    sourceSessionId: String(row['source_session_id']),
    sourceSessionTitle: typeof sourceSessionTitle === 'string' ? sourceSessionTitle : undefined,
    userNeed: String(row['user_need']),
    approach: String(row['approach']),
    outcome: String(row['outcome']),
    whatFailed: String(row['what_failed']),
    whatWorked: String(row['what_worked']),
    extractionSource: row['extraction_source'] as 'compaction' | 'exit' | 'manual',
    recordedAt: Number(row['recorded_at']),
    projectDir: typeof projectDir === 'string' ? projectDir : '',
    tags: parseTags(row['tags']),
  };
}

function parseTags(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const tags = parsed.filter((t): t is string => typeof t === 'string');
    return tags.length > 0 ? tags : undefined;
  } catch {
    return undefined;
  }
}

function memoMatchesSearch(memo: MemoryMemo, search: string): boolean {
  const haystack = [
    memo.userNeed,
    memo.approach,
    memo.whatFailed,
    memo.whatWorked,
    memo.sourceSessionTitle ?? '',
    ...(memo.tags ?? []),
  ]
    .join(' ')
    .toLowerCase()
    .replaceAll(/\s+/g, '');
  return haystack.includes(search.replaceAll(/\s+/g, ''));
}

/**
 * Tokenize text so FTS5's unicode61 tokenizer can index mixed CJK/ASCII text.
 * CJK characters are split into individual characters separated by spaces, and
 * CJK/ASCII boundaries are also separated so "使用redis缓存" becomes searchable
 * by "redis" as well as by individual CJK characters.
 */
function toFtsText(text: string): string {
  const lower = text.toLowerCase();
  const withBoundaries = lower
    .replaceAll(/([一-鿿㐀-䶿])([a-z0-9])/g, '$1 $2')
    .replaceAll(/([a-z0-9])([一-鿿㐀-䶿])/g, '$1 $2');
  const parts = withBoundaries.split(/[^a-z0-9一-鿿㐀-䶿]+/);
  const tokens: string[] = [];
  for (const part of parts) {
    if (part.length === 0) continue;
    if (/^[a-z0-9]+$/.test(part)) {
      tokens.push(part);
    } else {
      // Split every CJK run into individual characters.
      for (const ch of part) {
        if (ch.length > 0) tokens.push(ch);
      }
    }
  }
  return tokens.join(' ');
}

function buildFtsQuery(search: string): string | undefined {
  const ftsText = toFtsText(search);
  const tokens = ftsText.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(' AND ');
}
