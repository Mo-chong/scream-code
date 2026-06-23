/**
 * Quality Detector — 注入质量衰退检测器。
 *
 * 检测当前回合已注入变体的效果。
 * 纯函数。不依赖注入器，仅消费 VariantRegistry + StepSignature。
 *
 * Detection paths:
 * - 行为已观察 → 直通（注入生效中，不升级）
 * - 注入后 N 步无对应行为 → decay；当前权重不足 → escalate
 */

import type { StepSignature } from '../signature';
import type { VariantRegistry, WeightLevel } from '../variant-registry';
import { escalateLevel } from '../variant-registry';

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
 * 1. 行为已观察 → 跳过
 * 2. 注入已过 N 步但未观察行为 → decay
 * 3. 权重为 C/D 但步行为复杂 → escalate
 *
 * @param registry - VariantRegistry 实例
 * @param sig - 当前步签名
 * @param currentStep - 当前步号
 * @returns QDetectionResult | null（无问题返回 null）
 */
export function detectQualityIssue(
  registry: VariantRegistry,
  sig: StepSignature,
  currentStep: number,
): QDetectionResult | null {
  const STALE_AGE = 3; // 注入后 3 步无行为即认为衰退

  // 每个变体的检测是独立的，选择最需要升级的那个
  let bestResult: QDetectionResult | null = null;

  for (const record of registry.getAll()) {
    // ── 行为已观察 → 跳过 ──
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
        reason: `${record.variant}: injected ${age} steps ago (triggered ${record.triggerCount}x), behavior not observed; escalating ${record.level}→${escalateLevel(record.level)}`,
      });
      continue;
    }

    // ── Signal 2: 权重不足但行为复杂 ──
    // escalate: 当前权重为 C/D + 本步有 action tools + 长输出
    //   → 注入约束力可能不够。B 级以上不触发此信号（B 级已有结构约束）
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
        reason: `${record.variant}: action-heavy step with low-weight injection (${record.level}, triggered ${record.triggerCount}x); escalating ${record.level}→${escalateLevel(record.level)}`,
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
  // hasActionTools 不算——action 是编辑/写入，不是搜到结果后正确操作
  if (registry.get('prepare_search') && sig.hasKnowledgeTools) {
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

  // ── Phase 7.5 补全: 此前遗漏的观察条件 ────────────────
  // prepare_edit: 提醒后调了知识工具（LSP.references）→ 生效
  if (registry.get('prepare_edit') && sig.hasKnowledgeTools) {
    registry.markBehaviorObserved('prepare_edit');
  }
  // prepare_write: 写大文件后调了验证工具 → 生效
  if (registry.get('prepare_write') && sig.hasVerificationTools) {
    registry.markBehaviorObserved('prepare_write');
  }
  // prepare_memory: 查记忆后用了知识工具 → 生效
  if (registry.get('prepare_memory') && sig.hasKnowledgeTools) {
    registry.markBehaviorObserved('prepare_memory');
  }
  // step_after_edit: 被提醒后调了知识工具 → 生效
  if (registry.get('step_after_edit') && sig.hasKnowledgeTools) {
    registry.markBehaviorObserved('step_after_edit');
  }
  // step_after_search: 搜到结果后有了 action（改代码）→ 生效
  if (registry.get('step_after_search') && sig.hasActionTools) {
    registry.markBehaviorObserved('step_after_search');
  }
  // step_after_verify_fail: 验证失败后重新验证 → 生效
  if (registry.get('step_after_verify_fail') && sig.hasVerificationTools) {
    registry.markBehaviorObserved('step_after_verify_fail');
  }

  // ── 意图变体行为观察 ─────────────────────────────────
  if (!registry.hasIntentVariants()) return;

  // intent_fix_bug: Edit 文件含 test 路径 → 写复现测试
  if (registry.get('intent_fix_bug') && (sig.toolCounts['Edit'] ?? 0) > 0) {
    // 标记为已观察——至少 Edit 了文件，说明在修复
    registry.markBehaviorObserved('intent_fix_bug');
  }

  // intent_refactor: 有知识工具 → 先搜引用再改
  if (registry.get('intent_refactor') && sig.hasKnowledgeTools) {
    registry.markBehaviorObserved('intent_refactor');
  }

  // intent_add_feature: 有 Read/Glob 调用 → 先探索再实现
  if (registry.get('intent_add_feature') &&
      ((sig.toolCounts['Read'] ?? 0) > 0 || (sig.toolCounts['Glob'] ?? 0) > 0)) {
    registry.markBehaviorObserved('intent_add_feature');
  }

  // intent_review: 有 Read 且无 action 工具 → 只读审查
  if (registry.get('intent_review') &&
      (sig.toolCounts['Read'] ?? 0) > 0 && !sig.hasActionTools) {
    registry.markBehaviorObserved('intent_review');
  }

  // intent_research: 有知识工具 → 搜索＞动作
  if (registry.get('intent_research') && sig.hasKnowledgeTools) {
    registry.markBehaviorObserved('intent_research');
  }

  // intent_document: 有知识工具或 Edit/Write .md → 输出文档
  if (registry.get('intent_document') && (sig.hasKnowledgeTools || (sig.toolCounts['Edit'] ?? 0) > 0 || (sig.toolCounts['Write'] ?? 0) > 0)) {
    registry.markBehaviorObserved('intent_document');
  }
}

// ── 内部辅助 ─────────────────────────────────────────────

/** C/D 级属于低权重，B 级为结构化，A/S 级为高权重。 */
function isLowLevel(level: WeightLevel): boolean {
  return level === 'C' || level === 'D';
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
