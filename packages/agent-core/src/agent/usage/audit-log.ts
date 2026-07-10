import { appendFileSync, createWriteStream, existsSync, mkdirSync } from 'node:fs';

import { writeFile, appendFile } from 'node:fs/promises';

import { join, dirname } from 'node:path';

import type { TokenUsage } from '@scream-code/ltod';



// ── Types ────────────────────────────────────────────────────────



/**

 * 单条注入事件的详细记录。

 * 由 turn/index.ts 构建，合并 InjectionRouter.dispatch() + VariantScheduler 两路来源。

 * 每步写入 cache-audit-*.ndjson 的 injected 字段。

 */

export interface InjectionEvent {

  /** 注入变体名称（如 'stuck', 'guard-feedback'） */

  variant: string;

  /** 是否成功注入到 context */

  success: boolean;

  /** 注意力级别（S/A/B/C/D — 仅成功注入时有） */

  level?: string;

  /** 注入位置（H/AFTER_SYSTEM / M/MID_CONTEXT / T/AFTER_TOOL_CALL） */

  position?: string;

  /** 失败原因（仅 success=false 时）：residual / dedup / quota / error / timeout */

  reason?: string;

  /** 注入内容预估 token 数 */

  tokenEstimate?: number;

}



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

  /** 本轮注入事件的详细记录，空数组表示无注入 */

  injected: InjectionEvent[];

  /**

   * API 后端切换检测（heuristic）。

   * true 表示: model未变 + 无注入 + 非compaction + 前一步有缓存 + 当前缓存率骤降 + 输入量可比 → 疑似API key切换导致不同后端

   */

  apiKeySwitched: boolean;

  /** ContentArchive 缓存命中/未命中计数 */

  archiveHit: number;

  archiveMiss: number;

  /** 上轮用户消息步数（用于评估摘要触发阈值） */

  turnStepCount: number;

  /** 自动恢复失败的截断数据 key 数 */

  pendingRecoverKeys: number;

  /** 本轮是否触发了增量 LLM 摘要 */

  summaryTriggered: boolean;

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

        `# ============================================================\n` +
`# ============================================================\n` +
`# cache-audit — 缓存命中审计日志\n` +
`# ============================================================\n` +
`#\n` +
`# 📋 层级架构 (7层)\n` +
`#   L1 元数据  → turn, sessionId, model, ts, modelChanged\n` +
`#   L2 缓存    → totalInput, cacheHit, cacheMiss, hitRatio, apiKeySwitched\n` +
`#   L3 压缩    → compacted, compactedTokens\n` +
`#   L4 注入    → injected[].{variant,success,level,position,reason,tokenEstimate}\n` +
`#   L5 存档    → archiveHit, archiveMiss\n` +
`#   L6 摘要    → turnStepCount, pendingRecoverKeys, summaryTriggered\n` +
`#   L7 告警    → alerts\n` +
`#\n` +
`# 🔑 字段速查\n` +
`#   turn            用户消息轮次号（每轮从1递增，跨天不重置）\n` +
`#   sessionId       会话标识（重启/API切换会变，变后首轮必miss）\n` +
`#   model           模型名称（切换后下一轮几乎100%缓存miss）\n` +
`#   modelChanged    bool 本轮模型是否变了\n` +
`#   ts             ISO时间戳\n` +
`#   totalInput     本轮输入token总量\n` +
`#   cacheHit       缓存命中token数\n` +
`#   cacheMiss      缓存未命中token数\n` +
`#   hitRatio       缓存命中率（0-1，目标>0.97）\n` +
`#   compacted      bool 本轮是否触发了compaction\n` +
`#   compactedTokens  compaction节省的token数\n` +
`#   injected[]      注入事件数组（每轮可能0-N条）\n` +
`#     .variant      注入变体名（stuck / guard-feedback / intent_guidance 等）\n` +
`#     .success      bool 是否成功注入\n` +
`#     .level        S/A/B/C/D 注意力等级（仅success=true时）\n` +
`#     .position     H(头部AFTER_SYSTEM) / M(中部MID_CONTEXT) / T(尾部AFTER_TOOL_CALL)\n` +
`#     .reason       失败原因（success=false时）: residual/dedup/quota/error/timeout\n` +
`#     .tokenEstimate 注入内容预估token数\n` +
`#   apiKeySwitched  bool 疑似API key切换导致缓存miss\n` +
`#   archiveHit      ContentArchive命中计数\n` +
`#   archiveMiss     ContentArchive未命中计数\n` +
`#   turnStepCount  上轮用户消息步数（用于评估≥8步触发阈值）\n` +
`#   pendingRecoverKeys  自动恢复失败的截断数据key数（第一层兜底失败率）\n` +
`#   summaryTriggered  bool 本轮是否触发了增量LLM摘要\n` +
`#\n` +
`# 💡 高效查询\n` +
`#   看今日摘要触发频率:\n` +
`#     grep '"summaryTriggered":true' cache-audit-$(date +%F).ndjson | wc -l\n` +
`#   看哪些轮次是长任务（≥10步）:\n` +
`#     grep '"turnStepCount":1[0-9]' cache-audit-*.ndjson | jq '{turn,turnStepCount,summaryTriggered}'\n` +
`#   看注入被拦截的轮次（残差/去重/配额）:\n` +
`#     jq 'select(.injected[].success==false) | {turn,injected}' cache-audit-*.ndjson\n` +
`#   看S级高优注入分布:\n` +
`#     jq 'select(.injected[].level=="S") | {turn,injected}' cache-audit-*.ndjson\n` +
`#   看三大注入位置比例:\n` +
`#     jq '[.injected[] | select(.success) | .position] | group_by(.) | map({pos:.[0],n:length})' cache-audit-*.ndjson\n` +
`#   查API切换的轮次:\n` +
`#     grep '"modelChanged":true' cache-audit-*.ndjson\n` +
`#\n` +
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

  injectedEvents: InjectionEvent[] = [],

  modelChanged = false,

  apiKeySwitched = false,

  archiveStats?: { hits: number; misses: number },

  turnStepCount = 0,

  pendingRecoverKeys = 0,

  summaryTriggered = false,

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

    injected: injectedEvents,

    apiKeySwitched,

    archiveHit: archiveStats?.hits ?? 0,

    archiveMiss: archiveStats?.misses ?? 0,

    turnStepCount,

    pendingRecoverKeys,

    summaryTriggered,

  };

}