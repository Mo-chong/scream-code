import { DynamicInjector } from './injector';
import { InsertPosition } from './position-strategy';

const WORKING_SET_REMINDER_INTERVAL = 3;

export class WorkingSetInjector extends DynamicInjector {
  protected readonly injectionVariant = 'working-set';

  override getPosition(): InsertPosition {
    return InsertPosition.AFTER_TOOL_CALL;
  }

  protected getInjection(): string | undefined {
    const paths = this.agent.workingSet.getPaths();
    if (paths.length === 0) return undefined;

    // Dedup: suppress re-injection within WORKING_SET_REMINDER_INTERVAL assistant turns
    if (this.injectedAt !== null) {
      const turnsSince = this.countAssistantTurnsSince(this.injectedAt);
      if (turnsSince < WORKING_SET_REMINDER_INTERVAL) return undefined;
    }

    // Phase B': record as context fact for aggregated [Context Facts] block
    this.agent.context.recordFact?.(
      'working-set',
      paths.slice(0, 5).join(', ') + (paths.length > 5 ? ', ...' : ''),
      'info',
    );

    return [
      '## Working Set',
      '',
      '当前任务可能涉及以下文件：',
      ...paths.map((p) => `- ${p}`),
      '',
      '优先检查这些文件，避免重复读取未修改文件。',
    ].join('\n');
  }

  private countAssistantTurnsSince(from: number): number {
    let count = 0;
    const history = this.agent.context.history;
    for (let i = from; i < history.length; i++) {
      if (history[i]?.role === 'assistant') count++;
    }
    return count;
  }
}
