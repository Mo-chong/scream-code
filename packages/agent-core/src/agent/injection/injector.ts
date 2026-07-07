import type { Agent } from '..';
import { InsertPosition } from './position-strategy';
import type { InjectContext } from './router';

/** 快速字符串哈希（非加密，仅用于去重比较） */
export function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h.toString(36);
}

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
  private _lastContentHash: string | null = null;

  constructor(protected readonly agent: Agent) {}

  onContextClear(): void {
    this.injectedAt = null;
    this._lastContentHash = null;
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

  /**
   * 内容哈希去重：[优化C]
   * 同一注入器在内容未变更时跳过重复注入，维持 DeepSeek 公共前缀稳定。
   * 子类可覆写返回 false 以强制每次注入。
   */
  hasContentChanged(): boolean {
    const preview = this.getContentPreview();
    if (preview === undefined) return true;
    const hash = simpleHash(preview);
    if (hash === this._lastContentHash) return false;
    this._lastContentHash = hash;
    return true;
  }

  /**
   * 返回注入内容预览（同步，轻量）。
   * 用于内容哈希去重。返回 undefined = 无法预览，视为已变更。
   */
  protected getContentPreview(): string | undefined {
    return undefined;
  }

  async inject(context?: InjectContext): Promise<void> {
    const injection = await this.getInjection();
    if (injection) {
      // 内容哈希去重：同一内容不重复注入，除非是强制（S级）
      this._lastContentHash = simpleHash(injection);
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
