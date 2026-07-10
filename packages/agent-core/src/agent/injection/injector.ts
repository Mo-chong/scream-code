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
 */
export interface ResidualConfig {
  /** 每次注入的初始注意力权重（0-1） */
  readonly weight: number;
  /** 每步衰减因子（0-1），值越小衰减越快 */
  readonly decayPerStep: number;
  /** 最小间隔步数，低于此步数不注入 */
  readonly minStepGap: number;
  /** 残差低于此阈值时允许注入 */
  readonly threshold: number;
}

/**
 * 动态注入器基类。
 * 子类实现有状态的动态注入逻辑，由 InjectionRouter 调度。
 */
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

  /** 子类兼容别名，同 getTargetPosition */
  getPosition(): InsertPosition {
    return this.getTargetPosition();
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
   * [优化C] 内容哈希去重：同一注入器在内容未变更时跳过重复注入，
   * 维持 DeepSeek 公共前缀稳定。
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

  protected _lastInjectContext?: InjectContext;

  async inject(context?: InjectContext): Promise<void> {
    this._lastInjectContext = context;
    const injection = await this.getInjection();
    if (injection) {
      this._lastContentHash = simpleHash(injection);
      this.injectedAt = this.agent.context.history.length;
      const pos = this.getTargetPosition();
      if (pos === InsertPosition.AFTER_SYSTEM) {
        this.agent.context.insertSystemReminderAtHead(injection, {
          kind: 'injection',
          variant: this.injectionVariant,
        }, true);
      } else {
        this.agent.context.appendSystemReminder(injection, {
          kind: 'injection',
          variant: this.injectionVariant,
        });
      }
    } else {
      // Clear stale hash when no injection occurred
      this._lastContentHash = null;
    }
  }

  protected abstract readonly injectionVariant: string;

  /** expose the last content hash for audit logging (Phase M) */
  getLastContentHash(): string | null {
    return this._lastContentHash;
  }

  protected abstract getInjection(): string | Promise<string | undefined> | undefined;
}
