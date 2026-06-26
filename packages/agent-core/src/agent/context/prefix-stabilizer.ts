import type { ContentPart, TextPart } from '@scream-code/ltod';

import type { ContextMessage } from './types';

/**
 * Volatile-field patterns that change every request turn and break the
 * KV-cache prefix if embedded in cached content (system prompt, tools).
 *
 * Each regex matches a specific, machine-generated pattern — low risk of
 * false-positives on user-authored content.
 */
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Replace volatile runtime fields (ISO timestamps, UUIDs) in system-role
 * messages with fixed placeholders so the cache prefix is byte-identical
 * across turns.
 *
 * Only targets `role === 'system'` messages — these are the ones that
 * contribute to the cache prefix on providers that embed the system prompt
 * into the messages array (OpenAI, Gemini). For Anthropic-style APIs where
 * the system prompt is a separate parameter, apply `stabilizeSystemPrompt()`
 * to the prompt string directly.
 *
 * Pure function — does not mutate the input.
 */
export function stabilizePrefix(
  messages: readonly ContextMessage[],
): ContextMessage[] {
  return messages.map((msg) => {
    if (msg.role !== 'system') return msg;
    return {
      ...msg,
      content: msg.content.map((part) => {
        if (part.type !== 'text') return part;
        const text = (part as TextPart).text
          .replace(TIMESTAMP_RE, '[timestamp]')
          .replace(UUID_RE, '[uuid]');
        if (text === (part as TextPart).text) return part;
        return { ...(part as TextPart), text };
      }),
    };
  });
}

/**
 * Stabilize a standalone system prompt string (for Anthropic-style APIs
 * where the system prompt is a separate parameter, not a message).
 */
export function stabilizeSystemPrompt(prompt: string): string {
  return prompt
    .replace(TIMESTAMP_RE, '[timestamp]')
    .replace(UUID_RE, '[uuid]');
}
