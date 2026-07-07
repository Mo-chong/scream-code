import type { Agent } from '..';
import { InsertPosition } from './position-strategy';
import type { InjectContext } from './router';

/**
 * 可选的残差注意力配置。
 * 若注入器覆写此方法返回配置，router dispatch 将使用
 * ResNet 残差公式 R = weight × decayPerStep^Δstep 判断
 * 注意力是否已低于 threshold，低于则注入。
 */
export interface ResidualConfig {
  weight: number;
  decayPerStep: number;
  threshold: number;
  minStepGap: number;
}

export abstract class DynamicInjector {
  protected injectedAt: number | null = null;

  constructor(protected readonly agent: Agent) {}

  onContextClear(): void {
    this.injectedAt = null;
  }

  onContextCompacted(compactedCount: number): void {
    if (this.injectedAt !== null) {
      const newInjectedAt = this.injectedAt - compactedCount + 1;
      this.injectedAt = newInjectedAt >= 0 ? newInjectedAt : null;
    }
  }

  /**
   * Called when a single message is removed from the context history (e.g.
   * by `/undo`). Adjusts the injection position so future injections don't
   * reference a stale index or re-inject too early.
   */
  onContextMessageRemoved(index: number): void {
    if (this.injectedAt === null) return;
    if (index < this.injectedAt) {
      this.injectedAt--;
    } else if (index === this.injectedAt) {
      this.injectedAt = null;
    }
  }

  /** 注入器期望的插入位置（默认 AFTER_TOOL_CALL） */
  getTargetPosition(): InsertPosition {
    return InsertPosition.AFTER_TOOL_CALL;
  }

  /**
   * 残差注意力配置。
   * 覆写此方法返回配置后，router dispatch 会在每次注入前
   * 检查残差注意力 R = weight × decayPerStep^Δstep，
   * 只有 R < threshold 时才注入。
   * 返回 undefined = 不使用残差控制。
   */
  getResidualConfig(): ResidualConfig | undefined {
    return undefined;
  }

  async inject(context?: InjectContext): Promise<void> {
    const injection = await this.getInjection();
    if (injection) {
      this.injectedAt = this.agent.context.history.length;
      this.agent.context.appendSystemReminder(injection, {
        kind: 'injection',
        variant: this.injectionVariant,
      });
    }
  }

  protected abstract readonly injectionVariant: string;

  protected abstract getInjection(): string | Promise<string | undefined> | undefined;
}
