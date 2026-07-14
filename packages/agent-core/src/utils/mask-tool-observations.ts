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
 * 字节级恒定遮蔽文本 — 所有工具遮蔽后输出完全相同。
 *
 * DeepSeek KV Cache 要求前缀完整字节匹配。旧版 buildMaskContent 每步生成
 * 不同的 {toolName} 返回 {summary} → 公共前缀无法落盘 → 缓存率 2.2%。
 * 任何包含变量（工具名、key、摘要）的格式都会导致缓存断裂。
 *
 * AI 看到 role:tool 已知这是工具结果，此文本仅作"已执行+去尾部索引区"
 * 的确认信号。详情与取回KEY 统一在尾部 <masked-tools> 索引区呈现。
 */
const MASKED_TOOL_TEXT = '此工具结果已执行。完整结果见消息尾部 <masked-tools> 索引区（含每步取回KEY）。archive_recover(KEY) 可取回完整内容。';

function buildMaskContent(): string {
  return MASKED_TOOL_TEXT;
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
/** 缓存已生成的摘要（key=toolCallId）——跨步不重算 */
const _summaryCache = new Map<string, string>();

function generateSummary(msg: Message): string {
  const raw = getContentText(msg);
  // 短内容直接返回原文（不足100字符不会被遮蔽）
  if (raw.length <= 100) return raw.replace(/\s+/g, ' ').trim();
  // 已遮蔽：直接复用已有文本（不变 = 缓存稳定）
  if (raw.includes('archive_recover(')) {
    return raw.replace(/\s+/g, ' ').trim();
  }

  // 摘要缓存：相同原始内容输出相同摘要
  if (msg.toolCallId) {
    const cached = _summaryCache.get(msg.toolCallId);
    if (cached) return cached;
  }

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
    if (msg.toolCallId) _summaryCache.set(msg.toolCallId, summary);
    return summary;
  }

  // Fallback: first non-empty lines
  const firstLines = lines.map(l => l.trim()).filter(Boolean).slice(0, 5);
  const fallback = firstLines.join(' ').replace(/\s+/g, ' ').trim();
  const result = fallback.length <= 400 ? fallback : fallback.slice(0, 397) + '...';
  if (msg.toolCallId) _summaryCache.set(msg.toolCallId, result);
  return result;
}

// ── L2: 遮蔽索引区格式化 ──

/** 最新 N 条详细索引行的窗口大小 */
const TIER1_MAX = 3;

/**
 * 格式化完整 <masked-tools> 索引区块。
 *
 * Tier1: 最新 N 条详细行（当前注意力区）
 * Tier2: 较旧条目的压缩统计行（扫一眼即过，按需取回）
 *
 * 输出字节级前缀缓存（`<masked-tools>` 固定头）稳定命中，
 * 仅 Tier1 数据行尾部少量变化。
 *
 * @param records 全部未过时的 RecoverableRecord（按时间先后排列）
 * @returns 完整的 <masked-tools> 区块文本
 */
export function formatMaskedIndexBlock(records: RecoverableRecord[]): string {
  if (records.length === 0) return '';

  const lines: string[] = [];
  lines.push('<masked-tools>');

  // ── Tier1: 最新 N 条详细 ──
  const tier1 = records.slice(-TIER1_MAX);
  const tier2Count = records.length - tier1.length;

  // 表头（恒定前缀，缓存落盘）
  lines.push('# | 工具 | 状态 | 摘要 | 取回KEY');
  lines.push('--|------|------|------|---------');

  for (const rec of tier1) {
    const truncatedSummary = rec.summary.length > 40
      ? rec.summary.slice(0, 39) + '…'
      : rec.summary;
    lines.push(
      `${rec.priority} | ${rec.toolName} | OK | ${truncatedSummary} | ${rec.key}`,
    );
  }

  // ── Tier2: 旧条目压缩统计 ──
  if (tier2Count > 0) {
    lines.push('');
    lines.push(`前 ${tier2Count} 个工具结果已归档。archive_recover("history") 可取回全部。`);
  }

  // 统一取回指引（恒定文本）
  lines.push('');
  lines.push('使用方法: archive_recover("tool:call_xxx") 可取回对应步骤的完整输出。');

  lines.push('</masked-tools>');
  return lines.join('\n');
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
    const maskText = buildMaskContent();
    return { ...msg, content: [{ type: 'text' as const, text: maskText }] };
  });

  return { messages: result, recoverable };
}