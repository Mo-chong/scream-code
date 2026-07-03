import { describe, it, expect } from 'vitest';
import { checkGuard } from '../../../src/agent/turn/guard-engine';
import type { ContextMessage, StepToolSummary } from '../../../src/agent/turn/guard-engine';

/** Minimal ContextMessage stub — content uses Array<{type, text}> format */
function msg(role: 'user' | 'assistant' | 'tool', text: string): ContextMessage {
  return { role, content: [{ type: 'text', text }] };
}

/** Minimal StepToolSummary builder — only set fields you want non-default */
function tools(partial: Partial<StepToolSummary> = {}): StepToolSummary {
  return {
    hasKnowledgeTools: false,
    hasWriteTools: false,
    lastBashExitCode: null,
    hasMemoryLookup: false,
    hasCurrentCodeTools: false,
    ...partial,
  };
}

describe('checkGuard', () => {
  // ── Rule 1: exit code mismatch ──────────────────────────────

  it('Rule 1 triggers when lastBashExitCode=1 and text says passed', () => {
    const history = [msg('assistant', '测试通过，所有用例全部通过')];
    const result = checkGuard(history, tools({ lastBashExitCode: 1 }));
    expect(result.rule).toBe(1);
    expect(result.block).toBe(true);
  });

  it('Rule 1 does not trigger when lastBashExitCode=0', () => {
    const history = [msg('assistant', '测试通过，所有用例全部通过')];
    const result = checkGuard(history, tools({ lastBashExitCode: 0 }));
    expect(result.rule).toBe(0);
  });

  it('Rule 1 does not trigger when exit code 1 but no pass phrase', () => {
    const history = [msg('assistant', '报错了，exit code 1')];
    const result = checkGuard(history, tools({ lastBashExitCode: 1 }));
    expect(result.rule).toBe(0);
  });

  // ── Rule 2: unverified claim ───────────────────────────────

  it('Rule 2 triggers when hasKnowledgeTools=false and agent says 检查发现', () => {
    const history = [msg('assistant', '检查发现代码中有问题')];
    const result = checkGuard(history, tools({ hasKnowledgeTools: false }));
    expect(result.rule).toBe(2);
    expect(result.block).toBe(false);
    expect(result.reason).toMatch(/检查发现/);
  });

  it('Rule 2 triggers when hasKnowledgeTools=false and agent says 我看到', () => {
    const history = [msg('assistant', '我发现这个函数的实现有问题')];
    const result = checkGuard(history, tools({ hasKnowledgeTools: false }));
    expect(result.rule).toBe(2);
    expect(result.block).toBe(false);
    expect(result.reason).toMatch(/检查发现|我发现/);
  });

  it('Rule 2 does not trigger when hasKnowledgeTools=true', () => {
    const history = [msg('assistant', '检查发现代码中有问题')];
    const result = checkGuard(history, tools({ hasKnowledgeTools: true }));
    expect(result.rule).toBe(0);
  });

  // ── Rule 3: unverified edit claim ──────────────────────────

  it('Rule 3 triggers when hasWriteTools=false and agent says 已修改', () => {
    const history = [msg('assistant', '已修改该文件')];
    const result = checkGuard(history, tools({ hasWriteTools: false }));
    expect(result.rule).toBe(3);
    expect(result.block).toBe(false);
    expect(result.reason).toMatch(/已修改/);
  });

  it('Rule 3 triggers when hasWriteTools=false and agent says 已删除', () => {
    const history = [msg('assistant', '已删除无用代码')];
    const result = checkGuard(history, tools({ hasWriteTools: false }));
    expect(result.rule).toBe(3);
    expect(result.block).toBe(false);
    expect(result.reason).toMatch(/已修改/);
  });

  it('Rule 3 does not trigger when hasWriteTools=true', () => {
    const history = [msg('assistant', '已修改该文件')];
    const result = checkGuard(history, tools({ hasWriteTools: true }));
    expect(result.rule).toBe(0);
  });

  // ── Rule 4: memory-only claim ──────────────────────────────

  it('Rule 4 triggers when hasMemoryLookup=true and hasCurrentCodeTools=false', () => {
    const history = [msg('assistant', '函数返回值是 true')];
    const result = checkGuard(history, tools({ hasMemoryLookup: true, hasCurrentCodeTools: false }));
    expect(result.rule).toBe(4);
    expect(result.block).toBe(false);
    expect(result.reason).toMatch(/MemoryLookup/);
  });

  it('Rule 4 triggers with 文件中写 pattern', () => {
    const history = [msg('assistant', '文件中写了这个逻辑')];
    const result = checkGuard(history, tools({ hasMemoryLookup: true, hasCurrentCodeTools: false }));
    expect(result.rule).toBe(4);
    expect(result.block).toBe(false);
    expect(result.reason).toMatch(/MemoryLookup/);
  });

  it('Rule 4 does not trigger when hasCurrentCodeTools=true', () => {
    const history = [msg('assistant', '函数返回值是 true')];
    const result = checkGuard(history, tools({ hasMemoryLookup: true, hasCurrentCodeTools: true }));
    expect(result.rule).toBe(0);
  });

  it('Rule 4 does not trigger when hasMemoryLookup=false', () => {
    const history = [msg('assistant', '函数返回值是 true')];
    const result = checkGuard(history, tools({ hasMemoryLookup: false, hasCurrentCodeTools: false }));
    expect(result.rule).toBe(0);
  });

  // ── Priority: higher rule wins ─────────────────────────────

  it('Rule 1 takes priority over Rule 2 when both match', () => {
    // Rule 1 checked first in guard-engine.ts
    const history = [msg('assistant', '检查发现测试通过')];
    const result = checkGuard(history, tools({ hasKnowledgeTools: false, lastBashExitCode: 1 }));
    expect(result.rule).toBe(1);
    expect(result.block).toBe(true);
  });
});