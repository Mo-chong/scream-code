import { join } from 'pathe';

import { findProjectRoot } from './scanner';

export interface SkillInstallPaths {
  /** ~/.scream-code/skills */
  readonly userDir: string;
  /** <projectRoot>/.scream-code/skills */
  readonly projectDir: string;
}

/**
 * Resolve the two standard skill installation directories.
 *
 * - User skills live under `~/.scream-code/skills`.
 * - Project skills live under `<git-root>/.scream-code/skills`, where the
 *   git-root is the nearest ancestor of `workDir` containing a `.git` directory
 *   (falling back to `workDir` itself).
 */
export async function resolveSkillInstallPaths(options: {
  readonly userHomeDir: string;
  readonly workDir: string;
}): Promise<SkillInstallPaths> {
  const projectRoot = await findProjectRoot(options.workDir);
  return {
    userDir: join(options.userHomeDir, '.scream-code', 'skills'),
    projectDir: join(projectRoot, '.scream-code', 'skills'),
  };
}
