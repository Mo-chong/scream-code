import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectInstallSource } from '#/cli/update/source';

import { SCREAM_CODE_DATA_DIR_NAME } from '#/constant/app';

describe('detectInstallSource', () => {
  it('returns source when the install directory contains a .git directory', () => {
    const installDir = '/home/user/.scream-code';
    expect(
      detectInstallSource({
        getInstallDir: () => installDir,
        existsSync: (path: string) => path === join(installDir, '.git'),
      }),
    ).toBe('source');
  });

  it('returns source for the legacy ~/.scream-code path even when SCREAM_CODE_HOME points elsewhere', () => {
    const legacyGitDir = join(homedir(), SCREAM_CODE_DATA_DIR_NAME, '.git');

    expect(
      detectInstallSource({
        getInstallDir: () => '/custom/path',
        existsSync: (path: string) => path === legacyGitDir,
      }),
    ).toBe('source');
  });

  it('returns unsupported when no .git directory is found', () => {
    expect(
      detectInstallSource({
        getInstallDir: () => '/home/user/.scream-code',
        existsSync: () => false,
      }),
    ).toBe('unsupported');
  });

  it('returns unsupported when only the install dir exists without .git', () => {
    const installDir = '/home/user/.scream-code';
    expect(
      detectInstallSource({
        getInstallDir: () => installDir,
        existsSync: (path: string) => path === installDir,
      }),
    ).toBe('unsupported');
  });
});
