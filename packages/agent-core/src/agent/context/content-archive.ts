/**
 * ContentArchive — 保留缓冲区（纯内存）。
 *
 * 在工具输出被截断/MicroCompact/FullCompact 吞掉之前，把原始内容暂存到这里。
 * 模型后续可以通过 `archive_recover` MCP 工具按需召回完整内容。
 *
 * 设计要点：
 * - 纯内存，零外部依赖（LRU + TTL 双老化 + 权重淘汰）
 * - 单条生命周期 max 4 小时（以 lastAccessedAt 为判据，持续 recover 续命）
 * - 全局上限 2000 条目（加权淘汰，priority < 0.1 强制优先）
 * - 每个 entry 用调用方前缀 + toolCallId 做 key，互不干扰
 * - protected 仅防加权淘汰，不防 TTL 过期
 * - archive() 第三参数为 options 对象：{ source?, priority?, protected? }
 */

import type { ContentPart } from '@scream-code/ltod';
import { statSync } from 'node:fs';
import { flags } from '../../flags';

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
  /** 关联的文件路径（仅 tool result 存档有值） */
  filePath?: string;
  /** 文件修改时间（ms），用于检测文件变更 */
  fileMtime?: number;
  /** 文件大小（bytes） */
  fileSize?: number;
}

export interface ContentArchiveConfig {
  /** 软 TTL（ms），基于 lastAccessedAt，持续 recover 续命，默认 4 小时 */
  readonly ttlMs?: number;
  /** 硬 TTL（ms），基于 timestamp，无论如何强制过期，默认 24 小时 */
  readonly hardTtlMs?: number;
  /** 全局条目上限，默认 2000 */
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
const DEFAULT_TTL_MS = 14_400_000; // 4 小时（软 TTL，基于 lastAccessedAt）
const DEFAULT_HARD_TTL_MS = 86_400_000; // 24 小时（硬 TTL，基于 timestamp，覆盖软 TTL）（判据用 lastAccessedAt，持续 recover 的条目不丢）
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
  /** \u547d\u4e2d/\u672a\u547d\u4e2d\u8ba1\u6570\u5668 */
  private hits = 0;
  private misses = 0;
  /**
   * 全局共享存储（跨 agent 实例）。
   *
   * 子 agent 的 ContentArchive 通过此静态 Map 共享父 agent 的存档内容，
   * 实现「跨子 agent 缓存」——新建子 agent 时无需重新攒存。
   *
   * 生命周期：进程级，随进程销毁；不持久化。
   * 写入策略：每次 archive() 同步写入 sharedStore。
   * 读取策略：recover() 先查本地 store，未命中则回退到 sharedStore。
   * key 冲突：同 key 以本地 store 为准（本地优先）。
   */
  static readonly sharedStore = new Map<string, ContentArchiveEntry>();

  private readonly store = new Map<string, ContentArchiveEntry>();
  private readonly ttlMs: number;
  private readonly hardTtlMs: number;
  private readonly maxEntries: number;

  constructor(config?: ContentArchiveConfig) {
    this.ttlMs = config?.ttlMs ?? flags.asNumber('contentArchive.ttlMs') ?? DEFAULT_TTL_MS;
    this.hardTtlMs = config?.hardTtlMs ?? DEFAULT_HARD_TTL_MS;
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
    options?: { source?: string; priority?: number; protected?: boolean; filePath?: string; fileMtime?: number; fileSize?: number },
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
      filePath: options?.filePath,
      fileMtime: options?.fileMtime,
      fileSize: options?.fileSize,
    });

    // 同步写入全局共享存储（跨 agent 实例可见）
    ContentArchive.sharedStore.set(key, {
      content,
      timestamp: now,
      source: options?.source ?? 'unknown',
      priority: options?.priority ?? PRIORITY_NEW,
      protected: options?.protected ?? false,
      lastAccessedAt: now,
      filePath: options?.filePath,
      fileMtime: options?.fileMtime,
      fileSize: options?.fileSize,
    });

    return { key, success: true, evictedCount };
  }

  /**
   * 按 key 取回内容。
   * 先查本地 store，未命中则回退到 sharedStore。
   * 同时升权 + 刷新 lastAccessedAt。
   * 过期或不存在返回 undefined。
   */
  recover(key: string): string | ContentPart[] | undefined {
    // 查本地 store
    const entry = this.store.get(key);
    if (entry !== undefined) {
      this.hits++;
      const now = Date.now();
      if (now - entry.timestamp > this.hardTtlMs || now - entry.lastAccessedAt > this.ttlMs) {
        this.store.delete(key);
        ContentArchive.sharedStore.delete(key);
        return undefined;
      }
      // 校验关联文件是否已修改（覆盖外部编辑器修改）
      if (entry.filePath) {
        try {
          const st = statSync(entry.filePath);
          if (st.mtimeMs !== entry.fileMtime) {
            this.store.delete(key);
            ContentArchive.sharedStore.delete(key);
            return undefined;
          }
        } catch {
          this.store.delete(key);
          ContentArchive.sharedStore.delete(key);
          return undefined;
        }
      }
      entry.priority = Math.min(PRIORITY_MAX, entry.priority + PRIORITY_BOOST);
      entry.lastAccessedAt = now;
      return entry.content;
    }

    // 未命中本地 → 回退到共享存储
    const shared = ContentArchive.sharedStore.get(key);
    if (shared === undefined) return undefined;

    const now = Date.now();
    if (now - shared.timestamp > this.hardTtlMs || now - shared.lastAccessedAt > this.ttlMs) {
      ContentArchive.sharedStore.delete(key);
      return undefined;
    }
    // 校验关联文件是否已修改（共享存储路径）
    if (shared.filePath) {
      try {
        const st = statSync(shared.filePath);
        if (st.mtimeMs !== shared.fileMtime) {
          ContentArchive.sharedStore.delete(key);
          return undefined;
        }
      } catch {
        ContentArchive.sharedStore.delete(key);
        return undefined;
      }
    }
    // 从共享存储"借"回本地（soft copy-on-access）
    // ⚠️ 直接 mutate shared 对象而非创建新对象：保留 filePath/fileMtime/fileSize
    shared.priority = Math.min(PRIORITY_MAX, shared.priority + PRIORITY_BOOST);
    shared.lastAccessedAt = now;
    return shared.content;
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
    ContentArchive.sharedStore.clear();
  }

  // ─── 内部方法 ────────────────────────────────────

  /**
   * 内部 prune：清理所有 TTL 过期条目（protected 也删）。
   * 软 TTL（lastAccessedAt）失效 → 超期未访问
   * 硬 TTL（timestamp）失效 → 超过 24h 强制过期，持续 recover 也不保
   * @returns 删除的条目数
   */
  private pruneInternal(now: number): number {
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (now - entry.timestamp > this.hardTtlMs || now - entry.lastAccessedAt > this.ttlMs) {
        this.store.delete(key);
        ContentArchive.sharedStore.delete(key);
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

      const ageMs = now - entry.lastAccessedAt;
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

  /**
   * 文件被修改后清除所有关联该路径的缓存条目。
   * 由 Edit/Write 工具在写完文件后调用。
   *
   * @returns 删除了多少条
   */
  invalidateByPath(filePath: string): number {
    let count = 0;
    for (const [key, entry] of this.store) {
      if (entry.filePath === filePath) {
        this.store.delete(key);
        ContentArchive.sharedStore.delete(key);
        count++;
      }
    }
    if (count > 0) {
      console.log(`[ContentArchive] invalidated ${count} cache entries: ${filePath}`);
    }
    return count;
  }

  /**
   * 获取缓存统计信息（用于调试和监控）。
   */
  getStats(): { localSize: number; sharedSize: number; hits: number; misses: number } {
    return {
      localSize: this.store.size,
      sharedSize: ContentArchive.sharedStore.size,
      hits: this.hits,
      misses: this.misses,
    };
  }

  /**
   * 丢弃所有过期间缓存条目（强制清理）。
   */
  pruneAll(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (now - entry.lastAccessedAt > this.ttlMs) {
        this.store.delete(key);
        ContentArchive.sharedStore.delete(key);
        removed++;
      }
    }
    return removed;
  }
}
