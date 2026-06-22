/**
 * Injector C5 — anti_confabulation.
 *
 * Consumes DetectionResult from ConfabulationDetector.
 * Does NOT implement detection logic. Pure consumer of detection scores.
 *
 * Caller (turn/index.ts afterStep) provides the dedup set and append function
 * so this module has no dependency on TurnFlow.
 */

import type { DetectionResult } from '../detectors/confabulation';

/**
 * Threshold for injection. 2 = medium, 3 = high.
 * Low (1) is logged but does not inject.
 */
const INJECTION_THRESHOLD = 2;

/**
 * Inject anti-confabulation reminder based on detection result.
 *
 * @param result        - Detection result from ConfabulationDetector
 * @param dedupSet      - Per-step injected variants set (for duplicate protection)
 * @param appendReminder - Context appendSystemReminder function
 */
export function injectAntiConfabulation(
  result: DetectionResult,
  dedupSet: Set<string>,
  appendReminder: (text: string, meta: { kind: 'injection'; variant: string }) => void,
): void {
  if (result.confidence < INJECTION_THRESHOLD) return;
  if (dedupSet.has('anti_confabulation')) return;

  dedupSet.add('anti_confabulation');

  const text = buildText(result);
  appendReminder(text, {
    kind: 'injection',
    variant: 'anti_confabulation',
  });
}

function buildText(result: DetectionResult): string {
  if (result.confidence === 3) {
    return (
      '断言超出可用证据范围。\n' +
      '- MUST verify all claims with Read/Grep/LSP before asserting.\n' +
      '- NEVER fabricate. Each factual claim needs a tool trace.\n' +
      '- Fix the root cause. Do NOT work around.'
    );
  }
  // confidence === 2: gentle hint, no MUST/NEVER
  return (
    '检测到可能的证据缺口。\n' +
    'If you made claims above, verify them with Read/Grep/LSP before continuing.'
  );
}
