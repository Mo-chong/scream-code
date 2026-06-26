import { ErrorCodes, ScreamError } from '#/errors';
import type { McpServerStdioConfig } from '#/config/schema';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as path from 'node:path';
import { existsSync } from 'node:fs';

import {
  buildRequestOptions,
  SCREAM_MCP_CLIENT_NAME,
  SCREAM_MCP_CLIENT_VERSION,
  toMcpToolDefinition,
  toMcpToolResult,
  type UnexpectedCloseListener,
  type UnexpectedCloseReason,
} from './client-shared';
import type { MCPClient, MCPToolDefinition, MCPToolResult } from './types';

/**
 * Decode a stderr buffer: prefer UTF-8, fall back to GBK on Windows.
 *
 * On Chinese/Japanese/Korean Windows, console output is typically encoded in
 * the system code page (cp936 / shift-jis / euc-kr), not UTF-8.  Guessing the
 * right encoding from node alone is impractical, so we take a pragmatic
 * heuristic: try UTF-8 first; if the result contains replacement characters
 * (U+FFFD, a sign of invalid byte sequences), decode as GBK (the most common
 * non-UTF-8 Windows code page for CJK environments).
 */
function decodeStderr(chunk: Buffer): string {
  if (process.platform !== 'win32') return chunk.toString('utf8');
  const utf8 = chunk.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    return new TextDecoder('gbk').decode(chunk);
  } catch {
    return utf8;
  }
}

/**
 * Normalize a bare command name on Windows so cross-spawn resolves the `.cmd`
 * wrapper instead of the POSIX shebang script.
 *
 * Many npm / pnpm binaries ship three files under the global bin directory:
 *   - `foo`       (POSIX shebang script: `#!/bin/sh`)
 *   - `foo.cmd`   (Windows batch wrapper)
 *   - `foo.ps1`   (PowerShell wrapper)
 *
 * When the MCP config specifies `"command": "foo"` (no extension),
 * cross-spawn's `parseNonShell()` finds the bare `foo` file, reads its
 * shebang (`#!/bin/sh`), resolves `sh` → `/usr/bin/sh` (which has no `.exe`
 * extension in the resolved path), wraps EVERYTHING in `cmd.exe`, and then
 * `cmd.exe` cannot execute the shebang script — producing the misleading
 * "不是内部或外部命令，也不是可运行的程序或批处理文件" error.
 *
 * Only append `.cmd` when a `.cmd` wrapper actually exists in PATH — bare
 * commands like `node` (which resolve to `node.exe`) are left untouched.
 */
function normalizeWinCommand(command: string): string {
  // Only normalize bare names (no path separator, no extension).
  if (command.includes('/') || command.includes('\\')) return command;
  const ext = path.extname(command);
  if (ext.length > 0) return command;
  return findCmdInPath(command) ? command + '.cmd' : command;
}

/** Search PATH for `<command>.cmd`. Returns the full path or undefined. */
function findCmdInPath(command: string): string | undefined {
  const pathDirs = (process.env['PATH'] || '').split(path.delimiter);
  for (const dir of pathDirs) {
    try {
      const cmdPath = path.join(dir, command + '.cmd');
      if (existsSync(cmdPath)) return cmdPath;
    } catch {
      continue;
    }
  }
  return undefined;
}

export interface StdioMcpClientOptions {
  readonly clientName?: string;
  readonly clientVersion?: string;
  readonly toolCallTimeoutMs?: number;
}

const STDERR_BUFFER_CAPACITY = 4 * 1024;

/**
 * Wraps the `@modelcontextprotocol/sdk` stdio client and exposes the small
 * surface required by ltod's {@link MCPClient}. Lifecycle is explicit:
 * the caller must `connect()` before use and `close()` to terminate the
 * child process.
 */
export class StdioMcpClient implements MCPClient {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly toolCallTimeoutMs?: number;
  private readonly stderrBuffer = new BoundedTail(STDERR_BUFFER_CAPACITY);
  private started = false;
  private closed = false;
  // Flips to true only after `client.connect()` resolves AND the caller has
  // not torn things down mid-startup. The `onclose` hook uses this to
  // distinguish "transport died after the handshake" (→ unexpected close)
  // from "transport died during the handshake" (→ `connect()` throws; the
  // manager surfaces the failure via `formatStartupError`).
  private ready = false;
  private hooksInstalled = false;
  private unexpectedCloseListener: UnexpectedCloseListener | undefined;
  private lastTransportError: Error | undefined;
  // Buffered when the transport closes before a listener is installed (e.g.
  // a server that exits seconds after answering `tools/list`). Replayed when
  // `onUnexpectedClose` registers so the close is never silently dropped.
  private pendingUnexpectedClose: UnexpectedCloseReason | undefined;

  /** Capacity (in characters) of the stderr tail captured for diagnostics. */
  static readonly stderrBufferCapacity = STDERR_BUFFER_CAPACITY;

  constructor(config: McpServerStdioConfig, options: StdioMcpClientOptions = {}) {
    if (config.executor !== undefined && config.executor !== 'local') {
      throw new ScreamError(ErrorCodes.NOT_IMPLEMENTED, `MCP stdio executor '${config.executor}' is not yet implemented`);
    }
    const command = process.platform === 'win32' ? normalizeWinCommand(config.command) : config.command;
    this.transport = new StdioClientTransport({
      command,
      args: config.args,
      env: mergeStdioEnv(config.env),
      cwd: config.cwd,
      stderr: 'pipe',
    });
    // `stderr: 'pipe'` means we MUST drain the stream — otherwise the child
    // can block on a full pipe. We also keep the last few KB around so the
    // connection manager can attach it to user-facing failure messages
    // (`Timed out after 30000ms` on its own tells the user nothing).
    this.transport.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrBuffer.push(typeof chunk === 'string' ? chunk : decodeStderr(chunk));
    });
    this.client = new Client({
      name: options.clientName ?? SCREAM_MCP_CLIENT_NAME,
      version: options.clientVersion ?? SCREAM_MCP_CLIENT_VERSION,
    });
    this.toolCallTimeoutMs = options.toolCallTimeoutMs;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('MCP stdio client is closed');
    }
    if (this.started) return;
    this.started = true;
    // Install transport hooks BEFORE the SDK handshake so we never lose an
    // onclose that fires between handshake completion and our wiring. The
    // hooks themselves gate on `this.ready`, so a close that happens DURING
    // the handshake still flows through `client.connect()` rejecting.
    this.installTransportHooks();
    try {
      await this.client.connect(this.transport);
    } catch (error) {
      await this.closeStartedClient();
      throw error;
    }
    if (this.closed) {
      await this.closeStartedClient();
      throw new Error('MCP stdio client was closed during startup');
    }
    this.ready = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.closeStartedClient();
  }

  /**
   * Register a listener that fires when the underlying transport closes on
   * its own — i.e. the caller has not yet invoked {@link close}. At most one
   * listener can be installed; later registrations replace earlier ones.
   * Intentional closes never invoke the listener.
   *
   * If the transport already closed before this method was called, the
   * buffered reason is replayed synchronously so the close is never dropped.
   */
  onUnexpectedClose(listener: UnexpectedCloseListener): void {
    this.unexpectedCloseListener = listener;
    const pending = this.pendingUnexpectedClose;
    if (pending !== undefined) {
      this.pendingUnexpectedClose = undefined;
      listener(pending);
    }
  }

  /**
   * Returns the tail of bytes captured from the child's stderr since spawn.
   * Bounded by {@link StdioMcpClient.stderrBufferCapacity} so a noisy server
   * cannot exhaust memory.
   */
  stderrSnapshot(): string {
    return this.stderrBuffer.snapshot();
  }

  async listTools(): Promise<MCPToolDefinition[]> {
    const result = await this.client.listTools();
    return result.tools.map(toMcpToolDefinition);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolResult> {
    const requestOptions = buildRequestOptions(this.toolCallTimeoutMs, signal);
    const result = await this.client.callTool({ name, arguments: args }, undefined, requestOptions);
    return toMcpToolResult(result);
  }

  private async closeStartedClient(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.client.close();
  }

  private installTransportHooks(): void {
    // Idempotent: `connect()` is the only caller and is itself guarded by
    // `started`, but defending here lets future refactors call this freely.
    if (this.hooksInstalled) return;
    this.hooksInstalled = true;
    // `Client.onclose` fires for THREE situations:
    //   1. The intentional `close()` path → gated by `this.closed`.
    //   2. Transport dying during the SDK handshake → gated by `!this.ready`;
    //      the failure already surfaces via `client.connect()` rejecting, and
    //      `formatStartupError` attaches stderr at the manager layer.
    //   3. Transport dying after the handshake succeeded → the case we care
    //      about: fire or buffer for the manager's watch listener.
    this.client.onclose = () => {
      if (this.closed) return;
      if (!this.ready) return;
      const stderr = this.stderrBuffer.snapshot();
      const reason: UnexpectedCloseReason = {
        error: this.lastTransportError,
        stderr: stderr.length > 0 ? stderr : undefined,
      };
      const listener = this.unexpectedCloseListener;
      if (listener !== undefined) {
        listener(reason);
      } else {
        // Buffer so a listener registered moments later still sees the close.
        this.pendingUnexpectedClose = reason;
      }
    };
    this.client.onerror = (error) => {
      // Errors are informational on their own — `_onclose` is what tells us
      // the transport is gone — so just remember the latest one and let the
      // close handler decide whether to surface it. During startup the thrown
      // error from `client.connect()` already carries the message, so this
      // capture is only load-bearing post-`ready`.
      this.lastTransportError = error;
    };
  }
}

/**
 * A bounded "tail" buffer: appends characters and drops the oldest when the
 * total exceeds `capacity`. Used to keep the last few KB of child-process
 * stderr around without unbounded growth.
 */
class BoundedTail {
  private buffer = '';
  constructor(private readonly capacity: number) {}

  push(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.capacity) {
      this.buffer = this.buffer.slice(this.buffer.length - this.capacity);
    }
  }

  snapshot(): string {
    return this.buffer;
  }
}

// Only forward a safe subset of the parent's env to MCP child processes.
// Passing all of process.env would leak API keys and other secrets to third-
// party MCP servers. Explicit `config.env` entries always take precedence.
const ALLOWED_ENV_PREFIXES = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_',
  'TMPDIR', 'TEMP', 'TMP',
  'NODE_PATH', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_PREFIX',
  'XDG_', 'DBUS_', 'DISPLAY', 'WAYLAND_',
  'SYSTEMROOT', 'ProgramFiles', 'ProgramFiles(x86)', 'APPDATA', 'LOCALAPPDATA',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  // Windows: required for command resolution in child processes (Node 24
  // CVE-2024-27980 hardening blocks .cmd/.bat spawn with shell:false, so MCP
  // servers that use .cmd wrappers need PATHEXT to resolve the real target).
  'PATHEXT', 'COMSPEC',
];

function isEnvAllowed(key: string): boolean {
  return ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function mergeStdioEnv(configEnv?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isEnvAllowed(key)) {
      // Git Bash / MSYS2 can inject stray double-quotes into PATHEXT
      // (e.g. `\"";.COM;...;.SH";.CPL"`).  Those quotes break cmd.exe's
      // command resolution when a `.cmd` wrapper runs `"%_prog%"` — the
      // corrupt PATHEXT prevents `cmd.exe` from locating `node`.
      if (key === 'PATHEXT') {
        merged[key] = value.replace(/"/g, '');
      } else {
        merged[key] = value;
      }
    }
  }
  if (configEnv !== undefined) Object.assign(merged, configEnv);
  return merged;
}
