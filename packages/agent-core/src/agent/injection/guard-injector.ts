/**
 * GuardInjector — 守卫规则注入器（R1 阻断 + R2/R3/R4 备用）
 *
 * Phase38 精简版：R2/R3/R4 由 permissionEnforcerDetector 接管，
 * 但 guard-injector 保留对 R2/R3/R4 的注入能力（fallback）。
 * R1 (confabulation blocking) 是此注入器的核心职责。
 *
 * setGuardData() 由 turn/index.ts 在 runGuardDetection 后调用。
 */

import { DynamicInjector, type ResidualConfig } from './injector';
import { InsertPosition } from './position-strategy';
import type { Agent } from '..';

export interface GuardData {
  rule: 0 | 1 | 2 | 3 | 4;
  block: boolean;
  feedback?: string;
}

const GUARD_VARIANT = 'guard-feedback';

export class GuardInjector extends DynamicInjector {
  override readonly injectionVariant = GUARD_VARIANT;

  get name(): string { return GUARD_VARIANT; }
  get description(): string { return '守卫规则 R1 阻断 + R2/R3/R4 fallback'; }
  get priority(): number { return 80; }

  private lastRule: number = 0;
  private lastFeedback: string | null = null;
  private lastBlock: boolean = false;

  setGuardData(rule: number, block: boolean, feedback?: string): void {
    this.lastRule = rule;
    this.lastBlock = block;
    this.lastFeedback = feedback ?? null;
  }

  clearGuardData(): void {
    this.lastRule = 0;
    this.lastBlock = false;
    this.lastFeedback = null;
  }

  getLastFeedback(): string | null {
    return this.lastFeedback;
  }

  override getResidualConfig(): ResidualConfig {
    return { weight: 0.7, decayPerStep: 0.90, threshold: 0.20, minStepGap: 3 };
  }

  override getTargetPosition(): InsertPosition {
    return InsertPosition.AFTER_SYSTEM;
  }

  protected shouldInject(): boolean {
    // Phase38: R1 阻断走此注入器，R2/R3/R4 由 permissionEnforcerDetector 处理
    return this.lastRule === 1;
  }

  protected getInjection(): string | undefined {
    if (this.lastRule === 1) {
      // R1: confabulation block
      return this.lastFeedback || '检测到内容编造，当前步已阻断。';
    }
    // Phase38: R2/R3/R4 主要由 permissionEnforcerDetector 处理
    // guard-injector 保留 fallback（如果 detector 未触发）
    if (!this.lastFeedback) return undefined;
    return this.lastFeedback;
  }
}
