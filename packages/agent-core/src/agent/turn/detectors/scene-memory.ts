/**
 * SceneMemoryDetector — 检测用户输入中的"上次/以前"关键词，
 * 判断 AI 是否主动查了记忆。未查时触发 inject。
 *
 * 纯函数。输入用户输入 + 工具调用摘要，输出检测结果。
 */

export interface SceneMemoryIssue {
  /** 用户提到了"上次/以前"等回溯词 */
  readonly hasRecallKeyword: boolean;
  /** AI 本步是否调了 MemoryLookup */
  readonly hasCalledMemoryLookup: boolean;
  /** 是否需要注入提醒 */
  readonly needsReminder: boolean;
}

const RECALL_KEYWORDS = /上次|以前|之前|之前做|之前说过|按照以前的|之前处理|之前遇到过|老办法/i;

/**
 * 检测用户输入中是否有"上次/以前"等回溯关键词，
 * 并结合 AI 是否调了 MemoryLookup 判断是否需要提醒。
 *
 * @param userInput        用户本轮输入文本
 * @param hasMemoryLookup  本步是否调用了 MemoryLookup
 * @returns SceneMemoryIssue
 */
export function detectSceneMemory(
  userInput: string,
  hasMemoryLookup: boolean,
): SceneMemoryIssue {
  const hasRecallKeyword = RECALL_KEYWORDS.test(userInput);
  if (!hasRecallKeyword) {
    return { hasRecallKeyword: false, hasCalledMemoryLookup: false, needsReminder: false };
  }
  // 用户说了"上次"，但 AI 没查记忆 → 需要提醒
  if (!hasMemoryLookup) {
    return { hasRecallKeyword: true, hasCalledMemoryLookup: false, needsReminder: true };
  }
  return { hasRecallKeyword: true, hasCalledMemoryLookup: true, needsReminder: false };
}
