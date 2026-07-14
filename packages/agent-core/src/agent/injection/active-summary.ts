import { DynamicInjector, type ResidualConfig } from './injector';
import { InsertPosition } from './position-strategy';
import type { RecoverableRecord } from '../../utils/mask-tool-observations';
import { formatMaskedIndexBlock } from '../../utils/mask-tool-observations';

/**
 * ActiveSummaryInjector — 工具结果 <masked-tools> 索引区注入
 *
 * L1: 工具消息已改为字节级恒定字符串（buildMaskContent → MASKED_TOOL_TEXT）。
 * L2: formatMaskedIndexBlock 生成结构化的 Tier1+Tier2 索引区块。
 * L3 (本类): 在每轮尾部注入 <masked-tools> 索引区块。
 *
 * AI 消费链路：
 *   tool 消息区域看到 "此工具结果已执行…去消息尾部索引区"
 *   → 翻到尾部看到 <masked-tools> 表格（Tier1 最新 N 条，Tier2 统计）
 *   → archive_recover("tool:call_xxx") 取出完整内容
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

  /** 
   * 是否已写入 history 聚合存档（只写一次，不重复覆盖）
   * 第一次滑出 Tier1 时设为 true，避免每次 pending>3 都覆盖 contentArchive
   */
  private _archiveHistoryWritten = false;

  override getResidualConfig(): ResidualConfig | undefined {
    return { weight: 0.3, decayPerStep: 0.9, threshold: 0.2, minStepGap: 5 };
  }

  protected override getInjection(): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const pending: RecoverableRecord[] = this.agent.context?._pendingRecoveries;
    if (!pending || pending.length === 0) return undefined;

    // ── Item 6: 滑出 Tier1 的记录归档到 ContentArchive ──
    // 每条记录自身的 tool:callId 已在 context/index.ts:457 存档。
    // history 聚合条目只写入一次（第一次滑出时），不重复覆盖。
    const archive = (this.agent as any).contentArchive as
      | { archive: (key: string, content: string, opts?: { source: string }) => void }
      | undefined;
    if (archive?.archive && pending.length > 3 && !this._archiveHistoryWritten) {
      const slidOut = pending.slice(0, pending.length - 3);
      const historyContent = slidOut
        .map(r => `${r.isError ? '[ERROR]' : '[OK]'} ${r.toolName}: ${r.summary} (key: ${r.key})`)
        .join('\n');
      archive.archive('history', historyContent, { source: 'masked-index' });
      this._archiveHistoryWritten = true;
    }

    // 使用 L2 formatMaskedIndexBlock 生成结构化的 <masked-tools> 索引区块
    const indexBlock = formatMaskedIndexBlock(pending);
    if (!indexBlock) return undefined;

    return `<system-reminder>\n${indexBlock}\n</system-reminder>`;
  }
}
