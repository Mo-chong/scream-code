/**
 * QualityInjector — 质量偏差语气升级注入器。
 * 迁移自 turn/injectors/quality.ts (路径 B → 路径 A)
 *
 * 对同一 quality signal 逐步升级语气：C→B→A→S。
 * 特殊：不参与 budget 控制（绕过预算），因为质量升级必须无条件执行。
 */

import { DynamicInjector, type ResidualConfig } from './injector';
import type { InjectContext, QualityDeviationSignal } from './router';

const QUALITY_VARIANT = 'quality_escalate';

export class QualityInjector extends DynamicInjector {
  override readonly injectionVariant = QUALITY_VARIANT;

  /** 已发送的最高等级（按 signal 跟踪） */
  private sentSeverity = new Map<string, number>();

  get name(): string { return 'quality'; }
  get description(): string { return '基于 QualityDetector 信号升级注入语气'; }
  get priority(): number { return 50; }

  /** 返回 null 表示不参与 budget 控制（绕过预算） */
  override getResidualConfig(): ResidualConfig | undefined {
    return undefined;
  }

  override onContextClear(): void {
    this.sentSeverity.clear();
  }
  override onContextCompacted(_count: number): void {
    this.sentSeverity.clear();
  }

  protected override getInjection(): string | undefined {
    const ctx = this._lastInjectContext;
    if (!ctx?.qualitySignals || ctx.qualitySignals.length === 0) return undefined;

    const severityOrder = ['C', 'B', 'A', 'S'];

    for (const signal of ctx.qualitySignals) {
      const key = signal.signal;
      const currentIdx = severityOrder.indexOf(signal.severity);
      const sentIdx = this.sentSeverity.get(key) ?? -1;

      if (currentIdx > sentIdx) {
        // 升级
        this.sentSeverity.set(key, currentIdx);
        return this.buildText(signal);
      }
    }

    return undefined;
  }

  private buildText(signal: QualityDeviationSignal): string {
    const { severity, message } = signal;
    const base = `[质量偏差] ${message}`;

    switch (severity) {
      case 'S':
        return `${base}\n- NEVER repeat this pattern. It violates system rules.`;
      case 'A':
        return `${base}\n- MUST correct this before proceeding.`;
      case 'B':
        return `${base}\n- Follow the structured approach.`;
      default: // C
        return `${base}\n- Consider alternative approaches.`;
    }
  }
}
