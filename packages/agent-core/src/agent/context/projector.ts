import type { ContentPart, Message, TextPart } from '@scream-code/ltod';

import type { ContextMessage } from './types';

/**
 * Assert the message sequence adheres to the provider wire format.
 * Every `tool` result must have a preceding `assistant` that declared its
 * `toolCallId`, and no `user` message may sit between an `assistant(toolCalls)`
 * and its matching `tool` results.
 *
 * Development builds: throws `ProviderWireError` (fatal — bug in the pipeline).
 * Production builds: logs a warning and returns the original array unchanged
 * (safety net — the projector's own recovery already ran).
 */
/**
 * Check the message sequence for provider wire-format violations.
 * Every `tool` result must have a preceding `assistant` that declared its
 * `toolCallId`, and no `user` message may sit between an `assistant(toolCalls)`
 * and its matching `tool` results.
 *
 * Logs a warning on first violation in each session (noise-bounded).
 * Returns `true` if the sequence is clean, `false` if a violation was found.
 *
 * Does NOT throw or modify the array — the projector already repaired the
 * common cases via `reorderToolResults`. This is a canary for edge cases
 * that slipped through.
 */
export function assertWireFormat(messages: Message[]): boolean {
  let warned = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;

    if (m.role === 'tool') {
      let found = false;
      for (let k = i - 1; k >= 0; k--) {
        const prev = messages[k]!;
        if (prev.role === 'assistant' && prev.toolCalls.some((tc) => tc.id === m.toolCallId)) {
          found = true;
          break;
        }
        if (prev.role === 'assistant') break;
      }
      if (!found && !warned) {
        console.warn(`[projector] Wire warning: tool message (toolCallId=${m.toolCallId}) has no preceding assistant that declared it`);
        warned = true;
      }
      continue;
    }

    if (i + 1 < messages.length && messages[i + 1]!.role === 'tool') {
      if (m.role !== 'assistant' && !warned) {
        console.warn(`[projector] Wire warning: "${m.role}" message immediately precedes a tool result; expected "assistant"`);
        warned = true;
      }
    }
  }
  return !warned;
}

export function project(history: readonly ContextMessage[]): Message[] {
  // Keep partial or empty assistant placeholders away from providers.
  // They can appear when a turn is aborted or errors before any content
  // or tool call is appended.
  const usable = history.filter((message) => {
    return (
      message.partial !== true &&
      !(message.role === 'assistant' && message.content.length === 0 && message.toolCalls.length === 0)
    );
  });
  // A crash mid-tool-execution leaves an assistant message with tool_calls at
  // the tail but no matching tool results — the API rejects this. Drop it.
  const last = usable.at(-1);
  const repaired =
    last?.role === 'assistant' && last.toolCalls.length > 0 ? usable.slice(0, -1) : usable;
  const reordered = reorderToolResults(repaired);
  return mergeAdjacentUserMessages(reordered);
}

/**
 * Reorder messages so that tool results immediately follow their
 * originating assistant message, before any intervening user-role
 * injections. Also drops tool_calls that have no matching tool
 * result in the segment (covering crash / partial replay gaps at
 * any position, not just the trailing edge).
 *
 * Strict providers (e.g. DeepSeek V4 Flash) reject requests where
 * a user message appears between an assistant's `tool_calls` and
 * the matching `tool` results, or where a tool_call has no result.
 */
function reorderToolResults(history: readonly ContextMessage[]): ContextMessage[] {
  const result: ContextMessage[] = [];
  let i = 0;

  while (i < history.length) {
    const message = history[i]!;

    if (message.role !== 'assistant' || message.toolCalls.length === 0) {
      result.push(message);
      i += 1;
      continue;
    }

    // Detect malformed ids (empty or duplicate within this assistant).
    const malformed = new Set<number>();
    const pairedIds = new Set<string>();
    const seenIds = new Set<string>();
    message.toolCalls.forEach((tc, index) => {
      if (tc.id.length === 0) { malformed.add(index); return; }
      if (seenIds.has(tc.id)) { malformed.add(index); return; }
      seenIds.add(tc.id);
    });

    // Scan forward to the next assistant (or end) and collect
    // matching tool results + intervening messages.
    const segmentTools: ContextMessage[] = [];
    const segmentOthers: ContextMessage[] = [];
    let j = i + 1;

    for (; j < history.length; j += 1) {
      const next = history[j]!;
      if (next.role === 'assistant') break;

      if (
        next.role === 'tool' &&
        next.toolCallId !== undefined &&
        seenIds.has(next.toolCallId)
      ) {
        pairedIds.add(next.toolCallId);
        segmentTools.push(next);
      } else {
        segmentOthers.push(next);
      }
    }

    // Build the final toolCalls: keep only non-malformed, paired calls.
    const finalSeen = new Set<string>();
    const valid = message.toolCalls.filter((tc, index) => {
      if (malformed.has(index)) return false;
      if (finalSeen.has(tc.id)) return false;
      finalSeen.add(tc.id);
      return pairedIds.has(tc.id);
    });

    if (valid.length === 0) {
      // Every tool_call is malformed or unpaired – drop the entire
      // assistant, but keep the segment's messages in order.
      result.push(...segmentTools);
      result.push(...segmentOthers);
      i = j;
      continue;
    }

    result.push({ ...message, toolCalls: valid });
    result.push(...segmentTools);
    result.push(...segmentOthers);

    i = j;
  }

  return result;
}

function mergeAdjacentUserMessages(history: readonly ContextMessage[]): Message[] {
  const out: ContextMessage[] = [];
  for (const message of history) {
    const previous = out.at(-1);
    if (
      canMergeUserMessage(message) &&
      previous !== undefined &&
      canMergeUserMessage(previous)
    ) {
      out[out.length - 1] = mergeTwoUserMessages(previous, message);
      continue;
    }
    out.push(message);
  }
  return out.map(stripContextMetadata);
}

function canMergeUserMessage(message: ContextMessage): boolean {
  return message.role === 'user' && message.origin?.kind === 'user';
}

function mergeTwoUserMessages(a: ContextMessage, b: ContextMessage): ContextMessage {
  const aText = extractTextOnly(a);
  const bText = extractTextOnly(b);
  const nonTextParts = [
    ...a.content.filter((p) => p.type !== 'text'),
    ...b.content.filter((p) => p.type !== 'text'),
  ];
  const mergedText: TextPart = { type: 'text', text: `${aText}\n\n${bText}` };
  const content: ContentPart[] = [mergedText, ...nonTextParts];
  return {
    role: 'user',
    content,
    toolCalls: [],
    origin: a.origin,
  };
}

function extractTextOnly(message: Message): string {
  return message.content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

function stripContextMetadata(message: ContextMessage): Message {
  return {
    role: message.role,
    name: message.name,
    content: message.content.map((p) => ({ ...p })) as ContentPart[],
    toolCalls: message.toolCalls.map((tc) => ({ ...tc })),
    toolCallId: message.toolCallId,
    partial: message.partial,
  };
}
