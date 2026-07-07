import type { MemoValueTier } from '../models.js';

// ─── Rule-based value tier classification ───────────────────────────────────
// Hard-coded patterns so value judgments are deterministic — no AI dependency.

/** Classification rules ordered by priority (first match wins). */
const RULES: Array<{ pattern: RegExp; tier: MemoValueTier }> = [
  // ── CRITICAL: battle scars, breaking changes, firefights ──
  { pattern: /(踩坑|挖坑|大坑|坑|bug|fix|修复|错误|crash|break|breaking|regression|回滚|回退)/i, tier: 'critical' },
  { pattern: /(踩|填坑|救火|紧急|hotfix|workaround|根源|根因|root.cause|rollback|revert)/i, tier: 'critical' },

  // ── VALUABLE: architecture, patterns, design, optimizations ──
  { pattern: /(实现|设计|架构|方案|方法|模式|pattern|技巧|策略|优化|对比|权衡)/i, tier: 'valuable' },
  { pattern: /(经验|总结|教训|lessons?|learned|最佳|best.practice|配置|config|原理|principle)/i, tier: 'valuable' },
  { pattern: /(性能|performance|并发|concurrent|安全|security|auth|权限|permission)/i, tier: 'valuable' },

  // ── LOW: plans, logs, checklists, meeting notes ──
  { pattern: /(计划|规划|checklist|日志|log|记录|记录一下|今天|明天|本周|会议|meeting|同步|sync)/i, tier: 'low' },
  { pattern: /(验收|验证|确认|review|审批|approve|phase|阶段|todo|待办|下次|后续)/i, tier: 'low' },
];

/**
 * Classify a memo's value tier based on keyword patterns.
 * Uses a rule engine — zero LLM calls, deterministic, 1μs runtime.
 * @param extraRules - Optional additional rules appended after built-in RULES (first-match priority).
 */
export function classifyValueTier(memoText: string, extraRules?: Array<{ pattern: RegExp; tier: MemoValueTier }>): MemoValueTier {
  const allRules = extraRules ? [...RULES, ...extraRules] : RULES;
  for (const rule of allRules) {
    if (rule.pattern.test(memoText)) {
      return rule.tier;
    }
  }

  // ├─ Fallback: very short text (< 30 chars) → low value
  // └─ Everything else → normal (default)
  return memoText.length < 30 ? 'low' : 'normal';
}

/**
 * Build the full text used for value classification from a memo's fields.
 * Concatenates all prose fields with spaces, skipping empty/low-information values.
 */
export function buildMemoClassifyText(fields: {
  userNeed?: string;
  approach?: string;
  outcome?: string;
  whatFailed?: string;
  whatWorked?: string;
}): string {
  const skipValues = new Set(['none', 'n/a', 'na', '-', '', '无', '没有']);
  return [fields.userNeed, fields.approach, fields.outcome, fields.whatFailed, fields.whatWorked]
    .filter(v => v != null && !skipValues.has(v.toLowerCase().trim()))
    .join(' ');
}
