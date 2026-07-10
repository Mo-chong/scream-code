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
  + 'Produce at most 6 scannable bullet points of concrete actions.\n'
  + 'Rules:\n'
  + '1. Start each bullet with an emoji: 📖 readFile  ✏️ edit  ✅ verify  📦 install  🚀 run  🔧 config  ❌ error\n'
  + '2. Include step number, e.g. "step 5"\n'
  + '3. Keep each bullet under 80 chars\n'
  + '4. Collapse repeated edits on the same file into one line: "edit server.ts (3×)"\n'
  + '5. Merge with the existing summary below. Keep the 6 most recent items.\n'
  + '6. Output ONLY the bullet list, no commentary.\n'
  + '\n'
  + 'Format:\n'
  + '  📖 step 5: readFile user.ts\n'
  + '  ✏️ step 12: edit server.ts port 3000→4000\n'
  + '  ✅ step 14: verify curl → 200';

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
    .map((text, i) => `[step ${stepOffset + i}] ${text.slice(0, 300)}`)
    .join('\n');

  let userContent = '# Recent steps\n' + lines;
  if (existingSummary) {
    userContent += '\n\n# Existing summary (merge, keep 6 most recent)\n' + existingSummary;
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
