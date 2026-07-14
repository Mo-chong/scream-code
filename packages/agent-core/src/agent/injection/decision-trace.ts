import { DynamicInjector, type ResidualConfig } from './injector';
import { InsertPosition } from './position-strategy';

/**
 * DecisionTraceInjector — 决策链记录注入器
 *
 * 功能:
 *   当 ILR>0.6（信息丢失严重）时，注入决策链：AI 之前做了哪些尝试、结果如何、
 *   当前目标、下一步计划。防止 AI 在大量被遮蔽的 tool 结果中迷失方向。
 *
 * 触发条件:
 *   - step === 1
 *   - ILR > 0.6（被遮蔽的 tool 结果占多数）
 *
 * 残差频率: weight=0.5, decay=0.85, threshold=0.15, minStepGap=5 → ~每5轮一次
 */
export class DecisionTraceInjector extends DynamicInjector {
  constructor(protected override readonly agent: any) {
    super(agent);
  }

  protected readonly injectionVariant = 'decision_trace';

  /** 缓存修复 2026-07-13：头部注入破坏前缀缓存改用末尾 */
  override getTargetPosition(): InsertPosition {
    return InsertPosition.AFTER_TOOL_CALL;
  }

  override getResidualConfig(): ResidualConfig | undefined {
    return { weight: 0.5, decayPerStep: 0.85, threshold: 0.15, minStepGap: 5 };
  }

  protected override getInjection(): string | undefined {
    if (this._lastInjectContext?.currentStep !== 1) return undefined;

    const history: any[] = this.agent.context?.history ?? [];
    if (history.length === 0) return undefined;

    // 统计上轮的 tool 调用序列
    const toolMsgs = history.filter(m => m.role === 'tool');
    const maskedCount = Math.max(0, toolMsgs.length - 3);
    const ilr = toolMsgs.length > 0 ? maskedCount / toolMsgs.length : 0;
    if (ilr <= 0.6) return undefined;

    // 提取最近的 assistant 消息以了解 AI 的意图和目标
    const recentAssistant = history.filter(m => m.role === 'assistant').slice(-3);
    const recentTools = toolMsgs.slice(-3);

    const lines: string[] = [];
    lines.push(`<system-reminder>`);
    lines.push(`[decision-trace] ILR=${ilr.toFixed(2)} — 上轮决策链快照`);

    // 目标追踪
    const intents: string[] = [];
    for (const a of recentAssistant) {
      const text = a.content?.[0]?.text ?? '';
      const matches = text.match(/(?:现在|接下来|目标|需要|要).{1,50}/g);
      if (matches) intents.push(...matches);
    }
    if (intents.length > 0) {
      lines.push(`上轮目标/意图:`);
      for (const intent of intents.slice(-3)) {
        lines.push(`- ${intent.slice(0, 120)}`);
      }
    }

    // 上轮工具执行摘要
    if (recentTools.length > 0) {
      lines.push(`上轮最后 ${recentTools.length} 个工具结果:`);
      for (const t of recentTools) {
        const text = (t.content?.[0]?.text ?? '').slice(0, 100);
        lines.push(`- ${text}`);
      }
    }

    // 循环检测：连续多个相同工具无进展
    const toolNames = toolMsgs.slice(-6).map(t => {
      const text = t.content?.[0]?.text ?? '';
      if (text.startsWith('The file')) return 'edit';
      if (text.includes('not found') || text.includes('exit code')) return 'error';
      return 'other';
    });
    const repeatCount = toolNames.filter(n => n === toolNames[toolNames.length - 1]).length;
    if (repeatCount >= 4) {
      lines.push(`⚠️ 检测到可能循环：连续 ${repeatCount} 次相同操作类型，考虑切换策略`);
    }

    lines.push(`</system-reminder>`);
    return lines.join('\n');
  }
}
