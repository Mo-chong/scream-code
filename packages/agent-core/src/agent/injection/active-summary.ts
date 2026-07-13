import { DynamicInjector, type ResidualConfig } from './injector';
import { InsertPosition } from './position-strategy';
import type { RecoverableRecord } from '../../utils/mask-tool-observations';

/**
 * ActiveSummaryInjector — 工具结果 archive_recover 可用提醒
 *
 * 当 maskToolObservations 遮蔽了旧工具结果时，注入一句简短的提醒，
 * 告诉 AI 可以通过 archive_recover(key) 取回完整内容。
 *
 * 注意：工具结果的摘要已直接在 tool message content 中内联显示，
 * 因此本注入器只做纯提醒，不再重复携带每条摘要数据。
 */
export class ActiveSummaryInjector extends DynamicInjector {
  constructor(protected override readonly agent: any) {
    super(agent);
  }

  protected readonly injectionVariant = 'active_summary';

  override getTargetPosition(): InsertPosition {
    return InsertPosition.MID_CONTEXT;
  }

  override getResidualConfig(): ResidualConfig | undefined {
    // Light touch: only inject when genuinely needed, with wide spacing.
    return { weight: 0.3, decayPerStep: 0.9, threshold: 0.2, minStepGap: 5 };
  }

  protected override getInjection(): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const pending: RecoverableRecord[] = this.agent.context?._pendingRecoveries;
    if (!pending || pending.length === 0) return undefined;

    // Summary is already inline in masked tool messages; just remind
    // that archive_recover is available for full content retrieval.
    return [
      '<system-reminder>',
      '[提示] 部分旧工具结果的内容摘要已内联显示。',
      '如需完整原文，可调用 archive_recover(key) 取回。',
      '</system-reminder>',
    ].join('\n');
  }
}
