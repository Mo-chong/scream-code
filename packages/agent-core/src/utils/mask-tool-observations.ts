import type { Message } from '@scream-code/ltod';
import { flags } from '../flags';

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

// ─── 遮蔽文本 ──────────────────────────────────────────────

function getMaskText(toolCallId?: string, toolNameMap?: ReadonlyMap<string, string>): string {
  const toolName = toolCallId ? toolNameMap?.get(toolCallId) : undefined;
  const tag = toolName ? `:${toolName}` : '';
  return `[masked${tag}]`;
}

// ─── 入口 ─────────────────────────────────────────────────

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
      const text = getContentText(m.content);
      if (text.length < SHORT_OUTPUT_THRESHOLD) continue;
      indices.push(i);
    }
  }

  const cutoff = indices.length - k;
  if (cutoff <= 0) return [...messages];

  const keep = new Set(indices.slice(cutoff));
  return messages.map((msg, i) => {
    if (msg === undefined || msg.role !== 'tool' || keep.has(i)) return msg;

    const text = getContentText(msg.content);
    const toolName = msg.toolCallId ? toolNameMap?.get(msg.toolCallId) : undefined;

    // 保真层：错误 → 保留完整（单条预算上限）
    const error = classifyError(text);
    if (error) {
      if (text.length <= error.budget) return msg;
      const truncated = text.slice(0, error.budget) + '\n[content truncated - use Read to re-read if needed]';
      return { ...msg, content: [{ type: 'text' as const, text: truncated }] };
    }

    // 压缩层：成功 → 一行摘要
    if (isSuccessCompressible(text)) {
      const summary = getCompressedText(text, toolName);
      return { ...msg, content: [{ type: 'text' as const, text: summary }] };
    }

    // 遮蔽
    const maskText = getMaskText(msg.toolCallId, toolNameMap);
    return { ...msg, content: [{ type: 'text' as const, text: maskText }] };
  });
}
