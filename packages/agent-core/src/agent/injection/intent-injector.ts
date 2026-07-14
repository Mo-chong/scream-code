/**
 * IntentInjector — 意图检测结果注入器。
 * 迁移自 turn/injectors/intent.ts (路径 B → 路径 A)
 *
 * Pure consumer of intent detection. 检测逻辑在 turn/detectors/intent.ts。
 * 通过 InjectContext.intentPhase 接收检测结果。
 */

import { DynamicInjector, type ResidualConfig } from './injector';
import type { InjectContext } from './router';

const INTENT_GUIDANCE: Record<string, { B: string; A: string }> = {
  intent_fix_bug: {
    B:
      'Bug fix detected. Follow these steps:\n' +
      'Step 1: Write a minimal reproduction test.\n' +
      'Step 2: Confirm the test fails (RED).\n' +
      'Step 3: Fix the code.\n' +
      'Step 4: Confirm the test passes (GREEN).\n' +
      'Step 5: Clean up debug code.',
    A:
      'Bug fix protocol REQUIRED.\n' +
      'MUST write a reproduction test first (confirm RED).\n' +
      'MUST fix the root cause (not a workaround).\n' +
      'MUST confirm test passes (GREEN).\n' +
      'NEVER fix without a failing test.',
  },
  intent_refactor: {
    B:
      'Refactoring detected. Follow these steps:\n' +
      'Step 1: Use LSP|Grep to find all callers of changed symbols.\n' +
      'Step 2: Edit every caller — no compatibility shims, no deprecated paths.\n' +
      'Step 3: Verify (build/test).',
    A:
      'Refactoring protocol REQUIRED.\n' +
      'MUST use LSP|Grep to find ALL callers before changing a symbol.\n' +
      'MUST update every caller — no shims, no deprecated aliases.\n' +
      'MUST verify with build/test after the change.',
  },
  intent_add_feature: {
    B:
      'New feature detected. Follow these steps:\n' +
      'Step 1: Read existing files to understand current architecture.\n' +
      'Step 2: Design minimal change — identify files to modify.\n' +
      'Step 3: Implement. Keep changes focused.\n' +
      'Step 4: Verify (build/test).',
    A:
      'New feature protocol REQUIRED.\n' +
      'MUST read existing architecture first.\n' +
      'MUST design minimal changes — identify exact files.\n' +
      'MUST verify with build/test after implementation.',
  },
  intent_review: {
    B:
      'Review/audit detected. Follow these steps:\n' +
      'Step 1: Read all relevant files first (read-only).\n' +
      'Step 2: Identify issues — bugs, API contract violations, integration risks.\n' +
      'Step 3: Report with code examples for each finding.',
    A:
      'Review protocol REQUIRED.\n' +
      'MUST read all relevant files before concluding.\n' +
      'MUST identify concrete issues with code evidence.\n' +
      'NEVER skip files because the pattern seems clear.',
  },
  intent_research: {
    B:
      'Research task detected. Follow these steps:\n' +
      'Step 1: Plan search strategy — what queries, which sources.\n' +
      'Step 2: Execute searches. Collect findings.\n' +
      'Step 3: Synthesize results into a structured answer.',
    A:
      'Research protocol REQUIRED.\n' +
      'MUST plan search queries before executing.\n' +
      'MUST use diverse sources for verification.\n' +
      'NEVER fabricate findings — each claim needs a source.',
  },
  intent_document: {
    B:
      'Documentation task detected. Follow these steps:\n' +
      'Step 1: Read the relevant source code / feature to understand behavior.\n' +
      'Step 2: Write clear, structured Markdown.\n' +
      'Step 3: Verify formatting renders correctly.',
    A:
      'Documentation protocol REQUIRED.\n' +
      'MUST read source code first to verify behavior.\n' +
      'MUST produce correct, structured Markdown.\n' +
      'MUST review output format before finishing.',
  },
};

const INTENT_LEVEL_PREFIX: Record<string, string> = {
  intent_fix_bug: 'intent_fix_bug',
  intent_refactor: 'intent_refactor',
  intent_add_feature: 'intent_add_feature',
  intent_review: 'intent_review',
  intent_research: 'intent_research',
  intent_document: 'intent_document',
};

export class IntentInjector extends DynamicInjector {
  override readonly injectionVariant = 'intent_guidance';

  get name(): string { return 'intent_guidance'; }
  get description(): string { return '基于意图检测注入行为指导 (B/A 级)'; }
  get priority(): number { return 75; }

  override getResidualConfig(): ResidualConfig {
    // 每轮最多注入一次，不参与步级竞争
    return { weight: 100, decayPerStep: 0, threshold: 0, minStepGap: 0 };
  }

  protected override getInjection(): string | undefined {
    const ctx = this._lastInjectContext;
    if (!ctx?.intentPhase) return undefined;

    const parts = ctx.intentPhase.split(':');
    const variant: string = parts[0] ?? '';
    const level = (parts[1] || 'normal') as 'normal' | 'critical';

    const guidance = INTENT_GUIDANCE[variant as keyof typeof INTENT_GUIDANCE];
    if (!guidance) return undefined;

    return guidance[level] ?? undefined;
  }
}
