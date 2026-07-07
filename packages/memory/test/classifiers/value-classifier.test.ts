import { describe, it, expect } from 'vitest';
import { classifyValueTier, buildMemoClassifyText } from '../../src/classifiers/value-classifier.js';

describe('classifyValueTier', () => {
  // critical (rule 1-2): bug/fix/修复/填坑/root cause etc
  it('matches "bug" as critical', () => {
    expect(classifyValueTier('I found a critical bug in the auth module today')).toBe('critical');
  });
  it('matches "fix" as critical', () => {
    expect(classifyValueTier('I had to fix the memory leak in the production database')).toBe('critical');
  });
  it('matches "crash" as critical', () => {
    expect(classifyValueTier('the whole server crashes on startup every time now')).toBe('critical');
  });
  it('matches "breaking change" as critical', () => {
    expect(classifyValueTier('there is a breaking change in the API contract design')).toBe('critical');
  });
  it('matches "rollback" as critical', () => {
    expect(classifyValueTier('we need to rollback the last deployment to fix it')).toBe('critical');
  });
  it('matches "root cause" as critical', () => {
    expect(classifyValueTier('root cause analysis of the production issue today')).toBe('critical');
  });

  // valuable (rule 3-5): learned/security/implementation/经验/方案 etc
  it('matches "security" as valuable', () => {
    expect(classifyValueTier('I added new security features in the auth module today')).toBe('valuable');
  });
  it('matches "performance" as valuable', () => {
    expect(classifyValueTier('I improved the query performance by adding an index to the table')).toBe('valuable');
  });
  it('matches "learned" as valuable', () => {
    expect(classifyValueTier('I learned a lot about WebAssembly internals in the training')).toBe('valuable');
  });
  it('matches Chinese 设计 as valuable', () => {
    expect(classifyValueTier('我设计了新的系统架构方案来提升整体性能')).toBe('valuable');
  });
  it('matches Chinese 经验 as valuable', () => {
    expect(classifyValueTier('总结了这个重要的调试经验分享给整个开发团队')).toBe('valuable');
  });
  it('matches "best practice" as valuable', () => {
    expect(classifyValueTier('we need to follow the best practice for error handling code')).toBe('valuable');
  });

  // low (rule 6-7)
  it('matches "checklist" as low', () => {
    expect(classifyValueTier('I created the deployment checklist for the new release version')).toBe('low');
  });
  it('matches "meeting" as low', () => {
    expect(classifyValueTier('I had a team standup meeting today in the morning')).toBe('low');
  });
  it('matches "review" as low', () => {
    expect(classifyValueTier('I did a code review for the new pull request yesterday')).toBe('low');
  });
  it('matches "todo" as low', () => {
    expect(classifyValueTier('I wrote some todo items for the next sprint planning today')).toBe('low');
  });

  // fallback: very short (< 30 chars) → low
  it('returns low for very short text', () => {
    expect(classifyValueTier('hi')).toBe('low');
  });

  // normal: >= 30 chars with no keyword match, not matching "today" etc
  it('returns normal for longer text with no keywords', () => {
    expect(classifyValueTier('I went outside for a walk and enjoyed the fresh air')).toBe('normal');
  });

  // priority: first matching rule wins
  it('critical > low', () => {
    expect(classifyValueTier('I found a bug and did a review of the code today')).toBe('critical');
  });
  it('valuable > low', () => {
    expect(classifyValueTier('I learned a lot about security and did a review of the code')).toBe('valuable');
  });
});

describe('buildMemoClassifyText', () => {
  it('concatenates key fields', () => {
    const t = buildMemoClassifyText({ userNeed: 'A', approach: 'B', outcome: 'C', whatWorked: 'D', whatFailed: 'none' });
    expect(t).toContain('A');
    expect(t).toContain('B');
    expect(t).toContain('C');
    expect(t).toContain('D');
  });
  it('skips none/n/a', () => {
    const t = buildMemoClassifyText({ userNeed: 'X', approach: 'Y', outcome: 'Z', whatFailed: 'none', whatWorked: 'n/a' });
    expect(t).not.toContain('none');
    expect(t).not.toContain('n/a');
  });
  it('handles empty input', () => {
    expect(buildMemoClassifyText({})).toBe('');
  });
});
