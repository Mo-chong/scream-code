import type { Agent } from '..';
import type { DynamicInjector } from './injector';
import { GoalInjector } from './goal';
import { PermissionModeInjector } from './permission-mode';
import { PluginSessionStartInjector } from './plugin-session-start';
import { PlanModeInjector } from './plan-mode';
import { TodoListReminderInjector } from './todo-list';
import { UserPrefsInjector } from './user-prefs';
import { WolfPackModeInjector } from './wolfpack';
import { WorkingSetInjector } from './working-set';
import { GuardInjector } from './guard-injector';
import { ErrorAuditInjector } from './error-audit-injector';
import { InjectionRouter, type InjectContext } from './router';

export class InjectionManager {
  private readonly router: InjectionRouter;

  constructor(protected readonly agent: Agent) {
    this.router = new InjectionRouter();

    // 注册所有 DynamicInjector 至 router
    const injectors: [string, DynamicInjector][] = [
      ['plugin-session-start', new PluginSessionStartInjector(agent)],
      ['wolfpack', new WolfPackModeInjector(agent)],
      ['plan-mode', new PlanModeInjector(agent)],
      ['permission-mode', new PermissionModeInjector(agent)],
      ['todo-list', new TodoListReminderInjector(agent)],
      ['goal', new GoalInjector(agent)],
      ['working-set', new WorkingSetInjector(agent)],
      ['user-prefs', new UserPrefsInjector(agent)],
      ['guard-feedback', new GuardInjector(agent)],
      ['error-audit', new ErrorAuditInjector(agent)],
    ];
    for (const [id, injector] of injectors) {
      this.router.register(id, injector);
    }
  }

  /** 暴露 router 供后续步骤（Step 6+）直接调度 */
  getRouter(): InjectionRouter {
    return this.router;
  }

  async inject(currentStep: number): Promise<void> {
    const context: InjectContext = {
      currentStep,
      messageCount: this.agent.context?.history?.length ?? 0,
    };
    await this.router.dispatch(context);
  }

  /** Reset per-turn state on router + scheduler. */
  resetForTurn(): void {
    this.router.resetScheduler();
    this.router.onContextClear();
  }

  onContextClear(): void {
    this.router.onContextClear();
  }

  onContextCompacted(compactedCount: number): void {
    this.router.onContextCompacted(compactedCount);
  }

  onContextMessageRemoved(index: number): void {
    this.router.onContextMessageRemoved(index);
  }

  /** 路由内嵌的 maxInjectionsPerStep 控制已替代此功能；保留兼容接口 */
  maxInjectionsPerStep(): number {
    return 5;
  }

  /**
   * 查询给定变体是否可以在当前 step 注入。委托给 router.shouldInject。
   */
  canInject(variant: string, currentStep: number): boolean {
    return this.router.shouldInject(variant, currentStep);
  }

  getInjectionCount(variant: string): number {
    return this.router.getInjectionCount(variant);
  }

  /**
   * 注入后记录。委托给 router.recordInjection。
   */
  afterInject(variant: string, currentStep: number): void {
    this.router.recordInjection(variant, currentStep);
  }

  /** 重置所有注入器状态（turn 级别缓存） */
  onTurnReset(): void {
    // 占位 — 重置 per-turn 计数器
  }
}
