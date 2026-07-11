import type { Agent } from '..';
import { DynamicInjector, type ResidualConfig } from './injector';
import { InsertPosition } from './position-strategy';

interface GuardData {
  rule: number;     // 2/3/4 only — Rule 1 (blocking) 不走注入管线
  feedback: string;
}

/**
 * GuardInjector — 守卫反馈注入器
 *
 * 职责:
 *   将 checkGuard() 的观察结果（Rule 2/3/4）通过统一注入管线注入。
 *
 * 数据流:
 *   1. turn/index.ts:runGuardDetection() 调用 checkGuard()
 *   2. Rule 2/3/4 → setGuardData(rule, enrichedFeedback) 写入
 *   3. 下一轮 beforeStep → injection.inject() → router.dispatch()
 *   4. canInject() 检查变体残差 → getInjection() 返回反馈
 *   5. 拼接为系统提醒
 *
 * Rule 1 (阻断) 不走此注入器 — 它设 confabulationBlocked 标记控制流程。
 */
export class GuardInjector extends DynamicInjector {
  injectionVariant = 'guard-feedback';

  constructor(protected override readonly agent: Agent) {
    super(agent);
  }

  private guardData: GuardData | null = null;

  /** runGuardDetection 调用，设置本轮守卫数据供下一轮注入 */
  setGuardData(rule: number, feedback: string): void {
    this.guardData = { rule, feedback };
  }

  /** 每轮检测前调用，清除上一轮残留 */
  clearGuardData(): void {
    this.guardData = null;
  }

  /** 供 shouldContinueAfterStop 读取最近的 feedback（不限于注入） */
  get lastFeedback(): string | null {
    return this.guardData?.feedback ?? null;
  }

  override getTargetPosition(): InsertPosition {
    return InsertPosition.AFTER_TOOL_CALL;
  }

  override getResidualConfig(): ResidualConfig | undefined {
    // scheduler 用 variant-registry 的 guard-feedback 配置
    return { weight: 0.7, decayPerStep: 0.85, minStepGap: 3, threshold: 0.25 };
  }

  protected override getInjection(): string | undefined {
    if (!this.guardData || this.guardData.rule <= 1) return undefined;

    // Phase B': record as context fact for aggregated [Context Facts] block
    const ruleLabel = `Rule ${this.guardData.rule}`;
    const feedbackShort =
      this.guardData.feedback.length > 80
        ? this.guardData.feedback.slice(0, 80) + '…'
        : this.guardData.feedback;
    this.agent.context.recordFact?.(
      'guard-rules',
      `${ruleLabel}: ${feedbackShort}`,
      'warn',
    );

    return this.guardData.feedback;
  }
}
