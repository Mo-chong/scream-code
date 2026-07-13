import type { Message } from '@scream-code/ltod';
import { flags } from '../flags';

/**
 * A recoverable record for a masked tool result.
 * Generated when maskToolObservations masks a tool result, containing enough
 * info for ActiveSummaryInjector (Phase39b) to create a human-readable summary
 * and for the model to call archive_recover(key) to retrieve the full content.
 */
export interface RecoverableRecord {
  /** ContentArchive key, e.g. 'tool:' + toolCallId (matches context/index.ts format). */
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

/**
 * Build natural-language replacement for a masked tool result.
 *
 * Produces AI-readable text that describes what the tool returned and how to
 * retrieve the full content. No opaque markers like [已遮蔽] — the model
 * can immediately understand the summary and act on it.
 */
function buildMaskContent(
  toolCallId?: string,
  toolNameMap?: ReadonlyMap<string, string>,
  summary?: string,
): string {
  const toolName = toolCallId ? toolNameMap?.get(toolCallId) : undefined;
  const key = toolCallId ? `tool:${toolCallId}` : '';

  // Best case: we have tool name AND a content summary
  if (toolName && key && summary) {
    return `${toolName} 返回 ${summary}。完整内容已存档，可调用 archive_recover("${key}") 取回全文。`;
  }
  // Partial: tool name only
  if (toolName && key) {
    return `${toolName} 已执行。完整内容已存档，可调用 archive_recover("${key}") 取回全文。`;
  }
  // Fallback: just the key
  if (key) {
    return `工具结果已存档，可调用 archive_recover("${key}") 取回全文。`;
  }
  // No identifiers at all
  return '工具结果已存档，可调用 archive_recover 取回全文。';
}

function getContentText(msg: Message): string {
  if (!msg.content) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((p: any) => ('text' in p ? p.text : '')).join('\n');
  }
  return '';
}

/**
 * Generate a semantic summary of a tool result, prioritizing high-value lines.
 *
 * Strategy: find lines containing function/export/class/route definitions
 * and their surrounding context. Falls back to first lines when no semantic
 * pattern is found. Caps at 400 chars.
 *
 * Short results (< 100 chars) are not masked elsewhere, so this only
 * runs on longer content that genuinely needs summarisation.
 */
function generateSummary(msg: Message): string {
  const raw = getContentText(msg);
  if (raw.length <= 400) return raw.replace(/\s+/g, ' ').trim();

  // Split into lines for semantic analysis (preserve original line structure)
  const lines = raw.split('\n');

  // Priority patterns: lines that carry semantic weight in code/text
  const KEY_PATTERN = /^\s*(export\s+|function\s+|const\s+|let\s+|var\s+|class\s+|interface\s+|type\s+|def\s+|return\s+|import\s+.*from\s|@\w+\s|app\.\w+|router\.\w+|async\s+|await\s+)/;

  const selectedLines: string[] = [];
  const addedIndices = new Set<number>();

  for (let i = 0; i < lines.length && selectedLines.length < 15; i++) {
    const line = lines[i];
    if (!line) continue;
    if (KEY_PATTERN.test(line)) {
      // Add preceding non-empty line if it's context (comment or annotation)
      const prev = i > 0 ? lines[i - 1] : undefined;
      if (prev && !addedIndices.has(i - 1) && prev.trim().length > 0) {
        selectedLines.push(prev.trim().slice(0, 80));
        addedIndices.add(i - 1);
      }
      // Add the key line itself
      selectedLines.push(line.trim().slice(0, 120));
      addedIndices.add(i);
      // Add next line if it's not blank (code continuation)
      const next = i + 1 < lines.length ? lines[i + 1] : undefined;
      if (next && next.trim() && !addedIndices.has(i + 1)) {
        selectedLines.push(next.trim().slice(0, 100));
        addedIndices.add(i + 1);
      }
    }
  }

  // If we found semantic content, build summary from it
  if (selectedLines.length > 0) {
    let summary = selectedLines.join(' | ').trim();
    if (summary.length > 400) summary = summary.slice(0, 397) + '...';
    return summary;
  }

  // Fallback: first non-empty lines (current behavior)
  const firstLines = lines.map(l => l.trim()).filter(Boolean).slice(0, 5);
  const fallback = firstLines.join(' ').replace(/\s+/g, ' ').trim();
  return fallback.length <= 400 ? fallback : fallback.slice(0, 397) + '...';
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

  // ── 找"当前轮"边界 + 步数感知保护 ──
  // 最后一条 assistant(toolCalls) 之后的结果默认不遮蔽，
  // 但最多只保护最后 protectedLimit 个，防止大任务中较早结果不释放
  let currentRoundStart = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      currentRoundStart = i;
      break;
    }
  }
  // ── 收集所有 tool result 索引（短输出保护） ──
  const allIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m !== undefined && m.role === 'tool') {
      if (m.content) {
        const text = getContentText(m);
        if (text.length < 100) continue;
      }
      allIndices.push(i);
    }
  }
  // 步数感知：当前轮结果超过 5 时，较早的降级给历史轮遮蔽
  const currentRoundAll = currentRoundStart >= 0
    ? allIndices.filter((i) => i > currentRoundStart)
    : [];
  const protectedLimit = k + 2; // keepLastN + 2, auto-adjusts with flag
  const deferredToOld = currentRoundAll.length > protectedLimit
    ? currentRoundAll.slice(0, currentRoundAll.length - protectedLimit)
    : [];
  const currentRoundSet = new Set(
    currentRoundAll.slice(deferredToOld.length),
  );
  // 降级的当前轮结果加入历史轮，受 keepLastN 遮蔽
  const oldIndices = currentRoundStart >= 0
    ? allIndices.filter((i) => i <= currentRoundStart || deferredToOld.includes(i))
    : allIndices;

  // 只对历史轮应用 keepLastN
  const cutoff = oldIndices.length - k;
  if (cutoff <= 0 && currentRoundSet.size === 0) {
    return { messages: [...messages], recoverable: [] };
  }

  const maskSet = new Set(oldIndices.slice(0, Math.max(0, cutoff)));
  const recoverable: RecoverableRecord[] = [];

  const result = messages.map((msg, i) => {
    if (msg === undefined || msg.role !== 'tool' || !maskSet.has(i)) return msg;
    const summary = generateSummary(msg); // compute once, use twice
    if (msg.toolCallId) {
      const toolName = toolNameMap?.get(msg.toolCallId);
      recoverable.push({
        key: 'tool:' + msg.toolCallId,
        toolCallId: msg.toolCallId,
        toolName: toolName || 'unknown',
        summary,
        priority: inferPriority(toolName),
      });
    }
    const maskText = buildMaskContent(msg.toolCallId, toolNameMap, summary);
    return { ...msg, content: [{ type: 'text' as const, text: maskText }] };
  });

  return { messages: result, recoverable };
}