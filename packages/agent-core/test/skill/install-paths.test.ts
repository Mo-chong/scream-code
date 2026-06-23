import { describe, expect, it } from 'vitest';

import { resolveSkillInstallUnit } from '../../src/skill/install-paths';

describe('resolveSkillInstallUnit', () => {
  it('returns the skill directory for a directory-based skill', () => {
    const unit = resolveSkillInstallUnit('/home/user/.scream-code/skills/my-skill/SKILL.md');
    expect(unit).toBe('/home/user/.scream-code/skills/my-skill');
  });

  it('returns the parent directory when the skill has sub-skills', () => {
    const unit = resolveSkillInstallUnit(
      '/home/user/.scream-code/skills/my-skill/sub/SKILL.md',
    );
    expect(unit).toBe('/home/user/.scream-code/skills/my-skill');
  });

  it('returns the flat .md file for a top-level markdown skill', () => {
    const unit = resolveSkillInstallUnit('/home/user/.scream-code/skills/my-skill.md');
    expect(unit).toBe('/home/user/.scream-code/skills/my-skill.md');
  });

  it('supports the .agents brand directory', () => {
    const unit = resolveSkillInstallUnit('/repo/.agents/skills/team-skill/SKILL.md');
    expect(unit).toBe('/repo/.agents/skills/team-skill');
  });

  it('throws for paths outside managed skill roots', () => {
    expect(() => resolveSkillInstallUnit('/tmp/random/SKILL.md')).toThrow(
      'not under a managed skill root',
    );
  });
});
