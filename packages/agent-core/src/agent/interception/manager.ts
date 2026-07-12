/**
 * InterceptionManager — 拦截系统中央调度器
 *
 * Phase38a 基础设施。
 * 以 AI 消费体验为中心：根因合并、5 层优先级、递进策略、统一输出。
 *
 * ── 核心数据流 ──
 * detectors[] (纯函数) → RawSignal[]
 *   → mergeByRootCause() → MergedSignal[]
 *   → calcEscalation() → 带递进等级的 MergedSignal[]
 *   → sortByPriority() + budgetCap(3) → 排序封顶
 *   → formatMessage() → InterceptionMessage[] → AI
 */

import type { Agent } from '..';
import type {
  AttentionPriority,
  DetectorFn,
  EscalationLevel,
  InterceptionConfig,
  InterceptionContext,
  InterceptionMessage,
  InterceptionResult,
  MergedSignal,
  RawSignal,
  RootCause,
} from './types';
import { DEFAULT_INTERCEPTION_CONFIG, ROOT_CAUSE_PRIORITY_ORDER } from './config';

/** 根因的中文标签（用于统一输出格式的 header） */
const ROOT_CAUSE_LABEL: Record<RootCause, string> = {
  stuck_loop: '失败循环',
  confabulation: '虚构内容',
  edit_discipline: '编辑纪律',
  verify_discipline: '验证纪律',
  behavior_repeat: '重复行为',
  quality_degrade: '质量下降',
  attention_signal: '注意信号',
  tool_permission: '工具权限',
  turn_limit: '回合上限',
  context_pressure: '上下文压力',
  log_info: '日志信息',
};

/** 优先级标签（短格式，用于 header） */
const PRIORITY_LABEL: Record<AttentionPriority, string> = {
  P0_block: 'P0',
  P1_discipline: 'P1',
  P2_quality: 'P2',
  P3_signal: 'P3',
  P4_info: 'P4',
};

export class InterceptionManager {
  /** 注册的 detector 函数列表 */
  private detectors: DetectorFn[] = [];

  /** 历史触发计数器（key = rootCause，value = 累计次数） */
  private triggerHistory = new Map<string, number>();

  /** 当前配置 */
  private config: InterceptionConfig;

  constructor(
    /** Agent 引用（用于访问 eventLog、guard 等） */
    private readonly agent: Agent,
    config?: Partial<InterceptionConfig>,
  ) {
    this.config = { ...DEFAULT_INTERCEPTION_CONFIG, ...config };
  }

  /* ──────────────── 公共 API ──────────────── */

  /** 注册一个 detector 纯函数 */
  registerDetector(detector: DetectorFn): void {
    this.detectors.push(detector);
  }

  /** 主入口：执行拦截检查 */
  execute(ctx: InterceptionContext): InterceptionResult {
    if (!this.config.enabled) return { blocked: false, messages: [] };

    // Step 1: 运行所有 detector → 收集原始信号
    const signals: RawSignal[] = [];
    for (const detect of this.detectors) {
      const signal = detect(ctx);
      if (signal) signals.push(signal);
    }

    // Step 2: 检测"修复恢复"——先前活跃的根因本轮不再触发（正向信号）
    const currentRootCauses = new Set(signals.map((s) => s.rootCause));
    const resolvedCauses: { rootCause: string; prevCount: number }[] = [];
    for (const [cause, count] of this.triggerHistory) {
      if (count > 0 && !currentRootCauses.has(cause as any)) {
        resolvedCauses.push({ rootCause: cause, prevCount: count });
      }
    }

    // 最多 1 条正向信号/步（避免刷屏）
    let resolutionSignal: RawSignal | null = null;
    const firstResolved = resolvedCauses[0];
    if (firstResolved) {
      resolutionSignal = {
        rootCause: firstResolved.rootCause as any,
        priority: 'P3_signal',
        confidence: 0.7,
        message: `[恢复] 你已修复/摆脱了「${firstResolved.rootCause}」问题，已连续触发 ${firstResolved.prevCount} 次后在本轮消除。正向行为确认。`,
        escalation: 'hint',
        phase: 'post_step',
      };
    }

    if (signals.length === 0 && !resolutionSignal) {
      // 无信号也无恢复 → 清理过时历史（15步无触发清0）
      for (const [cause] of this.triggerHistory) {
        const key = cause;
        const prev = this.triggerHistory.get(key) ?? 0;
        // 逐步衰减，不直接清零
        if (prev > 0) this.triggerHistory.set(key, Math.max(0, prev - 1));
      }
      return { blocked: false, messages: [] };
    }

    const allSignals = (resolutionSignal ? [...signals, resolutionSignal] : signals) as RawSignal[];
    // Step 3: 按根因合并
    const merged = this.mergeByRootCause(allSignals);

    // Step 4: 计算递进等级
    const escalated = merged.map((m) => ({
      ...m,
      escalation: this.calcEscalation(m.rootCause, ctx),
      isPositive: this.checkPositiveSignal(m, ctx),
    }));

    // Step 5: 按优先级排序，取 top N
    const sorted = this.sortByPriority(escalated);
    const capped = sorted.slice(0, this.config.maxMessagesPerStep);

    // Step 6: 对未触发的根因做衰减，对已触发的做递增/重置
    // 先衰减本轮未出现的根因
    const activeCauses = new Set(capped.filter((m) => !m.isPositive).map((m) => m.rootCause));
    for (const [cause] of this.triggerHistory) {
      if (!activeCauses.has(cause as any)) {
        const prev = this.triggerHistory.get(cause as string) ?? 0;
        if (prev > 0) this.triggerHistory.set(cause as string, Math.max(0, prev - 1));
      }
    }
    // 再处理本轮活跃的根因
    for (const m of capped) {
      if (m.isPositive) {
        // 正向信号 → 已修复，计数器归零
        this.triggerHistory.delete(m.rootCause);
      } else {
        // 普通信号 → 递增
        const key = m.rootCause;
        this.triggerHistory.set(key, (this.triggerHistory.get(key) ?? 0) + 1);
      }
    }

    // Step 7: 阻断检查
    const blocked = capped.some((m) => m.priority === 'P0_block');

    // Step 8: 高频异常检测 — 当某个根因触发次数 ≥5 时自动注入趋势
    const anomalySignals: RawSignal[] = [];
    for (const [cause, count] of this.triggerHistory) {
      if (count >= 5) {
        const label = ROOT_CAUSE_LABEL[cause as RootCause] || cause;
        anomalySignals.push({
          rootCause: cause as RootCause,
          priority: 'P1_discipline' as const,
          confidence: 0.9,
          message: `高频异常：检测到「${label}」已触发 ${count} 次。请检查是否陷入重复模式——系统会自动记录，但需要你来打破循环。`,
          escalation: count >= 10 ? 'warn' as const : 'hint' as const,
          phase: 'post_step' as const,
        });
      }
    }
    const extendedSignals: RawSignal[] = anomalySignals.length > 0
      ? [...allSignals, anomalySignals[0]!] : allSignals;
    const reMerged = this.mergeByRootCause(extendedSignals);
    const reEscalated = reMerged.map((m) => ({
      ...m, escalation: this.calcEscalation(m.rootCause, ctx),
      isPositive: this.checkPositiveSignal(m, ctx),
    }));
    const reSorted = this.sortByPriority(reEscalated);
    const reCapped = reSorted.slice(0, this.config.maxMessagesPerStep);
    const finalCapped = anomalySignals.length > 0 ? reCapped : capped;
    const finalBlocked = finalCapped.some((m) => m.priority === 'P0_block');

    // Step 9: 结构化日志记录 — 记录本轮拦截事件（供 AI 自助查询）
    this.recordStep(ctx, extendedSignals, finalCapped, finalBlocked);

    return {
      blocked: finalBlocked,
      messages: finalCapped.map((m) => this.formatMessage(m)),
    };
  }

  /** 获取本轮拦截摘要（1 行，用于注入到下轮） */
  getTurnSummary(): string {
    const entries = Array.from(this.triggerHistory.entries())
      .filter(([, count]) => count > 0)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3);

    if (entries.length === 0) return '';

    return entries
      .map(([cause, count]) => {
        const label = ROOT_CAUSE_LABEL[cause as RootCause] || cause;
        return `${label}(${count}次)`;
      })
      .join(' ');
  }

  /** 重置触发历史计数 */
  resetTriggerHistory(): void {
    this.triggerHistory.clear();
  }

  /** 获取当前配置（用于动态调整） */
  getConfig(): InterceptionConfig {
    return { ...this.config };
  }

  /** 更新配置 */
  updateConfig(patch: Partial<InterceptionConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  /* ──────────────── 核心算法 ──────────────── */

  /**
   * 按根因合并信号
   * 同 rootCause 的多个信号 → 取最高优先级 + 最高递进 + 合并消息
   */
  private mergeByRootCause(signals: RawSignal[]): MergedSignal[] {
    const groups = new Map<RootCause, RawSignal[]>();

    for (const s of signals) {
      const arr = groups.get(s.rootCause) ?? [];
      arr.push(s);
      groups.set(s.rootCause, arr);
    }

    const result: MergedSignal[] = [];
    for (const [cause, group] of groups) {
      // 取最高优先级
      const priority = this.highestPriority(group.map((s) => s.priority));
      // 取最高递进等级
      const escalation = this.highestEscalation(group.map((s) => s.escalation));
      // 取置信度最高的消息
      const best = group.reduce((a, b) => (a.confidence > b.confidence ? a : b));
      // 取最多的证据
      const evidence = group
        .map((s) => s.evidence)
        .filter(Boolean)
        .join('; ');

      result.push({
        rootCause: cause,
        priority,
        message: evidence ? `${best.message} 证据: ${evidence}` : best.message,
        escalation,
        mergedCount: group.length,
        isPositive: false, // 由 calcEscalation 阶段确定
      });
    }

    return result;
  }

  /**
   * 计算递进等级
   * 基于历史触发次数 + escalation 配置
   */
  private calcEscalation(cause: RootCause, _ctx: InterceptionContext): EscalationLevel {
    const key = cause;
    const count = this.triggerHistory.get(key) ?? 0;

    // 如果优先级层不启用递进，直接返回最低等级
    const priority = this.priorityOfRootCause(cause);
    const priorityCfg = this.config.priorities[priority];
    if (!priorityCfg.enableEscalation) return 'hint';

    const { hintToNudge, nudgeToWarn, warnToBlock } = this.config.escalation;
    if (count >= warnToBlock) return 'block';
    if (count >= nudgeToWarn) return 'warn';
    if (count >= hintToNudge) return 'nudge';
    return 'hint';
  }

  /** 记录本轮结构化拦截日志 */
  private recordStep(
    ctx: InterceptionContext,
    allSignals: RawSignal[],
    capped: MergedSignal[],
    blocked: boolean,
  ): void {
    try {
      const log = (this.agent as any).eventLog;
      if (!log || typeof log.recordReport !== 'function') return;

      const report = {
        turnId: ctx.turnId,
        stepCount: ctx.step,
        detectors: allSignals.map((s) => ({
          detector: '',
          rootCause: s.rootCause,
          priority: s.priority,
          confidence: s.confidence,
          escalation: s.escalation,
          message: s.message,
          suppressed: false,
          isPositive: false,
          mergeCount: 1,
        })),
        decisions: capped.map((m) => ({
          step: ctx.step,
          rootCause: m.rootCause,
          priority: m.priority,
          escalation: m.escalation,
          triggerCount: this.triggerHistory.get(m.rootCause) ?? 0,
          blocked,
          isPositive: m.isPositive,
          mergedCount: m.mergedCount,
          message: m.message,
          timestamp: Date.now(),
          contributors: [],
        })),
        deliveries: capped.map((m) => ({
          step: ctx.step,
          rootCause: m.rootCause,
          outcome: blocked ? 'blocked_step' as const : 'delivered' as const,
          budgetUsed: true,
          position: m.priority === 'P0_block' ? 'EARLY'
            : m.priority === 'P1_discipline' ? 'AFTER_SYSTEM' : 'NEAR_END',
          tokenEstimate: Math.round(m.message.length / 4),
        })),
        wasBlocked: blocked,
        messageCount: capped.length,
      };
      log.recordReport(report);
    } catch {
      // 日志记录失败不影响主流程
    }
  }

  /**
   * 判断是否为正向信号
   * 正向信号 = AI 修复了之前的问题或改善了行为
   */
  private checkPositiveSignal(merged: MergedSignal, _ctx: InterceptionContext): boolean {
    // 1. "修复恢复"消息 → 确定正向
    if (merged.message.includes('[恢复]')) return true;
    // 2. 该根因之前触发过，本轮递进等级较低 → 弱改善
    const key = merged.rootCause;
    const prevCount = this.triggerHistory.get(key) ?? 0;
    if (prevCount > 0 && merged.escalation === 'hint' && merged.mergedCount <= 1) {
      return true;
    }
    return false;
  }

  /* ──────────────── 排序与格式化 ──────────────── */

  /** 按优先级排序（P0 > P1 > P2 > P3 > P4），同优先级按置信度降序 */
  private sortByPriority(signals: MergedSignal[]): MergedSignal[] {
    return [...signals].sort((a, b) => {
      const pa = ROOT_CAUSE_PRIORITY_ORDER.indexOf(a.rootCause);
      const pb = ROOT_CAUSE_PRIORITY_ORDER.indexOf(b.rootCause);
      if (pa !== pb) return pa - pb;
      // 同根因则已合并，但可能有不同 rootCause 同优先级
      return 0;
    });
  }

  /** 格式化消息为 AI 接收的最终格式 */
  private formatMessage(merged: MergedSignal): InterceptionMessage {
    const causeLabel = ROOT_CAUSE_LABEL[merged.rootCause] || merged.rootCause;

    // 正向信号使用不同 header
    const header = merged.isPositive
      ? `[注意/恢复] ${causeLabel}`
      : `[拦截/${PRIORITY_LABEL[merged.priority] || '?'}] ${causeLabel}`;
    const body = merged.message;

    return {
      rootCause: merged.rootCause,
      priority: merged.priority,
      header,
      body,
      escalation: merged.escalation,
      mergedCount: merged.mergedCount,
      isPositive: merged.isPositive,
    };
  }

  /* ──────────────── 工具方法 ──────────────── */

  private highestPriority(priorities: AttentionPriority[]): AttentionPriority {
    const order: AttentionPriority[] = ['P0_block', 'P1_discipline', 'P2_quality', 'P3_signal', 'P4_info'];
    for (const p of order) {
      if (priorities.includes(p)) return p;
    }
    return 'P4_info';
  }

  private highestEscalation(levels: EscalationLevel[]): EscalationLevel {
    const order: EscalationLevel[] = ['block', 'warn', 'nudge', 'hint'];
    for (const l of order) {
      if (levels.includes(l)) return l;
    }
    return 'hint';
  }

  private priorityOfRootCause(cause: RootCause): AttentionPriority {
    const idx = ROOT_CAUSE_PRIORITY_ORDER.indexOf(cause);
    if (idx <= 1) return 'P0_block';      // turn_limit, tool_permission
    if (idx <= 2) return 'P0_block';      // confabulation
    if (idx <= 4) return 'P1_discipline';  // stuck_loop, edit_discipline
    if (idx <= 6) return 'P1_discipline';  // verify_discipline, behavior_repeat
    if (idx <= 7) return 'P2_quality';     // quality_degrade
    if (idx <= 8) return 'P3_signal';      // attention_signal
    return 'P4_info';                      // context_pressure, log_info
  }
}
