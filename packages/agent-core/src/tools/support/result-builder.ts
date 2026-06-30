import type {
  ExecutableToolErrorResult,
  ExecutableToolSuccessResult,
} from '../../loop/types';

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_TAIL_CHARS = 20_000;
const DEFAULT_MAX_LINE_LENGTH = 2000;
const TRUNCATION_MARKER = '[...truncated]';
const TRUNCATION_MESSAGE = 'Output is truncated to fit in the message.';

// Regex to match ANSI escape sequences (colors, cursor movement, clear screen, etc.)
const ANSI_ESCAPE_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/**
 * Strip ANSI escape sequences from a string.
 */
function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '');
}

/**
 * Collapse lines that consist only of carriage-return + cursor-move patterns.
 * This handles progress bars (`\r 50%`, `\r 100%`), spinner artifacts, and
 * other overwrite-style terminal output that is meaningless in a final log.
 *
 * Strategy: any line whose visible content (after stripping ANSI) is entirely
 * whitespace or empty after removing trailing `\r` is dropped.
 */
function collapseCarriageReturnLines(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    // Strip ANSI first so we don't mistake colored whitespace for content
    const visible = stripAnsi(line).replace(/\r+$/, '').trim();
    if (visible.length === 0) {
      // Skip lines that were only \r-based overwrites
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Sanitize a command output string: strip ANSI escape sequences and collapse
 * carriage-return-only progress lines.
 */
export function sanitizeOutput(text: string): string {
  const noAnsi = stripAnsi(text);
  return collapseCarriageReturnLines(noAnsi);
}

export interface ToolResultBuilderOptions {
  readonly maxChars?: number;
  readonly maxTailChars?: number;
  readonly maxLineLength?: number | null;
  /** When true, strip ANSI escape sequences and collapse \r-only progress lines on every write(). */
  readonly sanitize?: boolean;
}

export type ExecutableToolResultBuilderResult = (
  | ExecutableToolSuccessResult
  | ExecutableToolErrorResult
) & {
  readonly output: string;
  readonly message: string;
  readonly truncated: boolean;
  readonly brief?: string;
};

export class ToolResultBuilder {
  private readonly maxChars: number;
  private readonly maxTailChars: number;
  private readonly maxLineLength: number | null;

  private readonly buffer: string[] = [];
  private nCharsValue = 0;
  private truncationHappened = false;
  private headTruncated = false;

  private readonly tailBuf: string[] = [];
  private tailCharsValue = 0;

  private readonly sanitizeEnabled: boolean;

  constructor(options: ToolResultBuilderOptions = {}) {
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.maxTailChars = options.maxTailChars ?? DEFAULT_TAIL_CHARS;
    this.maxLineLength =
      options.maxLineLength === undefined ? DEFAULT_MAX_LINE_LENGTH : options.maxLineLength;
    this.sanitizeEnabled = options.sanitize ?? false;

    if (this.maxLineLength !== null && this.maxLineLength <= TRUNCATION_MARKER.length) {
      throw new Error('maxLineLength must be greater than the truncation marker length.');
    }
  }

  get nChars(): number {
    return this.nCharsValue + this.tailCharsValue;
  }

  toString(): string {
    const head = this.buffer.join('');
    if (!this.headTruncated || this.tailCharsValue === 0) {
      return head;
    }
    this.trimTail();
    const tail = this.tailBuf.join('');
    const separator = head.endsWith('\n') ? '' : '\n';
    return `${head}${separator}${TRUNCATION_MARKER}\n${tail}`;
  }

  write(text: string): number {
    if (text.length === 0) return 0;

    // Phase20: strip ANSI + collapse \r-only lines at the builder level
    const cleaned = this.sanitizeEnabled ? sanitizeOutput(text) : text;
    if (cleaned.length === 0) return 0;

    const lines = cleaned.match(/[^\r\n]*(?:\r\n|[\n\r])|[^\r\n]+/g) ?? [];
    if (lines.length === 0) return 0;

    let charsWritten = 0;
    for (const originalLine of lines) {
      if (this.nCharsValue < this.maxChars) {
        const remainingChars = this.maxChars - this.nCharsValue;
        const limit =
          this.maxLineLength === null
            ? remainingChars
            : Math.min(remainingChars, this.maxLineLength);
        let line = originalLine;
        if (line.length > limit) {
          const lineBreak = /[\r\n]+$/.exec(line)?.[0] ?? '';
          const suffix = TRUNCATION_MARKER + lineBreak;
          const effectiveMaxLength = Math.max(limit, suffix.length);
          line = line.slice(0, effectiveMaxLength - suffix.length) + suffix;
          this.truncationHappened = true;
        }

        this.buffer.push(line);
        charsWritten += line.length;
        this.nCharsValue += line.length;
        if (this.nCharsValue >= this.maxChars) {
          this.headTruncated = true;
          this.truncationHappened = true;
        }
      } else {
        this.appendTail(originalLine);
        charsWritten += originalLine.length;
        this.headTruncated = true;
        this.truncationHappened = true;
      }
    }

    return charsWritten;
  }

  private appendTail(text: string): void {
    if (text.length === 0) return;
    if (this.maxTailChars === 0) return;

    if (text.length >= this.maxTailChars) {
      const trimmed = text.slice(-this.maxTailChars);
      this.tailBuf.length = 0;
      this.tailBuf.push(trimmed);
      this.tailCharsValue = trimmed.length;
      return;
    }

    this.tailBuf.push(text);
    this.tailCharsValue += text.length;
    if (this.tailCharsValue > this.maxTailChars * 2) {
      this.trimTail();
    }
  }

  private trimTail(): void {
    if (this.tailCharsValue <= this.maxTailChars) return;
    const joined = this.tailBuf.join('');
    const trimmed = joined.slice(-this.maxTailChars);
    this.tailBuf.length = 0;
    this.tailBuf.push(trimmed);
    this.tailCharsValue = trimmed.length;
  }

  ok(message = '', options: { readonly brief?: string } = {}): ExecutableToolResultBuilderResult {
    let finalMessage = message;
    if (finalMessage.length > 0 && !finalMessage.endsWith('.')) {
      finalMessage += '.';
    }
    if (this.truncationHappened) {
      finalMessage =
        finalMessage.length === 0 ? TRUNCATION_MESSAGE : `${finalMessage} ${TRUNCATION_MESSAGE}`;
    }

    const output = this.toString();
    const shouldAppendMessage =
      finalMessage.length > 0 && (this.truncationHappened || output.length === 0);
    return {
      isError: false,
      output: shouldAppendMessage
        ? output.length === 0
          ? finalMessage
          : output.endsWith('\n')
            ? `${output}${finalMessage}`
            : `${output}\n${finalMessage}`
        : output,
      message: finalMessage,
      truncated: this.truncationHappened,
      brief: options.brief,
    };
  }

  error(
    message: string,
    options: { readonly brief?: string } = {},
  ): ExecutableToolResultBuilderResult {
    const finalMessage = this.truncationHappened
      ? message.length === 0
        ? TRUNCATION_MESSAGE
        : `${message} ${TRUNCATION_MESSAGE}`
      : message;
    const output = this.toString();
    return {
      isError: true,
      output:
        finalMessage.length === 0
          ? output
          : output.length === 0
            ? finalMessage
            : output.endsWith('\n')
              ? `${output}${finalMessage}`
              : `${output}\n${finalMessage}`,
      message: finalMessage,
      truncated: this.truncationHappened,
      brief: options.brief,
    };
  }
}
