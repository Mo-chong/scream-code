import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalJian } from '@scream-code/jian';
import { describe, expect, it } from 'vitest';

import { pathToUri, uriToPath } from '../../src/lsp/client';
import {
  applyWorkspaceEdit,
  formatWorkspaceEditPreview,
  type AppliedEdit,
} from '../../src/lsp/edits';
import type { LspWorkspaceEdit } from '../../src/lsp/client';

async function withTempDir<T>(
  fn: (dir: string, jian: LocalJian) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'scream-lsp-edits-'));
  try {
    const jian = await LocalJian.create(dir);
    return await fn(dir, jian);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('pathToUri / uriToPath round-trip', () => {
  it('converts POSIX absolute paths back and forth', () => {
    const original = '/tmp/project/src/index.ts';
    expect(uriToPath(pathToUri(original))).toBe(original);
  });

  it('strips file:// prefix and decodes percent-encoded chars', () => {
    expect(uriToPath('file:///tmp/a%20b.ts')).toBe('/tmp/a b.ts');
  });

  it('returns non-file URIs unchanged', () => {
    expect(uriToPath('untitled:Untitled-1')).toBe('untitled:Untitled-1');
  });
});

describe('applyWorkspaceEdit (changes map)', () => {
  it('applies a single-line edit to disk via Jian', async () => {
    await withTempDir(async (dir, jian) => {
      const filePath = join(dir, 'a.ts');
      await jian.writeText(filePath, 'const oldName = 1;\n');

      const edit: LspWorkspaceEdit = {
        changes: {
          [pathToUri(filePath)]: [
            {
              range: {
                start: { line: 0, character: 6 },
                end: { line: 0, character: 13 },
              },
              newText: 'newName',
            },
          ],
        },
      };

      const applied = await applyWorkspaceEdit(edit, jian);
      expect(applied).toHaveLength(1);
      expect(applied[0]!.editCount).toBe(1);
      expect(await jian.readText(filePath)).toBe('const newName = 1;\n');
    });
  });

  it('applies multi-file edits in a single call', async () => {
    await withTempDir(async (dir, jian) => {
      const fileA = join(dir, 'a.ts');
      const fileB = join(dir, 'b.ts');
      await jian.writeText(fileA, 'function foo() {}\n');
      await jian.writeText(fileB, 'foo();\n');

      const edit: LspWorkspaceEdit = {
        changes: {
          [pathToUri(fileA)]: [
            {
              range: {
                start: { line: 0, character: 9 },
                end: { line: 0, character: 12 },
              },
              newText: 'bar',
            },
          ],
          [pathToUri(fileB)]: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 3 },
              },
              newText: 'bar',
            },
          ],
        },
      };

      const applied = await applyWorkspaceEdit(edit, jian);
      expect(applied).toHaveLength(2);
      expect(await jian.readText(fileA)).toBe('function bar() {}\n');
      expect(await jian.readText(fileB)).toBe('bar();\n');
    });
  });

  it('applies multi-line edit by splicing lines', async () => {
    await withTempDir(async (dir, jian) => {
      const file = join(dir, 'multi.ts');
      await jian.writeText(file, 'line0\nold\nline2\n');

      const edit: LspWorkspaceEdit = {
        changes: {
          [pathToUri(file)]: [
            {
              range: {
                start: { line: 1, character: 0 },
                end: { line: 1, character: 3 },
              },
              newText: 'new\nextra',
            },
          ],
        },
      };

      await applyWorkspaceEdit(edit, jian);
      expect(await jian.readText(file)).toBe('line0\nnew\nextra\nline2\n');
    });
  });

  it('applies edits bottom-to-top so earlier offsets stay valid', async () => {
    await withTempDir(async (dir, jian) => {
      const file = join(dir, 'multi-edit.ts');
      await jian.writeText(file, 'aaa bbb ccc');

      const edit: LspWorkspaceEdit = {
        changes: {
          [pathToUri(file)]: [
            {
              range: { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } },
              newText: 'CCC',
            },
            {
              range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } },
              newText: 'BBB',
            },
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              newText: 'AAA',
            },
          ],
        },
      };

      await applyWorkspaceEdit(edit, jian);
      expect(await jian.readText(file)).toBe('AAA BBB CCC');
    });
  });

  it('throws on overlapping edits before writing anything', async () => {
    await withTempDir(async (dir, jian) => {
      const file = join(dir, 'overlap.ts');
      await jian.writeText(file, 'abcdef');

      const edit: LspWorkspaceEdit = {
        changes: {
          [pathToUri(file)]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
              newText: 'XX',
            },
            {
              range: { start: { line: 0, character: 2 }, end: { line: 0, character: 6 } },
              newText: 'YY',
            },
          ],
        },
      };

      await expect(applyWorkspaceEdit(edit, jian)).rejects.toThrow(/overlapping LSP edits/);
      expect(await jian.readText(file)).toBe('abcdef');
    });
  });
});

describe('applyWorkspaceEdit (documentChanges)', () => {
  it('applies TextDocumentEdit entries to disk', async () => {
    await withTempDir(async (dir, jian) => {
      const file = join(dir, 'doc.ts');
      await jian.writeText(file, 'const x = 1;\n');

      const edit: LspWorkspaceEdit = {
        documentChanges: [
          {
            textDocument: { uri: pathToUri(file) },
            edits: [
              {
                range: {
                  start: { line: 0, character: 6 },
                  end: { line: 0, character: 7 },
                },
                newText: 'y',
              },
            ],
          },
        ],
      };

      const applied: AppliedEdit[] = await applyWorkspaceEdit(edit, jian);
      expect(applied).toHaveLength(1);
      expect(applied[0]!.editCount).toBe(1);
      expect(await jian.readText(file)).toBe('const y = 1;\n');
    });
  });

  it('merges changes and documentChanges targeting the same file', async () => {
    await withTempDir(async (dir, jian) => {
      const file = join(dir, 'merged.ts');
      await jian.writeText(file, 'aaa bbb');

      const edit: LspWorkspaceEdit = {
        changes: {
          [pathToUri(file)]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              newText: 'AAA',
            },
          ],
        },
        documentChanges: [
          {
            textDocument: { uri: pathToUri(file) },
            edits: [
              {
                range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } },
                newText: 'BBB',
              },
            ],
          },
        ],
      };

      const applied = await applyWorkspaceEdit(edit, jian);
      expect(applied).toHaveLength(1);
      expect(applied[0]!.editCount).toBe(2);
      expect(await jian.readText(file)).toBe('AAA BBB');
    });
  });
});

describe('formatWorkspaceEditPreview', () => {
  it('lists one summary line per affected file', () => {
    const edit: LspWorkspaceEdit = {
      changes: {
        'file:///tmp/a.ts': [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: 'AAA',
          },
        ],
        'file:///tmp/b.ts': [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            newText: 'BBB',
          },
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
            newText: 'CCC',
          },
        ],
      },
    };

    const preview = formatWorkspaceEditPreview(edit);
    expect(preview).toHaveLength(2);
    expect(preview.some((line) => line.includes('/tmp/a.ts') && line.includes('1 edit'))).toBe(true);
    expect(preview.some((line) => line.includes('/tmp/b.ts') && line.includes('2 edits'))).toBe(true);
  });

  it('formats documentChanges entries', () => {
    const edit: LspWorkspaceEdit = {
      documentChanges: [
        {
          textDocument: { uri: 'file:///tmp/c.ts' },
          edits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              newText: 'XXX',
            },
          ],
        },
      ],
    };

    const preview = formatWorkspaceEditPreview(edit);
    expect(preview).toEqual(['/tmp/c.ts: 1 edit']);
  });

  it('returns empty for an empty workspace edit', () => {
    expect(formatWorkspaceEditPreview({})).toEqual([]);
  });
});

describe('applyWorkspaceEdit path validation', () => {
  it('calls validatePath for every target before writing', async () => {
    await withTempDir(async (dir, jian) => {
      const insideA = join(dir, 'a.ts');
      const insideB = join(dir, 'b.ts');
      await jian.writeText(insideA, 'foo();\n');
      await jian.writeText(insideB, 'foo();\n');
      const edit: LspWorkspaceEdit = {
        changes: {
          [pathToUri(insideA)]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              newText: 'bar',
            },
          ],
          [pathToUri(insideB)]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              newText: 'bar',
            },
          ],
        },
      };

      const seen: string[] = [];
      await applyWorkspaceEdit(edit, jian, (p) => {
        seen.push(p);
      });
      expect(seen).toHaveLength(2);
      expect(seen.every((p) => p.startsWith(dir))).toBe(true);
    });
  });

  it('refuses to write when validatePath throws, leaving files untouched', async () => {
    await withTempDir(async (dir, jian) => {
      const inside = join(dir, 'inside.ts');
      const outside = join(tmpdir(), 'scream-lsp-outside.ts');
      await jian.writeText(inside, 'foo();\n');
      await jian.writeText(outside, 'foo();\n');

      const edit: LspWorkspaceEdit = {
        changes: {
          [pathToUri(inside)]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              newText: 'bar',
            },
          ],
          [pathToUri(outside)]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              newText: 'bar',
            },
          ],
        },
      };

      const blocked = (p: string): void => {
        if (!p.startsWith(dir)) {
          throw new Error(`path outside workspace: ${p}`);
        }
      };

      await expect(applyWorkspaceEdit(edit, jian, blocked)).rejects.toThrow(/outside workspace/);
      expect(await jian.readText(inside)).toBe('foo();\n');
      expect(await jian.readText(outside)).toBe('foo();\n');
    });
  });

  it('skips validation entirely when validatePath is undefined', async () => {
    await withTempDir(async (dir, jian) => {
      const file = join(dir, 'no-validate.ts');
      await jian.writeText(file, 'foo();\n');
      const edit: LspWorkspaceEdit = {
        changes: {
          [pathToUri(file)]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              newText: 'bar',
            },
          ],
        },
      };

      const applied = await applyWorkspaceEdit(edit, jian);
      expect(applied).toHaveLength(1);
      expect(await jian.readText(file)).toBe('bar();\n');
    });
  });
});
