import { execSync } from 'node:child_process';

import { ScreamHarness, log, resolveScreamHome } from '@scream-code/scream-code-sdk';

import { CLI_UI_MODE } from '#/constant/app';
import type { TuiConfig } from '#/tui/config';
import { loadTuiConfig, TuiConfigParseError } from '#/tui/config';
import { CHROME_GUTTER } from '#/tui/constant/rendering';
import { ScreamTUI } from '#/tui/index';
import { runLoadingAnimation } from '#/tui/components/chrome/loading';
import { detectTerminalTheme } from '#/tui/theme/detect';

import type { CLIOptions } from './options';
import { refreshUpdateCache } from './update/refresh';
import { createScreamCodeHostIdentity } from './version';

export async function runShell(
  opts: CLIOptions,
  version: string,
): Promise<void> {
  let tuiConfig: TuiConfig;
  let configWarning: string | undefined;
  try {
    tuiConfig = await loadTuiConfig();
  } catch (error) {
    if (!(error instanceof TuiConfigParseError)) throw error;
    tuiConfig = error.fallback;
    configWarning = error.message;
  }

  // Resolve `theme = "auto"` against the live terminal once, before pi-tui
  // grabs stdin. Explicit `dark` / `light` skip detection.
  const resolvedTheme = tuiConfig.theme === 'auto' ? await detectTerminalTheme() : tuiConfig.theme;

  const workDir = process.cwd();
  const homeDir = resolveScreamHome();
  const harness = new ScreamHarness({
    homeDir,
    identity: createScreamCodeHostIdentity(version),
  });
  log.info('scream-code starting', {
    version,
    uiMode: CLI_UI_MODE,
    nodeVersion: process.version,
    platform: `${process.platform}/${process.arch}`,
    workDir,
  });
  await harness.ensureConfigFile();

  // Preflight validates the host environment (e.g. Git Bash on Windows)
  await harness.preflight();

  // Fire the update-cache refresh in parallel with the loading splash so its
  // network latency is hidden behind the animation. The splash gates its
  // "press ENTER" prompt on this promise resolving.
  const updatePrefetch = refreshUpdateCache().catch(() => {});

  await runLoadingAnimation(resolvedTheme, updatePrefetch);

  const tui = new ScreamTUI(harness, {
    cliOptions: opts,
    tuiConfig,
    version,
    workDir,
    startupNotice: configWarning,
    resolvedTheme,
    updatePrefetched: true,
  });

  tui.onExit = async (exitCode = 0) => {
    const sessionId = tui.getCurrentSessionId();
    const hasContent = tui.hasSessionContent();
    const gutter = ' '.repeat(CHROME_GUTTER);
    process.stdout.write(`${gutter}再见！\n`);
    if (sessionId !== '' && hasContent) {
      process.stderr.write(`\n${gutter}恢复此会话：scream -r ${sessionId}\n`);
    }
    process.exit(exitCode);
  };
  try {
    execSync('stty -ixon', { stdio: 'ignore' });
  } catch {
    /* ignore */
  }
  try {
    await tui.start();
  } catch (error) {
    await harness.close();
    throw error;
  }
}
