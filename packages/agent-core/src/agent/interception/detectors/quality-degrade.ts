/**
 * QualityDegrade Detector
 *
 * 检测注入质量衰退，触发 C→B→A→S 升级。
 * 包装 injection/quality.injector.ts 中的 QualityInjector 逻辑，
 * 但将决策层移入 InterceptionManager：质量偏差走 P2_quality 递进。
 *
 * 纯函数 — 只检测，不输出。
 * 与 QualityInjector 的关系：
 *   - 本 detector 决定"是否报告质量问题"（决策）
 *   - QualityInjector 决定"怎么措辞"（表达，待 Phase38c 后逐步合并）
 */

import type { DetectorFn, RawSignal } from '../types';

/** C→B→A→S 质量升级等级 */
const SEVERITY_ORDER = ['C', 'B', 'A', 'S'] as const;
type Severity = (typeof SEVERITY_ORDER)[number];

export const qualityDegradeDetector: DetectorFn = (ctx): RawSignal | null => {
  // 消费 ctx.qualitySignals（由 turn/index.ts 在每轮收集）
  const signals = ctx.qualitySignals;
  if (!signals || signals.length === 0) return null;

  // 取最高严重级别的信号
  let highestSeverity: Severity | null = null;
  let bestMessage = '';

  for (const sig of signals) {
    // qualitySignals 可能是字符串数组，也可能是对象数组
    const sev: Severity = (
      typeof sig === 'string' ? sig.split(':')[0] || 'C'
      : (sig as any).severity || 'C'
    ) as Severity;
    const msg: string = (
      typeof sig === 'string' ? sig
      : (sig as any).message || ''
    ) as string;

    const sevIdx = SEVERITY_ORDER.indexOf(sev);
    const bestIdx = highestSeverity ? SEVERITY_ORDER.indexOf(highestSeverity) : -1;
    if (sevIdx > bestIdx) {
      highestSeverity = sev;
      bestMessage = msg;
    }
  }

  if (!highestSeverity) return null;

  // 计算优先级：C→P3, B→P2, A→P1_discipline, S→P1_discipline
  const sevIdx = SEVERITY_ORDER.indexOf(highestSeverity);
  const priority = sevIdx <= 0 ? 'normal'
    : sevIdx === 1 ? 'normal'
    : 'critical' as const;

  // 根据严重级别生成不同消息
  const severityLabel = highestSeverity;
  const baseMsg = bestMessage || `质量偏差升级至 ${severityLabel} 级`;

  const messageMap: Record<Severity, string> = {
    C: `${baseMsg}\n- 考虑改用结构化方法。`,
    B: `${baseMsg}\n- 请遵循结构化方式推进。`,
    A: `${baseMsg}\n- 必须在继续前修正此问题。`,
    S: `${baseMsg}\n- 禁止重复此模式，违反系统规则。`,
  };

  return {
    rootCause: 'quality_degrade',
    priority,
    confidence: sevIdx >= 2 ? 0.9 : 0.6,
    message: messageMap[highestSeverity],
    escalation: 'hint',
    phase: 'post_step',
  };
};
