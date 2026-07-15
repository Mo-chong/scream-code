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
  // 保护：只有当 bestMessage 在合理长度范围内才嵌入具体描述，否则回退通用消息
  const severityLabel = highestSeverity;
  const hasGoodMessage = bestMessage.length >= 10 && bestMessage.length <= 80;
  const baseMsg = hasGoodMessage ? bestMessage : `质量偏差升级至 ${severityLabel} 级`;

  const messageMap: Record<Severity, string> = {
    C: hasGoodMessage ? `${baseMsg} — 建议用工具验证代替手动推断。`
       : `${baseMsg}\n- 考虑改用结构化方法。`,
    B: hasGoodMessage ? `${baseMsg}（已重复多步）— 请 Read 当前内容后再操作。`
       : `${baseMsg}\n- 请遵循结构化方式推进。`,
    A: hasGoodMessage ? `${baseMsg} — 必须修正后继续，否则回合终止。建议换方法或缩小范围。`
       : `${baseMsg}\n- 必须在继续前修正此问题。`,
    S: hasGoodMessage ? `${baseMsg} — 已触发上限，违反系统规则。`
       : `${baseMsg}\n- 禁止重复此模式，违反系统规则。`,
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
