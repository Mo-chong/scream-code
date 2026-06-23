import { basename, dirname, join, normalize } from 'pathe';

import { findProjectRoot } from './scanner';

export interface SkillInstallPaths {
  /** ~/.scream-code/skills */
  readonly userDir: string;
  /** <projectRoot>/.scream-code/skills */
  readonly projectDir: string;
}

const MANAGED_SKILL_ROOT_NAMES = new Set(['.scream-code', '.agents']);

/**
 * Given a skill path, return the filesystem entry that represents the whole
 * skill installation unit. For directory-based skills this is the skill's root
 * directory (so bundled sub-skills are removed together); for flat `.md`
 * skills this is the `.md` file itself.
 *
 * The install unit is the first ancestor of `skillPath` whose parent is a
 * managed skill root such as `<...>/.scream-code/skills` or
 * `<...>/.agents/skills`.
 */
export function resolveSkillInstallUnit(skillPath: string): string {
  const normalized = normalize(skillPath).replaceAll('\\', '/');
  let current = normalized;
  while (true) {
    const parent = dirname(current).replaceAll('\\', '/');
    if (parent === current || parent === '.') {
      throw new Error(`Skill path "${skillPath}" is not under a managed skill root`);
    }
    const parentBase = basename(parent);
    const grandparent = dirname(parent).replaceAll('\\', '/');
    const grandparentBase = grandparent === '.' ? '' : basename(grandparent);
    if (parentBase === 'skills' && MANAGED_SKILL_ROOT_NAMES.has(grandparentBase)) {
      return current;
    }
    current = parent;
  }
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
