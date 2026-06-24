import type { Jian } from '@scream-code/jian';
import { describe, expect, it, vi } from 'vitest';

import { ReadGroupTool } from '../../src/tools/builtin/file/read-group';
import type { ReadGroupInput } from '../../src/tools/builtin/file/read-group';
import { createFakeJian } from './fixtures/fake-jian';
import { executeTool } from './fixtures/execute-tool';

const signal = new AbortController().signal;

const REGULAR_FILE_STAT = {
  stMode: 0o100_644,
  stIno: 1,
  stDev: 1,
  stNlink: 1,
  stUid: 1000,
  stGid: 1000,
  stSize: 0,
  stAtime: 0,
  stMtime: 0,
  stCtime: 0,
} satisfies Awaited<ReturnType<Jian['stat']>>;

const ENOENT_ERROR = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

function context(args: ReadGroupInput) {
  return {
    turnId: '0',
    toolCallId: 'call_readgroup',
    args,
    signal,
  };
}

function jianWithFiles(fileContents: Record<string, string>): Jian {
  return createFakeJian({
    stat: vi.fn<Jian['stat']>().mockImplementation(async (p) => {
      if (fileContents[p] === undefined) throw ENOENT_ERROR;
      return REGULAR_FILE_STAT;
    }),
    readBytes: vi.fn<Jian['readBytes']>().mockImplementation(async (p, n) => {
      const content = fileContents[p] ?? '';
      const bytes = Buffer.from(content, 'utf8');
      return n === undefined ? bytes : bytes.subarray(0, n);
    }),
    readLines: vi.fn<Jian['readLines']>().mockImplementation(async function* (p: string) {
      const content = fileContents[p] ?? '';
      if (content === '') return;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        yield i < lines.length - 1 ? `${line}\n` : line;
      }
    }),
    glob: async function* (): AsyncGenerator<string> {},
    iterdir: async function* (): AsyncGenerator<string> {},
  });
}

describe('ReadGroupTool', () => {
  it('reads multiple existing files', async () => {
    const tool = new ReadGroupTool(
      jianWithFiles({
        '/workspace/a.ts': 'content A',
        '/workspace/b.ts': 'content B',
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/a.ts', '/workspace/b.ts'] }),
    );

    expect(result.isError).toBeFalsy();
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('--- /workspace/a.ts ---');
    expect(output).toContain('content A');
    expect(output).toContain('--- /workspace/b.ts ---');
    expect(output).toContain('content B');
  });

  it('skips missing paths and continues with existing ones', async () => {
    const tool = new ReadGroupTool(
      jianWithFiles({ '/workspace/existing.ts': 'present' }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/existing.ts', '/workspace/missing.ts'] }),
    );

    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('present');
    expect(output).toContain('--- /workspace/missing.ts ---');
    expect(output).toContain('[ERROR]');
    expect(output).toContain('Skipped missing paths: /workspace/missing.ts');
  });

  it('fails when all paths are missing', async () => {
    const tool = new ReadGroupTool(jianWithFiles({}), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/a.ts', '/workspace/b.ts'] }),
    );

    expect(result).toMatchObject({ isError: true });
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('Paths not found: /workspace/a.ts, /workspace/b.ts');
  });

  it('single path keeps strict ENOENT semantics (no partition)', async () => {
    const tool = new ReadGroupTool(jianWithFiles({}), {
      workspaceDir: '/workspace',
      additionalDirs: [],
    });

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/only.ts'] }),
    );

    expect(result).toMatchObject({ isError: true });
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('--- /workspace/only.ts ---');
    expect(output).toContain('[ERROR]');
    expect(output).not.toContain('Paths not found');
  });

  it('preserves input order in output', async () => {
    const tool = new ReadGroupTool(
      jianWithFiles({
        '/workspace/zebra.ts': 'Z',
        '/workspace/apple.ts': 'A',
        '/workspace/mango.ts': 'M',
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/zebra.ts', '/workspace/apple.ts', '/workspace/mango.ts'] }),
    );

    const output = typeof result.output === 'string' ? result.output : '';
    const zebraIdx = output.indexOf('--- /workspace/zebra.ts ---');
    const appleIdx = output.indexOf('--- /workspace/apple.ts ---');
    const mangoIdx = output.indexOf('--- /workspace/mango.ts ---');
    expect(zebraIdx).toBeLessThan(appleIdx);
    expect(appleIdx).toBeLessThan(mangoIdx);
  });

  it('continues reading valid files when one path hits a non-ENOENT stat error', async () => {
    const eaccesError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const tool = new ReadGroupTool(
      createFakeJian({
        stat: vi.fn<Jian['stat']>().mockImplementation(async (p) => {
          if (p === '/workspace/locked.ts') throw eaccesError;
          return REGULAR_FILE_STAT;
        }),
        readBytes: vi.fn<Jian['readBytes']>().mockImplementation(async (_p, n) => {
          const bytes = Buffer.from('ok\n', 'utf8');
          return n === undefined ? bytes : bytes.subarray(0, n);
        }),
        readLines: vi.fn<Jian['readLines']>().mockImplementation(async function* () {
          yield 'ok\n';
        }),
        glob: async function* (): AsyncGenerator<string> {},
        iterdir: async function* (): AsyncGenerator<string> {},
      }),
      { workspaceDir: '/workspace', additionalDirs: [] },
    );

    const result = await executeTool(
      tool,
      context({ paths: ['/workspace/ok.ts', '/workspace/locked.ts'] }),
    );

    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('--- /workspace/ok.ts ---');
    expect(output).toContain('ok');
    expect(output).toContain('--- /workspace/locked.ts ---');
    expect(output).toContain('[ERROR]');
    expect(result.isError).toBe(true);
  });
});
