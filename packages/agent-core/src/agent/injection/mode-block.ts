import { DynamicInjector } from './injector';
import { InsertPosition } from './position-strategy';
import type { Agent } from '..';

/**
 * ModeBlockInjector — 模式状态合并注入器
 *
 * 聚合 plan-mode + permission-mode 为一条 AFTER_SYSTEM 系统提醒。
 * 减少头部注入器数量（user-prefs → DONE + 本合并 = 头部共 2 条）。
 *
 * 缓存安全：AFTER_SYSTEM 位置，splice 断缓存（继承父类行为）。
 */
export class ModeBlockInjector extends DynamicInjector {
  protected override readonly injectionVariant = 'mode_block';

  constructor(agent: Agent) {
    super(agent);
  }

  override getPosition(): InsertPosition {
    return InsertPosition.AFTER_SYSTEM;
  }

  protected override async getInjection(): Promise<string | undefined> {
    const parts: string[] = [];

    // plan mode
    const plan = this.agent.planMode;
    if (plan.isActive) {
      parts.push(`plan=${plan.strategy}`);
    }

    // permission mode
    const permMode = this.agent.permission?.mode;
    if (permMode) {
      parts.push(`perm=${permMode}`);
    }

    if (parts.length === 0) return undefined;

    return `<mode ${parts.join(' ')}/>`;
  }
}
