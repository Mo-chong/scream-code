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
  ['call_0', 'Read'],
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
    // keepLastN=1 → last OLD tool result (call_2) is unmasked, first OLD (call_1) is masked
    // Current round (call_3 after assistant[tc]) is never masked
    assert.ok(result.messages, 'should return messages');
    assert.ok(result.recoverable, 'should return recoverable array');
    assert.strictEqual(result.recoverable.length, 1, '1 old tool result should have a record');
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
      // Old tool result before assistant(tc) — will be masked
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_0', name: 'Read', args: {} }] } as unknown as Message,
      { role: 'tool', toolCallId: 'call_0', content: [{ type: 'text', text: 'X'.repeat(300) }], toolUseId: 'call_0' } as unknown as Message,
      // Current round — not masked
      makeAssistantMessage(['call_1']),
      makeToolMessage(1, 300),
    ];

    const result = maskToolObservations(messages, 0, toolNameMap);
    const rec = result.recoverable[0];
    assert.ok(rec, 'should have a record');
    assert.ok(rec.key.startsWith('micro:call_'), 'key should start with micro:');
    assert.strictEqual(rec.toolCallId, 'call_0', 'toolCallId should match');
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

