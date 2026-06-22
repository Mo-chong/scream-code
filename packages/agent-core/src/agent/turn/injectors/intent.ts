/**
 * Intent Injector — 回合意图注入。
 *
 * 消费 IntentDetection。不实现检测逻辑。
 * 纯消费者。按指令权重金字塔提供不同级别的注入文本。
 *
 * Caller (turn/index.ts runOneTurn) 提供 append 函数，
 * 因此本模块不依赖 TurnFlow。
 *
 * ## 指令权重映射
 *
 * - B 级（结构化）：步骤编号 + 条件格式，适合一般性建议
 * - A 级（祈使）：MUST/NEVER/REQUIRED，适合高置信度意图
 *
 * 后续质量升级链（C→B→A→S）由 `detectQualityIssue` + `escalateQuality` 自动处理，
 * 本注入器不重复实现升级逻辑。
 */

import type { IntentDetection } from '../detectors/intent';

/**
 * 注入意图指导。
 *
 * @param detection       - 检测结果
 * @param appendReminder  - context.appendSystemReminder 回调
 */
export function injectIntentGuidance(
  detection: IntentDetection,
  appendReminder: (text: string, meta: { kind: 'injection'; variant: string }) => void,
): void {
  if (!detection.guidanceText) return;

  appendReminder(detection.guidanceText, {
    kind: 'injection',
    variant: detection.variant,
  });
}
