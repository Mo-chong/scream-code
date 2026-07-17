import type { Message } from '@scream-code/ltod';
import { flags } from '../flags';
import { emptyMaskingStats, type MaskingStats } from './masking-stats';

/**
 * SnipHint — 工具声明的输出裁剪策略。
 * 当工具结果需要压缩时，优先使用工具自身的 SnipHint，
 * 而不是基于内容的通用检测。
 */
export interface SnipHint {
  /** 保留头部行数 */
  head?: number;
  /** 保留尾部行数 */
  tail?: number;
  /** 保留头部字符数（非行导向时） */
  headChars?: number;
  /** 保留尾部字符数（非行导向时） */
  tailChars?: number;
}

/**
 * 分层上下文蒸馏（上下文蒸馏塔 — 保真层 + 压缩层）
 * 
 * 对超出 keepLastN 的旧工具结果：
 *   - 错误结果 → 保真层：保留完整，单条预算上限按类型区分
 *   - 成功结果 → 压缩层：替换为一行摘要
 *   - 其余 → 遮蔽
 * 
 * 操作于 projected 消息列表，不改 _history。缓存安全。
 */

const SHORT_OUTPUT_THRESHOLD = 100;

// 保真层单条预算（按类型）
const ERROR_BUDGET: Record<string, number> = {
  compile: 300,   // 编译报错：看到文件+行号+类型描述
  edit: 99999,    // Edit 失败：通常 < 200，不设限
  exit: 300,      // 非零退出：看到命令+exit code+首行摘要
  test: 500,      // 测试失败：需要看到断言差异
  permission: 300, // 权限/拒绝
};

// ─── 工具结果文本提取 ───────────────────────────────────────

function getContentText(content: Message['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => ('text' in p ? p.text : '')).join('');
  }
  return '';
}

// ─── 保真层：错误检测 + 类型判断 ───────────────────────────

type ErrorKind = 'compile' | 'edit' | 'exit' | 'test' | 'permission';

interface ErrorResult {
  kind: ErrorKind;
  budget: number;
}

function classifyError(text: string): ErrorResult | null {
  const lower = text.toLowerCase();

  // 注意：检查顺序很重要——更具体的在前
  if (/old_string not found/i.test(text) || /multiple (matches|occurrences) for/i.test(text)) {
    return { kind: 'edit', budget: ERROR_BUDGET.edit };
  }
  if (/tests? failed|test suite.*failed|expected.*actual|assertion/i.test(lower)) {
    return { kind: 'test', budget: ERROR_BUDGET.test };
  }
  if (/refusing|denied|blocked/i.test(lower)) {
    return { kind: 'permission', budget: ERROR_BUDGET.permission };
  }
  if (/\berror\b/.test(lower) && !/\b0 errors\b/.test(lower) && !/\bno errors\b/.test(lower)) {
    return { kind: 'compile', budget: ERROR_BUDGET.compile };
  }
  if (/command failed with exit code:? [1-9]/i.test(text)) {
    return { kind: 'exit', budget: ERROR_BUDGET.exit };
  }

  return null;
}

// ─── 压缩层：成功摘要 ─────────────────────────────────────

function isSuccessCompressible(text: string): boolean {
  const lower = text.toLowerCase();
  if (/0 errors.*0 warnings|0 warnings.*0 errors/.test(text)) return true;
  if (/compilation complete|build complete/i.test(lower)) return true;
  if (/applied \d+ edit/i.test(text)) return true;
  if (/written successfully|file written|created/i.test(lower)) return true;
  if (/no (matches|references|definition|diagnostics)/i.test(lower)) return true;
  return false;
}

function getCompressedText(text: string, toolName?: string): string {
  if (/0 errors/i.test(text) && /0 warnings/i.test(text)) return 'Build: 0 errors, 0 warnings';
  const editMatch = text.match(/Applied (\d+) edit/i);
  if (editMatch) return `Edit: ${editMatch[1]} edits applied`;
  if (/written successfully|file written|created/i.test(text.toLowerCase())) return 'File written';
  if (/no/i.test(text.toLowerCase())) {
    const kind = text.match(/no (matches|references|definition|diagnostics)/i)?.[1] ?? 'results';
    return `No ${kind}`;
  }
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  const truncated = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
  return `[${toolName ?? 'tool'}] ${truncated}`;
}

// ─── 错误已解决检测（自动降级） ──────────────────────────

/** 从工具结果文本中提取文件路径 */
function extractPath(text: string): string | null {
  // Edit/Bash 输出通常包含文件路径
  const m = text.match(/(?:in|at|for)\s+['\"]?([^'\"\s]+\.[a-zA-Z]{1,4})['\"]?/i);
  return m?.[1] ?? null;
}

/** 从 tool_use block 提取路径（参数中的 path） */
function extractPathFromToolCall(toolCallId: string | undefined, messages: readonly Message[], msgIndex: number): string | null {
  if (!toolCallId) return null;
  // 找到对应的 assistant message
  for (let j = msgIndex - 1; j >= 0; j--) {
    const prev = messages[j];
    if (!prev || prev.role !== 'assistant') continue;
    for (const tc of prev.toolCalls ?? []) {
      if (tc.id !== toolCallId && tc.name !== 'Edit') continue;
      try {
        const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
        if (args?.path) return args.path;
      } catch { /* ignore */ }
    }
  }
  return null;
}

/**
 * 检查在 error index 之后是否有同一路径的成功操作
 */
function isErrorResolved(
  currentText: string,
  currentToolCallId: string | undefined,
  currentIndex: number,
  messages: readonly Message[],
): boolean {
  const path = extractPath(currentText) ?? extractPathFromToolCall(currentToolCallId, messages, currentIndex);
  if (!path) return false;

  // 向后扫描，找同一路径的成功操作
  for (let j = currentIndex + 1; j < messages.length; j++) {
    const later = messages[j];
    if (!later) continue;

    if (later.role === 'tool') {
      const laterText = getContentText(later.content);
      // 同一路径的 Edit 成功 → 已解决
      if (laterText.includes(path) && /applied \d+ edit/i.test(laterText)) return true;
      // 同一路径的 Write 成功 → 已解决
      if (laterText.includes(path) && /written successfully|file written|created/i.test(laterText.toLowerCase())) return true;
    }

    if (later.role === 'assistant') {
      for (const tc of later.toolCalls ?? []) {
        if (tc.name !== 'Edit') continue;
        try {
          const args = typeof tc.arguments === 'string' ? JSON.parse(tc.arguments) : tc.arguments;
          if (args?.path && args.path === path) return true; // 后续有同路径的 Edit 调用 = 已尝试过
        } catch { /* ignore */ }
      }
    }
  }
  return false;
}

// ─── 内容类型检测（结构化内容保护） ───────────────────────

function isStructuredOutput(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { JSON.parse(trimmed); return true; } catch {}
  }
  if (/^```[\w-]*\n/m.test(trimmed)) return true;
  if (/^\|.+\|.+\|\s*$/m.test(trimmed) && /^\|[-\s:]+\|/.test(trimmed)) return true;
  return false;
}

// ─── 遮蔽文本 ──────────────────────────────────────────────

function getMaskText(toolCallId?: string, toolNameMap?: ReadonlyMap<string, string>): string {
  const toolName = toolCallId ? toolNameMap?.get(toolCallId) : undefined;
  const tag = toolName ? `:${toolName}` : '';
  return `[masked${tag}]`;
}

// ─── codegraph 结果定向压缩 ────────────────────────────────

/** 检测是否为 codegraph 工具结果 */
function isCodegraphResult(toolName: string | undefined, text: string): boolean {
  if (toolName?.includes('codegraph')) return true;
  if (/^\*\*Exploration:/m.test(text)) return true;
  return false;
}

/** 压缩 codegraph 结果：保留 L1+L2（摘要+调用关系），去掉 L3 源码块
 *
 * codegraph 三层架构:
 *   L1(文件/符号索引) + L2(调用关系) 在第1个 ``` 前
 *   L3(源码块) 在第1个 ``` 后 — 有意设计的可裁剪内容，需时重新查询
 */
function getCodegraphSummary(text: string): string {
  const codeBlockStart = text.indexOf('\n```');
  if (codeBlockStart === -1) return text; // 纯文本，无 L3 需裁剪
  const l1l2 = text.slice(0, codeBlockStart).trim();
  return l1l2 || text; // L1+L2 为空时保全文（极少发生）
}

// ─── 入口 ─────────────────────────────────────────────────

/**
 * Apply a tool-declared SnipHint to truncate long output.
 * If no SnipHint declared, returns undefined — fall through to content-based masking.
 */
function snipByHint(text: string, hint: SnipHint | undefined): string | undefined {
  if (!hint) return undefined;
  const lines = text.split('\n');
  if (hint.head !== undefined && hint.tail !== undefined && lines.length > hint.head + hint.tail) {
    return [...lines.slice(0, hint.head), `... ${lines.length - hint.head - hint.tail} lines omitted`, ...lines.slice(-hint.tail)].join('\n');
  }
  if (hint.headChars !== undefined && hint.tailChars !== undefined && text.length > hint.headChars + hint.tailChars + 20) {
    return text.slice(0, hint.headChars) + '\n[content truncated - use Read to re-read if needed]\n' + text.slice(-hint.tailChars);
  }
  return undefined;
}

export function maskToolObservations(
  messages: readonly Message[],
  keepLastN?: number,
  toolNameMap?: ReadonlyMap<string, string>,
  snipHints?: ReadonlyMap<string, SnipHint>,
): { messages: Message[]; stats: MaskingStats } {
  const k = keepLastN ?? flags.asNumber('mask.keepLastN') ?? 3;
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m !== undefined && m.role === 'tool') {
      const text = getContentText(m.content);
      if (text.length < SHORT_OUTPUT_THRESHOLD) continue;
      indices.push(i);
    }
  }

  const cutoff = indices.length - k;
  if (cutoff <= 0) return { messages: [...messages], stats: emptyMaskingStats() };

  const stats: MaskingStats = { total: 0, preservedError: 0, resolvedError: 0, preservedStructured: 0, compressed: 0, snipped: 0, fullyMasked: 0, bytesSaved: 0, codegraphStripped: 0 };
  const keep = new Set(indices.slice(cutoff));
  const result = messages.map((msg, i) => {
    if (msg === undefined || msg.role !== 'tool' || keep.has(i)) return msg;
    stats.total++;

    const text = getContentText(msg.content);
    const origLen = text.length;
    const toolName = msg.toolCallId ? toolNameMap?.get(msg.toolCallId) : undefined;

    // ★ codegraph 结果定向压缩（先于 isStructuredOutput，避免源码块被结构化保护整段保留）
    if (isCodegraphResult(toolName, text)) {
      const summary = getCodegraphSummary(text);
      if (summary !== text) {
        stats.codegraphStripped++;
        stats.bytesSaved += origLen - summary.length;
        return { ...msg, content: [{ type: 'text' as const, text: summary }] };
      }
    }

    // 保真层：错误 → 保留完整（单条预算上限，已解决降级）
    const error = classifyError(text);
    if (error) {
      // 已解决 → 降级为简短说明
      if (isErrorResolved(text, msg.toolCallId, i, messages)) {
        const path = extractPath(text) ?? extractPathFromToolCall(msg.toolCallId, messages, i) ?? '';
        const resolved = path ? `Edit ${path}: resolved ✓` : 'Error: resolved ✓';
        stats.resolvedError++;
        stats.bytesSaved += origLen - resolved.length;
        return { ...msg, content: [{ type: 'text' as const, text: resolved }] };
      }
      if (text.length <= error.budget) {
        stats.preservedError++;
        return msg;
      }
      const truncated = text.slice(0, error.budget) + '\n[content truncated - use Read to re-read if needed]';
      stats.preservedError++;
      stats.bytesSaved += origLen - truncated.length;
      return { ...msg, content: [{ type: 'text' as const, text: truncated }] };
    }

    // 结构化内容保护：JSON/代码/表格 → 保留完整
    if (isStructuredOutput(text)) {
      stats.preservedStructured++;
      return msg;
    }

    // 压缩层：成功 → 一行摘要
    if (isSuccessCompressible(text)) {
      const summary = getCompressedText(text, toolName);
      stats.compressed++;
      stats.bytesSaved += origLen - summary.length;
      return { ...msg, content: [{ type: 'text' as const, text: summary }] };
    }

    // SnipHint 优先裁剪（工具声明的裁剪策略）
    if (toolName && snipHints) {
      const hint = snipHints.get(toolName) ?? snipHints.get('_default');
      const snipped = snipByHint(text, hint);
      if (snipped !== undefined && snipped !== text) {
        stats.snipped++;
        stats.bytesSaved += origLen - snipped.length;
        return { ...msg, content: [{ type: 'text' as const, text: snipped }] };
      }
    }

    // 遮蔽
    const maskText = getMaskText(msg.toolCallId, toolNameMap);
    stats.fullyMasked++;
    stats.bytesSaved += origLen - maskText.length;
    return { ...msg, content: [{ type: 'text' as const, text: maskText }] };
  });

  return { messages: result, stats };
}
