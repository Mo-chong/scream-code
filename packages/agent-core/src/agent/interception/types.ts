/**
 * InterceptionManager — Types
 *
 * Phase38a 基础设施。
 * 以 AI 消费体验为中心：根因合并、5 层优先级、递进策略、统一输出格式。
 *
 * 与现有系统的分界原则:
 * - InterceptionManager 决定"要不要做"（block / inject / log）
 * - InjectionRouter 决定"怎么做"（注入内容组装 + 频率控制）
 * - 不产生循环依赖：本文件引用 agent/ 下的类型，而非被引用
 */

import type { ToolCall } from '@scream-code/ltod';
import type { TurnEventLog } from '../turn/event-log';
import type { GuardResult } from '../turn/guard-engine';

/* ──────────────── 优先级与递进 ──────────────── */

/** 注意力优先级 — 决定消息是否 / 如何送达 AI。对齐全系统 WeightLevel 3 级 */
export type AttentionPriority = 'critical' | 'normal' | 'debug';

/** 递进等级 — 同一根因多次触发时升级 */
export type EscalationLevel = 'hint' | 'nudge' | 'warn' | 'block';

/** 根因分类 — 用于合并同根因消息 */
export type RootCause =
  | 'stuck_loop'          // 卡在失败循环中
  | 'confabulation'       // 虚构内容
  | 'edit_discipline'     // 编辑未查 LSP
  | 'verify_discipline'   // 跳过验证
  | 'behavior_repeat'     // 重复违规
  | 'quality_degrade'     // 质量下降
  | 'attention_signal'    // [DONE] / [NEED] / [CONFIRM]
  | 'tool_permission'     // 工具权限
  | 'turn_limit'          // 回合上限
  | 'context_pressure'    // 上下文压力
  | 'log_info';           // 纯日志

/** 拦截阶段 */
export type InterceptionPhase = 'pre_step' | 'post_step' | 'pre_tool' | 'post_tool';

/* ──────────────── 信号与消息 ──────────────── */

/** 检测信号 — 每个 detector 产生的原始信号 */
export interface RawSignal {
  rootCause: RootCause;
  priority: AttentionPriority;
  confidence: number;       // 0-1
  message: string;          // 给 AI 的消息正文
  escalation: EscalationLevel;
  phase: InterceptionPhase;
  evidence?: string;        // 工具证据（如 LSP 引用结果）
}

/** 合并后的中间信号（去重 + 聚合后，格式化前） */
export interface MergedSignal {
  rootCause: RootCause;
  priority: AttentionPriority;
  message: string;
  escalation: EscalationLevel;
  mergedCount: number;       // 本条合并了 N 个原始信号
  isPositive: boolean;       // 正向信号（奖励 / 确认）
}

/** 最终消息 — AI 实际收到的拦截通知 */
export interface InterceptionMessage {
  rootCause: RootCause;
  priority: AttentionPriority;
  header: string;           // "[拦截] <根因> P1"
  body: string;             // 根因 + 建议（统一格式）
  escalation: EscalationLevel;
  mergedCount: number;
  isPositive: boolean;
}

/** 拦截检查结果 */
export interface InterceptionResult {
  /** 是否阻断当前 step */
  blocked: boolean;
  /** AI 最终收到的消息（最多 3 条） */
  messages: InterceptionMessage[];
}

/* ──────────────── 拦截上下文 ──────────────── */

/** 拦截上下文 — 所有 detector 共享的状态 */
export interface InterceptionContext {
  step: number;
  turnId: number;
  lastToolCalls: readonly ToolCall[];
  lastAIResponse?: string;
  guardResult?: GuardResult;
  confabulationConfidence: number;   // 0 | 1 | 2 | 3
  qualitySignals: readonly string[]; // 质量偏差信号名列表
  behaviorViolations: Record<string, number>;
  eventLog: TurnEventLog;
  /** 历史触发计数器（key = rootCause，value = 累计次数） */
  triggerHistory: Record<string, number>;
  /** AI 注意力信号 [DONE]/[NEED]/[CONFIRM] */
  attentionSignals?: { done?: boolean; need?: boolean; confirm?: boolean };
  /** 上回合偏差链状态（由 handleAfterStep 设置，下回合 beforeStep 消费） */
  lastTurnHadDeviation?: boolean;
  /** 上回合 Guard Rule 1 触发状态 */
  lastTurnHadGuardRule1?: boolean;
  /** 用户本轮输入文本（用于检测"上次/以前"关键词） */
  userInputText?: string;
  /** 本步是否调用了 MemoryLookup */
  calledMemoryLookup?: boolean;
}

/* ──────────────── Detector 接口 ──────────────── */

/** Detector 纯函数签名 — 只做检测，不做输出 */
export type DetectorFn = (ctx: InterceptionContext) => RawSignal | null;

/* ──────────────── 配置类型 ──────────────── */

/** 单优先级层的配置 */
export interface PriorityLayerConfig {
  enabled: boolean;
  action: 'block_step' | 'inject_feedback' | 'log_only';
  /** 是否启用递进（normal/debug 通常不递进） */
  enableEscalation: boolean;
}

/** 递进阈值配置 */
export interface EscalationConfig {
  hintToNudge: number;   // 第 2 次触发 → nudge
  nudgeToWarn: number;   // 第 4 次触发 → warn
  warnToBlock: number;   // 第 6 次触发 → block
  autoResetAfterSteps: number; // 15 步后重置计数
}

/** 拦截系统全局配置 */
export interface InterceptionConfig {
  enabled: boolean;
  maxMessagesPerStep: number;  // 单步最多 3 条
  priorities: Record<AttentionPriority, PriorityLayerConfig>;
  escalation: EscalationConfig;
}
