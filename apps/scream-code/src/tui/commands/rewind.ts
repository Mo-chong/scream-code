import type { SlashCommandHost } from './dispatch';
import { formatErrorMessage } from '../utils/event-payload';
import { getNoActiveSessionMessage } from '../constant/scream-tui';
import { isBusy } from '../utils/app-state';
import { checkpoint } from '@scream-code/agent-core/turn-step';

// ── Rewind command ───────────────────────────────────────────────────────
// Restores files to their state before a specified number of turns ago.
// The reverse of /forward.

export async function handleRewindCommand(
  host: SlashCommandHost,
  args: string = '',
): Promise<void> {
  if (isBusy(host.state.appState)) {
    host.showError('Cannot rewind while agent is running.');
    return;
  }

  const count = parseStepCount(args);
  if (count === undefined) {
    host.showError('Usage: /rewind <number>  — e.g. /rewind 3');
    return;
  }

  try {
    const currentTurn = checkpoint.currentTurn;
    const targetTurn = Math.max(0, currentTurn - count);
    const restored = checkpoint.restoreFromTurn(targetTurn);

    if (restored.length === 0) {
      host.showTemporaryMessage(`No files to rewind in the last ${count} turn(s).`);
    } else {
      for (const path of restored) {
        host.showTemporaryMessage(`Rewound: ${path}`);
      }
    }
  } catch (error) {
    const message = formatErrorMessage(error);
    host.showError(`Rewind failed: ${message}`);
  }
}

// ── Forward command ───────────────────────────────────────────────────────
// Re-applies file changes undone by /rewind.

export async function handleForwardCommand(
  host: SlashCommandHost,
  _args: string = '',
): Promise<void> {
  if (isBusy(host.state.appState)) {
    host.showError('Cannot forward while agent is running.');
    return;
  }

  try {
    if (!checkpoint.hasRestored) {
      host.showTemporaryMessage('Nothing to forward. Use /rewind first.');
      return;
    }

    const forwarded = checkpoint.forwardToLatest();
    for (const path of forwarded) {
      host.showTemporaryMessage(`Forwarded: ${path}`);
    }
  } catch (error) {
    const message = formatErrorMessage(error);
    host.showError(`Forward failed: ${message}`);
  }
}

// ── Parsing ─────────────────────────────────────────────────────────────

function parseStepCount(args: string): number | undefined {
  const value = args.trim();
  if (value.length === 0) return 1;
  if (!/^[1-9]\d*$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}
