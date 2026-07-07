import type { Message } from '@scream-code/ltod';

const MASK_TEXT = '[Old tool output: obscured — tool may be re-invoked if needed]';

/**
 * Replace old tool result content with a placeholder, keeping the last
 * `keepLastN` results intact so the model's current tool exchange is not
 * disrupted.
 *
 * Operates on the projected message list (post-compaction) just before the
 * provider call, so it does not affect `context.history` — the original
 * results are preserved for the next micro-compaction or undo.
 *
 * Pure function — does not mutate the input.
 */
export function maskToolObservations(
  messages: readonly Message[],
  keepLastN: number = 3,
): Message[] {
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m !== undefined && m.role === 'tool') indices.push(i);
  }

  const cutoff = indices.length - keepLastN;
  if (cutoff <= 0) return [...messages];

  const keep = new Set(indices.slice(cutoff));
  return messages.map((msg, i) => {
    if (msg === undefined || msg.role !== 'tool' || keep.has(i)) return msg;
    return { ...msg, content: [{ type: 'text' as const, text: MASK_TEXT }] };
  });
}
