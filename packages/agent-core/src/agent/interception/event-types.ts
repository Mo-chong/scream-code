/**
 * InterceptionEvent — 拦截事件结构化类型体系
 *
 * 分层架构（3 层）：
 *   DetectorResult  ← 原始检测信号
 *   InterceptionDecision  ← 合并/递进/排序后的决策
 *   DeliveryResult  ← 最终注入/阻断结果
 *
 * 相比旧 InterceptionEvent（扁平 kind/variant/action）：
 *   - 每层有类型安全的结构化字段
 *   - 支持按 detector/根因/优先级/递进等级 多维度聚合
 *   - AI 可通过 query API 自助分析趋势
 */

import type { AttentionPriority, EscalationLevel, RootCause } from './types';

/* ──────────────── 第1层：Detector 原始信号 ──────────────── */

export interface DetectorResult {
  /** 检测器名称 */
  detector: string;
  /** 检测到的根因 */
  rootCause: RootCause;
  /** 优先级建议 */
  priority: AttentionPriority;
  /** 置信度 0-1 */
  confidence: number;
  /** 递进等级 */
  escalation: EscalationLevel;
  /** AI 可见的消息 */
  message: string;
  /** 是否被禁言（被其他更高优先级的消息覆盖） */
  suppressed: boolean;
  /** 是否正向信号（如修复恢复） */
  isPositive: boolean;
  /** 本轮合并计数（同根因合并了几条） */
  mergeCount: number;
}

/* ──────────────── 第2层：InterceptionManager 决策结果 ──────────────── */

export interface InterceptionDecision {
  /** 决策发生的步号 */
  step: number;
  /** 根因（合并后） */
  rootCause: RootCause;
  /** 最终优先级 */
  priority: AttentionPriority;
  /** 最终递进等级 */
  escalation: EscalationLevel;
  /** 递进背后的历史触发次数 */
  triggerCount: number;
  /** 是否阻断当前 step */
  blocked: boolean;
  /** 是否正向信号 */
  isPositive: boolean;
  /** 合并了几条原始信号 */
  mergedCount: number;
  /** 格式化后的消息 */
  message: string;
  /** 决策时间戳 */
  timestamp: number;
  /** 参与决策的 detector 名称列表 */
  contributors: string[];
}

/* ──────────────── 第3层：注入/阻断 结果 ──────────────── */

export interface DeliveryResult {
  /** 投递的步号 */
  step: number;
  /** 根因 */
  rootCause: RootCause;
  /** 实际投递方式 */
  outcome: 'delivered' | 'blocked_step' | 'dropped_budget' | 'dropped_priority';
  /** 是否占 budget 槽 */
  budgetUsed: boolean;
  /** 注入位置（仅 delivered） */
  position?: string;
  /** 消息长度估值（token） */
  tokenEstimate?: number;
  /** 对应的决策引用 */
  decisionRef?: string;
}

/* ──────────────── 聚合查询结果 ──────────────── */

/** 特定 rootCause 的触发趋势 */
export interface RootCauseTrend {
  rootCause: RootCause;
  label: string;
  /** 最近 N 步内的触发次数 */
  recentCount: number;
  /** 历史总触发次数 */
  totalCount: number;
  /** 平均递进等级（1=hint, 2=nudge, 3=warn, 4=block） */
  avgEscalation: number;
  /** 当前是否活跃 */
  active: boolean;
  /** 最近一步的递进等级 */
  currentEscalation: EscalationLevel;
}

/** Detector 效果分析 */
export interface DetectorStats {
  detector: string;
  /** 触发总次数 */
  totalTriggers: number;
  /** 最终被投递的次数 */
  delivered: number;
  /** 被合并/禁言的次数 */
  suppressed: number;
  /** 禁言率（suppressed / total）—— 越高说明该 detector 常被优先级更高的覆盖） */
  suppressionRate: number;
  /** 导致阻断的次数 */
  blockCount: number;
  /** 最近一次触发步号 */
  lastTriggerStep: number;
}

/** 回合级拦截报告 */
export interface TurnInterceptionReport {
  turnId: number;
  stepCount: number;
  /** 本轮所有 detector 输出 */
  detectors: DetectorResult[];
  /** 本轮所有决策 */
  decisions: InterceptionDecision[];
  /** 本轮投递结果 */
  deliveries: DeliveryResult[];
  /** 本轮总体是否被阻断过 */
  wasBlocked: boolean;
  /** 投递消息数 */
  messageCount: number;
}
