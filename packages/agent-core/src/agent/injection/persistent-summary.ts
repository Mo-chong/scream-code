import { DynamicInjector, type ResidualConfig } from './injector';
import type { Agent } from '..';
import { computeILR, getSummaryLevel } from '../turn/index';
import { flags } from '../../flags';

/**
 * PersistentSummaryInjector — 基于 ILR (Information Loss Ratio) 注入持久摘要
 * 替代 turn/index.ts 中直接调用的 updatePersistentSummary() 逻辑
 *
 * 触发条件:
 *   - currentStep === 1（仅每轮第一步，与旧内联代码一致）
 *   - computeILR(history) > 0 → 有信息被 maskToolObservations 遮蔽
 *   - ILR > 0.6 → full 级结构化摘要
 *   - ILR > 0   → factual 级摘要
 *
 * 受 InjectionRouter 的 6 道门 + maxInjectionsPerStep=5 统一管控
 * 残差频率: weight=0.7, decay=0.85, threshold=0.15 → ~每3轮一次
 */
export class PersistentSummaryInjector extends DynamicInjector {
  constructor(protected override readonly agent: Agent) {
    super(agent);
  }

  get name(): string { return 'persistent-summary'; }
  get description(): string { return 'Injects structured summary based on mask information loss'; }
  override get injectionVariant(): string { return 'persistent_summary'; }

  /** 残差控制注入频率，防止每步重复注入 */
  override getResidualConfig(): ResidualConfig | undefined {
    return { weight: 0.7, decayPerStep: 0.85, threshold: 0.15, minStepGap: 3 };
  }

  protected override getInjection(): string | undefined {
    // 仅每轮第一步触发（与旧内联 updatePersistentSummary 保持一致）
    const step = this._lastInjectContext?.currentStep;
    if (step !== 1) return undefined;

    const history = this.agent.context.history;
    const keepLastN = flags.asNumber('mask.keepLastN') ?? 3;
    const ilr = computeILR(history, keepLastN);
    const level = getSummaryLevel(ilr);
    if (level === 'none') return undefined;

    // 构建本轮 tool 调用摘要（从 history 中提取被 mask 的 tool 结果）
    const facts = this.extractFacts(history);
    const dataAnchors = this.extractAnchors(history);

    const parts: string[] = [];
    parts.push(`[summary]  [level:${level}]  [ILR:${ilr.toFixed(2)}]`);
    if (facts.length > 0) {
      parts.push('');
      parts.push('## 事实');
      facts.slice(-10).forEach(f => parts.push(`- ${f}`));
    }
    if (dataAnchors.length > 0) {
      parts.push('');
      parts.push('## 锚点');
      dataAnchors.slice(-5).forEach(a => parts.push(`- ${a}`));
    }

    const text = parts.join('\n');
    return `<system-reminder>\n${text}\n</system-reminder>`;
  }

  /**
   * Check if a message content contains mask output in any format.
   */
  private isMaskedContent(msg: any): boolean {
    const text = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content) ? msg.content.map((p: any) => p.text ?? '').join('') : '';
    if (!text) return false;
    return text.startsWith('[tool output masked') ||
      text.startsWith('[已遮蔽') ||
      text.includes('可调用 archive_recover');
  }

  private extractFacts(history: readonly any[]): string[] {
    // Use same positional logic as computeILR: find current round boundary,
    // then collect tool results beyond keepLastN (those that get masked).
    const keepLastN = flags.asNumber('mask.keepLastN') ?? 3;

    let currentRoundStart = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m && m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        currentRoundStart = i;
        break;
      }
    }

    // Collect old tool result indices (before boundary)
    const oldToolIndices: number[] = [];
    for (let i = 0; i < history.length; i++) {
      const m = history[i];
      if (m?.role !== 'tool') continue;
      if (currentRoundStart >= 0 && i > currentRoundStart) continue;
      oldToolIndices.push(i);
    }

    // Only entries beyond keepLastN AND not short get masked
    const maskThreshold = Math.max(0, oldToolIndices.length - keepLastN);
    const facts: string[] = [];
    for (let i = maskThreshold; i < oldToolIndices.length; i++) {
      const msg = history[oldToolIndices[i]!]!;
      const text = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content) ? msg.content.map((p: any) => p.text ?? '').join('') : '';
      if (text.length < 100) continue; // short output, never masked
      const toolCallId = (msg as any).toolCallId ?? (msg as any).toolUseId ?? '';
      facts.push(`(工具${i+1} 结果过长，可用 archive_recover("tool:${toolCallId}") 取回全文，共 ${text.length} 字符)`);
    }
    return facts;
  }

  private extractAnchors(history: readonly any[]): string[] {
    const anchors: string[] = [];
    const msgs = history.filter((m: any) => m.role === 'assistant' || m.role === 'user');
    for (const msg of msgs.slice(-6)) {
      const text = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content) ? msg.content.map((p: any) => p.text ?? '').join('') : '';
      // 提取可能的数值型数据锚点（版本号、路径、数字）
      const matches = text.match(/[\d.]+ → [\d.]+|version[\s:]+[\d.]+|coverage[\s:]+[\d.]+%|[A-Z]:\\[^\s]+|\/[\w/.-]+/g);
      if (matches) matches.forEach((m: string) => anchors.push(m));
    }
    return anchors;
  }
}
