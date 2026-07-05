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
    if (level === 'S') return 'head';
    if (level === 'A') return 'head';

    // feedback_/post_ 类变体是步级实时反馈，末尾追加
    if (
      variant.startsWith('feedback_') ||
      variant.startsWith('post_') ||
      variant.startsWith('step_after_')
    ) {
      return 'tail';
    }

    // 校验未知 variant：不在已知前缀集合中时告警
    this.warnIfUnknown(variant);

    return 'tail';
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
