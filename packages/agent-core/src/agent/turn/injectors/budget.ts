/**
 * InjectBudget — 回合级注入预算管理器。
 *
 * 纯数据层 + 决策函数。权重感知，与残差系统融合。
 * 由 TurnFlow 实例化，每回合 reset。
 *
 * ## 设计要点
 *
 * - 权重分级：S(800/250) A(600/200) B(500/150) C(300/100) D(200/80)
 * - stepNorm: 步号越大 perStep 上限越紧（step 1 最宽裕）
 * - degradationFactor: variant 越多新注入边际价值越低，总预算衰减
 * - behaviorObserved 降级: 已生效变体重注入时走 C 级预算
 * - quality_escalate_ / system_trigger 穿透预算
 *
 * @module
 */

import type { WeightLevel } from '../variant-registry';

export interface InjectBudgetConfig {
  perTurnMax: Record<WeightLevel, number>;
  perStepMax: Record<WeightLevel, number>;
}

export const DEFAULT_BUDGET_CONFIG: InjectBudgetConfig = {
  perTurnMax: { S: 800, A: 600, B: 500, C: 300, D: 200 },
  perStepMax: { S: 250, A: 200, B: 150, C: 100, D: 80 },
};

export class InjectBudget {
  private turnTokens = 0;
  private stepTokens = 0;
  private variantCount = 0;
  private stepNumber = 0;
  readonly config: InjectBudgetConfig;

  constructor(config?: Partial<InjectBudgetConfig>) {
    this.config = {
      perTurnMax: { ...DEFAULT_BUDGET_CONFIG.perTurnMax, ...config?.perTurnMax },
      perStepMax: { ...DEFAULT_BUDGET_CONFIG.perStepMax, ...config?.perStepMax },
    };
  }

  /** 同步外部 variant 计数（由 TurnFlow 在每次 inject 后更新） */
  syncVariantCount(count: number): void {
    this.variantCount = count;
  }

  /** 每步开始: 重置 step 计数器 + 更新步号 */
  beginStep(stepNumber: number): void {
    this.stepTokens = 0;
    this.stepNumber = stepNumber;
  }

  /**
   * 检查是否可注入。
   *
   * 实际有效上限受两个衰减因子影响:
   *   stepNorm = 1 + (1 / (stepNumber + 1))
   *     → step 1 最大 (1.50)，step 10+ 趋近 1.0
   *   degradationFactor = max(0.4, 1 - variantCount × 0.1)
   *     → count=0 满额，count=6+ 最低 0.4
   *   实际上限 = floor(配置上限 × stepNorm × degradationFactor)
   *
   * TODO: stepNorm 和 degradationFactor 的参数需根据实际数据调优。
   */
  canInject(estimatedTokens: number, weightLevel: WeightLevel): boolean {
    const stepNorm = 1 + (1 / (this.stepNumber + 1));
    const degradationFactor = Math.max(0.4, 1 - this.variantCount * 0.1);
    const turnCap = Math.floor(this.config.perTurnMax[weightLevel] * degradationFactor);
    const stepCap = Math.floor(this.config.perStepMax[weightLevel] * stepNorm * degradationFactor);
    if (this.turnTokens + estimatedTokens > turnCap) return false;
    if (this.stepTokens + estimatedTokens > stepCap) return false;
    return true;
  }

  /** 记录已注入的 token 数 */
  record(actualTokens: number): void {
    this.turnTokens += actualTokens;
    this.stepTokens += actualTokens;
  }

  /** 每回合开始时重置全部计数器 */
  reset(): void {
    this.turnTokens = 0;
    this.stepTokens = 0;
    this.variantCount = 0;
    this.stepNumber = 0;
  }

  /** 当前回合累计 token 数 */
  get turnUsage(): number { return this.turnTokens; }

  /** 当前步累计 token 数 */
  get stepUsage(): number { return this.stepTokens; }
}
