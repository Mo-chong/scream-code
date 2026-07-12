import { describe, it, assert } from 'vitest';
import { maskToolObservations, type RecoverableRecord } from '../../src/utils/mask-tool-observations';
import type { Message } from '@scream-code/ltod';

function makeToolMessage(i: number, contentLen = 500): Message {
  return {
    role: 'tool',
    toolCallId: `call_${i}`,
    content: [{ type: 'text', text: 'X'.repeat(contentLen) }],
    toolUseId: `call_${i}`,
  } as unknown as Message;
}

function makeAssistantMessage(toolIds: string[]): Message {
  return {
    role: 'assistant',
    content: '',
    toolCalls: toolIds.map(id => ({ id, name: 'Read', args: {} } as any)),
  } as unknown as Message;
}

const toolNameMap = new Map<string, string>([
  ['call_1', 'Read'],
  ['call_2', 'Bash'],
  ['call_3', 'Grep'],
]);

describe('Phase39 — maskToolObservations pipeline', () => {

  it('returns recoverable records for masked tool results', () => {
    const messages: Message[] = [
      makeAssistantMessage(['call_1', 'call_2']),
      makeToolMessage(1),
      makeToolMessage(2),
      makeAssistantMessage(['call_3']),
      makeToolMessage(3),
    ];

    const result = maskToolObservations(messages, 1, toolNameMap);
    // keepLastN=1 → last tool is unmasked, first 2 are masked
    assert.ok(result.messages, 'should return messages');
    assert.ok(result.recoverable, 'should return recoverable array');
    assert.strictEqual(result.recoverable.length, 2, '2 old tool results should have records');
  });

  it('masks old tool results and keeps the last N', () => {
    const messages: Message[] = [
      makeAssistantMessage(['call_1', 'call_2']),
      makeToolMessage(1),
      makeToolMessage(2),
      makeAssistantMessage(['call_3']),
      makeToolMessage(3),
    ];

    const result = maskToolObservations(messages, 1, toolNameMap);
    const lastTool = result.messages[result.messages.length - 1];
    // Last tool should still have full content (not masked)
    const lastContent = lastTool?.content;
    const text = typeof lastContent === 'string'
      ? lastContent
      : Array.isArray(lastContent)
        ? lastContent.map((c: any) => c.text ?? '').join('')
        : '';
    assert.ok(text.includes('XXXXX'), 'last tool result should be unmasked');
  });

  it('short tool results (<100 chars) are not masked', () => {
    const shortContent = 'ok';
    const messages: Message[] = [
      makeAssistantMessage(['call_1']),
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: shortContent }], toolUseId: 'call_1' } as unknown as Message,
    ];

    const result = maskToolObservations(messages, 0, toolNameMap);
    // keepLastN=0 but content < 100 chars → should NOT be masked
    const tool = result.messages[result.messages.length - 1];
    const text = typeof tool?.content === 'string'
      ? tool.content
      : Array.isArray(tool?.content)
        ? (tool.content as any[]).map(c => c.text ?? '').join('')
        : '';
    assert.ok(text.includes(shortContent), 'short content should be preserved');
    assert.strictEqual(result.recoverable.length, 0, 'short results should not produce records');
  });

  it('RecoverableRecord has correct fields', () => {
    const messages: Message[] = [
      makeAssistantMessage(['call_1']),
      makeToolMessage(1, 300),
    ];

    const result = maskToolObservations(messages, 0, toolNameMap);
    const rec = result.recoverable[0];
    assert.ok(rec, 'should have a record');
    assert.ok(rec.key.startsWith('micro:call_'), 'key should start with micro:');
    assert.strictEqual(rec.toolCallId, 'call_1', 'toolCallId should match');
    assert.strictEqual(rec.toolName, 'Read', 'toolName should be Read');
    assert.strictEqual(rec.priority, 1, 'Read should have priority 1 (FILE_OPS)');
    assert.ok(rec.summary.length <= 300, 'summary should be ≤ content length');
  });

  it('empty or short messages produce empty result', () => {
    const result = maskToolObservations([], undefined, toolNameMap);
    assert.strictEqual(result.messages.length, 0);
    assert.strictEqual(result.recoverable.length, 0);
  });

});

import { mergeOldToolPairs } from '../../src/utils/mask-tool-observations';

describe('Phase40 — mergeOldToolPairs', () => {

  it('merges old tool pairs into single assistant messages', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'read files' }] } as unknown as Message,
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_a', name: 'Read', args: { path: 'a.ts' } }] } as unknown as Message,
      { role: 'tool', toolCallId: 'call_a', content: [{ type: 'text', text: '[已遮蔽·key:micro:call_a·Read·archive_recover可取回]' }], toolUseId: 'call_a' } as unknown as Message,
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_b', name: 'Read', args: { path: 'b.ts' } }] } as unknown as Message,
      { role: 'tool', toolCallId: 'call_b', content: [{ type: 'text', text: '[已遮蔽·key:micro:call_b·Read·archive_recover可取回]' }], toolUseId: 'call_b' } as unknown as Message,
    ];

    // keepLastNPairs=1 — keep only the last pair, merge the first
    const result = mergeOldToolPairs(messages, 1);

    // user msg stays
    assert.strictEqual(result[0]?.role, 'user');
    // first pair merged: 2 messages → 1
    assert.strictEqual(result[1]?.role, 'assistant');
    assert.strictEqual((result[1] as any).toolCalls, undefined, 'merged pair should not have toolCalls');
    assert.ok((result[1]?.content as unknown as string)?.includes('调用 Read'), 'merged content should describe the call');
    // second pair intact (kept as last)
    assert.strictEqual(result[2]?.role, 'assistant');
    assert.ok((result[2] as any).toolCalls, 'kept pair should still have toolCalls');
    assert.strictEqual(result[3]?.role, 'tool', 'kept pair should still have tool result');

    // Total: user(1) + merged(1) + kept pair(2) = 4 instead of original 5
    assert.strictEqual(result.length, 4, 'should reduce 5 messages to 4');
  });

  it('preserves all messages when all pairs are kept', () => {
    const messages: Message[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'Read', args: {} }] } as unknown as Message,
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } as unknown as Message,
    ];

    const result = mergeOldToolPairs(messages, 3);
    assert.strictEqual(result.length, 2, 'should keep both messages when under keep limit');
  });

  it('handles empty input', () => {
    assert.strictEqual(mergeOldToolPairs([], 3).length, 0);
  });

});

