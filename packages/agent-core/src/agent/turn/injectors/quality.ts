/**
 * Injector Q — 注入质量升级器。
 *
 * 消费 QDetectionResult，按权重金字塔升级注入文本。
 * 不实现检测逻辑。纯消费者。
 *
 * Caller (turn/index.ts afterStep) 提供 dedup set 和 append 函数，
 * 因此本模块不依赖 TurnFlow。
 */

import type { QDetectionResult } from '../detectors/quality';
import type { WeightLevel } from '../variant-registry';

/**
 * 按权重金字塔升级注入。
 *
 * 升级规则：
 * | 当前  | 升级  | 策略                                 |
 * |-------|-------|--------------------------------------|
 * | C/D   | B     | 结构化：步骤编号 + 条件格式           |
 * | B     | A     | 祈使：MUST/NEVER                      |
 * | A     | S     | 结构锚定：<system-reminder> 包裹      |
 * | S     | S     | 已最高，提示 compaction 后重注入       |
 *
 * @param result       - 检测结果
 * @param dedupSet     - 本步已注入 variant 集合
 * @param appendReminder - context.appendSystemReminder 回调
 */
export function escalateQuality(
  result: QDetectionResult,
  dedupSet: Set<string>,
  appendReminder: (
    text: string,
    meta: { kind: 'injection'; variant: string },
  ) => void,
): void {
  // 同变体每步只升级一次
  const variantKey = `quality_escalate_${result.targetVariant}`;
  if (dedupSet.has(variantKey)) return;
  dedupSet.add(variantKey);

  const text = buildEscalatedText(result);
  appendReminder(text, {
    kind: 'injection',
    variant: variantKey,
  });
}

// ── 文本构建 ─────────────────────────────────────────────

function buildEscalatedText(result: QDetectionResult): string {
  const { currentLevel, suggestedLevel, targetVariant, reason } = result;

  // C→B / D→B: 结构化升级
  // 将原本的否定式/角色式指令转为结构化 Step 格式
  if (isAtOrBelowC(currentLevel) && suggestedLevel === 'B') {
    return (
      '<system-reminder kind="injection" variant="' +
      targetVariant +
      '">\n' +
      'Step 1: Identify the variant that needs attention: ' +
      targetVariant +
      '\n' +
      'Step 2: Apply the following constraint:\n' +
      '- ' +
      reason +
      '\n' +
      'Step 3: Verify the constraint is effective.\n' +
      '</system-reminder>'
    );
  }

  // B→A: 祈使升级
  if (currentLevel === 'B' && suggestedLevel === 'A') {
    return (
      '<system-reminder kind="injection" variant="' +
      targetVariant +
      '">\n' +
      'MUST follow the constraint from variant "' +
      targetVariant +
      '".\n' +
      'NEVER ignore it.\n' +
      'Reason: ' +
      reason +
      '\n' +
      '</system-reminder>'
    );
  }

  // A→S: 结构锚定升级（最高级，使用最强约束语言）
  if (currentLevel === 'A' && suggestedLevel === 'S') {
    return (
      '<system-reminder kind="injection" variant="' +
      targetVariant +
      '">\n' +
      'ALWAYS apply the constraint from "' +
      targetVariant +
      '".\n' +
      'This is a structural requirement, not a suggestion.\n' +
      'Failure to apply it is a violation.\n' +
      'Reason: ' +
      reason +
      '\n' +
      '</system-reminder>'
    );
  }

  // 默认 fallback: A 级
  return (
    '<system-reminder kind="injection" variant="' +
    targetVariant +
    '">\n' +
    'MUST follow the constraint from variant "' +
    targetVariant +
    '".\n' +
    'NEVER ignore it.\n' +
    'Reason: ' +
    reason +
    '\n' +
    '</system-reminder>'
  );
}

function isAtOrBelowC(level: WeightLevel): boolean {
  return level === 'C' || level === 'D';
}
