import type { Agent } from '..';
import type { DynamicInjector } from './injector';
import { GoalInjector } from './goal';
import { PermissionModeInjector } from './permission-mode';
import { PluginSessionStartInjector } from './plugin-session-start';
import { PlanModeInjector } from './plan-mode';
import { TodoListReminderInjector } from './todo-list';
import { WolfPackModeInjector } from './wolfpack';
import { WorkingSetInjector } from './working-set';
import { VariantScheduler } from '../turn/variant-registry';

export class InjectionManager {
  private readonly injectors: DynamicInjector[];
  private readonly scheduler: VariantScheduler;

  constructor(protected readonly agent: Agent) {
    this.injectors = [
      new PluginSessionStartInjector(agent),
      new WolfPackModeInjector(agent),
      new PlanModeInjector(agent),
      new PermissionModeInjector(agent),
      new TodoListReminderInjector(agent),
      new GoalInjector(agent),
      new WorkingSetInjector(agent),
    ];
    this.scheduler = new VariantScheduler();
  }

  async inject(): Promise<void> {
    for (const injector of this.injectors) {
      await injector.inject();
    }
  }

  /** Reset per-turn state on all injectors + reset VariantScheduler counters. */
  resetForTurn(): void {
    this.scheduler.reset();
  }

  onContextClear(): void {
    for (const injector of this.injectors) {
      injector.onContextClear();
    }
  }

  onContextCompacted(compactedCount: number): void {
    for (const injector of this.injectors) {
      try {
        injector.onContextCompacted(compactedCount);
      } catch {
        continue;
      }
    }
  }

  onContextMessageRemoved(index: number): void {
    for (const injector of this.injectors) {
      try {
        injector.onContextMessageRemoved(index);
      } catch {
        continue;
      }
    }
  }

  /**
   * Phase22.3: 查询给定变体是否可以在当前 step 注入。
   * 委托给 VariantScheduler.shouldInject。
   */
  canInject(variant: string, currentStep: number): boolean {
    return this.scheduler.shouldInject(variant, currentStep);
  }

  getInjectionCount(variant: string): number {
    return this.scheduler.getInjectionCount(variant);
  }

  /**
   * Phase22.3: 注入后记录。
   * 委托给 VariantScheduler.record。
   */
  afterInject(variant: string, currentStep: number): void {
    this.scheduler.record(variant, currentStep);
  }

  /**
   * Phase22.3: 重置所有注入器状态。
   */
  onTurnReset(): void {
    // 占位 — 重置 per-turn 计数器
  }
}
