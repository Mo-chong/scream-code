/**
 * GuardInjector — 将 guard-engine.ts 的 checkGuard() 包装为 DynamicInjector。
 *
 * 通过注入系统统一调度，取代 turn/index.ts 中的直接 checkGuard 调用。
 * 注册 variant: 'guard-feedback'
 */

import { DynamicInjector, type ResidualConfig } from './injector';
import { InsertPosition } from './position-strategy';
import type { Agent } from '..';
import { checkGuard, type StepToolSummary } from '../turn/guard-engine';
import type { ContextMessage } from '../context';

export class GuardInjector extends DynamicInjector {
  protected readonly injectionVariant = 'guard-feedback';

  constructor(agent: Agent) {
    super(agent);
  }

  /** 守卫反馈高优先级：注入到系统提示之后 */
  override getTargetPosition(): InsertPosition {
    return InsertPosition.AFTER_SYSTEM;
  }

  /**
   * 守卫反馈使用残差注意力衰减：
   * - weight: 0.9（初始权重高，避免过多注入）
   * - decayPerStep: 0.90（每步衰减 10%）
   * - threshold: 0.3（注意力低于 0.3 时注入）
   * - minStepGap: 3（最短 3 步间隔）
   */
  override getResidualConfig(): ResidualConfig {
    return { weight: 0.9, decayPerStep: 0.90, threshold: 0.3, minStepGap: 3 };
  }

  /**
   * 从上下文历史中提取最近一步的工具使用摘要。
   * 扫描历史中最后一条 assistant 消息之后的 tool_call / tool_result 消息，
   * 区分知识工具（Read/Grep/LSP）、写入工具（Edit/Write/Delete）、Bash 和 MemoryLookup。
   */
  private buildToolSummaryFromHistory(history: readonly ContextMessage[]): StepToolSummary {
    let hasKnowledgeTools = false;
    let hasWriteTools = false;
    let lastBashExitCode: number | null = null;
    let hasMemoryLookup = false;
    let hasCurrentCodeTools = false;

    // 从后往前扫描最近 10 条消息
    // role 取值: 'system' | 'user' | 'assistant' | 'tool'
    // tool 调用 = assistant 消息的 toolCalls[] 字段
    // tool 结果 = role === 'tool' 的消息
    const recent = history.slice(-10);
    for (const msg of recent) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          const toolName = tc.name ?? '';
          if (/^(Read|Grep|Glob|LSP|codegraph)/i.test(toolName)) {
            hasKnowledgeTools = true;
            hasCurrentCodeTools = true;
          } else if (/^(Edit|Write|Delete)/i.test(toolName)) {
            hasWriteTools = true;
          } else if (/MemoryLookup|Memory/i.test(toolName)) {
            hasMemoryLookup = true;
          }
        }
      }
      if (msg.role === 'tool') {
        // Tool 结果消息：从第一个 text part 提取 Bash exit code
        const firstText = msg.content?.[0]?.type === 'text' ? msg.content[0].text : '';
        const exitMatch = firstText.match(/Exit.?code:\s*(-?\d+)/i) ?? firstText.match(/exit[=\s]+(\d+)/i);
        if (exitMatch) {
          lastBashExitCode = parseInt(exitMatch[1]!, 10);
        }
      }
    }

    return {
      hasKnowledgeTools,
      hasWriteTools,
      lastBashExitCode,
      hasMemoryLookup,
      hasCurrentCodeTools,
    };
  }

  protected getInjection(): string | undefined {
    const history = this.agent.context?.history;
    if (!history || history.length < 3) return undefined;

    // 从 history 最后几条消息推断工具使用摘要
    // 扫描最近 assistant 消息后的工具调用，避免硬编码假数据
    const toolSummary = this.buildToolSummaryFromHistory(history);

    const result = checkGuard(history, toolSummary);
    if (result.rule === 0) return undefined;

    return result.feedback;
  }
}
