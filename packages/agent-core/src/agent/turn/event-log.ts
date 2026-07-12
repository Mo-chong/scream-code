/**
 * TurnEventLog — 回合级拦截事件日志系统。
 *
 * 内存环形缓冲区。记录系统在 inject() / convergence gate / afterStep 中
 * 发生的所有拦截事件。AI 没有绕过权——record() 调用嵌入在硬编码路径中。
 *
 * 与 SessionMemory 同模式：环形缓冲区 + record() + getTurnSummary()。
 * SessionMemory 记工具执行，TurnEventLog 记拦截事件。
 */

import { VARIANT_META } from './variant-registry';
import type { DetectorResult, InterceptionDecision, DeliveryResult, RootCauseTrend, DetectorStats, TurnInterceptionReport } from '../interception/event-types';

export interface InterceptionEvent {
  /** 全局序列号。单调递增。 */
  seq: number;
  /** 事件种类：injection_skipped | injection_delivered | convergence_gate | deviation_chain | confabulation | verify_fail | guard_observe | behavior_feedback */
  kind: string;
  /** 相关 variant 名称（无 variant 的穿件传空字符串） */
  variant: string;
  /** 记录时的回合步号 */
  step: number;
  /** 具体动作：skipped_residual | skipped_budget | injected | gate_held | gate_passed | detected | observed | not_observed */
  action: string;
  /** 人类可读的原因说明 */
  reason: string;
  /** 所属回合 ID */
  turnId: number;
  /** 🆕 Phase15+: 注入时的权重等级（仅 delivered/skipped 事件有效） */
  level?: string;
  /** 🆕 Phase15+: 预算估值（仅 budget skip 事件有效） */
  tokenEstimate?: number;
  /** 🆕 Phase26: 主体类型 — 'main' | 'sub' | 'independent' */
  agentType?: string;
}

const MAX_EVENTS = 200;

export class TurnEventLog {
  private events: InterceptionEvent[] = [];
  private nextSeq = 1;

  /** 增量摘要追踪：用于 afterStep 只注入新事件。 */
  private lastSummarizedTurnId = -1;
  private lastSummarizedSeq = 0;
  /** 当前回合采样决策缓存：variant → 本回合是否采样 */
  private turnSampleCache = new Map<string, boolean>();

  /**
   * 记录一条拦截事件。
   *
   * 采样过滤：高频 variant 按 ResNet W 权重降采样。
   * seq 自动分配。事件数超 MAX_EVENTS 时丢弃最旧的事件。
   */
  record(event: Omit<InterceptionEvent, 'seq'>): void {
    // W 驱动采样：高频 variant 降采样减少记录量
    if (!this.shouldSample(event.variant)) return;

    this.events.push({ ...event, seq: this.nextSeq++ });
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }
  }

  /** 获取指定回合的所有事件。 */
  getTurnEvents(turnId: number): InterceptionEvent[] {
    return this.events.filter(e => e.turnId === turnId);
  }

  /** 按事件种类过滤。 */
  getByKind(kind: string): InterceptionEvent[] {
    return this.events.filter(e => e.kind === kind);
  }

  /** 按 variant 名称过滤。 */
  getByVariant(variant: string): InterceptionEvent[] {
    return this.events.filter(e => e.variant === variant);
  }

  /**
   * 获取自上次调用以来新增的回合事件摘要。
   * 用于 afterStep 增量注入——避免重复发送已报告的事件。
   * 跨回合自动重置。
   *
   * 自动过滤掉 interception_log 变体自身的事件，防止日志注入自引用的无限循环。
   */
  getNewTurnSummary(turnId: number): string {
    if (turnId !== this.lastSummarizedTurnId) {
      this.lastSummarizedTurnId = turnId;
      this.lastSummarizedSeq = 0;
    }
    const newEvents = this.events.filter(e =>
      e.seq > this.lastSummarizedSeq && e.turnId === turnId && e.variant !== 'interception_log',
    );
    if (newEvents.length === 0) return '';

    this.lastSummarizedSeq = this.events.at(-1)?.seq ?? 0;
    return this.formatEvents(newEvents);
  }

  /** 回合开始时清空。 */
  clear(): void {
    this.events.length = 0;
    this.nextSeq = 1;
    this.lastSummarizedTurnId = -1;
    this.lastSummarizedSeq = 0;
    this.turnSampleCache.clear();
  }

  /** 获取所有事件（用于 INDEX.json v2 汇总）。 */
  getAllEvents(): InterceptionEvent[] {
    return this.events;
  }

  /**
   * 获取指定回合的预算使用摘要。
   * 从事件中聚合 injection_delivered 的 tokenEstimate (used)，
   * injection_skipped/skipped_budget (skipped)，
   * 和 injection_skipped/skipped_residual (residual)。
   * 返回 null 表示该回合无事件。
   */
  getBudgetSummary(turnId: number): { used: number; skipped: number; residual: number; totalEvents: number } | null {
    const turnEvents = this.getTurnEvents(turnId);
    if (turnEvents.length === 0) return null;
    let used = 0;
    let skipped = 0;
    let residual = 0;
    for (const e of turnEvents) {
      if (e.kind === 'injection_delivered' && e.action === 'injected') {
        if (e.tokenEstimate) used += e.tokenEstimate;
      } else if (e.kind === 'injection_skipped' && e.action === 'skipped_budget') {
        skipped++;
      } else if (e.kind === 'injection_skipped' && e.action === 'skipped_residual') {
        residual++;
      }
    }
    return { used, skipped, residual, totalEvents: turnEvents.length };
  }

  // ── W 驱动采样 ─────────────────────────────────────────

  /**
   * 根据 ResNet VARIANT_META.W 权重判断本条事件是否应该记录。
   *
   * 高频 variant（低 W）降采样减少记录量。
   * 低频重要 variant（高 W 或无配置）全量记录。
   *
   * 同 variant 在同一回合中采样决策一致（回合开始时缓存）。
   */
  private shouldSample(variant: string): boolean {
    if (!variant) return true;
    const cached = this.turnSampleCache.get(variant);
    if (cached !== undefined) return cached;

    const rate = sampleRateForVariant(variant);
    if (rate >= 1.0) {
      this.turnSampleCache.set(variant, true);
      return true;
    }
    const sampled = hashVariant(variant) % 100 < rate * 100;
    this.turnSampleCache.set(variant, sampled);
    return sampled;
  }

  /** 将事件列表格式化为摘要文本。 */
  private formatEvents(events: InterceptionEvent[]): string {
    const lines: string[] = ['### 拦截日志', ''];
    const groups = new Map<string, InterceptionEvent[]>();

    for (const e of events) {
      const key = `${e.kind}/${e.action}`;
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(e);
    }

    for (const [key, group] of groups) {
      lines.push(`- ${key}: ${group.length} 次`);
      for (const e of group.slice(-3)) {
        const v = e.variant ? `[${e.variant}] ` : '';
        lines.push(`  · 第${e.step}步: ${v}${e.reason}`);
      }
    }

    return lines.join('\n');
  }

  // ── Phase38 新增：结构化拦截事件记录 ─────────────────────────

  /** 记录一轮拦截检测的完整报告（detectors + 决策 + 投递） */
  recordReport(report: TurnInterceptionReport): void {
    if (report.detectors.length === 0 && report.decisions.length === 0) return;

    // 记录每一条 detector 输出
    for (const d of report.detectors) {
      this.record({
        kind: 'detector_fired',
        variant: d.detector,
        step: report.stepCount,
        turnId: report.turnId,
        action: d.suppressed ? 'suppressed' : 'active',
        reason: `[${d.rootCause}] ${d.message.slice(0, 60)}`,
        level: d.isPositive ? '1' : '0',
        tokenEstimate: 0,
        agentType: 'main',
      });
    }

    // 记录每一条决策
    for (const d of report.decisions) {
      this.record({
        kind: 'interception_decision',
        variant: `intercept_${d.rootCause}`,
        step: d.step,
        turnId: report.turnId,
        action: d.blocked ? 'blocked' : d.isPositive ? 'positive' : 'injected',
        reason: `[${d.priority}] ${d.escalation} x${d.triggerCount}: ${d.message.slice(0, 60)}`,
        level: d.priority === 'P0_block' ? '3' : d.priority === 'P1_discipline' ? '2' : d.priority === 'P2_quality' ? '1' : '0',
        tokenEstimate: d.message.length / 4,
        agentType: 'main',
      });
    }

    // 记录投递结果
    for (const d of report.deliveries) {
      this.record({
        kind: 'interception_delivery',
        variant: `intercept_${d.rootCause}`,
        step: d.step,
        turnId: report.turnId,
        action: d.outcome,
        reason: d.outcome === 'delivered' ? `位置: ${d.position || '?'}` : '超budget',
        level: d.outcome === 'delivered' ? '1' : '0',
        tokenEstimate: d.tokenEstimate ?? 0,
        agentType: 'main',
      });
    }
  }

  // ── Phase38 新增：AI 可查询的聚合方法 ─────────────────────────

  /** 获取指定根因的触发趋势（最近 N 步内） */
  getRootCauseTrend(rootCause: string, recentSteps: number = 30): RootCauseTrend {
    const all = this.events.filter(e => e.variant === `intercept_${rootCause}`);
    const recent = all.filter(e => e.step >= (this.events.at(-1)?.step ?? 0) - recentSteps);

    const escalationMap: Record<string, number> = { hint: 1, nudge: 2, warn: 3, block: 4 };
    let sumEsc = 0;
    let escCount = 0;
    for (const e of recent) {
      const match = e.reason.match(/\[(\w+)\]\s+(\w+)\s+x(\d+)/);
      if (match) {
        sumEsc += escalationMap[match[2]!] || 1;
        escCount++;
      }
    }

    const lastEvent = all.at(-1);
    const currentEsc: 'hint' | 'nudge' | 'warn' | 'block' = lastEvent
      ? (lastEvent.reason.includes('blocked') ? 'block'
        : lastEvent.reason.includes('warn') ? 'warn'
        : lastEvent.reason.includes('nudge') ? 'nudge' : 'hint')
      : 'hint';

    return {
      rootCause: rootCause as any,
      label: rootCause,
      recentCount: recent.length,
      totalCount: all.length,
      avgEscalation: escCount > 0 ? sumEsc / escCount : 1,
      active: recent.length > 0,
      currentEscalation: currentEsc,
    };
  }

  /** 获取所有 detector 的效果分析 */
  getAllDetectorStats(): DetectorStats[] {
    const detectorMap = new Map<string, { total: number; delivered: number; suppressed: number; block: number; lastStep: number }>();

    for (const e of this.events) {
      if (e.kind === 'detector_fired' && e.variant) {
        const stat = detectorMap.get(e.variant) ?? { total: 0, delivered: 0, suppressed: 0, block: 0, lastStep: 0 };
        stat.total++;
        if (e.action === 'suppressed') stat.suppressed++;
        if (e.action === 'active') stat.delivered++;
        if (e.reason.includes('blocked')) stat.block++;
        if (e.step > stat.lastStep) stat.lastStep = e.step;
        detectorMap.set(e.variant, stat);
      }
    }

    return Array.from(detectorMap.entries()).map(([detector, s]) => ({
      detector,
      totalTriggers: s.total,
      delivered: s.delivered,
      suppressed: s.suppressed,
      suppressionRate: s.total > 0 ? s.suppressed / s.total : 0,
      blockCount: s.block,
      lastTriggerStep: s.lastStep,
    }));
  }

  /** 获取整体拦截概况摘要（AI 一眼看懂的文本） */
  getInterceptionSummary(): string {
    const stats = this.getAllDetectorStats();
    if (stats.length === 0) return '无拦截事件。';

    const lines: string[] = ['## 拦截系统运行概况', ''];

    // 总触发
    const total = stats.reduce((s, d) => s + d.totalTriggers, 0);
    lines.push(`总拦截事件: ${total} 次`);

    // 按活跃度排序
    const active = stats.filter(d => d.totalTriggers > 0).sort((a, b) => b.totalTriggers - a.totalTriggers);
    lines.push('');
    lines.push('### Detector 触发频率');
    for (const d of active.slice(0, 10)) {
      const bar = '█'.repeat(Math.min(d.totalTriggers, 20));
      const pct = (d.suppressionRate * 100).toFixed(0);
      lines.push(`- ${d.detector.padEnd(30)} ${d.totalTriggers}次 ${bar} (禁言率 ${pct}%)`);
    }

    // 频繁升级到 block 的根因
    const blockers = stats.filter(d => d.blockCount > 0).sort((a, b) => b.blockCount - a.blockCount);
    if (blockers.length > 0) {
      lines.push('');
      lines.push('### 高频阻断源');
      for (const d of blockers.slice(0, 5)) {
        lines.push(`- ${d.detector}: ${d.blockCount} 次阻断`);
      }
    }

    lines.push('');
    lines.push('> 趋势数据自动更新。需要深度分析请调用 getRootCauseTrend() 或 getAllDetectorStats()。');
    return lines.join('\n');
  }
}

// ── W 驱动采样率计算 ────────────────────────────────────────

/**
 * 根据 ResNet VARIANT_META.W 权重计算采样率。
 *
 * 公式: sampleRate = clamp(W × 0.5 + 0.1, 0.1, 1.0)
 * W=1.0 → 60%, W=0.8 → 50%, W=0.5 → 35%, 未配置 → 100%（保守全量）
 */
function sampleRateForVariant(variant: string): number {
  const meta = VARIANT_META[variant];
  if (!meta) return 1.0;
  return Math.min(1.0, Math.max(0.1, meta.weight * 0.5 + 0.1));
}

/**
 * 基于 variant 名称的确定性哈希。
 * 确保同 variant 在同一回合中采样决策一致。
 */
function hashVariant(variant: string): number {
  let hash = 0;
  for (let i = 0; i < variant.length; i++) {
    const char = variant.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // 转 32-bit int
  }
  return Math.abs(hash);
}
