import type { ToolCall } from '@scream-code/ltod';
import { expect, it } from 'vitest';

import { createCommandJian, testAgent } from './harness/agent';

it('runs a text-only agent turn from prompt to completion', async () => {
  const ctx = testAgent();
  ctx.configure();

  ctx.mockNextResponse({ type: 'think', think: '<think-1>' }, { type: 'text', text: '<text-1>' });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

  expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
    [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "time": "<time>" }
    [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
    [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
    [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
    [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
    [emit] thinking.delta              { "turnId": 0, "delta": "<think-1>" }
    [emit] assistant.delta             { "turnId": 0, "delta": "<text-1>" }
    [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "think", "think": "<think-1>" } }, "time": "<time>" }
    [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "<text-1>" } }, "time": "<time>" }
    [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
    [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
    [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
    [emit] agent.status.updated        { "model": "mock-model", "contextTokens": 11, "maxContextTokens": 1000000, "contextUsage": 0.000011, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 3, "output": 8, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
    [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\n【行为确认】本轮验证流程完整且代码质量合规。继续。\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "feedback_positive" } }, "time": "<time>" }
    [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
  `);
  expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: []
    messages:
      user: text "Hello"
  `);
  await ctx.expectResumeMatches();
});

it('forwards provider finish diagnostics on filtered steps', async () => {
  const ctx = testAgent();
  ctx.configure();

  ctx.mockNextProviderResponse({
    parts: [{ type: 'text', text: 'blocked' }],
    finishReason: 'filtered',
    rawFinishReason: 'content_filter',
  });
  await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

  await ctx.untilTurnEnd();

  const wireStepEnd = ctx.allEvents.find(
    (event) =>
      event.type === '[wire]' &&
      event.event === 'context.append_loop_event' &&
      (event.args as { event?: { type?: string } }).event?.type === 'step.end',
  );
  const rpcStepEnd = ctx.allEvents.find(
    (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
  );

  expect(wireStepEnd?.args).toMatchObject({
    event: {
      finishReason: 'filtered',
      providerFinishReason: 'filtered',
      rawFinishReason: 'content_filter',
    },
  });
  expect(rpcStepEnd?.args).toMatchObject({
    finishReason: 'filtered',
    providerFinishReason: 'filtered',
    rawFinishReason: 'content_filter',
  });
  await ctx.expectResumeMatches();
});

it('runs an agent turn through builtin tool approval and execution', async () => {
  const bashCall: ToolCall = {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: '{"command":"printf lookup-result","timeout":60}',
  };
  const ctx = testAgent({ jian: createCommandJian('lookup-result') });
  ctx.configure({ tools: ['Bash'] });

  ctx.mockNextResponse({ type: 'text', text: 'I will run that.' }, bashCall);
  await ctx.rpc.prompt({
    input: [{ type: 'text', text: 'Run a command that prints lookup-result' }],
  });
  expect(await ctx.untilApproval(true)).toMatchInlineSnapshot(`
    [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Run a command that prints lookup-result" } ], "origin": { "kind": "user" }, "time": "<time>" }
    [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
    [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Run a command that prints lookup-result" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
    [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
    [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
    [emit] assistant.delta             { "turnId": 0, "delta": "I will run that." }
    [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf lookup-result\\",\\"timeout\\":60}" }
    [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will run that." } }, "time": "<time>" }
    [emit] requestApproval             { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf lookup-result", "display": { "kind": "command", "command": "printf lookup-result", "cwd": "<cwd>", "language": "bash" } }
  `);
  expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    system: <system-prompt>
    tools: Bash
    messages:
      user: text "Run a command that prints lookup-result"
  `);

  ctx.mockNextResponse({ type: 'text', text: 'The command printed lookup-result.' });
  expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
    [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf lookup-result", "result": { "decision": "approved", "selectedLabel": "approve" }, "time": "<time>" }
    [wire] context.append_loop_event           { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf lookup-result", "timeout": 60 }, "description": "Running: printf lookup-result", "display": { "kind": "command", "command": "printf lookup-result", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
    [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf lookup-result", "timeout": 60 }, "description": "Running: printf lookup-result", "display": { "kind": "command", "command": "printf lookup-result", "cwd": "<cwd>", "language": "bash" } }
    [wire] context.append_loop_event           { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "lookup-result" } }, "time": "<time>" }
    [emit] tool.result                         { "turnId": 0, "toolCallId": "call_bash", "output": "lookup-result" }
    [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }, "time": "<time>" }
    [emit] turn.step.completed                 { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
    [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
    [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 33, "maxContextTokens": 1000000, "contextUsage": 0.000033, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
    [wire] context.append_message              { "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\n【行为确认】本轮验证流程完整且代码质量合规。继续。\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "feedback_positive" }, "protected": false }, "time": "<time>" }
    [wire] context.append_message              { "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\n【注入器状态】\\n  code_quality_feedback: level=D count=0 lastStep=-1 score=0.6\\n  deviation_chain_intercept: level=D count=0 lastStep=-1 score=0.99\\n  feedback_positive: level=D count=1 lastStep=1 score=0.6\\n  guard_feedback_rule_1: level=D count=0 lastStep=-1 score=0.81\\n  guard_feedback_rule_2: level=D count=0 lastStep=-1 score=0.6\\n  guard_feedback_rule_3: level=D count=0 lastStep=-1 score=0.68\\n  guard_feedback_rule_4: level=D count=0 lastStep=-1 score=0.6\\n  intent_add_feature: level=D count=0 lastStep=-1 score=0.83\\n  intent_document: level=D count=0 lastStep=-1 score=0.62\\n  intent_fix_bug: level=D count=0 lastStep=-1 score=0.83\\n  intent_refactor: level=D count=0 lastStep=-1 score=0.83\\n  intent_research: level=D count=0 lastStep=-1 score=0.72\\n  intent_review: level=D count=0 lastStep=-1 score=0.72\\n  post_edit: level=D count=0 lastStep=-1 score=0.48\\n  post_memory: level=D count=0 lastStep=-1 score=0.48\\n  post_search: level=D count=0 lastStep=-1 score=0.48\\n  post_verify_fail: level=D count=0 lastStep=-1 score=0.79\\n  post_verify_pass: level=D count=0 lastStep=-1 score=0.4\\n  post_write_large: level=D count=0 lastStep=-1 score=0.4\\n  prepare_bash_file: level=D count=0 lastStep=-1 score=0.41\\n  prepare_edit: level=D count=0 lastStep=-1 score=0.68\\n  prepare_memory: level=D count=0 lastStep=-1 score=0.6\\n  prepare_search: level=D count=0 lastStep=-1 score=0.6\\n  prepare_verify: level=D count=0 lastStep=-1 score=0.68\\n  prepare_write: level=D count=0 lastStep=-1 score=0.68\\n  scene_memory_recall: level=D count=0 lastStep=-1 score=0.7\\n  step_after_edit: level=D count=0 lastStep=-1 score=0.48\\n  step_after_search: level=D count=0 lastStep=-1 score=0.4\\n  step_after_verify_fail: level=D count=0 lastStep=-1 score=0.68\\n  step_code_ref_quality: level=D count=0 lastStep=-1 score=0.43\\n  system_trigger: level=D count=0 lastStep=-1 score=0.99\\n  budget: 250 remaining, 1 this step\\n</system-reminder>" } ], "toolCalls": [], "origin": "injector_facts", "protected": false }, "time": "<time>" }
    [wire] context.append_message              { "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\nThis task spans multiple steps. Use TodoList to track the remaining work and current phase.\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "system_trigger", "name": "todo_suggested" }, "protected": false }, "time": "<time>" }
    [wire] context.append_loop_event           { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
    [emit] turn.step.started                   { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
    [emit] assistant.delta                     { "turnId": 0, "delta": "The command printed lookup-result." }
    [wire] context.append_loop_event           { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "The command printed lookup-result." } }, "time": "<time>" }
    [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 591, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
    [emit] turn.step.completed                 { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 591, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
    [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 591, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
    [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 603, "maxContextTokens": 1000000, "contextUsage": 0.000603, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 602, "output": 34, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 602, "output": 34, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 602, "output": 34, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
    [emit] turn.ended                          { "turnId": 0, "reason": "completed" }
  `);
  expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
    [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf lookup-result", "result": { "decision": "approved", "selectedLabel": "approve" }, "time": "<time>" }
    [wire] context.append_loop_event           { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf lookup-result", "timeout": 60 }, "description": "Running: printf lookup-result", "display": { "kind": "command", "command": "printf lookup-result", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
    [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf lookup-result", "timeout": 60 }, "description": "Running: printf lookup-result", "display": { "kind": "command", "command": "printf lookup-result", "cwd": "<cwd>", "language": "bash" } }
    [wire] context.append_loop_event           { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "lookup-result" } }, "time": "<time>" }
    [emit] tool.result                         { "turnId": 0, "toolCallId": "call_bash", "output": "lookup-result" }
    [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }, "time": "<time>" }
    [emit] turn.step.completed                 { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
    [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
    [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 33, "maxContextTokens": 1000000, "contextUsage": 0.000033, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 11, "output": 22, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
    [wire] context.append_message              { "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\n【行为确认】本轮验证流程完整且代码质量合规。继续。\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "feedback_positive" } }, "time": "<time>" }
    [wire] context.append_message              { "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\nThis task spans multiple steps. Use TodoList to track the remaining work and current phase.\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "system_trigger", "name": "todo_suggested" } }, "time": "<time>" }
    [wire] context.append_loop_event           { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
    [emit] turn.step.started                   { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
    [emit] assistant.delta                     { "turnId": 0, "delta": "The command printed lookup-result." }
    [wire] context.append_loop_event           { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "The command printed lookup-result." } }, "time": "<time>" }
    [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 107, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
    [emit] turn.step.completed                 { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 107, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
    [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 107, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
    [emit] agent.status.updated                { "model": "mock-model", "contextTokens": 119, "maxContextTokens": 1000000, "contextUsage": 0.000119, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 118, "output": 34, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 118, "output": 34, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 118, "output": 34, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
    [emit] turn.ended                          { "turnId": 0, "reason": "completed" }
  `);
  await ctx.expectResumeMatches();
});
