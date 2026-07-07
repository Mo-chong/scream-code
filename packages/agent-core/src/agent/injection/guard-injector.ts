/**
 * GuardInjector — 将 guard-engine.ts 的 checkGuard() 包装为 DynamicInjector。
 *
 * 通过注入系统统一调度，取代 turn/index.ts 中的直接 checkGuard 调用。
 * 注册 variant: 'guard-feedback'
 */

import { DynamicInjector } from './injector';
import type { Agent } from '..';
import { checkGuard, type StepToolSummary } from '../turn/guard-engine';

export class GuardInjector extends DynamicInjector {
  protected readonly injectionVariant = 'guard-feedback';

  constructor(agent: Agent) {
    super(agent);
  }

  protected getInjection(): string | undefined {
    const history = this.agent.context?.history;
    if (!history || history.length < 3) return undefined;

    // 从 turn eventLog / 上下文推断工具使用摘要
    // 默认值安全：未检测到时不触发规则（hasKnowledgeTools=true 避免误报）
    const toolSummary: StepToolSummary = {
      hasKnowledgeTools: true,
      hasWriteTools: false,
      lastBashExitCode: null,
      hasMemoryLookup: false,
      hasCurrentCodeTools: true,
    };

    const result = checkGuard(history, toolSummary);
    if (result.rule === 0) return undefined;

    return result.feedback;
  }
}
