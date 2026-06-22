/**
 * Quality Detector — 注入质量衰退检测器。
 *
 * 残差检测当前回合已注入变体的效果。
 * 纯函数。不依赖注入器，仅消费 VariantRegistry + StepSignature。
 *
 * ## ResNet logic
 *
 * - **Identity path**: behaviorObserved === true → 直通（注入生效中，不升级）
 * - **Residual**: 注入后 N 步无对应行为 → decay；当前权重不足 → escalate
 * - **BatchNorm**: stepNorm 用于场景归一化（v1: 预留）
 */

import type { StepSignature, ContextSnapshot } from '../signature';
import type { VariantRegistry, WeightLevel } from '../variant-registry';

// ── 类型 ────────────────────────────────────────────────

export type QConfidence = 0 | 1 | 2;

export type QSignal = 'decay' | 'escalate' | 'none';

export interface QDetectionResult {
  /** 置信度：0=无问题, 1=建议升级, 2=必须升级 */
  confidence: QConfidence;
  /** 检测信号 */
  signal: QSignal;
  /** 需要升级的具体 variant */
  targetVariant: string;
  /** 当前权重 */
  currentLevel: WeightLevel;
  /** 建议升级到的权重 */
  suggestedLevel: WeightLevel;
  /** 原因描述 */
  reason: string;
}

// ── 检测主函数 ─────────────────────────────────────────

/**
 * 检测注入质量衰退。
 *
 * 扫描注册表中所有变体：
 * 1. Identity path: behavior observed → 跳过
 * 2. 注入已过 N 步但未观察行为 → decay
 * 3. 权重 ≤ B 但步行为复杂 → escalate
 *
 * @param registry - VariantRegistry 实例
 * @param sig - 当前步签名
 * @param snap - 当前步上下文快照
 * @param currentStep - 当前步号
 * @returns QDetectionResult | null（无问题返回 null）
 */
export function detectQualityIssue(
  registry: VariantRegistry,
  sig: StepSignature,
  snap: ContextSnapshot,
  currentStep: number,
): QDetectionResult | null {
  const STALE_AGE = 3; // 注入后 3 步无行为即认为衰退

  // 每个变体的检测是独立的，选择最需要升级的那个
  let bestResult: QDetectionResult | null = null;

  for (const record of registry.getAll()) {
    // ── Identity path: 行为已观察 → 直通 ──
    if (record.behaviorObserved === true) continue;

    const age = currentStep - record.stepInjected;

    // ── Signal 1: 注入已过期但行为未观察 ──
    // decay: 注入 N 步后，对应行为从未被观察到 → 可能注入被忽视
    if (age >= STALE_AGE && record.behaviorObserved === null) {
      bestResult = betterResult(bestResult, {
        confidence: 1,
        signal: 'decay',
        targetVariant: record.variant,
        currentLevel: record.level,
        suggestedLevel: escalateLevel(record.level),
        reason: `${record.variant}: injected ${age} steps ago, behavior not observed; escalating ${record.level}→${escalateLevel(record.level)}`,
      });
      continue;
    }

    // ── Signal 2: 权重不足但行为复杂 ──
    // escalate: 当前权重较低（≤B）+ 本步有 action tools + 长输出
    //   → 注入约束力可能不够
    if (
      isLowLevel(record.level) &&
      sig.hasActionTools &&
      sig.outputLength > 200
    ) {
      bestResult = betterResult(bestResult, {
        confidence: 2,
        signal: 'escalate',
        targetVariant: record.variant,
        currentLevel: record.level,
        suggestedLevel: escalateLevel(record.level),
        reason: `${record.variant}: action-heavy step with low-weight injection (${record.level}); escalating ${record.level}→${escalateLevel(record.level)}`,
      });
      continue;
    }

    // ── Signal 3 (预留): compaction 清除了注入 ──
    // 详见未来 Phase
  }

  return bestResult;
}

// ── 行为观察 ─────────────────────────────────────────────

/**
 * 根据工具调用签名推断注入变体是否生效（行为观察）。
 *
 * 不需要 NL 理解——通过工具调用模式推断：
 * - post_edit 生效 → Edit 后调用了知识工具
 * - prepare_bash_file 生效 → 注入后使用了 Read
 * - prepare_search 生效 → Grep/LSP 后调用了知识工具
 * - post_memory 生效 → MemoryLookup 后调用了知识工具
 *
 * @param registry - VariantRegistry 实例
 * @param sig - 当前步签名
 */
export function observeBehavior(
  registry: VariantRegistry,
  sig: StepSignature,
): void {
  // post_edit: 如果 Edit 后调用了知识工具 → 注入生效
  if (registry.get('post_edit') && sig.hasKnowledgeTools) {
    registry.markBehaviorObserved('post_edit');
  }

  // prepare_bash_file: 如果注入后使用 Read（而非 Bash）→ 注入生效
  if (registry.get('prepare_bash_file') && (sig.toolCounts['Read'] ?? 0) > 0) {
    registry.markBehaviorObserved('prepare_bash_file');
  }

  // prepare_search: Grep/LSP 后使用了知识工具 → 注入生效
  if (
    registry.get('prepare_search') &&
    (sig.hasKnowledgeTools || sig.hasActionTools)
  ) {
    registry.markBehaviorObserved('prepare_search');
  }

  // post_memory: MemoryLookup 后调用了知识工具 → 注入生效
  if (registry.get('post_memory') && sig.hasKnowledgeTools) {
    registry.markBehaviorObserved('post_memory');
  }

  // prepare_verify: 后续有 verify 工具调用 → 注入生效
  if (registry.get('prepare_verify') && sig.hasVerificationTools) {
    registry.markBehaviorObserved('prepare_verify');
  }
}

// ── 内部辅助 ─────────────────────────────────────────────

function isLowLevel(level: WeightLevel): boolean {
  return level === 'C' || level === 'D' || level === 'B';
}

/** 从两个候选结果中选出更严重的一个。 */
function betterResult(
  a: QDetectionResult | null,
  b: QDetectionResult,
): QDetectionResult {
  if (a === null) return b;
  if (b.confidence > a.confidence) return b;
  if (b.confidence < a.confidence) return a;
  // 同 confidence 时优先 escalate > decay
  if (b.signal === 'escalate' && a.signal !== 'escalate') return b;
  return a;
}

// ── 权重升级（与 variant-registry.ts 共享同一逻辑）──────────────

function escalateLevel(level: WeightLevel): WeightLevel {
  switch (level) {
    case 'C': return 'B';
    case 'D': return 'B';
    case 'B': return 'A';
    case 'A': return 'S';
    case 'S': return 'S';
  }
}
