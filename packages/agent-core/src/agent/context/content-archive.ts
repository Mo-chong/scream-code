/**
 * ContentArchive — 保留缓冲区（纯内存）。
 *
 * 在工具输出被截断/MicroCompact/FullCompact 吞掉之前，把原始内容暂存到这里。
 * 模型后续可以通过 `archive_recover` MCP 工具按需召回完整内容。
 *
 * 设计要点：
 * - 纯内存，零外部依赖（LRU + TTL 双老化 + 权重淘汰）
 * - 单条生命周期 max 30 分钟（秒级可配）
 * - 全局上限 2000 条目（加权淘汰，priority < 0.1 强制优先）
 * - 每个 entry 用调用方前缀 + toolCallId 做 key，互不干扰
 * - protected 仅防加权淘汰，不防 TTL 过期
 * - archive() 第三参数为 options 对象：{ source?, priority?, protected? }
 */

import type { ContentPart } from '@scream-code/ltod';

// ─── 类型导出 ────────────────────────────────────────
export interface ContentArchiveEntry {
  /** 存档时的原始内容（字符串或 ContentPart[]） */
  readonly content: string | ContentPart[];
  /** 存档时间戳（ms） */
  readonly timestamp: number;
  /** 触发存档的调用方标识，用于区分来源 */
  readonly source: string;
  /** 权重 0.0~1.0，越高越不容易被淘汰；recover() 会升权 */
  priority: number;
  /** 是否受保护（仅防加权淘汰，不防 TTL 过期） */
  protected: boolean;
  /** 最近访问时间（ms），recover() 时刷新 */
  lastAccessedAt: number;
}

export interface ContentArchiveConfig {
  /** 单条存活时间（ms），默认 300_000（5 分钟） */
  readonly ttlMs?: number;
  /** 全局条目上限，默认 50 */
  readonly maxEntries?: number;
}

export interface ArchiveResult {
  readonly key: string;
  readonly success: boolean;
  readonly evictedCount: number;
  /** 失败原因，如 NO_EVICTABLE_ENTRY（所有未过期条目均受保护，无法腾出空间） */
  readonly error?: string;
}

// ─── 默认值 ──────────────────────────────────────────
const DEFAULT_TTL_MS = 1_800_000; // 30 分钟
const DEFAULT_MAX_ENTRIES = 2000;

// 权重常量
const PRIORITY_BOOST = 0.1;       // recover() 每次升权步长
const PRIORITY_MAX = 1.0;         // 权重上限
const PRIORITY_NEW = 1.0;         // 新条目初始权重
const FORCED_THRESHOLD = 0.1;     // 低于此值强制优先淘汰
const ACCESS_BOOST_FACTOR = 0.5;  // 访问新鲜度因子

/**
 * ContentArchive — 纯内存保留缓冲区。
 *
 * 职责：
 *   1. archive(key, content, options?) — 存入一条原始内容（超限时加权淘汰）
 *   2. recover(key) — 按 key 取出（同时升权 + 刷新 lastAccessedAt）
 *   3. list() — 列出所有存活条目的 key
 *   4. prune() — 清理过期条目（protected 条目同样过期即删）
 *   5. evictOne() — 加权淘汰一条非 protected 条目
 *
 * 线程安全：当前场景是单线程事件循环，无需锁。
 */
export class ContentArchive {
  private readonly store = new Map<string, ContentArchiveEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(config?: ContentArchiveConfig) {
    this.ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  // ─── 公共接口 ────────────────────────────────────

  /**
   * 存入一条原始内容。
   * 如果当前条目数 ≥ maxEntries，先清理过期条目，再加权淘汰直到有空间。
   * 所有未过期条目均受保护（protected = true）时 → 返回 error: NO_EVICTABLE_ENTRY。
   *
   * @param key      唯一键，建议格式 `"{source}:{toolCallId}"`
   * @param content  字符串或 ContentPart[]
   * @param options 可选参数：source（来源标识）、priority（初始权重）、protected（是否受保护）
   * @returns ArchiveResult
   */
  archive(
    key: string,
    content: string | ContentPart[],
    options?: { source?: string; priority?: number; protected?: boolean },
  ): ArchiveResult {
    const now = Date.now();
    let evictedCount = 0;

    // 容量门卫：循环淘汰直到有空间或无法继续
    for (let attempt = 0; attempt < this.maxEntries && this.store.size >= this.maxEntries; attempt++) {
      this.pruneInternal(now);
      if (this.store.size < this.maxEntries) break;
      const evicted = this.evictOne(now);
      if (!evicted) {
        return {
          key,
          success: false,
          evictedCount,
          error: 'NO_EVICTABLE_ENTRY',
        };
      }
      evictedCount++;
    }

    this.store.set(key, {
      content,
      timestamp: now,
      source: options?.source ?? 'unknown',
      priority: options?.priority ?? PRIORITY_NEW,
      protected: options?.protected ?? false,
      lastAccessedAt: now,
    });

    return { key, success: true, evictedCount };
  }

  /**
   * 按 key 取回内容。
   * 同时升权（priority += 0.1, 上限 1.0）+ 刷新 lastAccessedAt。
   * 过期或不存在返回 undefined。
   */
  recover(key: string): string | ContentPart[] | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;

    const now = Date.now();

    // TTL 过期检查（protected 条目同样过期）
    if (now - entry.timestamp > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }

    // 升权
    entry.priority = Math.min(PRIORITY_MAX, entry.priority + PRIORITY_BOOST);
    entry.lastAccessedAt = now;

    return entry.content;
  }

  /**
   * 列出所有存活条目的 key。
   */
  list(): string[] {
    this.prune();
    return Array.from(this.store.keys());
  }

  /**
   * 当前存活条目数。
   */
  get size(): number {
    this.prune();
    return this.store.size;
  }

  /**
   * 清理过期条目（protected 条目同样过期即删）。
   */
  prune(): number {
    return this.pruneInternal(Date.now());
  }

  /**
   * 清空所有条目。
   */
  clear(): void {
    this.store.clear();
  }

  // ─── 内部方法 ────────────────────────────────────

  /**
   * 内部 prune：清理所有 TTL 过期条目（protected 也删）。
   * @returns 删除的条目数
   */
  private pruneInternal(now: number): number {
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (now - entry.timestamp > this.ttlMs) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * 加权淘汰一条非 protected 条目。
   *
   * 评分公式：
   *   decay = Math.exp(-ageMs / TTL_MS)
   *   accessBoost = 1 - ageFactor × 0.5
   *   score = priority × decay × accessBoost
   *
   * 硬约束：priority < 0.1 的条目强制优先淘汰（在同组内选最低分）。
   *
   * @returns true 成功淘汰一条；false 无非 protected 条目可淘汰
   */
  private evictOne(now: number): boolean {
    let forcedTarget: { key: string; score: number } | null = null;
    let normalTarget: { key: string; score: number } | null = null;

    for (const [key, entry] of this.store) {
      if (entry.protected) continue;

      const ageMs = now - entry.timestamp;
      const ageFactor = Math.min(1, ageMs / this.ttlMs);
      const decay = Math.exp(-ageMs / this.ttlMs);
      const accessBoost = 1 - ageFactor * ACCESS_BOOST_FACTOR;
      const score = entry.priority * decay * accessBoost;

      if (entry.priority < FORCED_THRESHOLD) {
        // 强制淘汰组：选最低分
        if (forcedTarget === null || score < forcedTarget.score) {
          forcedTarget = { key, score };
        }
      } else {
        // 正常组：选最低分
        if (normalTarget === null || score < normalTarget.score) {
          normalTarget = { key, score };
        }
      }
    }

    // priority < 0.1 优先淘汰
    const target = forcedTarget ?? normalTarget;
    if (target === null) return false;

    this.store.delete(target.key);
    return true;
  }
}
