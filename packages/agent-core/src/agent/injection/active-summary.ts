import { DynamicInjector, type ResidualConfig } from './injector';
import { InsertPosition } from './position-strategy';
import type { RecoverableRecord } from '../../utils/mask-tool-observations';

/**
 * ActiveSummaryInjector — 工具结果 archive_recover 可用提醒
 *
 * 当 maskToolObservations 遮蔽了旧工具结果时，注入提示让 AI 知道
 * 哪些存档记录可取回。按优先级排序，只提醒值得展开的级别。
 *
 * 注意：工具结果的摘要已直接在 tool message content 中内联显示，
 * 因此本注入器只做摘要指引，不重复携带每条摘要内容。
 *
 * 优先级：0=交互（最重要）、1=文件、2=API、3=搜索、4=状态（最不关心）
 * 仅提醒优先级 ≤ 2（交互/文件/API）的记录。
 */
export class ActiveSummaryInjector extends DynamicInjector {
  constructor(protected override readonly agent: any) {
    super(agent);
  }

  protected readonly injectionVariant = 'active_summary';

  override getTargetPosition(): InsertPosition {
    // MID_CONTEXT 破坏前缀缓存（97%→37%，2026-07-13数据），改用末尾
    return InsertPosition.AFTER_TOOL_CALL;
  }

  override getResidualConfig(): ResidualConfig | undefined {
    // Light touch: only inject when genuinely needed, with wide spacing.
    return { weight: 0.3, decayPerStep: 0.9, threshold: 0.2, minStepGap: 5 };
  }

  /** Priority label to display to AI */
  private static readonly PRIORITY_LABEL: Record<number, string> = {
    0: '交互', 1: '文件', 2: 'API', 3: '搜索', 4: '状态',
  };

  private _injectedKeys = new Set<string>();

  override onContextClear(): void {
    super.onContextClear();
    this._injectedKeys.clear();
  }

  override onContextCompacted(compactedCount: number): void {
    super.onContextCompacted(compactedCount);
    this._injectedKeys.clear();
  }

  protected override getInjection(): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const pending: RecoverableRecord[] = this.agent.context?._pendingRecoveries;
    if (!pending || pending.length === 0) return undefined;

    // Filter to high-value records not yet injected, sorted by priority
    const important = pending
      .filter(r => r.priority <= 2 && !this._injectedKeys.has(r.key))
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 3);

    if (important.length === 0) return undefined;

    for (const r of important) {
      this._injectedKeys.add(r.key);
    }

    const lines: string[] = ['<system-reminder>'];
    lines.push(`[存档] ${pending.length} 条已存档，${important.length} 条值得关注：`);

    for (const r of important) {
      const label = ActiveSummaryInjector.PRIORITY_LABEL[r.priority] ?? '其他';
      lines.push(`  [${label}] ${r.summary} (key: ${r.key})`);
    }

    lines.push('</system-reminder>');
    return lines.join('\n');
  }
}
