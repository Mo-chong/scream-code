import { describe, expect, it } from 'vitest';

import { ContentHashCache } from '../../../src/agent/turn/content-cache';

describe('ContentHashCache', () => {
  it('returns false for first injection (no history)', () => {
    const c = new ContentHashCache();
    expect(c.isDuplicate('system_main', '系统指令：初始化上下文...')).toBe(false);
    expect(c.size).toBe(1);
  });

  it('returns true when same variant + same content injected again', () => {
    const c = new ContentHashCache();
    c.isDuplicate('system_main', '系统指令：初始化上下文...');
    expect(c.isDuplicate('system_main', '系统指令：初始化上下文...')).toBe(true);
  });

  it('returns false when same variant but different content', () => {
    const c = new ContentHashCache();
    c.isDuplicate('intent_step', '意图：执行第二步');
    expect(c.isDuplicate('intent_step', '意图：执行第三步')).toBe(false);
  });

  it('returns false when different variant same content', () => {
    const c = new ContentHashCache();
    c.isDuplicate('intent_step', '相同内容');
    expect(c.isDuplicate('system_main', '相同内容')).toBe(false);
  });

  it('treats variant with trailing number as same key', () => {
    const c = new ContentHashCache();
    c.isDuplicate('post_step_1', '反馈内容');
    // 归一化后 key=post_step，所以 post_step_2 也去重
    expect(c.isDuplicate('post_step_2', '反馈内容')).toBe(true);
  });

  it('uses prefix (default 60 chars) for hash, ignores suffix', () => {
    const c = new ContentHashCache();
    c.isDuplicate('intent_step', 'A'.repeat(60) + '不同后缀');
    // 相同前缀视为相同
    expect(c.isDuplicate('intent_step', 'A'.repeat(60) + '不同后缀2')).toBe(true);
    // 不同前缀视为不同
    expect(c.isDuplicate('intent_step', 'B'.repeat(60) + '不同后缀')).toBe(false);
  });

  it('reset clears all cached hashes', () => {
    const c = new ContentHashCache();
    c.isDuplicate('system_main', '内容');
    c.isDuplicate('intent_step', '内容');
    expect(c.size).toBe(2);
    c.reset();
    expect(c.size).toBe(0);
    // 重置后相同内容不再去重
    expect(c.isDuplicate('system_main', '内容')).toBe(false);
  });

  it('clearVariant removes single variant', () => {
    const c = new ContentHashCache();
    c.isDuplicate('system_main', '内容A');
    c.isDuplicate('intent_step', '内容B');
    expect(c.size).toBe(2);
    c.clearVariant('system_main');
    // 清掉后 system_main 可重新注入（同时重新注册）
    expect(c.isDuplicate('system_main', '内容A')).toBe(false);
    expect(c.size).toBe(2); // intent_step + system_main 重新注册
  });
});