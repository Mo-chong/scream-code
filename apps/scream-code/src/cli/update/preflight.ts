import { homedir } from 'node:os';
import { join } from 'node:path';

import { readUpdateCache } from './cache';
import { promptForInstallConfirmation, type InstallPromptOptions } from './prompt';
import { refreshUpdateCache } from './refresh';
import { selectUpdateTarget } from './select';
import {
  INSTALL_COMMAND_STRING,
  MANUAL_UPDATE_MESSAGE,
  installUpdate,
} from './install-strategy';
import {
  type UpdateDecision,
  type UpdatePreflightResult,
  type UpdateTarget,
} from './types';

export type { UpdatePreflightResult } from './types';

export interface RunUpdatePreflightOptions {
  readonly stdout?: { write(chunk: string): boolean };
  readonly stderr?: { write(chunk: string): boolean };
  readonly isTTY?: boolean;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderManualUpdateMessage(_currentVersion: string, _target: UpdateTarget): string {
  return MANUAL_UPDATE_MESSAGE;
}

function renderInstallSuccessMessage(target: UpdateTarget): string {
  return `已更新至 ${target.version}。请重新启动 scream 以使用新版本。\n`;
}

function refreshInBackground(): void {
  void refreshUpdateCache().catch(() => {});
}

async function promptInstall(
  currentVersion: string,
  target: UpdateTarget,
  installCommand: string,
): Promise<boolean> {
  const options: InstallPromptOptions = {
    currentVersion,
    target,
    installCommand,
  };
  return promptForInstallConfirmation(options);
}

export function decideUpdateAction(
  target: UpdateTarget | null,
  isInteractive: boolean,
): UpdateDecision {
  if (target === null) return 'none';
  if (!isInteractive) return 'manual-command';
  return 'prompt-install';
}

export async function runUpdatePreflight(
  currentVersion: string,
  options: RunUpdatePreflightOptions = {},
): Promise<UpdatePreflightResult> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  try {
    const cache = await readUpdateCache().catch(() => null);
    const latest = cache?.latest ?? null;
    const target = selectUpdateTarget(currentVersion, latest);
    refreshInBackground();

    const isInteractive =
      options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);

    const decision = decideUpdateAction(target, isInteractive);
    if (decision === 'none' || target === null) return 'continue';

    const installCommand = INSTALL_COMMAND_STRING;

    if (decision === 'manual-command') {
      stdout.write(renderManualUpdateMessage(currentVersion, target));
      return 'continue';
    }

    const confirmed = await promptInstall(currentVersion, target, installCommand);
    if (!confirmed) return 'continue';

    try {
      await installUpdate();
      stdout.write(renderInstallSuccessMessage(target));
      return 'exit';
    } catch (error) {
      stderr.write(
        `警告：更新失败：${formatErrorMessage(error)}\n`,
      );
      return 'continue';
    }
  } catch {
    return 'continue';
  }
}
