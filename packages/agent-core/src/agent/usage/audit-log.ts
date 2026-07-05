import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
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
  /** ISO timestamp */
  ts: string;
  totalInput: number;
  cacheHit: number;
  cacheMiss: number;
  hitRatio: number;
  compacted: boolean;
  compactedTokens: number;
  alerts: string[];
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
    return join(this.logDir, 'cache-audit.ndjson');
  }

  async init(): Promise<void> {
    await this.ensureDir();
    const fp = this.filePath;
    // Write header comment on first open
    if (!existsSync(fp)) {
      await writeFile(
        fp,
        `# cache-audit — Phase26 缓存命中审计日志\n` +
        `# format: JSON Lines (ndjson), one entry per turn\n` +
        `# fields: turn,model,ts,totalInput,cacheHit,cacheMiss,hitRatio,compacted,compactedTokens,alerts\n` +
        `# started: ${new Date().toISOString()}\n`,
      );
    }
    this.stream = createWriteStream(fp, { flags: 'a', encoding: 'utf-8' });
  }

  write(entry: AuditLogEntry): void {
    if (!this.stream) {
      // Silent drop if not initialized — don't crash the turn
      return;
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

export function buildAuditEntry(
  turn: number,
  model: string,
  metrics: CacheMetrics,
  compacted: boolean,
  compactedTokens: number,
): AuditLogEntry {
  const alerts: string[] = [];
  for (const rule of ALERT_RULES) {
    const alert = rule.check(metrics);
    if (alert) alerts.push(alert);
  }

  return {
    turn,
    model,
    ts: new Date().toISOString(),
    totalInput: metrics.totalInput,
    cacheHit: metrics.hitTokens,
    cacheMiss: metrics.missTokens,
    hitRatio: metrics.hitRatio,
    compacted,
    compactedTokens,
    alerts,
  };
}