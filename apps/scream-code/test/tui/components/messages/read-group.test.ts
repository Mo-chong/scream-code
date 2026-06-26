import { describe, expect, it } from 'vitest';

import { parseReadGroupOutput } from '#/tui/components/messages/read-group';

describe('parseReadGroupOutput', () => {
  it('parses clean file sections with line counts', () => {
    const output = [
      '── .ts (2) ──',
      '',
      '--- /workspace/a.ts ---',
      '1\tconst x = 1;',
      '2\tconst y = 2;',
      '<system>2 lines read from file</system>',
      '',
      '--- /workspace/b.ts ---',
      '1\tconst z = 3;',
      '<system>1 lines read from file</system>',
    ].join('\n');

    const results = parseReadGroupOutput(output);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      filePath: '/workspace/a.ts',
      lines: 2,
      failed: false,
      hasConflicts: false,
    });
    expect(results[1]).toMatchObject({
      filePath: '/workspace/b.ts',
      lines: 1,
      failed: false,
      hasConflicts: false,
    });
  });

  it('flags files containing merge conflict markers', () => {
    const output = [
      '── .ts (2) ──',
      '',
      '--- /workspace/clean.ts ---',
      '1\tfunction foo() {',
      '2\t  return 1;',
      '3\t}',
      '<system>3 lines read from file</system>',
      '',
      '--- /workspace/conflict.ts ---',
      '1\tfunction foo() {',
      '2\t<<<<<<< HEAD',
      '3\t  return 1;',
      '4\t=======',
      '5\t  return 2;',
      '6\t>>>>>>> branch',
      '7\t}',
      '<system>7 lines read from file</system>',
    ].join('\n');

    const results = parseReadGroupOutput(output);

    expect(results).toHaveLength(2);
    expect(results[0]?.hasConflicts).toBe(false);
    expect(results[1]?.hasConflicts).toBe(true);
  });

  it('marks failed entries when section starts with [ERROR]', () => {
    const output = [
      '--- /workspace/missing.ts ---',
      '[ERROR] file does not exist',
    ].join('\n');

    const results = parseReadGroupOutput(output);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      filePath: '/workspace/missing.ts',
      failed: true,
      lines: 0,
    });
    expect(results[0]?.hasConflicts).toBeFalsy();
  });
});
