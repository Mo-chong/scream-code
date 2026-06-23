import { DynamicInjector } from './injector';

const WORKING_SET_REMINDER_INTERVAL = 3;

export class WorkingSetInjector extends DynamicInjector {
  protected readonly injectionVariant = 'working-set';

  protected getInjection(): string | undefined {
    const paths = this.agent.workingSet.getPaths();
    if (paths.length === 0) return undefined;

    // Dedup: suppress re-injection within WORKING_SET_REMINDER_INTERVAL assistant turns
    if (this.injectedAt !== null) {
      const turnsSince = this.countAssistantTurnsSince(this.injectedAt);
      if (turnsSince < WORKING_SET_REMINDER_INTERVAL) return undefined;
    }

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
