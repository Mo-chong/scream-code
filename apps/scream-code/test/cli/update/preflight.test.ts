import { afterEach, describe, expect, it, vi } from 'vitest';

import { readUpdateCache } from '#/cli/update/cache';
import { runUpdatePreflight } from '#/cli/update/preflight';
import { promptForInstallConfirmation } from '#/cli/update/prompt';
import type * as PromptModule from '#/cli/update/prompt';
import { refreshUpdateCache } from '#/cli/update/refresh';
import type * as RefreshModule from '#/cli/update/refresh';
import { detectInstallSource } from '#/cli/update/install-strategy';
import { emptyUpdateCache, type UpdateCache } from '#/cli/update/types';

const mocks = vi.hoisted(() => ({
  readUpdateCache: vi.fn(),
  detectInstallSource: vi.fn(),
  installUpdate: vi.fn(),
  promptForInstallConfirmation: vi.fn(),
  refreshUpdateCache: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('../../../src/cli/update/cache', () => ({
  readUpdateCache: mocks.readUpdateCache,
}));

vi.mock('../../../src/cli/update/install-strategy', () => ({
  detectInstallSource: mocks.detectInstallSource,
  installUpdate: mocks.installUpdate,
  INSTALL_COMMAND_STRING:
    'cd ~/.scream-code && git pull mochong main && pnpm install && pnpm -r build',
  MANUAL_UPDATE_MESSAGE:
    'Scream Code 有新版本可用，自动更新失败。请手动执行：\n' +
    '  cd ~/.scream-code && git pull mochong main && pnpm install && pnpm -r build\n',
}));

vi.mock('../../../src/cli/update/prompt', async () => {
  const actual = await vi.importActual<typeof PromptModule>('../../../src/cli/update/prompt.js');
  return {
    ...actual,
    promptForInstallConfirmation: mocks.promptForInstallConfirmation,
  };
});

vi.mock('../../../src/cli/update/refresh', async () => {
  const actual = await vi.importActual<typeof RefreshModule>('../../../src/cli/update/refresh.js');
  return {
    ...actual,
    refreshUpdateCache: mocks.refreshUpdateCache,
  };
});

function cacheWith(version: string): UpdateCache {
  return {
    source: 'cdn',
    checkedAt: '2026-04-23T08:00:00.000Z',
    latest: version,
  };
}

function captureOutput(): {
  stdout: string[];
  stderr: string[];
  options: {
    stdout: { write(chunk: string): boolean };
    stderr: { write(chunk: string): boolean };
    isTTY: boolean;
  };
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    options: {
      stdout: { write: (chunk: string) => { stdout.push(chunk); return true; } },
      stderr: { write: (chunk: string) => { stderr.push(chunk); return true; } },
      isTTY: true,
    },
  };
}

describe('runUpdatePreflight', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('continues on first launch with empty cache, still refreshes in background', async () => {
    mocks.readUpdateCache.mockResolvedValue(emptyUpdateCache());
    mocks.refreshUpdateCache.mockResolvedValue(emptyUpdateCache());
    const { options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(readUpdateCache).toHaveBeenCalledTimes(1);
    expect(refreshUpdateCache).toHaveBeenCalledTimes(1);
    expect(detectInstallSource).not.toHaveBeenCalled();
  });

  it('skips when non-interactive', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    const { options } = captureOutput();
    await expect(
      runUpdatePreflight('0.4.0', { ...options, isTTY: false }),
    ).resolves.toBe('continue');
    expect(detectInstallSource).not.toHaveBeenCalled();
  });

  it('source install: prompts and runs git pull + pnpm install + pnpm -r build', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockReturnValue('source');
    mocks.promptForInstallConfirmation.mockResolvedValue(true);
    mocks.installUpdate.mockResolvedValue(undefined);
    const { stdout, options } = captureOutput();

    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('exit');
    expect(mocks.promptForInstallConfirmation).toHaveBeenCalledWith(
      expect.objectContaining({
        installCommand:
          'cd ~/.scream-code && git pull mochong main && pnpm install && pnpm -r build',
        installSource: 'source',
      }),
    );
    expect(mocks.installUpdate).toHaveBeenCalledTimes(1);
    expect(stdout.join('')).toContain('已更新至 0.5.0');
  });

  it('unsupported: prints manual upgrade command, does not call installUpdate', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockReturnValue('unsupported');
    const { stdout, options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(stdout.join('')).toContain('git pull mochong main');
    expect(promptForInstallConfirmation).not.toHaveBeenCalled();
    expect(mocks.installUpdate).not.toHaveBeenCalled();
  });

  it('declined install continues without installUpdate', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockReturnValue('source');
    mocks.promptForInstallConfirmation.mockResolvedValue(false);
    const { options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(mocks.installUpdate).not.toHaveBeenCalled();
  });

  it('warns and continues when installUpdate rejects, without claiming success', async () => {
    mocks.readUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.refreshUpdateCache.mockResolvedValue(cacheWith('0.5.0'));
    mocks.detectInstallSource.mockReturnValue('source');
    mocks.promptForInstallConfirmation.mockResolvedValue(true);
    mocks.installUpdate.mockRejectedValue(new Error('git pull failed'));
    const { stdout, stderr, options } = captureOutput();
    await expect(runUpdatePreflight('0.4.0', options)).resolves.toBe('continue');
    expect(stderr.join('')).toContain('警告：更新失败');
    // A failed install must never print the "Updated …" success line.
    expect(stdout.join('')).not.toContain('已更新至');
  });

});
