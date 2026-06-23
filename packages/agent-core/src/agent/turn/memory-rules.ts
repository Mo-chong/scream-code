/**
 * MemoryRulesInjector — 记忆主动注入：场景匹配时注入自定义规则记忆。
 *
 * 从记忆系统中搜索 tags 含 'behavior-rule' 的记忆，命中后
 * 以 system_trigger 注入到上下文。
 *
 * 纯度保证：只注入用户手动写的规则记忆（tags.includes('behavior-rule')），
 * 不注入 AI 自动存储的经验记忆。
 */

import type { MemoryMemo, MemoryMemoStore } from '@scream-code/memory';

/** 注入文本长度上限（token 估算） */
const MAX_INJECTION_LENGTH = 600;

/**
 * 在记忆系统中搜索最匹配当前场景的行为规则记忆。
 *
 * @param store     记忆存储（主 agent 有，sub agent 可能 undefined）
 * @param query     搜索关键词（来自用户输入或场景检测）
 * @param limit     最多返回条数（默认 1）
 * @returns         匹配的行为规则记忆列表（已按 tag 过滤）
 */
export async function searchBehaviorRules(
  store: MemoryMemoStore | undefined,
  query: string,
  limit = 1,
): Promise<MemoryMemo[]> {
  if (!store) return [];

  try {
    const candidates = await store.search(query, { candidateLimit: 20 });
    const rules = candidates.filter(
      (m) => m.tags?.includes('behavior-rule'),
    );
    return rules.slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * 格式化规则记忆为注入文本。
 *
 * @example
 * ```
 * <system-reminder>
 * 【行为规则】
 * 声称测试通过前必须检查 Bash exit code
 * </system-reminder>
 * ```
 */
export function formatBehaviorRule(memo: MemoryMemo): string {
  let text = '【行为规则】\n';
  text += memo.userNeed;
  if (memo.approach) {
    text += '\n' + memo.approach;
  }
  // 截断过长文本
  if (text.length > MAX_INJECTION_LENGTH) {
    text = text.slice(0, MAX_INJECTION_LENGTH) + '…';
  }
  return text;
}

/**
 * 检测用户输入/当前场景是否命中场景关键词，返回搜索 query。
 *
 * @param userInput 用户输入文本
 * @returns 场景 search query，无匹配时返回 undefined
 */
export function detectSceneQuery(userInput: readonly { type: string; text?: string }[]): string | undefined {
  const text = userInput.map(c => c.type === 'text' ? (c.text ?? '') : '').join(' ');

  if (/测试|验证|typecheck|test|verify|lint/i.test(text)) return '测试 验证 typecheck';
  if (/修改|编辑|函数|API|重构|添加|更新|删除/i.test(text)) return '修改 编辑 函数 调用方';
  if (/搜索|查找|查|grep|glob|read/i.test(text)) return '搜索 查看 证据';
  if (/交付|提价|发布|合并|合并请求/i.test(text)) return '交付 完成 端到端';
  if (/写|写入|文件/i.test(text)) return '写文件 大文件 审查';

  return undefined;
}
