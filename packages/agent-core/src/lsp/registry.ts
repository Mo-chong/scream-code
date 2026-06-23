import { access } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { dirname, join, sep } from 'pathe';
import type { Jian } from '@scream-code/jian';

import { LspClient } from './client';

export interface LspCommand {
  readonly command: string[];
  readonly languageId: string;
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
  '.ts': { command: ['typescript-language-server', '--stdio'], languageId: 'typescript' },
  '.tsx': { command: ['typescript-language-server', '--stdio'], languageId: 'typescriptreact' },
  '.js': { command: ['typescript-language-server', '--stdio'], languageId: 'javascript' },
  '.jsx': { command: ['typescript-language-server', '--stdio'], languageId: 'javascriptreact' },
  '.py': { command: ['pyright-langserver', '--stdio'], languageId: 'python' },
  '.rs': { command: ['rust-analyzer'], languageId: 'rust' },
  '.go': { command: ['gopls'], languageId: 'go' },
};

export class LspRegistry {
  private readonly clients = new Map<string, LspClient>();

  constructor(private readonly jian: Jian) {}

  /**
   * Get or create an LSP client for the given file path.
   * Automatically resolves the TS project root (first ancestor dir with tsconfig.json).
   */
  async getClient(path: string, _workspaceRoot: string): Promise<LspClient | undefined> {
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    const config = LANGUAGE_SERVERS[ext];
    if (config === undefined) return undefined;

    const resolvedCmd = await _resolveCmd(config);
    const projectRoot = await resolveProjectRoot(path);
    const key = `${projectRoot}\0${resolvedCmd.join(' ')}`;
    let client = this.clients.get(key);
    if (client === undefined) {
      client = new LspClient(resolvedCmd, projectRoot, this.jian);
      await client.start();
      this.clients.set(key, client);
    }
    return client;
  }

  languageIdForPath(path: string): string | undefined {
    const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
    return LANGUAGE_SERVERS[ext]?.languageId;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.stop()));
    this.clients.clear();
  }
}

/**
 * Walk up from `filePath` to find the nearest ancestor directory containing a
 * `tsconfig.json` (or `jsconfig.json`). Falls back to `dirname(filePath)`.
 * This prevents TypeScript LSP from scanning huge unscoped directories.
 */
async function resolveProjectRoot(filePath: string): Promise<string> {
  let dir = dirname(filePath);
  const root = /^[A-Za-z]:[\\/]$/.test(dir) ? dir : sep;
  while (dir.length >= root.length) {
    try {
      await access(join(dir, 'tsconfig.json'));
      return dir;
    } catch {
      try {
        await access(join(dir, 'jsconfig.json'));
        return dir;
      } catch {
        dir = dirname(dir);
      }
    }
  }
  return dirname(filePath);
}
