import type { Message } from '@scream-code/ltod';
import { flags } from '../flags';

function getMaskText(toolCallId?: string, toolNameMap?: ReadonlyMap<string, string>): string {
  const toolName = toolCallId ? toolNameMap?.get(toolCallId) : undefined;
  if (toolName) {
    return `[Observation masked (${toolName}) — tool may be re-invoked if needed]`;
  }
  return '[Old tool output: obscured — tool may be re-invoked if needed]';
}

/**
 * Replace old tool result content with a placeholder, keeping the last
 * `keepLastN` results intact so the model's current tool exchange is not
 * disrupted.
 *
 * Operates on the projected message list (post-compaction) just before the
 * provider call, so it does not affect `context.history` — the original
 * results are preserved for the next micro-compaction or undo.
 *
 * Short tool results (< 100 chars) are never masked to preserve small confirmations.
 * Sets the display name from the assistant's tool name if provided via toolNameMap.
 *
 * Pure function — does not mutate the input.
 */
export function maskToolObservations(
  messages: readonly Message[],
  keepLastN?: number,
  toolNameMap?: ReadonlyMap<string, string>,
): Message[] {
  const k = keepLastN ?? flags.asNumber('mask.keepLastN') ?? 3;
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m !== undefined && m.role === 'tool') {
      // 短输出保护：< 100 chars 不遮蔽
      if (m.content) {
        const text =
          typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p: any) => ('text' in p ? p.text : '')).join('')
              : '';
        if (text.length < 100) continue; // 保留短输出
      }
      indices.push(i);
    }
  }

  const cutoff = indices.length - k;
  if (cutoff <= 0) return [...messages];

  const keep = new Set(indices.slice(cutoff));
  return messages.map((msg, i) => {
    if (msg === undefined || msg.role !== 'tool' || keep.has(i)) return msg;
    const maskText = getMaskText(msg.toolCallId, toolNameMap);
    return { ...msg, content: [{ type: 'text' as const, text: maskText }] };
  });
}
