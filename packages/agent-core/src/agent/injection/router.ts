/**
 * InjectionRouter — 注入调度管线核心。
 *
 * 职责:
 * 1. 注册/反注册所有 DynamicInjector
 * 2. dispatch() 执行注入管线：收集 → 位置排序 → 调度器过滤 → Token预算过滤 → 执行
 * 3. 管理注入器生命周期事件 (onContextClear / onContextCompacted / onContextMessageRemoved)
 *
 * 融合计划 Step 1-11 逐步完善管线各环节。
 */

import type { Agent } from '..';
import type { DynamicInjector } from './injector';
import { InsertPosition } from './position-strategy';
import { VariantScheduler } from '../turn/variant-registry';

// ─── Step 11a: CacheGroup ──────────────────────────────────────────

/**
 * 缓存分组 — 同一分组的注入共享冷却状态。
 */
export type CacheGroup = 'core' | 'context' | 'feedback' | 'audit' | 'default';

/**
 * 注入变体的缓存分组映射（运行时只读）。
 * Step 11b 将据此进行冷却/残差决策。
 */
const CACHE_GROUP_MAP: Record<string, CacheGroup> = {
  'plugin-session-start': 'core',
  'plan-mode': 'core',
  'permission-mode': 'core',
  'wolfpack': 'context',
  'goal': 'context',
  'working-set': 'context',
  'user-prefs': 'feedback',
  'guard-feedback': 'feedback',
  'error-audit': 'audit',
};

export function getCacheGroup(variant: string): CacheGroup {
  return CACHE_GROUP_MAP[variant] ?? 'default';
}

// ─── 类型 ───────────────────────────────────────────────────────────

/**
 * 注入上下文。dispatch() 的输入参数，描述当前回合状态。
 */
export interface InjectContext {
  /** 当前回合已执行的步数（1-based） */
  readonly currentStep: number;
  /** 当前 step 的 tool result 简述（可能为空） */
  readonly toolResult?: string;
  /** 当前回合消息历史长度 */
  readonly messageCount: number;
  /** 剩余可用 token（undefined = 不限制） */
  readonly remainingBudget?: number;
}

/**
 * dispatch() 的单个注入结果。
 */
export interface InjectResult {
  /** 注入变体名称 */
  variant: string;
  /** 实际使用的注入位置 */
  position: InsertPosition;
  /** 是否成功执行 */
  success: boolean;
  /** 失败原因（仅 success===false 时） */
  error?: string;
  /** 注入时的回合步号 */
  stepInjected: number;
}

// ─── Router 配置 ────────────────────────────────────────────────────

export interface RouterConfig {
  /** 每步最大注入数（默认 5） */
  maxInjectionsPerStep: number;
  /** 是否启用注意力路由（Step 11） */
  enableAttentionRouting: boolean;
  /** 是否启用 Token 预算过滤（Step 7） */
  enableTokenBudget: boolean;
}

const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  maxInjectionsPerStep: 5,
  enableAttentionRouting: false,
  enableTokenBudget: false,
};

// ─── InjectionRouter ────────────────────────────────────────────────

export class InjectionRouter {
  private readonly injectors = new Map<string, DynamicInjector>();
  private readonly config: RouterConfig;
  private readonly scheduler = new VariantScheduler();
  /** Step 9: 运行时停用的 variant 集合 */
  private readonly disabled = new Set<string>();
  /** Step 7: 当前剩余 token 预算 (undefined = 不限制) */
  private remainingBudget: number | undefined;

  constructor(config?: Partial<RouterConfig>) {
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config };
  }

  // ─── 注册 / 反注册 ──────────────────────────────────────────────

  /**
   * 注册一个 DynamicInjector，id 等于 variant name。
   * 已存在同 id 时覆盖（日志警告由上层负责）。
   */
  register(id: string, injector: DynamicInjector): void {
    this.injectors.set(id, injector);
  }

  /**
   * 反注册指定 id 的注入器。
   * @returns true 如果该 id 存在且被移除
   */
  unregister(id: string): boolean {
    return this.injectors.delete(id);
  }

  /** 查询指定 id 是否已注册 */
  has(id: string): boolean {
    return this.injectors.has(id);
  }

  /** 当前注入器数量 */
  get size(): number {
    return this.injectors.size;
  }

  // ─── 核心管线 ───────────────────────────────────────────────────

  /**
   * 设置当前 token 预算。dispatch 前调用。
   */
  setBudget(budget: number | undefined): void {
    this.remainingBudget = budget;
  }

  /**
   * Step 7: Token 预算检查。
   * 预留实现 — 当 remainingBudget 设置且低于阈值时过滤注入。
   */
  private tokenBudgetCheck(currentCost: number): boolean {
    if (this.remainingBudget === undefined) return true;
    return currentCost <= this.remainingBudget;
  }

  /**
   * 执行注入管线。
   *
   * 当前实现：遍历所有注册注入器（未被 disabled），逐次调用 inject()，
   * 达到 maxInjectionsPerStep 上限后停止。
   *
   * TODO(Step 11): 缓存感知 / 注意力路由 / 冷却
   */
  async dispatch(context: InjectContext): Promise<InjectResult[]> {
    const results: InjectResult[] = [];
    let injectionCount = 0;

    for (const [id, injector] of this.injectors) {
      if (injectionCount >= this.config.maxInjectionsPerStep) break;

      // Step 9: 运行时停用的注入器跳过
      if (this.disabled.has(id)) continue;

      // Step 2: 调度器过滤
      if (!this.scheduler.shouldInject(id, context.currentStep)) {
        continue;
      }

      // Step 7: Token 预算检查（预留）
      if (!this.tokenBudgetCheck(injectionCount + 1)) {
        continue;
      }

      // TODO(Step 11): 缓存感知 / 注意力路由 / 冷却

      try {
        // DynamicInjector.inject() 内部调用 getInjection() + appendSystemReminder
        await injector.inject();
        this.scheduler.record(id, context.currentStep);
        results.push({
          variant: id,
          position: InsertPosition.AFTER_TOOL_CALL,
          success: true,
          stepInjected: context.currentStep,
        });
        injectionCount++;
      } catch (error) {
        results.push({
          variant: id,
          position: InsertPosition.AFTER_TOOL_CALL,
          success: false,
          error: String(error),
          stepInjected: context.currentStep,
        });
      }
    }

    return results;
  }

  /** 调度器接口暴露（供 Step 6 注入迁移时问询） */
  shouldInject(variant: string, currentStep: number): boolean {
    return this.scheduler.shouldInject(variant, currentStep);
  }

  getInjectionCount(variant: string): number {
    return this.scheduler.getInjectionCount(variant);
  }

  recordInjection(variant: string, currentStep: number): void {
    this.scheduler.record(variant, currentStep);
  }

  resetScheduler(): void {
    this.scheduler.reset();
  }

  // ─── Step 9: 运行时停用 ────────────────────────────────────────

  /** 运行时停用一个注入变体 */
  disable(id: string): this {
    this.disabled.add(id);
    return this;
  }

  /** 重新启用一个注入变体 */
  enable(id: string): this {
    this.disabled.delete(id);
    return this;
  }

  /** 查询注入变体是否被停用 */
  isDisabled(id: string): boolean {
    return this.disabled.has(id);
  }

  /** 当前停用变体清单（只读拷贝） */
  getDisabledList(): string[] {
    return Array.from(this.disabled);
  }

  /** 运行时状态摘要（诊断/监控用） */
  getStats(): { registered: number; disabled: string[]; active: string[] } {
    const all = Array.from(this.injectors.keys());
    return {
      registered: all.length,
      disabled: Array.from(this.disabled),
      active: all.filter((id) => !this.disabled.has(id)),
    };
  }

  // ─── 生命周期转发 ───────────────────────────────────────────────

  /** 通知所有注册注入器：上下文已清除 */
  onContextClear(): void {
    for (const injector of this.injectors.values()) {
      injector.onContextClear();
    }
  }

  /** 通知所有注册注入器：上下文已合并 */
  onContextCompacted(compactedCount: number): void {
    for (const injector of this.injectors.values()) {
      try {
        injector.onContextCompacted(compactedCount);
      } catch {
        // 单个注入器失败不阻断其余
        continue;
      }
    }
  }

  /** 通知所有注册注入器：上下文中的一条消息被移除 */
  onContextMessageRemoved(index: number): void {
    for (const injector of this.injectors.values()) {
      try {
        injector.onContextMessageRemoved(index);
      } catch {
        continue;
      }
    }
  }
}
