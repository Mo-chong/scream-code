/**
 * QualityScore — 基于 event-log telemetry 的轻量质量评分
 *
 * 不消耗 context token，不做 LLM-as-judge。
 * 使用已有数据（偏差链触发、收敛门注入、工具报错、忠实性不一致）合成 qualityIndex。
 *
 * 使用场景：
 *   改注入结构前跑 baseline → 改后对比 → "qualityIndex 提升 12%"
 */

export interface QualityScoreInput {
  /** 总回合数 */
  totalSteps: number;
  /** 偏差链激活次数（kind=detector_fired, action=active） */
  deviationCount: number;
  /** 收敛门注入次数（kind=interception_delivery, action=delivered） */
  convergenceCount: number;
  /** 工具报错次数（isError=true） */
  toolErrorCount: number;
  /** 工具总调用次数 */
  toolTotalCount: number;
  /** 忠实性不一致次数（kind=faithfulness, consistent=false） */
  faithfulnessMismatchCount: number;
  /** 忠实性总检查次数 */
  faithfulnessTotalCount: number;
  /** 最终债务值 */
  finalDebt: number;
  /** 债务上限（carryover + 7） */
  debtCap: number;
}

export interface QualityScoreResult {
  /** 各维度评分（0-100，越高越好） */
  scores: {
    deviation: number;
    convergence: number;
    toolAccuracy: number;
    faithfulness: number;
    debtHealth: number;
  };
  /** 加权综合（0-100） */
  qualityIndex: number;
  /** 原始数据（用于调试） */
  raw: QualityScoreInput;
}

const WEIGHTS = {
  deviation: 0.25,
  convergence: 0.20,
  toolAccuracy: 0.25,
  faithfulness: 0.20,
  debtHealth: 0.10,
};

/**
 * 计算质量评分。
 * 每个维度 0-100，越高越好。
 * qualityIndex = 加权平均。
 */
export function computeQualityScore(input: QualityScoreInput): QualityScoreResult {
  const { totalSteps, toolTotalCount, faithfulnessTotalCount, finalDebt, debtCap } = input;

  // 偏差链评分: 免错率 (1 - 偏差回合占比) * 100
  const deviationRate = totalSteps > 0 ? input.deviationCount / totalSteps : 0;
  const deviationScore = Math.max(0, Math.round((1 - deviationRate) * 100));

  // 收敛门评分: 免纠率
  const convergenceRate = totalSteps > 0 ? input.convergenceCount / totalSteps : 0;
  const convergenceScore = Math.max(0, Math.round((1 - convergenceRate) * 100));

  // 工具准确率: (1 - 报错率) * 100
  const toolErrorRate = toolTotalCount > 0 ? input.toolErrorCount / toolTotalCount : 0;
  const toolAccuracyScore = Math.max(0, Math.round((1 - toolErrorRate) * 100));

  // 忠实性评分: 一致率
  const faithfulnessRate = faithfulnessTotalCount > 0
    ? (faithfulnessTotalCount - input.faithfulnessMismatchCount) / faithfulnessTotalCount
    : 1;
  const faithfulnessScore = Math.max(0, Math.round(faithfulnessRate * 100));

  // 债务健康度: 债务占用百分比
  const debtRatio = debtCap > 0 ? finalDebt / debtCap : 0;
  const debtHealthScore = Math.max(0, Math.round((1 - Math.min(debtRatio, 1)) * 100));

  // 加权合成
  const qualityIndex = Math.round(
    deviationScore * WEIGHTS.deviation +
    convergenceScore * WEIGHTS.convergence +
    toolAccuracyScore * WEIGHTS.toolAccuracy +
    faithfulnessScore * WEIGHTS.faithfulness +
    debtHealthScore * WEIGHTS.debtHealth
  );

  return {
    scores: {
      deviation: deviationScore,
      convergence: convergenceScore,
      toolAccuracy: toolAccuracyScore,
      faithfulness: faithfulnessScore,
      debtHealth: debtHealthScore,
    },
    qualityIndex,
    raw: input,
  };
}
