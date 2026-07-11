import type { Message } from '@scream-code/ltod';
import type { LLM } from '../../loop';

/**
 * LLM-based incremental summary extraction.
 *
 * Calls the agent's LLM every ~30 steps to produce a crisp bullet-point
 * summary of what the agent did. The model merges old + new actions,
 * deduplicates, and outputs at most 6 scannable bullets with emojis.
 *
 * Design constraints:
 *  - Must produce text, not tool calls → called without streaming
 *  - Must be cheap → ~$0.105/call (6K in + 200 out), ~$1.16/day at your scale
 *  - Must be readable at a glance → bullets with emojis, S‑level head injection
 */

const SUMMARY_SYSTEM_PROMPT =
  'You are a context summarizer for a coding agent. '
  + 'Produce at most 8 scannable bullet points of concrete actions.\n'
  + 'Rules:\n'
  + '1. Start each bullet with an emoji (priority order): ❌ error/timeout  ✏️ edit  📖 read  🔍 search  🚀 run  🔧 config/tools  🧠 plan  ✅ verify\n'
  + '2. Include step number AND file path, e.g. "step 5" + "turn/index.ts"\n'
  + '3. Keep each bullet under 100 chars\n'
  + '4. Collapse repeated edits on the same file into one line: "edit server.ts (3×)"\n'
  + '5. Merge with the existing summary below. Keep the 8 most recent items.\n'
  + '6. Output ONLY the bullet list, no commentary.\n'
  + '7. CRITICAL: preserve file paths (e.g. turn/index.ts) and success/failure signals\n'
  + '8. CRITICAL: detect direction changes (read-only → writing, searching → editing)\n'
  + '\n'
  + 'Format:\n'
  + '  ❌ step 12: Bash pnpm build → timeout 60s\n'
  + '  ✏️ step 20: Edit turn/index.ts L2053 → add reset\n'
  + '  📖 step 7: Read audit-log.ts → find UTC bug\n'
  + '  🚀 step 25: Bash echo (9 steps, tools)';

/**
 * Ask the LLM to produce an incremental summary of the recent steps.
 * Returns the formatted markdown bullet list, or empty string on failure.
 */
export async function summarizeWithLLM(
  llm: LLM,
  existingSummary: string,
  recentAssistantTexts: string[],
  stepOffset: number,
): Promise<string> {
  const lines = recentAssistantTexts
    .map((text, i) => `[step ${stepOffset + i}] ${text.slice(0, 500)}`)
    .join('\n')
    .slice(0, 4000); // 总输入上限 4000 chars（30 条智能提取绰绰有余）

  let userContent = '# Recent steps\n' + lines;
  if (existingSummary) {
    userContent += '\n\n# Existing summary (merge, keep 6 most recent)\n' + existingSummary.slice(0, 2000);
  }

  let resultText = '';

  await llm.chat({
    messages: [
      { role: 'system' as const, content: [{ type: 'text' as const, text: SUMMARY_SYSTEM_PROMPT }], toolCalls: [] },
      { role: 'user' as const, content: [{ type: 'text' as const, text: userContent }], toolCalls: [] },
    ] as Message[],
    tools: [],
    signal: new AbortController().signal,
    onTextPart: (part) => {
      resultText += part.text;
    },
  });

  return resultText.trim();
}
