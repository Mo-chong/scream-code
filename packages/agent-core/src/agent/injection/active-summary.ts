import { DynamicInjector, type ResidualConfig } from './injector';
import { InsertPosition } from './position-strategy';
import type { RecoverableRecord } from '../../utils/mask-tool-observations';

/**
 * ActiveSummaryInjector — 主动工具结果摘要注入
 *
 * Phase39 替代 ToolResultRecoveryInjector（旧版 129 行，审计确认 1694 轮 0 次触发）。
 *
 * 关键区别：
 *   旧版: 从 history 估算被遮蔽消息 → 管线顺序矛盾 → 永不触发
 *   新版: 从 context._pendingRecoveries 读取 maskToolObservations 返回的准确记录
 *
 * 注入格式：含 key 的引导式摘要，AI 看到后可调用 archive_recover(key) 取回全文。
 * 优先级：ERROR > FILE > API > SEARCH > STATUS，每轮最多 3 条摘要。
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
    // Light residual: inject every 2 steps max, but not on every step.
    return { weight: 0.6, decayPerStep: 0.85, threshold: 0.15, minStepGap: 2 };
  }

  /** Track which record keys we have already injected to avoid duplicates. */
  private _injectedKeys = new Set<string>();

  override onContextClear(): void {
    super.onContextClear();
    this._injectedKeys.clear();
  }

  override onContextCompacted(compactedCount: number): void {
    super.onContextCompacted(compactedCount);
    // On compaction the history changes — clear injected key tracking
    // to re-evaluate which records still make sense.
    this._injectedKeys.clear();
  }

  protected override getInjection(): string | undefined {
    if (this._lastInjectContext?.currentStep !== 1) return undefined;

    // Read pending recoveries left by maskToolObservations.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const pending: RecoverableRecord[] = this.agent.context?._pendingRecoveries;
    if (!pending || pending.length === 0) return undefined;

    // Filter to records not yet injected
    const fresh = pending.filter(r => !this._injectedKeys.has(r.key));
    if (fresh.length === 0) return undefined;

    // Sort by priority (lower = more important)
    fresh.sort((a, b) => a.priority - b.priority);

    // Take top 3
    const top = fresh.slice(0, 3);

    // Mark injected keys
    for (const r of top) {
      this._injectedKeys.add(r.key);
    }

    const lines: string[] = [];
    lines.push(`<system-reminder>`);
    lines.push(`[摘要] 以下内容已被遮蔽存档，需要时可调用 archive_recover(key) 取回全文：`);

    const PRIORITY_LABEL: Record<number, string> = {
      0: '交互', 1: '文件', 2: 'API', 3: '搜索', 4: '状态',
    };

    for (const r of top) {
      const label = PRIORITY_LABEL[r.priority] ?? '其他';
      lines.push(`  [${label}] ${r.summary} (key: ${r.key})`);
    }

    lines.push(`</system-reminder>`);
    return lines.join('\n');
  }
}
