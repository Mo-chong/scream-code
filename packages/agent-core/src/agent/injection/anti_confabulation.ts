/**
 * AntiConfabulationInjector — 反事实提醒注入器。
 * 迁移自 turn/injectors/anti_confabulation.ts (路径 B → 路径 A)
 *
 * Pure consumer of detection scores. Does NOT implement detection logic.
 * 不设置拦截标志（confaBlocked 归属 TurnFlow 收敛门）。
 *
 * 响应级别:
 * - confidence 2 → C 级提醒
 * - confidence 3+ → A 级 MUST/NEVER 约束
 */

import { DynamicInjector, type ResidualConfig } from './injector';
import type { InjectContext } from './router';

const INJECTION_THRESHOLD = 2;

export class AntiConfabulationInjector extends DynamicInjector {
  override readonly injectionVariant = 'anti_confabulation';

  get name(): string { return 'anti_confabulation'; }
  get description(): string { return '基于 ConfabulationDetector 得分注入反事实提醒'; }
  get priority(): number { return 70; }

  override getResidualConfig(): ResidualConfig {
    return { weight: 40, decayPerStep: 0.9, threshold: 0.6, minStepGap: 2 };
  }

  protected override getInjection(): string | undefined {
    const ctx = this._lastInjectContext;
    if (!ctx?.confabulationResult) return undefined;

    const { confidence, details } = ctx.confabulationResult;
    if (confidence < INJECTION_THRESHOLD) return undefined;

    if (confidence >= 3) {
      return (
        `断言超出可用证据范围 (${details})\n` +
        '- MUST verify all claims with Read/Grep/LSP before asserting.\n' +
        '- NEVER fabricate. Each factual claim needs a tool trace.\n' +
        '- Fix the root cause. Do NOT work around.'
      );
    }

    return (
      '检测到可能的证据缺口。\n' +
      'If you made claims above, verify them with Read/Grep/LSP before continuing.'
    );
  }
}
