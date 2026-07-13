import type { Message } from '@scream-code/ltod';
import { flags } from '../flags';

/**
 * A recoverable record for a masked tool result.
 * Generated when maskToolObservations masks a tool result, containing enough
 * info for ActiveSummaryInjector (Phase39b) to create a human-readable summary
 * and for the model to call archive_recover(key) to retrieve the full content.
 */
export interface RecoverableRecord {
  /** ContentArchive key, e.g. 'micro:' + toolCallId (matches micro.ts format). */
  key: string;
  /** toolCallId of the masked message. */
  toolCallId: string;
  /** Tool display name (e.g. 'Read', 'Bash', 'Grep'). */
  toolName: string;
  /** Short summary (≤200 chars) of the tool result content. */
  summary: string;
  /**
   * Priority hint for injection ordering.
   * 0=user-interaction, 1=file-ops, 2=api-calls, 3=search, 4=status.
   */
  priority: number;
}

/** Priority constants — ordered by information value. */
const PRIORITY = {
  USER_INTERACTION: 0,
  FILE_OPS: 1,
  API_CALLS: 2,
  SEARCH: 3,
  STATUS: 4,
} as const;

function inferPriority(toolName?: string): number {
  if (!toolName) return PRIORITY.STATUS;
  const n = toolName.toLowerCase();
  if (n === 'askuserquestion') return PRIORITY.USER_INTERACTION;
  if (n === 'bash' || n === 'read' || n === 'edit' || n === 'write') return PRIORITY.FILE_OPS;
  if (n === 'websearch' || n === 'fetch' || n === 'batch_search') return PRIORITY.API_CALLS;
  if (n === 'grep' || n === 'glob' || n === 'search' || n === 'extract') return PRIORITY.SEARCH;
  return PRIORITY.STATUS;
}

function getMaskText(toolCallId?: string, toolNameMap?: ReadonlyMap<string, string>): string {
  const toolName = toolCallId ? toolNameMap?.get(toolCallId) : undefined;
  const key = toolCallId ? `micro:${toolCallId}` : '';
  if (toolName && key) {
    return `[已遮蔽·key:${key}·${toolName}·archive_recover可取回]`;
  }
  if (key) {
    return `[已遮蔽·key:${key}·已存档·archive_recover可取回]`;
  }
  return '[已遮蔽·已存档·archive_recover可取回]';
}

function getContentText(msg: Message): string {
  if (!msg.content) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((p: any) => ('text' in p ? p.text : '')).join('\n');
  }
  return '';
}

function generateSummary(msg: Message): string {
  const text = getContentText(msg).replace(/\s+/g, ' ').trim();
  if (text.length <= 200) return text;
  return text.slice(0, 197) + '...';
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
 * Returns both the masked messages and a list of RecoverableRecord for each
 * newly masked tool result, so downstream injectors can build summaries.
 *
 * Pure function — does not mutate the input.
 */
export function maskToolObservations(
  messages: readonly Message[],
  keepLastN?: number,
  toolNameMap?: ReadonlyMap<string, string>,
): { messages: Message[]; recoverable: RecoverableRecord[] } {
  const k = keepLastN ?? flags.asNumber('mask.keepLastN') ?? 3;
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m !== undefined && m.role === 'tool') {
      // 短输出保护：< 100 chars 不遮蔽
      if (m.content) {
        const text = getContentText(m);
        if (text.length < 100) continue; // 保留短输出
      }
      indices.push(i);
    }
  }

  const cutoff = indices.length - k;
  if (cutoff <= 0) return { messages: [...messages], recoverable: [] };

  const keep = new Set(indices.slice(cutoff));
  const recoverable: RecoverableRecord[] = [];

  const result = messages.map((msg, i) => {
    if (msg === undefined || msg.role !== 'tool' || keep.has(i)) return msg;
    // Build recoverable record before masking the content
    if (msg.toolCallId) {
      const toolName = toolNameMap?.get(msg.toolCallId);
      recoverable.push({
        key: 'micro:' + msg.toolCallId,
        toolCallId: msg.toolCallId,
        toolName: toolName || 'unknown',
        summary: generateSummary(msg),
        priority: inferPriority(toolName),
      });
    }
    const maskText = getMaskText(msg.toolCallId, toolNameMap);
    return { ...msg, content: [{ type: 'text' as const, text: maskText }] };
  });

  return { messages: result, recoverable };
}

/**
 * After masking, merge old tool-call + tool-result pairs into single assistant messages.
 *
 * For assistant messages with toolCalls outside the keep window where ALL of their
 * corresponding tool results have been masked:
 * - Merge the tool call descriptions + masked result markers into assistant content
 * - Remove the toolCalls array
 * - Remove the corresponding tool result messages
 *
 * This runs AFTER maskToolObservations, so it sees already-masked tool results.
 * It cuts the message count nearly in half for old turns, improving AI attention.
 *
 * Pure function — does not mutate the input.
 */
export function mergeOldToolPairs(
  messages: readonly Message[],
  keepLastNPairs?: number,
): Message[] {
  const k = keepLastNPairs ?? 3;

  // Step 1: Identify all assistant(toolCalls) → tool result pairs
  type Pair = { asstIdx: number; toolCallIds: string[]; toolResultIdxs: number[] };
  const pairs: Pair[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== 'assistant' || !m.toolCalls?.length) continue;

    const toolCallIds = m.toolCalls
      .map((tc: any) => tc?.id ?? tc?.toolUseId ?? '')
      .filter(Boolean);
    if (toolCallIds.length === 0) continue;

    // Find matching tool results that follow this message
    const toolResultIdxs: number[] = [];
    for (let j = i + 1; j < messages.length; j++) {
      const tj = messages[j];
      if (tj?.role !== 'tool') {
        if (tj?.role === 'assistant' && tj.toolCalls?.length) break;
        continue;
      }
      const tid = (tj as any).toolCallId ?? (tj as any).toolUseId ?? '';
      if (toolCallIds.includes(tid)) {
        toolResultIdxs.push(j);
      }
    }

    if (toolResultIdxs.length === toolCallIds.length) {
      // Safety: only merge if ALL tool results are masked
      // Prevents merging active/in-flight exchanges that would break tool protocol
      const allMasked = toolResultIdxs.every(idx => {
        const r = messages[idx];
        return r && getContentText(r).startsWith('[已遮蔽');
      });
      if (allMasked) {
        pairs.push({ asstIdx: i, toolCallIds, toolResultIdxs });
      }
    }
  }

  // Step 2: Keep last K pairs, merge the rest
  const cutoff = pairs.length - k;
  if (cutoff <= 0) return [...messages];

  const mergePairIdxs = new Set(pairs.slice(0, cutoff).map(p => p.asstIdx));
  const mergeToolIdxs = new Set(pairs.slice(0, cutoff).flatMap(p => p.toolResultIdxs));

  // Step 3: Build result
  const result: Message[] = [];
  let i = 0;
  while (i < messages.length) {
    if (mergePairIdxs.has(i)) {
      const pair = pairs.find(p => p.asstIdx === i)!;
      const asstMsg = messages[i]!;

      const lines: string[] = [];
      const contentStr = (asstMsg.content as any) ?? '';
      if (typeof contentStr === 'string' && contentStr.trim()) {
        lines.push(contentStr.trim());
      }

      for (let idx = 0; idx < pair.toolCallIds.length; idx++) {
        const tcId = pair.toolCallIds[idx]!;
        const tc = (asstMsg.toolCalls as any[])?.find((t: any) => (t?.id ?? t?.toolUseId) === tcId);
        const tcName = tc?.name ?? 'tool';
        const tcArgs = (tc?.args as any) ? JSON.stringify(tc.args).slice(0, 120) : '';
        const tResult = messages[pair.toolResultIdxs[idx]!];
        const resultText = tResult ? getContentText(tResult) : '[无结果]';
        lines.push(`调用 ${tcName}(${tcArgs}) → ${resultText}`);
      }

      result.push({ ...asstMsg, content: [{ type: 'text' as const, text: lines.join('\n') }], toolCalls: [] } as unknown as Message);
      i++;
      while (i < messages.length && mergeToolIdxs.has(i)) i++;
    } else if (mergeToolIdxs.has(i)) {
      i++;
    } else {
      result.push(messages[i]!);
      i++;
    }
  }

  return result;
}
