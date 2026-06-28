import { describe, expect, it } from 'vitest';

import { buildRoleAdditionalText } from '#/tui/commands/like';

describe('buildRoleAdditionalText', () => {
  it('returns an empty string when no preferences are set', () => {
    expect(buildRoleAdditionalText({})).toBe('');
  });

  it('includes the nickname when set', () => {
    expect(buildRoleAdditionalText({ nickname: 'Alex' })).toBe(
      'The user\'s preferred nickname is "Alex".',
    );
  });

  it('includes the tone when set', () => {
    expect(buildRoleAdditionalText({ tone: 'friendly' })).toBe(
      'Respond in a friendly tone.',
    );
  });

  it('includes other preferences verbatim', () => {
    expect(buildRoleAdditionalText({ other: 'use Chinese, avoid abbreviations' })).toBe(
      'Additional user preferences: use Chinese, avoid abbreviations',
    );
  });

  it('combines all fields in order', () => {
    expect(
      buildRoleAdditionalText({
        nickname: 'Alex',
        tone: 'friendly',
        other: 'use examples',
      }),
    ).toBe(
      'The user\'s preferred nickname is "Alex".\nRespond in a friendly tone.\nAdditional user preferences: use examples',
    );
  });

  it('trims whitespace from inputs', () => {
    expect(buildRoleAdditionalText({ nickname: '  Alex  ', tone: '  concise ' })).toBe(
      'The user\'s preferred nickname is "Alex".\nRespond in a concise tone.',
    );
  });

  it('ignores fields that are empty after trimming', () => {
    expect(buildRoleAdditionalText({ nickname: '   ', tone: 'calm', other: '' })).toBe(
      'Respond in a calm tone.',
    );
  });
});
