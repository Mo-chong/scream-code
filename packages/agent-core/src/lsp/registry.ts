import { access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'pathe';
import { createRequire } from 'node:module';
import type { Jian } from '@scream-code/jian';

import { LspClient } from './client';

export interface LspCommand {
  readonly command: string[];
  readonly languageId: string;
  /** Optional factory for initializationOptions passed to the server. */
  readonly initOptions?: (workspaceRoot: string) => Record<string, unknown> | undefined;
}

/** Resolve npm binary commands to `node <entry>` on Windows (bypass .cmd wrappers). */
const _cmdCache = new Map<string, string[]>();

async function _resolveCmd(desc: LspCommand): Promise<string[]> {
  const key = desc.command.join(' ');
  const cached = _cmdCache.get(key);
  if (cached) return cached;

  if (process.platform === 'win32' && desc.languageId.startsWith('typescript')) {
    // On Windows, npm-installed .cmd wrappers can't be spawned directly.
    // Resolve to `node <lib/cli.mjs>` via the global npm root.
    try {
      const npmRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
      const entry = join(npmRoot, 'typescript-language-server', 'lib', 'cli.mjs');
      await access(entry); // confirm it exists
      const resolved: string[] = [process.execPath, entry, '--stdio'];
      _cmdCache.set(key, resolved);
      return resolved;
    } catch { /* fallthrough to raw command */ }
  }
  _cmdCache.set(key, desc.command);
  return desc.command;
}

const LANGUAGE_SERVERS: Readonly<Record<string, LspCommand>> = {
  '.ts': { command: ['typescript-language-server', '--stdio'], languageId: 'typescript', initOptions: typescriptInitOptions },
  '.tsx': { command: ['typescript-language-server', '--stdio'], languageId: 'typescriptreact', initOptions: typescriptInitOptions },
  '.js': { command: ['typescript-language-server', '--stdio'], languageId: 'javascript', initOptions: typescriptInitOptions },
  '.jsx': { command: ['typescript-language-server', '--stdio'], languageId: 'javascriptreact', initOptions: typescriptInitOptions },
  '.py': { command: ['pyright-langserver', '--stdio'], languageId: 'python' },
  '.rs': { command: ['rust-analyzer'], languageId: 'rust' },
  '.go': { command: ['gopls'], languageId: 'go' },
};

/**
 * Resolve a `tsserver` lib directory for `typescript-language-server`.
 */
function resolveTsserverPath(workspaceRoot: string): string | undefined {
  const workspaceCandidate = join(workspaceRoot, 'node_modules', 'typescript', 'lib');
  if (existsSync(join(workspaceCandidate, 'tsserver.js'))) return workspaceCandidate;
  try {
    const bundled = createRequire(import.meta.url).resolve('typescript/lib/tsserver.js');
    return bundled.slice(0, -'/tsserver.js'.length);
  } catch {
    return undefined;
  }
}

function typescriptInitOptions(workspaceRoot: string): Record<string, unknown> | undefined {
  const tsserverPath = resolveTsserverPath(workspaceRoot);
  if (tsserverPath === undefined) return undefined;
  return { tsserver: { path: tsserverPath } };
}

export class LspRegistry {
  private readonly clients = new Map<string, Promise<LspClient>>();

  constructor(private readonly jian: Jian) {}

  /**
   * Get or create an LSP client for the given file path and workspace root.
   * Returns undefined if the file type is not supported.
   *
   * Caches the in-flight `Promise<LspClient>` so concurrent callers share
   * the same startup and never receive a client whose `initialize` has not
   * completed.
   */
  async getClient(path: string, workspaceRoot: string): Promise<LspClient | undefined> {
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    const config = LANGUAGE_SERVERS[ext];
    if (config === undefined) return undefined;

    const resolvedCmd = await _resolveCmd(config);
    const key = `${workspaceRoot}\0${resolvedCmd.join(' ')}`;
    let clientPromise = this.clients.get(key);
    if (clientPromise === undefined) {
      clientPromise = this.createAndStartClient(resolvedCmd, workspaceRoot, config);
      this.clients.set(key, clientPromise);
    }
    return clientPromise;
  }

  private async createAndStartClient(
    command: string[],
    workspaceRoot: string,
    config: LspCommand,
  ): Promise<LspClient> {
    const client = new LspClient(
      command,
      workspaceRoot,
      this.jian,
      config.initOptions?.(workspaceRoot),
    );
    try {
      await client.start();
      return client;
    } catch (error) {
      const key = `${workspaceRoot}\0${command.join(' ')}`;
      this.clients.delete(key);
      throw error;
    }
  }

  languageIdForPath(path: string): string | undefined {
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    return LANGUAGE_SERVERS[ext]?.languageId;
  }

  /** Returns the server command for the path's extension, or undefined when unsupported. */
  commandForPath(path: string): string[] | undefined {
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    return LANGUAGE_SERVERS[ext]?.command;
  }

  async stopAll(): Promise<void> {
    const promises = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(
      promises.map((promise) => promise.then((client) => client.stop())),
    );
  }
}
