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

/**
 * 插入位置枚举。
 * AFTER_SYSTEM — 系统提示之后（最高优先级）
 * MID_CONTEXT — 上下文中间（中优先级）
 * AFTER_TOOL_CALL — 工具调用之后（低优先级，默认）
 * CONTEXT_BOTTOM — 上下文底部（NEAR_ZERO 注意力，融合预留）
 * ATTENTION_PEAK — 注意力峰值动态位置（DYNAMIC，融合预留）
 */
export enum InsertPosition {
  AFTER_SYSTEM = 'AFTER_SYSTEM',
  MID_CONTEXT = 'MID_CONTEXT',
  AFTER_TOOL_CALL = 'AFTER_TOOL_CALL',
  CONTEXT_BOTTOM = 'CONTEXT_BOTTOM',
  ATTENTION_PEAK = 'ATTENTION_PEAK',
}

/**
 * 注意力权重等级 → InsertPosition 映射
 */
export const POSITION_ATTENTION: Record<string, InsertPosition> = {
  S: InsertPosition.AFTER_SYSTEM,
  A: InsertPosition.AFTER_SYSTEM,
  B: InsertPosition.MID_CONTEXT,
  C: InsertPosition.AFTER_TOOL_CALL,
  D: InsertPosition.AFTER_TOOL_CALL,
};

/**
 * 根据 InsertPosition 返回排序优先级提升值。
 */
export function getPositionPriorityBoost(pos: InsertPosition): number {
  switch (pos) {
    case InsertPosition.AFTER_SYSTEM: return 1000;
    case InsertPosition.MID_CONTEXT: return 500;
    case InsertPosition.AFTER_TOOL_CALL: return 0;
    case InsertPosition.CONTEXT_BOTTOM: return -500;
    case InsertPosition.ATTENTION_PEAK: return 9999;
  }
}

export interface PositionStrategy {
  decidePosition(variant: string, level: WeightLevel): InsertPosition;
}

/**
 * 默认位置策略 — 基于 variant 等级和名称决策
 *
 * head:      S/A 级（安全/核心行为） — 缓存友好，仅影响 reminder 群之后
 * tail:      feedback_/post_/step_after_ 类（步级反馈），B/C/D 级 — 零缓存破坏
 *
 * 未知 variant 告警：当 variant 不在任何已知模式中时，console.warn 提示开发人员。
 * 这防止新增 variant 后忘记更新映射表导致静默 fallback。
 */
export class AttentionPositionStrategy implements PositionStrategy {
  /** 已知 variant 前缀模式集合，用于校验未知 variant */
  private static KNOWN_PREFIXES = [
    'system_', 'intent_', 'prepare_', 'post_', 'step_after_',
    'guard_feedback_', 'feedback_', 'scene_memory_', 'step_code_',
    'code_quality_', 'system_ref_', 'truncation_recover_',
  ];

  private warnedVariants = new Set<string>();

  decidePosition(variant: string, level: WeightLevel): InsertPosition {
    if (level === 'S') return InsertPosition.AFTER_SYSTEM;
    if (level === 'A') return InsertPosition.AFTER_SYSTEM;

    // feedback_/post_ 类变体是步级实时反馈，末尾追加
    if (
      variant.startsWith('feedback_') ||
      variant.startsWith('post_') ||
      variant.startsWith('step_after_')
    ) {
      return InsertPosition.AFTER_TOOL_CALL;
    }

    // 校验未知 variant：不在已知前缀集合中时告警
    this.warnIfUnknown(variant);

    return InsertPosition.AFTER_TOOL_CALL;
  }

  /**
   * 校验 variant 是否已知。若未知且未告警过，console.warn 提示。
   * 防止新增 variant 后忘记更新映射表而静默 fallback 到 tail。
   */
  private warnIfUnknown(variant: string): void {
    if (this.warnedVariants.has(variant)) return;
    const known = AttentionPositionStrategy.KNOWN_PREFIXES.some(
      p => variant.startsWith(p),
    );
    if (!known) {
      console.warn(
        `[AttentionPositionStrategy] unknown variant "${variant}" — ` +
        `falling back to 'tail'. Add to KNOWN_PREFIXES if intentional.`,
      );
      this.warnedVariants.add(variant);
    }
  }
}
