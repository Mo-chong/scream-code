import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface LoopVerifierConfig {
  command: string;
  timeoutMs: number;
}

export type VerifierResult =
  | { passed: true; output: string; durationMs: number }
  | { passed: false; output: string; durationMs: number; exitCode: number };

const MAX_OUTPUT_CHARS = 2000;

export async function runShellVerifier(
  config: LoopVerifierConfig,
  cwd: string,
): Promise<VerifierResult> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(config.command, {
      cwd,
      timeout: config.timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    return {
      passed: true,
      output: trimOutput(stdout + stderr),
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
    return {
      passed: false,
      output: trimOutput((e.stdout ?? '') + (e.stderr ?? '')),
      durationMs: Date.now() - start,
      exitCode: e.killed ? -1 : (e.code ?? 1),
    };
  }
}

function trimOutput(text: string): string {
  return text.slice(-MAX_OUTPUT_CHARS);
}
