import { DynamicInjector, type ResidualConfig } from './injector';
import type { Agent } from '..';
import { computeILR, getSummaryLevel } from '../turn/index';

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
    const ilr = computeILR(history, 3);
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
    const facts: string[] = [];
    for (const msg of history) {
      if (msg?.role !== 'tool') continue;
      const text = typeof msg.content === 'string' ? msg.content
        : Array.isArray(msg.content) ? msg.content.map((p: any) => p.text ?? '').join('') : '';
      if (this.isMaskedContent(msg)) {
        // New format: "Read 返回 xxx。完整内容已存档..."
        if (text.includes('可调用 archive_recover')) {
          // Extract tool name from text (first word before " 返回" or " 已执行")
          const toolName = text.split(/ [返回已]/)[0] ?? '工具';
          const charLen = text.length;
          facts.push(`(${toolName} 结果已存档摘要，共 ${charLen} 字符，可 archive_recover 取回全文)`);
        } else {
          // Old format: [tool output masked] or [已遮蔽·key:...]
          facts.push(`(工具结果已遮蔽，共 ${text.length} 字符)`);
        }
      }
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
