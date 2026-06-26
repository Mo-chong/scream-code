import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname, delimiter } from 'node:path';

// Only install git hooks when running in a real git repository.
// Users who download source archives (instead of git clone) will
// lack a .git directory — skip silently instead of spamming errors.
if (existsSync('.git')) {
  const cli = resolve(import.meta.dirname, '..', 'node_modules', 'simple-git-hooks', 'cli.js');
  if (existsSync(cli)) {
    // Ensure node and git are on PATH even when run via pnpm on Windows (cmd.exe)
    const nodeBinDir = dirname(process.execPath);
    const env = { ...process.env, PATH: `${nodeBinDir}${delimiter}${process.env.PATH ?? ''}` };
    execSync(`"${process.execPath}" "${cli}"`, { stdio: 'inherit', shell: true, env, cwd: resolve(import.meta.dirname, '..') });
  }
}
