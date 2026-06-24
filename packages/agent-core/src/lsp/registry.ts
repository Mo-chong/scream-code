import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import type { Jian } from '@scream-code/jian';

import { LspClient } from './client';

export interface LspCommand {
  readonly command: string[];
  readonly languageId: string;
  /** Optional factory for initializationOptions passed to the server. */
  readonly initOptions?: (workspaceRoot: string) => Record<string, unknown> | undefined;
}

const TYPESCRIPT_SERVER_COMMAND = ['typescript-language-server', '--stdio'];

const LANGUAGE_SERVERS: Readonly<Record<string, LspCommand>> = {
  '.ts': { command: TYPESCRIPT_SERVER_COMMAND, languageId: 'typescript', initOptions: typescriptInitOptions },
  '.tsx': { command: TYPESCRIPT_SERVER_COMMAND, languageId: 'typescriptreact', initOptions: typescriptInitOptions },
  '.js': { command: TYPESCRIPT_SERVER_COMMAND, languageId: 'javascript', initOptions: typescriptInitOptions },
  '.jsx': { command: TYPESCRIPT_SERVER_COMMAND, languageId: 'javascriptreact', initOptions: typescriptInitOptions },
  '.py': { command: ['pyright-langserver', '--stdio'], languageId: 'python' },
  '.rs': { command: ['rust-analyzer'], languageId: 'rust' },
  '.go': { command: ['gopls'], languageId: 'go' },
};

/**
 * Resolve a `tsserver` lib directory for `typescript-language-server`.
 *
 * `typescript-language-server` is only the LSP protocol layer; it shells out to
 * TypeScript's own `tsserver.js` to compute diagnostics. It searches the
 * workspace's `node_modules/typescript` by default, so editing a standalone
 * `.ts` file outside any JS project makes it exit with "Could not find a valid
 * TypeScript installation." Passing `initializationOptions.tsserver.path`
 * points it at a known-good install so diagnostics work regardless of where
 * the edited file lives.
 *
 * Resolution order: workspace `node_modules/typescript`, then the
 * `typescript` dependency bundled with scream-code itself (resolved via
 * `require.resolve`). Returns undefined when neither is available, in which
 * case the server will fall back to its own search (and likely fail for
 * project-less files).
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
   * Caches the in-flight `Promise<LspClient>` rather than the client instance
   * so concurrent callers share the same startup and never receive a client
   * whose `initialize` has not completed.
   */
  async getClient(path: string, workspaceRoot: string): Promise<LspClient | undefined> {
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    const config = LANGUAGE_SERVERS[ext];
    if (config === undefined) return undefined;

    const key = `${workspaceRoot}\0${config.command.join(' ')}`;
    let clientPromise = this.clients.get(key);
    if (clientPromise === undefined) {
      clientPromise = this.createAndStartClient(config, workspaceRoot, key);
      this.clients.set(key, clientPromise);
    }
    return clientPromise;
  }

  private async createAndStartClient(
    config: LspCommand,
    workspaceRoot: string,
    key: string,
  ): Promise<LspClient> {
    const client = new LspClient(
      config.command,
      workspaceRoot,
      this.jian,
      config.initOptions?.(workspaceRoot),
    );
    try {
      await client.start();
      return client;
    } catch (error) {
      // Uncache the failed promise so subsequent calls don't reuse a
      // half-started client (process undefined, started flag stuck) and
      // block for the diagnostics poll timeout on every Edit/Write.
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
