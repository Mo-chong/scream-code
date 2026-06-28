/**
 * FileActionAudit — 文件操作审计日志。
 *
 * 记录所有 B 组工具结果处理段中产生的文件写入操作。
 * 继承自抽象基类 FlushBuffer（flush 调度骨架），具体刷盘逻辑在
 * drainBatch() 中实现：追加写入单一 audit log 文件。
 *
 * 设计要点：
 * - 熔断守卫：连续 5 次 flush 失败 → 熔断打开 → 停止刷盘
 * - 非熔断时调用 scheduleFlush(() => this.flushWithBreaker())
 * - 刷盘间隔：每 30s 一次防抖
 * - 磁盘路径：<screamHome>/audit/YYYY-MM-DD.jsonl
 */

import { mkdir, open } from 'node:fs/promises';
import { join } from 'pathe';

import { resolveScreamHome } from '../../config/path';

// ─── 类型 ────────────────────────────────────────

export interface FileActionAuditEntry {
  /** 产生此文件操作的 toolCallId */
  toolCallId: string;
  /** 文件操作描述，如 "write:content-archive.ts" */
  action: string;
  /** 操作时间戳 */
  timestamp: number;
  /** 结果预览（如文件路径或摘要） */
  resultPreview: string;
  /** 操作是否成功 */
  success: boolean;
  /** 操作耗时（ms），0 表示未知 */
  durationMs: number;
}

// ─── 熔断常量 ────────────────────────────────────

const CIRCUIT_BREAKER_THRESHOLD = 5; // 连续失败次数
const DEFAULT_FLUSH_INTERVAL_MS = 30_000; // 30 秒防抖

// ─── 抽象基类 FlushBuffer<T> ─────────────────────

/**
 * FlushBuffer<T> — flush 调度骨架。
 *
 * 职责：
 *   1. 维护 pendingEntries 缓冲区
 *   2. shouldFlush → scheduleFlush → ensureFlush → drainPendingRecords 调度链
 *   3. 并发保护和错误收集
 *
 * 子类只需实现：
 *   - drainBatch(): Promise<void> 实际刷盘逻辑
 *   - (可选) 覆盖 shouldFlush() 自定义触发条件
 */
export abstract class FlushBuffer<T> {
  protected pendingEntries: T[] = [];
  protected flushPromise: Promise<void> | null = null;
  protected lastFlushTime = 0;
  protected error: unknown;

  protected abstract readonly minFlushIntervalMs: number;
  protected abstract readonly maxPending: number;

  /**
   * 子类必须实现的刷盘逻辑：将一批条目写入磁盘。
   */
  protected abstract drainBatch(): Promise<void>;

  // ─── 公共 API ─────────────────────────────────

  /**
   * 向缓冲区追加一条待处理条目。
   * 达到阈值时自动触发异步刷盘。
   */
  push(entry: T): void {
    this.pendingEntries.push(entry);
    if (this.shouldFlush()) this.scheduleFlush();
  }

  /**
   * 强制刷新所有待处理条目到磁盘。
   * 用于会话结束前的兜底 flush。
   */
  async flush(): Promise<void> {
    this.throwIfError();
    while (this.pendingEntries.length > 0 || this.flushPromise !== null) {
      await this.ensureFlush();
      this.throwIfError();
    }
  }

  // ─── Flush 判定 ─────────────────────────────

  protected shouldFlush(): boolean {
    return this.pendingEntries.length >= this.maxPending;
  }

  // ─── 异步刷盘管道 ──────────────────────────

  protected scheduleFlush(customCatch?: (error: unknown) => void): void {
    void this.ensureFlush().catch((err) => {
      this.error = err;
      customCatch?.(err);
    });
  }

  protected async ensureFlush(): Promise<void> {
    if (this.flushPromise !== null) return;
    const promise = this.drainPendingRecords().finally(() => {
      if (this.flushPromise === promise) this.flushPromise = null;
      if (this.error === undefined && this.pendingEntries.length > 0) this.scheduleFlush();
    });
    this.flushPromise = promise;
    return promise;
  }

  protected async drainPendingRecords(): Promise<void> {
    while (this.pendingEntries.length > 0) {
      await this.drainBatch();
    }
  }

  protected throwIfError(): void {
    if (this.error !== undefined) throw this.error;
  }
}

// ─── FileActionAudit ──────────────────────────────

/**
 * FileActionAudit — 文件操作审计日志。
 *
 * 使用 FlushBuffer 骨架实现，追加写入 .jsonl 文件。
 * 每 30s 防抖刷盘，连续 5 次失败触发熔断。
 */
export class FileActionAudit extends FlushBuffer<FileActionAuditEntry> {
  protected readonly minFlushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
  protected readonly maxPending = 1; // 即时刷盘（同 EventSnapshotBuffer）

  private consecutiveFailures = 0;
  private circuitOpen = false;

  constructor() {
    super();
  }

  // ─── 熔断守卫 ───────────────────────────────

  /**
   * 熔断是否打开。打开时 skipFlush 返回 true，不再刷盘。
   */
  get isCircuitOpen(): boolean {
    return this.circuitOpen;
  }

  /**
   * 带熔断保护的刷盘入口。
   * 外部通过 scheduleFlush(() => this.flushWithBreaker()) 调用。
   */
  flushWithBreaker(): void {
    if (this.circuitOpen) return;
    this.scheduleFlush((err) => {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.circuitOpen = true;
        // 连续 5 次失效 → 熔断生效（不再尝试刷盘）
      }
    });
  }

  // ─── 刷盘逻辑 ───────────────────────────────

  protected override shouldFlush(): boolean {
    // 熔断打开时不刷盘
    if (this.circuitOpen) return false;
    // 防抖：距上次刷盘不足 minFlushIntervalMs 时，仅当条目积压才刷
    if (Date.now() - this.lastFlushTime < this.minFlushIntervalMs) {
      return this.pendingEntries.length > this.maxPending * 2;
    }
    return this.pendingEntries.length >= this.maxPending;
  }

  protected override scheduleFlush(customCatch?: (error: unknown) => void): void {
    if (this.circuitOpen) return;
    // 传给父类，传入熔断回调
    super.scheduleFlush(customCatch ?? ((err) => {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        this.circuitOpen = true;
      }
    }));
  }

  protected async drainBatch(): Promise<void> {
    const batch = this.pendingEntries.splice(0);
    if (batch.length === 0) return;

    const baseDir = this.resolveBaseDir();
    await mkdir(baseDir, { recursive: true });

    // 按日期分文件
    const byDate = new Map<string, FileActionAuditEntry[]>();
    for (const entry of batch) {
      const date = new Date(entry.timestamp).toISOString().slice(0, 10);
      let group = byDate.get(date);
      if (!group) { group = []; byDate.set(date, group); }
      group.push(entry);
    }

    for (const [date, entries] of byDate) {
      await this.appendToDateFile(baseDir, date, entries);
    }

    this.lastFlushTime = Date.now();
    this.consecutiveFailures = 0; // 成功 flush → 重置熔断计数
    if (this.circuitOpen) {
      this.circuitOpen = false; // 恢复后自动合闸
    }
  }

  // ─── 磁盘 IO ─────────────────────────────────

  private async appendToDateFile(baseDir: string, date: string, entries: FileActionAuditEntry[]): Promise<void> {
    const path = join(baseDir, `${date}.jsonl`);
    const lines = entries.map(e => JSON.stringify(e));
    const content = lines.join('\n') + '\n';

    const fh = await open(path, 'a');
    try {
      await fh.writeFile(content, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  private resolveBaseDir(): string {
    return join(resolveScreamHome(), 'audit');
  }
}
