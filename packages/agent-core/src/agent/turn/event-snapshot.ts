/**
 * EventSnapshotBuffer — 回合拦截事件持久化缓冲区。
 *
 * 内存缓冲区 + 即时刷盘。回合结束时接收 TurnEventLog 的快照，
 * 每个有事件的回合立即写入 Markdown 到磁盘文件。
 *
 * 架构复用自 FileSystemAgentRecordPersistence：
 *   pendingEntries → shouldFlush → scheduleFlush → ensureFlush → drainBatch
 *
 * 磁盘路径: <screamHome>/interception-logs/<YYYY-MM-DD>.md
 *          <screamHome>/interception-logs/INDEX.json  (atomicWrite)
 *          screamHome ≈ ~/.scream-code/  (resolveScreamHome)
 */

import { mkdir, open, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'pathe';

import type { Agent } from '..';
import { resolveScreamHome } from '../../config/path';
import { atomicWrite } from '../../utils/fs';
import type { InterceptionEvent } from './event-log';

// ── 类型 ────────────────────────────────────────────────────────

interface SnapshotBufferEntry {
  turnId: number;
  events: InterceptionEvent[];
  stepCount: number;
  /** pushTurn 时的时间戳（≈回合结束时间） */
  timestamp: number;
}

interface IndexStats {
  version: number;
  globalStats: {
    totalEvents: number;
    byKind: Record<string, number>;
    byVariant: Record<string, number>;
    lastUpdated: string;
  };
}

// ── 阈值 ────────────────────────────────────────────────────────

// 立即刷盘 — 每个有事件的回合都写入，不攒批
const MAX_PENDING_ROUNDS = 1;
const MIN_FLUSH_INTERVAL_MS = 0;

// ── EventSnapshotBuffer ─────────────────────────────────────────

export class EventSnapshotBuffer {
  private pendingEntries: SnapshotBufferEntry[] = [];
  private flushPromise: Promise<void> | null = null;
  private lastFlushTime = 0;
  private error: unknown;

  constructor(private readonly agent: Agent) {}

  // ── Public API ─────────────────────────────────────────────

  /**
   * 回合结束时将本回合的拦截事件加入缓冲区。
   * 异步，不 await——不阻塞 AI 回合结束。
   */
  pushTurn(turnId: number, events: InterceptionEvent[], stepCount: number): void {
    if (events.length === 0) return;
    this.pendingEntries.push({ turnId, events, stepCount, timestamp: Date.now() });
    if (this.shouldFlush()) this.scheduleFlush();
  }

  /**
   * 强制刷新所有待处理事件到磁盘。
   * 用于会话结束/关闭前的兜底 flush。
   */
  async flush(): Promise<void> {
    this.throwIfError();
    while (this.pendingEntries.length > 0 || this.flushPromise !== null) {
      await this.ensureFlush();
      this.throwIfError();
    }
  }

  // ── Flush 判定 ────────────────────────────────────────────

  private shouldFlush(): boolean {
    // MAX_PENDING_ROUNDS=1 → 有事件就刷盘
    return this.pendingEntries.length >= MAX_PENDING_ROUNDS;
  }

  // ── 异步刷盘管道（复用 FileSystemAgentRecordPersistence 模式）─

  private scheduleFlush(): void {
    void this.ensureFlush().catch((error) => {
      this.agent.log.error('EventSnapshotBuffer flush failed', { error });
      this.error = error;
    });
  }

  private async ensureFlush(): Promise<void> {
    if (this.flushPromise !== null) return;
    const promise = this.drainPendingRecords().finally(() => {
      if (this.flushPromise === promise) this.flushPromise = null;
      if (this.error === undefined && this.pendingEntries.length > 0) this.scheduleFlush();
    });
    this.flushPromise = promise;
    return promise;
  }

  private throwIfError(): void {
    if (this.error !== undefined) throw this.error;
  }

  private async drainPendingRecords(): Promise<void> {
    while (this.pendingEntries.length > 0) {
      await this.drainBatch();
    }
  }

  private async drainBatch(): Promise<void> {
    const batch = this.pendingEntries.splice(0);
    if (batch.length === 0) return;

    const baseDir = this.resolveBaseDir();
    await mkdir(baseDir, { recursive: true });

    // 按日期分组写入
    const byDate = new Map<string, SnapshotBufferEntry[]>();
    for (const entry of batch) {
      const date = new Date(entry.timestamp).toISOString().slice(0, 10); // YYYY-MM-DD
      let group = byDate.get(date);
      if (!group) { group = []; byDate.set(date, group); }
      group.push(entry);
    }

    for (const [date, entries] of byDate) {
      await this.appendToDateFile(baseDir, date, entries);
    }

    // 更新 INDEX.json
    await this.updateIndex(baseDir, batch);
    this.lastFlushTime = Date.now();
  }

  // ── 磁盘 IO ───────────────────────────────────────────────

  private async appendToDateFile(baseDir: string, date: string, entries: SnapshotBufferEntry[]): Promise<void> {
    const path = join(baseDir, `${date}.md`);
    const needsHeader = await this.fileNeedsHeader(path);

    const lines: string[] = [];
    if (needsHeader) {
      lines.push(`# 拦截日志 — ${date}`);
      lines.push('');
    }

    for (const entry of entries) {
      lines.push(`## [${this.sessionId}] Turn #${entry.turnId} — ${formatTime(entry.timestamp)} | ${entry.stepCount} steps`);
      lines.push(...this.formatTurnEvents(entry.events));
      lines.push('---');
      lines.push('');
    }

    // 提取 whatFailed 素材
    const whatFailed = extractWhatFailed(entries.flatMap(e => e.events));
    if (whatFailed.length > 0) {
      lines.push('### 行为总结', '');
      for (const wf of whatFailed) lines.push(`- ${wf}`);
      lines.push('');
    }

    const content = lines.join('\n');
    if (content.length === 0) return;

    const fh = await open(path, needsHeader ? 'w' : 'a');
    try {
      await fh.writeFile(content, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  private async updateIndex(baseDir: string, batch: SnapshotBufferEntry[]): Promise<void> {
    const indexPath = join(baseDir, 'INDEX.json');

    let stats: IndexStats;
    try {
      const raw = await readFile(indexPath, 'utf-8');
      stats = JSON.parse(raw) as IndexStats;
    } catch {
      // 首次运行，文件不存在
      stats = { version: 1, globalStats: { totalEvents: 0, byKind: {}, byVariant: {}, lastUpdated: '' } };
    }

    for (const entry of batch) {
      for (const event of entry.events) {
        stats.globalStats.totalEvents++;
        stats.globalStats.byKind[event.kind] = (stats.globalStats.byKind[event.kind] ?? 0) + 1;
        if (event.variant) {
          stats.globalStats.byVariant[event.variant] = (stats.globalStats.byVariant[event.variant] ?? 0) + 1;
        }
      }
    }
    stats.globalStats.lastUpdated = new Date().toISOString();

    await atomicWrite(indexPath, JSON.stringify(stats, null, 2));
  }

  /** 检查文件是否存在且非空（决定是否写文件头）。 */
  private async fileNeedsHeader(path: string): Promise<boolean> {
    try {
      const fh = await open(path, 'r');
      try {
        const stat = await fh.stat();
        return stat.size === 0;
      } finally {
        await fh.close();
      }
    } catch {
      return true; // 文件不存在 → 需要写 header
    }
  }

  /** 提取 sessionId: homedir = <projectDir>/<sessionId>/agents/<agentId> */
  private get sessionId(): string {
    const h = this.agent.homedir;
    if (!h) return 'unknown';
    return basename(dirname(dirname(h)));
  }

  private resolveBaseDir(): string {
    // 集中存到 .scream-code/interception-logs/，不跟 session 绑定
    return join(resolveScreamHome(), 'interception-logs');
  }

  // ── 格式化 ─────────────────────────────────────────────────

  private formatTurnEvents(events: InterceptionEvent[]): string[] {
    if (events.length === 0) return [];

    const lines: string[] = [];
    const groups = new Map<string, InterceptionEvent[]>();

    for (const e of events) {
      const key = `${e.kind}/${e.action}`;
      let group = groups.get(key);
      if (!group) { group = []; groups.set(key, group); }
      group.push(e);
    }

    for (const [key, group] of groups) {
      lines.push(`- ${key}: ${group.length} 次`);
      for (const e of group.slice(-3)) {
        const v = e.variant ? `[${e.variant}] ` : '';
        lines.push(`  · 第${e.step}步: ${v}${e.reason}`);
      }
    }

    return lines;
  }
}

// ── 纯函数 ──────────────────────────────────────────────────────

/**
 * 从拦截事件中提取 whatFailed 片段。
 * 用于写入日志文件末尾的「行为总结」区段。
 */
function extractWhatFailed(events: InterceptionEvent[]): string[] {
  const results: string[] = [];
  for (const e of events) {
    if (e.kind === 'convergence_gate' && e.action === 'gate_held') {
      results.push(`收敛门拦截: ${e.reason}`);
    } else if (e.kind === 'deviation_chain') {
      results.push(`偏差链触发: ${e.reason}`);
    } else if (e.kind === 'confabulation') {
      results.push(`反事实阻断: ${e.reason}`);
    } else if (e.kind === 'verify_fail') {
      results.push(`验证失败: ${e.reason}`);
    }
  }
  return results;
}

/** ISO 时间 → 短时间显示。 */
function formatTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}
