/**
 * InterceptionEventLog — 拦截事件日志记录与查询 API
 *
 * 3 层结构化拦截事件记录 + 聚合查询 API。
 * 从 `turn/event-log.ts` TurnEventLog 类中提取的独立函数，
 * 所有拦截日志逻辑统一归入 `interception/` 目录。
 *
 * 与 TurnEventLog 的关系：
 *   - recordInterceptionEvents() 接受 record 回调（避免对 TurnEventLog 的直接依赖）
 *   - 查询函数接受 events 数组（纯函数，可测试）
 *   - turn/event-log.ts 中 TurnEventLog 的方法委托到本文件
 */

import type { AttentionPriority, EscalationLevel, RootCause } from './types';
import type { InterceptionEvent } from '../turn/event-log';
import type { TurnInterceptionReport, RootCauseTrend, DetectorStats } from './event-types';

/* ──────────────── 记录 ──────────────── */

/** 拦截事件记录（被 InterceptionManager.recordStep() 自动调用） */
export function recordInterceptionEvents(
  record: (event: Omit<InterceptionEvent, 'seq'>) => void,
  report: TurnInterceptionReport,
): void {
  if (report.detectors.length === 0 && report.decisions.length === 0) return;

  for (const d of report.detectors) {
    record({
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

  for (const d of report.decisions) {
    record({
      kind: 'interception_decision',
      variant: `intercept_${d.rootCause}`,
      step: d.step,
      turnId: report.turnId,
      action: d.blocked ? 'blocked' : d.isPositive ? 'positive' : 'injected',
      reason: `[${d.priority}] ${d.escalation} x${d.triggerCount}: ${d.message.slice(0, 60)}`,
      level: d.priority === 'P0_block' ? '3' : d.priority === 'P1_discipline' ? '2' : d.priority === 'P2_quality' ? '1' : '0',
      tokenEstimate: Math.round(d.message.length / 4),
      agentType: 'main',
    });
  }

  for (const d of report.deliveries) {
    record({
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

/* ──────────────── 查询 API ──────────────── */

/** 获取指定根因的触发趋势 */
export function getRootCauseTrend(
  events: InterceptionEvent[],
  rootCause: string,
  recentSteps: number = 30,
): RootCauseTrend {
  const all = events.filter(e => e.variant === `intercept_${rootCause}`);
  const maxStep = events.reduce((m, e) => Math.max(m, e.step), 0);
  const recent = all.filter(e => e.step >= maxStep - recentSteps);

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
  const currentEsc: EscalationLevel = lastEvent
    ? (lastEvent.reason.includes('blocked') ? 'block'
      : lastEvent.reason.includes('warn') ? 'warn'
      : lastEvent.reason.includes('nudge') ? 'nudge' : 'hint')
    : 'hint';

  return {
    rootCause: rootCause as RootCause,
    label: rootCause,
    recentCount: recent.length,
    totalCount: all.length,
    avgEscalation: escCount > 0 ? sumEsc / escCount : 1,
    active: recent.length > 0,
    currentEscalation: currentEsc,
  };
}

/** 获取所有 detector 的效果分析 */
export function getDetectorStats(events: InterceptionEvent[]): DetectorStats[] {
  const detectorMap = new Map<string, { total: number; delivered: number; suppressed: number; block: number; lastStep: number }>();

  for (const e of events) {
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
export function getInterceptionSummary(events: InterceptionEvent[]): string {
  const stats = getDetectorStats(events);
  if (stats.length === 0) return '无拦截事件。';

  const lines: string[] = ['## 拦截系统运行概况', ''];

  const total = stats.reduce((s, d) => s + d.totalTriggers, 0);
  lines.push(`总拦截事件: ${total} 次`);
  lines.push('');

  const active = stats.filter(d => d.totalTriggers > 0).sort((a, b) => b.totalTriggers - a.totalTriggers);
  lines.push('### Detector 触发频率');
  for (const d of active.slice(0, 10)) {
    const bar = '█'.repeat(Math.min(d.totalTriggers, 20));
    const pct = (d.suppressionRate * 100).toFixed(0);
    lines.push(`- ${d.detector.padEnd(30)} ${d.totalTriggers}次 ${bar} (禁言率 ${pct}%)`);
  }

  const blockers = stats.filter(d => d.blockCount > 0).sort((a, b) => b.blockCount - a.blockCount);
  if (blockers.length > 0) {
    lines.push('');
    lines.push('### 高频阻断源');
    for (const d of blockers.slice(0, 5)) {
      lines.push(`- ${d.detector}: ${d.blockCount} 次阻断`);
    }
  }

  lines.push('');
  lines.push('> 趋势数据自动更新。需要深度分析请调用 getRootCauseTrend() 或 getDetectorStats()。');
  return lines.join('\n');
}
