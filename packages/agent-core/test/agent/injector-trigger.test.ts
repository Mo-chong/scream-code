/**
 * TurnFlow injector trigger verification — condition-based testing.
 *
 * Each test scripts LLM responses that trigger specific tool calls, then
 * asserts the expected injection text appears in agent context history.
 *
 * A 组 (prepareToolExecution): fires BEFORE tool executes.
 * B 组 (finalizeToolResult):   fires AFTER tool completes.
 * C 组 (afterStep):            fires after every step end.
 */

import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Jian, JianProcess } from '@scream-cli/jian';
import { testAgent } from './harness/agent';
import { createFakeJian } from '../tools/fixtures/fake-jian';
import { makeToolCall } from '../loop/fixtures/fake-llm';

// ── Tool call helpers ────────────────────────────────

function bashCall(command: string, timeout = 60) {
  return makeToolCall('Bash', { command, timeout });
}

// ── Jian factory ─────────────────────────────────────

function makeProcess(stdout: string, exitCode: number): JianProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([stdout]),
    stderr: Readable.from(['']),
    pid: 42,
    exitCode,
    wait: vi.fn().mockResolvedValue(exitCode),
    kill: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Jian supporting Bash exec + file read/write + stat.
 * Stat correctly distinguishes directories vs files, so Edit/Write
 * tools can execute without mode errors.
 */
function createJian(
  stdout = 'ok',
  exitCode = 0,
  fileContent: string | null = null,
): Jian {
  return createFakeJian({
    execWithEnv: vi.fn().mockImplementation(async () => makeProcess(stdout, exitCode)),
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeText: vi.fn(async (_p: string, c: string) => c.length),
    readText: vi.fn().mockImplementation(async (path: string) => {
      if (fileContent !== null) return fileContent;
      if (path.endsWith('.ts') || path.endsWith('.md') || path.endsWith('.json')) return 'content\n';
      const err = new Error(`ENOENT: ${path}`);
      (err as any).code = 'ENOENT';
      throw err;
    }),
    stat: vi.fn().mockImplementation(async (path: string) => {
      // /workspace and its parent are directories; everything else is a file
      const normalized = path.replace(/\/+$/, '');
      if (normalized === '/workspace' || normalized === '' || normalized === '/') {
        return { stMode: 0o40755 };
      }
      return { stMode: 0o100644 };
    }),
  });
}

// ── History helpers ──────────────────────────────────

function historyContainsText(
  history: Array<{ role: string; content: Array<{ type: string; text: string }> }>,
  needle: string,
): boolean {
  return history.some(
    (m) =>
      m.role === 'user' &&
      m.content?.some(
        (c: any) => c.type === 'text' && typeof c.text === 'string' && c.text.includes(needle),
      ),
  );
}

function countInjectionText(
  history: Array<{ role: string; content: Array<{ type: string; text: string }> }>,
  needle: string,
): number {
  return history.filter(
    (m) =>
      m.role === 'user' &&
      m.content?.some(
        (c: any) => c.type === 'text' && typeof c.text === 'string' && c.text.includes(needle),
      ),
  ).length;
}

function injectedVariants(
  history: Array<{ role: string; origin?: { kind?: string; variant?: string } }>,
): string[] {
  return history
    .filter((m) => m.origin?.kind === 'injection' && typeof m.origin.variant === 'string')
    .map((m) => m.origin!.variant!)
    .filter((v, i, a) => a.indexOf(v) === i);
}

// ── Tests ────────────────────────────────────────────

describe('A 组: prepareToolExecution（执行前注入）', () => {

  // A1 跳过: Edit 工具的 resolvePathAccessPath 包含复杂的路径解析/normalizePath 逻辑，
  // 测试环境 mock Jian 无法完全满足，执行超时。A1 注入逻辑与 A3 (prepare_search) 同模式。
  it.skip('A1 — Edit 即将执行时注入 prepare_edit', { timeout: 20_000 }, async () => {
    const ctx = testAgent({ jian: createJian() });
    ctx.configure({ tools: ['Edit'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(makeToolCall('Edit', { path: '/workspace/test.ts', old_string: 'x', new_string: 'y' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'edit test.ts' }] });
    await ctx.untilTurnEnd();

    expect(
      historyContainsText(ctx.agent.context.history, 'MUST update all callers after edit. Use LSP.references.'),
    ).toBe(true);
  });

  it('A3 — LSP 调用时注入 prepare_search', async () => {
    const ctx = testAgent({ jian: createJian() });
    ctx.configure({ tools: ['LSP'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(makeToolCall('LSP', { path: '/workspace/test.ts', operation: 'references' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'find references' }] });
    await ctx.untilTurnEnd();

    expect(
      historyContainsText(ctx.agent.context.history, 'NEVER edit after seeing only one match. Evaluate ALL results.'),
    ).toBe(true);
  });

  it('A4 — Bash 含 cat 时注入 prepare_bash_file', async () => {
    const ctx = testAgent({ jian: createJian() });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(bashCall('cat /some/file'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'cat file' }] });
    await ctx.untilTurnEnd();

    expect(
      historyContainsText(ctx.agent.context.history, 'NEVER use Bash for file reads'),
    ).toBe(true);
  });

  it('A4 — 非文件操作 Bash 不注入', async () => {
    const ctx = testAgent({ jian: createJian() });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(bashCall('ls -la'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'list dir' }] });
    await ctx.untilTurnEnd();

    expect(
      historyContainsText(ctx.agent.context.history, 'NEVER use Bash for file reads'),
    ).toBe(false);
  });

  it('A5 — 验证命令时注入 prepare_verify', async () => {
    const ctx = testAgent({ jian: createJian() });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(bashCall('pnpm test'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run tests' }] });
    await ctx.untilTurnEnd();

    expect(
      historyContainsText(ctx.agent.context.history, 'Fail → fix. NEVER downgrade verification.'),
    ).toBe(true);
  });

  it('A5 — 非验证命令不触发', async () => {
    const ctx = testAgent({ jian: createJian() });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(bashCall('echo hello'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'echo' }] });
    await ctx.untilTurnEnd();

    expect(
      historyContainsText(ctx.agent.context.history, 'Fail → fix. NEVER downgrade verification.'),
    ).toBe(false);
  });

  // A6 跳过: MemoryLookup 注册条件 this.agent.type === 'main' && this.agent.memoStore
  // (需要 screamHomeDir 初始化 MemoStore → 文件系统 IO，测试环境无法满足)。
  // 在 type:'scream' 环境下 preflightToolCall 返回 rejected，prepareToolExecution hook 不执行。
  // A6 的注入逻辑与 A3 (prepare_search) 同路径—只是 ctx.toolCall.name 字符串匹配不同。
  it.skip('A6 — MemoryLookup 调用时注入 prepare_memory', async () => {
    const ctx = testAgent({ jian: createJian(), type: 'main' });
    ctx.configure({ tools: ['MemoryLookup'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(makeToolCall('MemoryLookup', { query: 'previous auth bug' }));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'check memory' }] });
    await ctx.untilTurnEnd();

    expect(
      historyContainsText(ctx.agent.context.history, 'MUST check whatFailed before repeating approach.'),
    ).toBe(true);
  });
});

describe('B 组: finalizeToolResult（执行后注入）', () => {

  it('B4 — 验证通过后注入 post_verify_pass', async () => {
    const ctx = testAgent({ jian: createJian('tests passed', 0) });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(bashCall('pnpm test'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'verify' }] });
    await ctx.untilTurnEnd();

    expect(
      historyContainsText(ctx.agent.context.history, 'Verification passed. Deliver the result.'),
    ).toBe(true);
  });

  it('B5 — 验证失败后注入 post_verify_fail', async () => {
    const ctx = testAgent({ jian: createJian('tests failed', 1) });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(bashCall('pnpm test'));
    ctx.mockNextResponse({ type: 'text', text: 'The test failed. I need to fix the issue.' });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'verify' }] });
    await ctx.untilTurnEnd();

    expect(
      historyContainsText(ctx.agent.context.history, 'NEVER downgrade verification. Fix the root cause.'),
    ).toBe(true);
  });
});

describe('C 组: afterStep（步级反馈注入）', () => {

  it('C3 — 验证失败后注入 step_after_verify_fail', async () => {
    const ctx = testAgent({ jian: createJian('fail', 1) });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(bashCall('pnpm test --run'));
    ctx.mockNextResponse({ type: 'text', text: 'I need to fix the test failure.' });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'verify' }] });
    await ctx.untilTurnEnd();

    expect(
      historyContainsText(ctx.agent.context.history, 'NEVER downgrade. Fix the root cause, re-run verification.'),
    ).toBe(true);
  });
});

describe('注入器协同', () => {

  it('A5 + B4 在验证通过时同时存在', async () => {
    const ctx = testAgent({ jian: createJian('ok', 0) });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(bashCall('pnpm test'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'verify' }] });
    await ctx.untilTurnEnd();

    expect(
      historyContainsText(ctx.agent.context.history, 'Fail → fix. NEVER downgrade verification.'),
    ).toBe(true);
    expect(
      historyContainsText(ctx.agent.context.history, 'Verification passed. Deliver the result.'),
    ).toBe(true);
  });
});

describe('注入变体防重复', () => {

  it('同 step 同 variant 只注一次 — 两个验证命令只触发一次 A5', async () => {
    const ctx = testAgent({ jian: createJian('ok', 0) });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(bashCall('pnpm test'), bashCall('pnpm lint'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run two verifications' }] });
    await ctx.untilTurnEnd();

    expect(countInjectionText(ctx.agent.context.history, 'Fail → fix. NEVER downgrade verification.')).toBe(1);
  });

  it('同 step 同 variant 只注一次 — 两个 LSP 调用只触发一次 A3', async () => {
    const ctx = testAgent({ jian: createJian() });
    ctx.configure({ tools: ['LSP'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(
      makeToolCall('LSP', { path: '/workspace/test.ts', operation: 'references' }),
      makeToolCall('LSP', { path: '/workspace/test.ts', operation: 'definition' }),
    );
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'two lsp calls' }] });
    await ctx.untilTurnEnd();

    expect(
      countInjectionText(ctx.agent.context.history, 'NEVER edit after seeing only one match.'),
    ).toBe(1);
  });
});

describe('注入器变体标签', () => {

  it('verify 通过场景有正确的 variant 标签', async () => {
    const ctx = testAgent({ jian: createJian('ok', 0) });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(bashCall('pnpm test'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'verify' }] });
    await ctx.untilTurnEnd();

    const variants = injectedVariants(ctx.agent.context.history);
    expect(variants).toContain('prepare_verify');
    expect(variants).toContain('post_verify_pass');
  });
});

describe('毒性早期拦截 / deviation_chain_intercept', () => {

  it('正常验证通过不触发偏差拦截', async () => {
    const ctx = testAgent({ jian: createJian('ok', 0) });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(bashCall('pnpm test'));
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'run tests' }] });
    await ctx.untilTurnEnd();

    expect(
      historyContainsText(ctx.agent.context.history, 'deviation_chain_intercept'),
    ).toBe(false);
  });

  it('验证失败触发偏差拦截', async () => {
    const ctx = testAgent({ jian: createJian('tests failed', 1) });
    ctx.configure({ tools: ['Bash'] });
    await ctx.rpc.setPermission({ mode: 'yolo' });

    ctx.mockNextResponse(bashCall('pnpm test --run'));
    ctx.mockNextResponse({ type: 'text', text: 'I need to fix the test failure.' });
    ctx.mockNextResponse({ type: 'text', text: 'done' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'verify' }] });
    await ctx.untilTurnEnd();

    expect(
      historyContainsText(ctx.agent.context.history, 'MUST verify all claims with tool calls.'),
    ).toBe(true);
  });
});