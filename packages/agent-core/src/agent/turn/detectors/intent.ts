/**
 * Intent Detector — 回合级用户意图检测。
 *
 * 纯函数。分析 user prompt 文本，返回检测到的意图。
 * 不产生副作用，不依赖注入器。
 *
 * Detection paths:
 * - 无匹配 → null（0 开销）
 * - 检测到意图 → IntentDetection + 建议权重等级
 * - 置信度基于匹配词密度
 *
 * ## 指令权重映射
 *
 * - 低置信度 → B 级（结构化步骤提示）
 * - 高置信度 → A 级（MUST/NEVER 祈使）
 *
 * 意图变体注入后自动参与 VariantRegistry 的质量升级链（C→B→A→S），
 * 因此即使初始为 B 级，后续根据行为观察结果可自动升级。
 */

import type { ContentPart } from '@scream-cli/ltod';
import type { WeightLevel } from '../variant-registry';

// ── 类型 ────────────────────────────────────────────────

export type IntentConfidence = 'low' | 'high';

export interface IntentDetection {
  /** 意图 variant 名，如 'intent_fix_bug' */
  variant: string;
  /** 置信度 */
  confidence: IntentConfidence;
  /** 基于置信度的建议注入权重 */
  weightLevel: WeightLevel;
  /** 注入文本（已按权重级别预制好） */
  guidanceText: string;
  /** 检测原因（用于调试/日志） */
  reason: string;
}

// ── 意图定义 ───────────────────────────────────────────

interface IntentRule {
  variant: string;
  /** 关键词数组，每个独立 regex（无捕获组），.test() 分别检测后计数 */
  keywords: RegExp[];
  /** 高置信度所需的关键词匹配数 */
  highConfidenceThreshold: number;
  /** 排除词：匹配到则不触发 */
  excludePattern?: RegExp;
  /** 高置信度额外信号词 */
  highConfidenceMarkers?: RegExp;
}

const INTENT_RULES: IntentRule[] = [
  {
    variant: 'intent_fix_bug',
    keywords: [
      /\bfix\b/i, /\bbug\b/i, /\berror\b/i, /\bfail(?:ed|ure)?\b/i,
      /\bbroken\b/i, /\bcrash\b/i, /\bincorrect\b/i, /\bwrong\b/i,
      /\bregression\b/i, /\b异常\b/i, /\b修复\b/i, /\b问题\b/i,
    ],
    highConfidenceThreshold: 2,
    highConfidenceMarkers: /\b(reproduc|failing test)/i,
  },
  {
    variant: 'intent_refactor',
    keywords: [
      /\brefactor\b/i, /\brestructur\w*\b/i, /\brewrite\b/i,
      /\bclean up\b/i, /\breorganize\w*\b/i, /\bmodernize\w*\b/i,
      /\bmigrat\w*\b/i, /\b重构\b/i, /\b重写\b/i, /\b整理\b/i,
    ],
    highConfidenceThreshold: 2,
    excludePattern: /\b(test|config|setting|文档|doc)\b/i,
    highConfidenceMarkers: /\b(all callers?|compatibility shim|clean cutover)\b/i,
  },
  {
    variant: 'intent_add_feature',
    keywords: [
      /\badd\b/i, /\bfeature\b/i, /\bnew\b/i, /\bimplement\b/i,
      /\bcreate\b/i, /\bbuild\b/i, /\bintegrate\w*\b/i,
      /\b新功能\b/i, /\b实现\b/i, /\b新增\b/i, /\b添加\b/i,
    ],
    highConfidenceThreshold: 2,
    excludePattern: /\b(test|config|setting)\b/i,
  },
  {
    variant: 'intent_review',
    keywords: [
      /\breview\b/i, /\baudit\b/i, /\bcheck\b/i, /\binspect\b/i,
      /\bscan\b/i, /\b审查\b/i, /\b审计\b/i, /\b检查\b/i,
    ],
    highConfidenceThreshold: 2,
    excludePattern: /\b(fix|refactor|add|implement|create)\b/i,
    highConfidenceMarkers: /\b(only review|read only|examine)\b/i,
  },
  {
    variant: 'intent_research',
    keywords: [
      /\bresearch\b/i, /\binvestigate\b/i, /\bfind out\b/i, /\bexplore\b/i,
      /\blearn about\b/i, /\bsearch for\b/i,
      /\b研究\b/i, /\b调查\b/i, /\b探索\b/i, /\b了解\b/i,
    ],
    highConfidenceThreshold: 2,
    highConfidenceMarkers: /\b(deep dive|thorough|comprehensive|compare|vs\.|versus|trade-offs?)\b/i,
  },
  {
    variant: 'intent_document',
    keywords: [
      /\bdocument\b/i, /\bwrite docs\b/i, /\bexplain\b/i, /\bdocumentation\b/i,
      /\btutorial\b/i, /\breadme\b/i, /\bapi doc\b/i,
      /\b文档\b/i, /\b说明\b/i, /\b教程\b/i,
    ],
    highConfidenceThreshold: 2,
    highConfidenceMarkers: /\b(api reference|user guide|生成文档|写文档)\b/i,
  },
];

// ── B 级注入文本模板 ───────────────────────────────────

const B_LEVEL_GUIDANCE: Record<string, string> = {
  intent_fix_bug:
    '<system-reminder kind="injection" variant="intent_fix_bug">\n' +
    'Bug fix detected. Follow these steps:\n' +
    'Step 1: Write a minimal reproduction test.\n' +
    'Step 2: Confirm the test fails (RED).\n' +
    'Step 3: Fix the code.\n' +
    'Step 4: Confirm the test passes (GREEN).\n' +
    'Step 5: Clean up debug code.\n' +
    '</system-reminder>',

  intent_refactor:
    '<system-reminder kind="injection" variant="intent_refactor">\n' +
    'Refactoring detected. Follow these steps:\n' +
    'Step 1: Use LSP|Grep to find all callers of changed symbols.\n' +
    'Step 2: Edit every caller — no compatibility shims, no deprecated paths.\n' +
    'Step 3: Verify (build/test).\n' +
    '</system-reminder>',

  intent_add_feature:
    '<system-reminder kind="injection" variant="intent_add_feature">\n' +
    'New feature detected. Follow these steps:\n' +
    'Step 1: Read existing files to understand current architecture.\n' +
    'Step 2: Design minimal change — identify files to modify.\n' +
    'Step 3: Implement. Keep changes focused.\n' +
    'Step 4: Verify (build/test).\n' +
    '</system-reminder>',

  intent_review:
    '<system-reminder kind="injection" variant="intent_review">\n' +
    'Review/audit detected. Follow these steps:\n' +
    'Step 1: Read all relevant files first (read-only).\n' +
    'Step 2: Identify issues — bugs, API contract violations, integration risks.\n' +
    'Step 3: Report with code examples for each finding.\n' +
    '</system-reminder>',

  intent_research:
    '<system-reminder kind="injection" variant="intent_research">\n' +
    'Research task detected. Follow these steps:\n' +
    'Step 1: Plan search strategy — what queries, which sources.\n' +
    'Step 2: Execute searches. Collect findings.\n' +
    'Step 3: Synthesize results into a structured answer.\n' +
    '</system-reminder>',

  intent_document:
    '<system-reminder kind="injection" variant="intent_document">\n' +
    'Documentation task detected. Follow these steps:\n' +
    'Step 1: Read the relevant source code / feature to understand behavior.\n' +
    'Step 2: Write clear, structured Markdown.\n' +
    'Step 3: Verify formatting renders correctly.\n' +
    '</system-reminder>',
};

// ── A 级注入文本模板 ───────────────────────────────────

const A_LEVEL_GUIDANCE: Record<string, string> = {
  intent_fix_bug:
    '<system-reminder kind="injection" variant="intent_fix_bug">\n' +
    'Bug fix protocol REQUIRED.\n' +
    'MUST write a reproduction test first (confirm RED).\n' +
    'MUST fix the root cause (not a workaround).\n' +
    'MUST confirm test passes (GREEN).\n' +
    'NEVER fix without a failing test.\n' +
    '</system-reminder>',

  intent_refactor:
    '<system-reminder kind="injection" variant="intent_refactor">\n' +
    'Refactoring protocol REQUIRED.\n' +
    'MUST use LSP|Grep to find ALL callers before changing a symbol.\n' +
    'MUST update every caller — no shims, no deprecated aliases.\n' +
    'MUST verify with build/test after the change.\n' +
    '</system-reminder>',

  intent_add_feature:
    '<system-reminder kind="injection" variant="intent_add_feature">\n' +
    'New feature protocol REQUIRED.\n' +
    'MUST read existing architecture first.\n' +
    'MUST design minimal changes — identify exact files.\n' +
    'MUST verify with build/test after implementation.\n' +
    '</system-reminder>',

  intent_review:
    '<system-reminder kind="injection" variant="intent_review">\n' +
    'Review protocol REQUIRED.\n' +
    'MUST read all relevant files before concluding.\n' +
    'MUST identify concrete issues with code evidence.\n' +
    'NEVER skip files because the pattern seems clear.\n' +
    '</system-reminder>',

  intent_research:
    '<system-reminder kind="injection" variant="intent_research">\n' +
    'Research protocol REQUIRED.\n' +
    'MUST plan search queries before executing.\n' +
    'MUST use diverse sources for verification.\n' +
    'NEVER fabricate findings — each claim needs a source.\n' +
    '</system-reminder>',

  intent_document:
    '<system-reminder kind="injection" variant="intent_document">\n' +
    'Documentation protocol REQUIRED.\n' +
    'MUST read source code first to verify behavior.\n' +
    'MUST produce correct, structured Markdown.\n' +
    'MUST review output format before finishing.\n' +
    '</system-reminder>',
};

// ── 检测主函数 ─────────────────────────────────────────

/**
 * 检测 user prompt 中的意图。
 *
 * 对每条意图规则：
 * 1. 计算关键词匹配数 + 排除词检查
 * 2. 综合判定置信度
 * 3. 选匹配词数最多的意图作为结果
 *
 * @param input - user prompt 的 ContentPart 数组
 * @returns IntentDetection | null（无匹配返回 null）
 */
export function detectIntent(input: readonly ContentPart[]): IntentDetection | null {
  // 只处理 text 类型 part
  const text = input
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join(' ');

  if (!text.trim()) return null;

  let best: IntentDetection | null = null;
  let bestKeywordCount = 0;

  for (const rule of INTENT_RULES) {
    // ── 排除词检查 ──
    if (rule.excludePattern?.test(text)) continue;

    // ── 关键词匹配：每条独立 test() 计数 ──
    let keywordCount = 0;
    for (const kw of rule.keywords) {
      if (kw.test(text)) keywordCount++;
    }
    if (keywordCount === 0) continue;

    // ── 置信度判定 ──
    const hasHighMarkers = rule.highConfidenceMarkers?.test(text) ?? false;
    const isHigh =
      hasHighMarkers || keywordCount >= rule.highConfidenceThreshold;

    const confidence: IntentConfidence = isHigh ? 'high' : 'low';
    const weightLevel: WeightLevel = isHigh ? 'A' : 'B';
    const guidanceText = isHigh
      ? (A_LEVEL_GUIDANCE[rule.variant] ?? '')
      : (B_LEVEL_GUIDANCE[rule.variant] ?? '');

    const markerNote = hasHighMarkers ? ' (high-confidence markers)' : '';
    const reason = `${rule.variant}: matched ${keywordCount} keyword(s)${markerNote}, confidence=${confidence}, weight=${weightLevel}`;

    const detection: IntentDetection = {
      variant: rule.variant,
      confidence,
      weightLevel,
      guidanceText,
      reason,
    };

    // 选匹配词最多的意图
    if (keywordCount > bestKeywordCount) {
      best = detection;
      bestKeywordCount = keywordCount;
    }
  }

  return best;
}
