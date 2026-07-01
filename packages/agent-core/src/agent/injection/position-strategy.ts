/**
 * 注意力位置策略 — 根据 variant 等级决定注入位置
 *
 * 利用 Transformer 的 U 形注意力曲线：
 * - head（消息列表前部）：利用 primacy effect，适用于 S/A 级约束
 * - tail（消息列表末尾）：利用 recency effect，适用于常规提醒（默认）
 *
 * 设计原则：模块化、可复用、接口统一
 */

import type { WeightLevel } from '../turn/variant-registry';

export type InsertPosition = 'tail' | 'head' | 'near_head';

export interface PositionStrategy {
  decidePosition(variant: string, level: WeightLevel): InsertPosition;
}

/**
 * 默认位置策略 — 基于 variant 等级和名称决策
 *
 * head:      S 级（安全/毒性） — 最高约束，需要 primacy effect
 * near_head: A 级（核心行为），feedback_/post_ 类（步级反馈） — 避免 U 形死区
 * tail:      B/C/D 级（质量、信息、观察） — 利用 recency effect
 */
export class AttentionPositionStrategy implements PositionStrategy {
  decidePosition(variant: string, level: WeightLevel): InsertPosition {
    if (level === 'S') return 'head';

    if (level === 'A') return 'near_head';

    // feedback_/post_ 类变体是步级实时反馈，需要高可见性
    if (
      variant.startsWith('feedback_') ||
      variant.startsWith('post_') ||
      variant.startsWith('step_after_')
    ) {
      return 'near_head';
    }

    return 'tail';
  }
}
