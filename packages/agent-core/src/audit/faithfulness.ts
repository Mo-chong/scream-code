/**
 * FaithfulnessCheck — 被动忠实性检测
 *
 * 不注入 prompt，不打断 AI。在 handleAfterStep 中读取上一步的推理文本和实际工具调用，
 * 检测"推理→行动"之间是否有明确不一致。
 *
 * 设计原则：
 *   - 只检测**明确**不一致（高精度、低召回）。宁可漏报，不误报。
 *   - 不消耗 context token，不修改 prompt
 *   - 结果记录在 event-log 中，供 QualityScore 聚合
 */

/** 推理动词 → 期望的工具名 */
const ACTION_MAP: Array<{ verbs: RegExp; tools: string[]; desc: string }> = [
  { verbs: /\b(read|look\s+at|open|check\s+content|查看|读取)\b/i, tools: ['Read'], desc: 'read' },
  { verbs: /\b(search|find|grep|look\s+up|查找|搜索)\b/i, tools: ['Grep', 'mcp__anysearch__search', 'WebSearch'], desc: 'search' },
  { verbs: /\b(edit|change|modify|replace|update|改写|更新|修改|编辑)\b/i, tools: ['Edit', 'Write'], desc: 'edit' },
  { verbs: /\b(explore|codegraph|symbol|调用图|call\s*graph)\b/i, tools: ['codegraph_node', 'codegraph'], desc: 'explore' },
  { verbs: /\b(compile|build|test|构建|测试|verify)\b/i, tools: ['Bash'], desc: 'build' },
  { verbs: /\b(run|execute|bash|shell|执行|运行)\b/i, tools: ['Bash'], desc: 'run' },
];

export interface FaithfulnessResult {
  consistent: boolean;
  /** 不匹配详情。consistent=true 时为空数组 */
  mismatches: FaithfulnessMismatch[];
  /** 该步的推理摘要（前 80 字） */
  reasoningPreview: string;
}

interface FaithfulnessMismatch {
  desc: string;
  verb: string;       // 匹配到的动词
  expectedTools: string[];
  actualTools: string[];
}

/**
 * 检查上一步的推理文本是否与实际的工具调用一致。
 *
 * @param reasoningText 上一步 AI 输出的推理文本（assistant 消息内容）
 * @param toolCounts    上一步实际调用的工具名→次数映射
 * @returns FaithfulnessResult
 */
export function checkFaithfulness(
  reasoningText: string,
  toolCounts: Record<string, number>,
): FaithfulnessResult {
  if (!reasoningText || Object.keys(toolCounts).length === 0) {
    return { consistent: true, mismatches: [], reasoningPreview: '' };
  }

  const actualToolNames = Object.keys(toolCounts);
  const mismatches: FaithfulnessMismatch[] = [];
  const reasoningPreview = reasoningText.slice(0, 80).replace(/\s+/g, ' ').trim();

  for (const entry of ACTION_MAP) {
    const match = reasoningText.match(entry.verbs);
    if (!match) continue;

    // 检查是否有期望的工具被实际调用
    const hasExpectedTool = entry.tools.some(t => actualToolNames.some(a => a.includes(t) || t.includes(a)));

    if (!hasExpectedTool) {
      mismatches.push({
        desc: entry.desc,
        verb: match[0],
        expectedTools: entry.tools,
        actualTools: actualToolNames,
      });
    }
  }

  return {
    consistent: mismatches.length === 0,
    mismatches,
    reasoningPreview,
  };
}
