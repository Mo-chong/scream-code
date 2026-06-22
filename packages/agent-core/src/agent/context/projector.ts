import type { ContentPart, Message, TextPart } from '@scream-cli/ltod';

import type { ContextMessage } from './types';

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
 * injections. Strict providers (e.g. DeepSeek V4 Flash) reject
 * requests where a user message appears between an assistant's
 * `tool_calls` and the matching `tool` results.
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

    const toolCallIds = new Set(message.toolCalls.map((tc) => tc.id));
    const segmentTools: ContextMessage[] = [];
    const segmentOthers: ContextMessage[] = [];
    let j = i + 1;

    for (; j < history.length; j += 1) {
      const next = history[j]!;
      if (next.role === 'assistant') break;

      if (
        next.role === 'tool' &&
        next.toolCallId !== undefined &&
        toolCallIds.has(next.toolCallId)
      ) {
        segmentTools.push(next);
      } else {
        segmentOthers.push(next);
      }
    }

    result.push(message);
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
