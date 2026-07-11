import { DynamicInjector } from './injector';
import type { Agent } from '..';

/**
 * SessionSummaryInjector — 将 session memory 摘要注入到消息队列
 * 替代 turn/index.ts 中直接调用的 this.inject(sessionSummary, ...) 逻辑
 *
 * 触发条件:
 *   - currentStep === 1（每轮第一次 step）
 *   - fullCompaction.shouldInjectSessionSummary()（compaction 成功后注入）
 *
 * 受 InjectionRouter 的 6 道门 + maxInjectionsPerStep=5 统一管控
 * 不再独立绕过注入管线
 */
export class SessionSummaryInjector extends DynamicInjector {
  constructor(protected override readonly agent: Agent) {
    super(agent);
  }

  get name(): string { return 'session-summary'; }
  get description(): string { return 'Injects session memory digest after successful compaction'; }
  override get injectionVariant(): string { return 'session_summary'; }

  protected override getInjection(): string | undefined {
    // 只在 step1 或 compaction 成功后触发
    const step = this._lastInjectContext?.currentStep;
    if (step !== 1 && !this.agent.fullCompaction.shouldInjectSessionSummary()) {
      return undefined;
    }
    const sessionSummary = this.agent.sessionMemory.getSessionSummary();
    if (sessionSummary.length === 0) return undefined;
    return `<system-reminder>\n[session-summary]\n${sessionSummary}\n</system-reminder>`;
  }
}
