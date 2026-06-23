/**
 * GuardRuleEngine — 后处理行为矫正规则引擎。
 *
 * 在 afterStep 中运行，检查 AI 回复文本 vs 工具调用事实。
 * 3 条规则：
 *   Rule 1 (拦截): "测试通过" + exit code ≠ 0 → confabulationBlocked
 *   Rule 2 (记录): "检查发现" + 无 Read/Grep/LSP → guard_observe
 *   Rule 3 (记录): "已修改" + 无 Edit/Write → guard_observe
 *
 * 规则 1 是拦截模式（零误报），规则 2/3 是观察模式（先看数据再决策）。
 */

import { extractLastAssistantText } from './signature';
import type { TurnEventLog } from './event-log';
import type { ContextMessage } from '../context';

/** 工具使用摘要，由 turn manager 在 afterStep 时提供 */
export interface StepToolSummary {
  /** 上一步是否调用了知识工具（Read/Grep/LSP） */
  readonly hasKnowledgeTools: boolean;
  /** 上一步是否调用了修改工具（Edit/Write） */
  readonly hasWriteTools: boolean;
  /** 上一步 Bash exit code（Bash 未执行时为 null） */
  readonly lastBashExitCode: number | null;
}

/**
 * Guard 规则检查结果。
 * 只返回一条规则的结果——按规则优先级（Rule 1 > 2 > 3）。
 */
export interface GuardResult {
  /** 命中的规则编号（1/2/3），未命中则为 0 */
  readonly rule: number;
  /** 是否拦截（只有 Rule 1 拦截） */
  readonly block: boolean;
  /** 人类可读的原因 */
  readonly reason: string;
}

/**
 * 检查 AI 最近一段回复是否触发 Guard 规则。
 *
 * @param history 上下文历史（用于提取最后一条 assistant 文本）
 * @param tools  上一步的工具使用摘要
 * @returns GuardResult — 未命中时 rule=0
 */
export function checkGuard(
  history: readonly ContextMessage[],
  tools: StepToolSummary,
): GuardResult {
  const lastText = extractLastAssistantText(history);

  if (lastText.length === 0) return { rule: 0, block: false, reason: '' };

  // ── Rule 1: 谎报测试通过 ─────────────────────────────────────
  // 触发: AI 回复含 "测试通过" / "验证通过" + Bash exit code = 非0
  if (
    tools.lastBashExitCode !== null &&
    tools.lastBashExitCode !== 0 &&
    /测试通过|验证通过|all tests?\s*pass|tests?\s+passed/i.test(lastText)
  ) {
    return {
      rule: 1,
      block: true,
      reason:
        `Guard Rule 1: 声称"测试通过"但 Bash exit code = ${tools.lastBashExitCode}。` +
        '禁止谎报测试结果。必须修复根因后重新跑完整验证。',
    };
  }

  // ── Rule 2: 声称检查发现但无知识工具调用 ──────────────────────
  // 触发: AI 回复含 "检查发现" / "可以看到" / "我发现"
  //        + 上一步无 Read/Grep/LSP 调用
  if (
    !tools.hasKnowledgeTools &&
    /检查发现|可以看到|我发现|I find that|I can see/i.test(lastText)
  ) {
    return {
      rule: 2,
      block: false,
      reason:
        'Guard Rule 2 (观察): AI 声称"检查发现"但上一步无 Read/Grep/LSP 调用。' +
        '可能是在编造代码内容。',
    };
  }

  // ── Rule 3: 声称已修改但无编辑工具调用 ────────────────────────
  // 触发: AI 回复含 "已修改" / "已修复" / "已更新"
  //        + 上一步无 Edit/Write 调用
  if (
    !tools.hasWriteTools &&
    /已修改|已修复|已更新|已添加|已删除|已重构/i.test(lastText)
  ) {
    return {
      rule: 3,
      block: false,
      reason:
        'Guard Rule 3 (观察): AI 声称"已修改"但上一步无 Edit/Write 调用。' +
        '可能存在编造。',
    };
  }

  return { rule: 0, block: false, reason: '' };
}
