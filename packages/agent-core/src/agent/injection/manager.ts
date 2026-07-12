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
import { StuckInjector } from './stuck';
import { IntentInjector } from './intent-injector';
import { ErrorAuditInjector } from './error-audit-injector';
import { GuardInjector } from './guard-injector';
import { SessionSummaryInjector } from './session-summary';
import { PersistentSummaryInjector } from './persistent-summary';
import { ActiveSummaryInjector } from './active-summary';
import { DecisionTraceInjector } from './decision-trace';
import { InjectionRouter, type InjectContext } from './router';

export class InjectionManager {
  private readonly router: InjectionRouter;

  /** GuardInjector 暴露给 turn/index.ts 的 runGuardDetection */
  readonly guardInjector: GuardInjector;

  constructor(protected readonly agent: Agent) {
    this.guardInjector = new GuardInjector(agent);
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
      // 路径 B 迁移：原 turn/injectors/{stuck,quality,intent}.ts
      ['system_ref_stuck', new StuckInjector(agent)],
      ['intent_guidance', new IntentInjector(agent)],
      ['error-audit', new ErrorAuditInjector(agent)],
      ['guard-feedback', this.guardInjector],
      ['session-summary', new SessionSummaryInjector(agent)],
      // Phase39b: ActiveSummaryInjector 替代 ToolResultRecoveryInjector
      // ToolResultRecoveryInjector 旧设计基于 history 估算遮蔽数，
      // 管线顺序矛盾导致 1694 轮 0 次触发（cache-audit 验证）。
      // ActiveSummaryInjector 从 context._pendingRecoveries 读取准确记录。
      ['active-summary', new ActiveSummaryInjector(agent)],
      ['decision-trace', new DecisionTraceInjector(agent)],
    ];
    for (const [id, injector] of injectors) {
      this.router.register(id, injector);
    }
  }

  /** 暴露 router 供后续步骤（Step 6+）直接调度 */
  getRouter(): InjectionRouter {
    return this.router;
  }

  async inject(ctx: InjectContext): Promise<void> {
    const context: InjectContext = {
      ...ctx,
      predictedHitRatio: ctx.predictedHitRatio ?? this.agent.fullCompaction?.strategy?.getPredictedHitRatio?.(),
    };

    // Step 0: 拦截系统预批准消息 — 优先占 budget 槽
    let preApprovedCount = 0;
    if (context.extraInterceptions?.length) {
      const maxPerStep = 5; // 同 RouterConfig DEFAULT.maxInjectionsPerStep
      for (const msg of context.extraInterceptions) {
        if (preApprovedCount >= maxPerStep) break;
        this.agent.context.appendSystemReminder(msg.body, {
          kind: 'injection',
          variant: `intercept_${msg.rootCause}`,
        }, false);
        preApprovedCount++;
      }
    }

    try {
      await this.router.dispatch(context);
    } finally {
      // Phase B': flush aggregated [Context Facts] after all injectors have run.
      // Must be in finally to clear map even if dispatch throws.
      const factsBlock = this.agent.context.flushContextFacts();
      if (factsBlock !== null) {
        // Inject at tail (append) to preserve prefix cache hit ratio ~98%
        this.agent.context.appendSystemReminder(factsBlock, {
          kind: 'injection',
          variant: 'context-facts',
        }, false);
      }
    }
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
