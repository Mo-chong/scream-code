import { appendFileSync, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { writeFile, appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { TokenUsage } from '@scream-code/ltod';

// ── Types ────────────────────────────────────────────────────────

export interface CacheMetrics {
  hitRatio: number;          // cacheHit / (cacheHit + cacheMiss), 0 if no data
  hitTokens: number;
  missTokens: number;
  totalInput: number;        // total input tokens this turn
}

export interface AuditLogEntry {
  turn: number;
  model: string;
  modelChanged: boolean;
  sessionId: string;
  /** ISO timestamp */
  ts: string;
  totalInput: number;
  cacheHit: number;
  cacheMiss: number;
  hitRatio: number;
  compacted: boolean;
  compactedTokens: number;
  alerts: string[];
  /** 本轮注入的变体名列表，空表示无注入 */
  injected: string[];
  /**
   * API 后端切换检测（heuristic）。
   * true 表示: model未变 + 无注入 + 非compaction + 前一步有缓存 + 当前缓存率骤降 + 输入量可比 → 疑似API key切换导致不同后端
   */
  apiKeySwitched: boolean;
}

export interface AuditLoggerConfig {
  /** Directory for audit log files, defaults to workspace/ */
  logDir?: string;
}

// ── Alert rules ───────────────────────────────────────────────────

const ALERT_RULES: { check: (m: CacheMetrics) => string | null }[] = [
  {
    check: (m) =>
      m.hitTokens + m.missTokens > 0 && m.hitRatio < 0.2
        ? `缓存接近全 miss (命中率 ${(m.hitRatio * 100).toFixed(0)}%) — 检查注入频率或刚 compaction`
        : null,
  },
  {
    check: (m) =>
      m.hitTokens + m.missTokens > 0 && m.hitRatio > 0.8
        ? null // 静默 — 正常
        : null,
  },
];

// ── CacheMetrics calculator ──────────────────────────────────────

export function computeCacheMetrics(usage: TokenUsage): CacheMetrics {
  const hitTokens = usage.cacheHitTokens ?? 0;
  const missTokens = usage.cacheMissTokens ?? 0;
  const total = hitTokens + missTokens;
  const hitRatio = total > 0 ? hitTokens / total : 0;

  return {
    hitRatio,
    hitTokens,
    missTokens,
    totalInput: usage.inputOther + (usage.inputCacheRead ?? 0) + (usage.inputCacheCreation ?? 0),
  };
}

// ── Audit log writer ─────────────────────────────────────────────

export class AuditLogWriter {
  private logDir: string;
  private stream: ReturnType<typeof createWriteStream> | null = null;
  private entryCount = 0;
  private flushIntervalMs: number;
  /** 当前打开的日期, YYYY-MM-DD */
  private currentDate: string = '';

  constructor(config: AuditLoggerConfig = {}) {
    this.logDir = config.logDir ?? 'workspace';
    this.flushIntervalMs = 5000; // flush every 5s
  }

  async ensureDir(): Promise<void> {
    const dir = join(this.logDir);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private get filePath(): string {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return join(this.logDir, `cache-audit-${date}.ndjson`);
  }

  async init(): Promise<void> {
    await this.ensureDir();
    this.currentDate = new Date().toISOString().slice(0, 10);
    const fp = this.filePath;
    if (!existsSync(fp)) {
      await writeFile(
        fp,
        `# cache-audit — 缓存命中审计\n` +
        `# 用途: 诊断注入/compaction/API切换对KV缓存的影响 | sessionId按对话查 | injected列出本轮注入变体 | modelChanged=true表示API切换过\n` +
        `# 查: grep '"injected":\\[' cache-audit-*.ndjson 找出有注入的轮次 | grep '"modelChanged":true' 找API切换的轮次\n` +
        `# fields: turn,model,sessionId,modelChanged,ts,totalInput,cacheHit,cacheMiss,hitRatio,compacted,compactedTokens,alerts,injected,apiKeySwitched\n` +
        `# started: ${new Date().toISOString()}\n`,
      );
    }
    this.stream = createWriteStream(fp, { flags: 'a', encoding: 'utf-8' });
  }

  write(entry: AuditLogEntry): void {
    if (!this.stream) {
      return;
    }
    // 按日期轮转：新的一天 → 关旧流开新流
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.currentDate) {
      this.stream.end();
      this.currentDate = today;
      const fp = join(this.logDir, `cache-audit-${today}.ndjson`);
      if (!existsSync(fp)) {
        appendFileSync(
          fp,
	  `# cache-audit — 缓存命中审计\n` +
	  `# 用途: 诊断注入/compaction/API切换对KV缓存的影响 | sessionId按对话查 | injected列出本轮注入变体 | modelChanged=true表示API切换过\n` +
	  `# 查: grep '"injected":\\[' cache-audit-*.ndjson 找出有注入的轮次 | grep '"modelChanged":true' 找API切换的轮次\n` +
	  `# fields: turn,model,sessionId,modelChanged,ts,totalInput,cacheHit,cacheMiss,hitRatio,compacted,compactedTokens,alerts,injected,apiKeySwitched\n` +
	  `# started: ${new Date().toISOString()}
`,
        );
      }
      this.stream = createWriteStream(fp, { flags: 'a', encoding: 'utf-8' });
    }
    const line = JSON.stringify(entry) + '\n';
    this.stream.write(line);
    this.entryCount++;

    // Auto-flush every N entries
    if (this.entryCount % 20 === 0) {
      this.stream.write(''); // flush hint
    }
  }

  async flush(): Promise<void> {
    // createWriteStream with 'a' doesn't have a great flush, but
    // we can close and reopen to guarantee durability on demand.
    // For now, rely on the OS buffer.
  }

  destroy(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }
}

// ── Entry builder ─────────────────────────────────────────────────

/**
 * Detect if a cache miss is likely caused by an API endpoint switch
 * (different backend has no shared cache) rather than injection or context growth.
 *
 * DeepSeek KV 缓存特性：
 * - 完整前缀单元缓存，公共前缀（如 system prompt）跨请求检测落盘
 * - 切换后端后公共前缀可能仍命中，但对话特定内容必然 miss
 * - 因此 hit ratio 不会降到 0%，只会从 ~95% 降到 20-60%
 *
 * 最优方案：用 期望命中 vs 实际命中 的比值代替硬阈值。
 * expectedHitTokens = prevRatio × currTotalInput（如缓存行为不变应有的命中数）
 * actualHitTokens = currMetrics.hitTokens
 * 若 actual / expected < 0.3 → 缓存严重退化，排除其他因素后判定为后端切换
 *
 * 排除条件：modelChanged / compacted / injected / 无可比前一步 /
 *   前一步无缓存 / 输入量不可比（>3x 排除上下文暴涨）
 */
export function detectApiKeySwitch(
  prevMetrics: CacheMetrics | null,
  currMetrics: CacheMetrics,
  modelChanged: boolean,
  compacted: boolean,
  injectedCount: number,
): boolean {
  if (modelChanged) return false;
  if (compacted) return false;
  if (!prevMetrics) return false;

  // 前一步必须有可观的缓存（≥70%才有意义判断"失去了缓存"）
  if (prevMetrics.hitRatio < 0.7) return false;

  // 输入量可比（排除上下文暴涨稀释缓存）
  const inputRatio = Math.max(currMetrics.totalInput, prevMetrics.totalInput) /
    Math.min(currMetrics.totalInput, prevMetrics.totalInput);
  if (inputRatio > 3) return false;

  // 降幅：前一步命中率 - 当前步命中率
  // API切换实测降幅 25-65pp（公共前缀缓存跨key残存），正常波动 <5pp
  const drop = prevMetrics.hitRatio - currMetrics.hitRatio;
  if (drop < 0.25) return false;

  // 注入保护：有任何注入 → 不判定为API切换。注入会改prompt前缀，影响缓存命中率。
  // 这是最高优先级规则——宁可漏判API切换，绝不误判注入导致的缓存降低。
  if (injectedCount > 0) return false;

  return true;
}

export function buildAuditEntry(
  turn: number,
  model: string,
  sessionId: string,
  metrics: CacheMetrics,
  compacted: boolean,
  compactedTokens: number,
  injectedVariants: string[] = [],
  modelChanged = false,
  apiKeySwitched = false,
  archiveStats?: { hits: number; misses: number },
): AuditLogEntry {
  const alerts: string[] = [];
  for (const rule of ALERT_RULES) {
    const alert = rule.check(metrics);
    if (alert) alerts.push(alert);
  }

  // F4: 实时告警 — 审计日志不只看才用
  for (const alert of alerts) {
    console.warn(`[cache-audit] ${alert}`);
  }
  if (apiKeySwitched) {
    console.warn(`[cache-audit] apiKeySwitched detected at turn ${turn}`);
  }

  return {
    turn,
    model,
    sessionId,
    modelChanged,
    ts: new Date().toISOString(),
    totalInput: metrics.totalInput,
    cacheHit: metrics.hitTokens,
    cacheMiss: metrics.missTokens,
    hitRatio: metrics.hitRatio,
    compacted,
    compactedTokens,
    alerts,
    injected: injectedVariants,
    apiKeySwitched,
    archiveHit: archiveStats?.hits ?? 0,
    archiveMiss: archiveStats?.misses ?? 0,
  };
}