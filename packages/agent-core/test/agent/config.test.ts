import type { ModelCapability, ProviderConfig, ToolCall } from '@scream-code/ltod';
import { describe, expect, it } from 'vitest';

import type { ResolvedAgentProfile } from '../../src/profile';
import { createCommandJian, testAgent } from './harness/agent';
import { DEFAULT_TEST_SYSTEM_PROMPT } from './harness/snapshots';

describe('Agent config', () => {
  it('exposes provider, system prompt, thinking level, and model capability updates', async () => {
    const ctx = testAgent();
    const initialProvider: ProviderConfig = {
      type: 'openai',
      apiKey: 'sk-initial',
      baseUrl: 'https://initial.example/v1',
      model: 'gpt-initial',
    };
    const initialCapability: ModelCapability = {
      image_in: true,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
      max_context_tokens: 128000,
    };
    ctx.configure({
      provider: initialProvider,
      modelCapabilities: initialCapability,
    });

    await expect(ctx.rpc.getConfig({})).resolves.toMatchObject({
      provider: initialProvider,
      systemPrompt: DEFAULT_TEST_SYSTEM_PROMPT,
      thinkingLevel: 'off',
      modelCapabilities: initialCapability,
    });

    const nextProvider: ProviderConfig = {
      type: 'scream',
      apiKey: 'sk-next',
      baseUrl: 'https://next.example/v1',
      model: 'scream-next',
    };
    const nextCapability: ModelCapability = {
      image_in: true,
      video_in: true,
      audio_in: false,
      thinking: true,
      tool_use: true,
      max_context_tokens: 262144,
    };
    ctx.configureRuntimeModel(nextProvider, nextCapability);
    ctx.agent.config.update({
      systemPrompt: 'Changed profile prompt.',
      thinkingLevel: 'high',
    });

    await expect(ctx.rpc.getConfig({})).resolves.toMatchObject({
      provider: nextProvider,
      systemPrompt: 'Changed profile prompt.',
      thinkingLevel: 'high',
      modelCapabilities: nextCapability,
    });
    await ctx.expectResumeMatches();
  });

  it('useProfile emits the rendered system prompt and active tools', async () => {
    const ctx = testAgent();
    ctx.configure();
    const profile: ResolvedAgentProfile = {
      name: 'test-profile',
      systemPrompt: () => 'Profile system prompt.',
      tools: ['Bash'],
    };

    ctx.agent.useProfile(profile);

    expect(ctx.newEvents()).toMatchInlineSnapshot(`
      [wire] config.update            { "profileName": "test-profile", "systemPrompt": "Profile system prompt.", "time": "<time>" }
      [emit] agent.status.updated     { "model": "mock-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "permission": "manual" }
      [wire] tools.set_active_tools   { "names": [ "Bash" ], "time": "<time>" }
    `);
    await ctx.expectResumeMatches();
  });

  it('config.update with cwd initializes builtin tools', async () => {
    const ctx = testAgent();
    ctx.configure();

    const tools = await ctx.rpc.getTools({});

    expect(toolNames(tools)).toEqual(
      expect.arrayContaining(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob']),
    );
    await ctx.expectResumeMatches();
  });

  it('keeps turn-start config for later steps and applies updates to the next turn', async () => {
    const bashCall: ToolCall = {
      type: 'function',
      id: 'call_bash',
      name: 'Bash',
      arguments: '{"command":"printf original-result","timeout":60}',
    };
    const ctx = testAgent({ jian: createCommandJian('original-result') });
    ctx.configure({ tools: ['Bash'] });

    ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall);
    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'Run Bash before config changes' }],
    });
    expect(await ctx.untilApproval(true)).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Run Bash before config changes" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Run Bash before config changes" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [emit] assistant.delta             { "turnId": 0, "delta": "I will run Bash." }
      [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "argumentsPart": "{\\"command\\":\\"printf original-result\\",\\"timeout\\":60}" }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will run Bash." } }, "time": "<time>" }
      [emit] requestApproval             { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf original-result", "display": { "kind": "command", "command": "printf original-result", "cwd": "<cwd>", "language": "bash" } }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash
      messages:
        user: text "Run Bash before config changes"
    `);

    ctx.configureRuntimeModel({
      type: 'scream',
      apiKey: 'test-key',
      model: 'changed-model',
    });
    ctx.agent.config.update({ systemPrompt: 'Changed system prompt.' });
    await ctx.rpc.setActiveTools({ names: [] });

    ctx.mockNextResponse({ type: 'text', text: 'Still using the original turn config.' });
    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      [wire] config.update                       { "modelAlias": "changed-model", "time": "<time>" }
      [emit] agent.status.updated                { "model": "changed-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "permission": "manual" }
      [wire] config.update                       { "systemPrompt": "Changed system prompt.", "time": "<time>" }
      [emit] agent.status.updated                { "model": "changed-model", "contextTokens": 0, "maxContextTokens": 1000000, "contextUsage": 0, "planMode": false, "permission": "manual" }
      [wire] tools.set_active_tools              { "names": [], "time": "<time>" }
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_bash", "toolName": "Bash", "action": "Running: printf original-result", "result": { "decision": "approved", "selectedLabel": "approve" }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "tool.call", "uuid": "call_bash", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf original-result", "timeout": 60 }, "description": "Running: printf original-result", "display": { "kind": "command", "command": "printf original-result", "cwd": "<cwd>", "language": "bash" } }, "time": "<time>" }
      [emit] tool.call.started                   { "turnId": 0, "toolCallId": "call_bash", "name": "Bash", "args": { "command": "printf original-result", "timeout": 60 }, "description": "Running: printf original-result", "display": { "kind": "command", "command": "printf original-result", "cwd": "<cwd>", "language": "bash" } }
      [wire] context.append_loop_event           { "event": { "type": "tool.result", "parentUuid": "call_bash", "toolCallId": "call_bash", "result": { "output": "original-result" } }, "time": "<time>" }
      [emit] tool.result                         { "turnId": 0, "toolCallId": "call_bash", "output": "original-result" }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "usage": { "inputOther": 9, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }, "time": "<time>" }
      [emit] turn.step.completed                 { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 9, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use" }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 9, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated                { "model": "changed-model", "contextTokens": 32, "maxContextTokens": 1000000, "contextUsage": 0.000032, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 9, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 9, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 9, "output": 23, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_message              { "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\n【行为确认】本轮验证流程完整且代码质量合规。继续。\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "feedback_positive" } }, "time": "<time>" }
      [wire] context.append_message              { "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\nThis task spans multiple steps. Use TodoList to track the remaining work and current phase.\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "system_trigger", "name": "todo_suggested" } }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "step.begin", "uuid": "<uuid-3>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [emit] turn.step.started                   { "turnId": 0, "step": 2, "stepId": "<uuid-3>" }
      [emit] assistant.delta                     { "turnId": 0, "delta": "Still using the original turn config." }
      [wire] context.append_loop_event           { "event": { "type": "content.part", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "stepUuid": "<uuid-3>", "part": { "type": "text", "text": "Still using the original turn config." } }, "time": "<time>" }
      [wire] context.append_loop_event           { "event": { "type": "step.end", "uuid": "<uuid-3>", "turnId": "0", "step": 2, "usage": { "inputOther": 106, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed                 { "turnId": 0, "step": 2, "stepId": "<uuid-3>", "usage": { "inputOther": 106, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                        { "model": "mock-model", "usage": { "inputOther": 106, "output": 13, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated                { "model": "changed-model", "contextTokens": 119, "maxContextTokens": 1000000, "contextUsage": 0.000119, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 115, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 115, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 115, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [emit] turn.ended                          { "turnId": 0, "reason": "completed" }
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "I will run Bash."  calls call_bash:Bash { "command": "printf original-result", "timeout": 60 }
        tool[call_bash]: text "original-result"
        user: text "<system-reminder>\\n【行为确认】本轮验证流程完整且代码质量合规。继续。\\n</system-reminder>"
        user: text "<system-reminder>\\n【注入器状态】\\n  code_quality_feedback: level=D count=0 lastStep=-1 score=0.6\\n  deviation_chain_intercept: level=D count=0 lastStep=-1 score=0.99\\n  feedback_positive: level=D count=1 lastStep=1 score=0.6\\n  guard_feedback_rule_1: level=D count=0 lastStep=-1 score=0.81\\n  guard_feedback_rule_2: level=D count=0 lastStep=-1 score=0.6\\n  guard_feedback_rule_3: level=D count=0 lastStep=-1 score=0.68\\n  guard_feedback_rule_4: level=D count=0 lastStep=-1 score=0.6\\n  intent_add_feature: level=D count=0 lastStep=-1 score=0.83\\n  intent_document: level=D count=0 lastStep=-1 score=0.62\\n  intent_fix_bug: level=D count=0 lastStep=-1 score=0.83\\n  intent_refactor: level=D count=0 lastStep=-1 score=0.83\\n  intent_research: level=D count=0 lastStep=-1 score=0.72\\n  intent_review: level=D count=0 lastStep=-1 score=0.72\\n  post_edit: level=D count=0 lastStep=-1 score=0.48\\n  post_memory: level=D count=0 lastStep=-1 score=0.48\\n  post_search: level=D count=0 lastStep=-1 score=0.48\\n  post_verify_fail: level=D count=0 lastStep=-1 score=0.79\\n  post_verify_pass: level=D count=0 lastStep=-1 score=0.4\\n  post_write_large: level=D count=0 lastStep=-1 score=0.4\\n  prepare_bash_file: level=D count=0 lastStep=-1 score=0.41\\n  prepare_edit: level=D count=0 lastStep=-1 score=0.68\\n  prepare_memory: level=D count=0 lastStep=-1 score=0.6\\n  prepare_search: level=D count=0 lastStep=-1 score=0.6\\n  prepare_verify: level=D count=0 lastStep=-1 score=0.68\\n  prepare_write: level=D count=0 lastStep=-1 score=0.68\\n  scene_memory_recall: level=D count=0 lastStep=-1 score=0.7\\n  step_after_edit: level=D count=0 lastStep=-1 score=0.48\\n  step_after_search: level=D count=0 lastStep=-1 score=0.4\\n  step_after_verify_fail: level=D count=0 lastStep=-1 score=0.68\\n  step_code_ref_quality: level=D count=0 lastStep=-1 score=0.43\\n  system_trigger: level=D count=0 lastStep=-1 score=0.99\\n  budget: 250 remaining, 1 this step\\n</system-reminder>"
        user: text "<system-reminder>\\nThis task spans multiple steps. Use TodoList to track the remaining work and current phase.\\n</system-reminder>"
    `);

    ctx.mockNextResponse({ type: 'text', text: 'Now the changed config is active.' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Start a fresh turn' }] });

    expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "I will run Bash."  calls call_bash:Bash { "command": "printf original-result", "timeout": 60 }
        tool[call_bash]: text "original-result"
        user: text "<system-reminder>\\n【行为确认】本轮验证流程完整且代码质量合规。继续。\\n</system-reminder>"
        user: text "<system-reminder>\\nThis task spans multiple steps. Use TodoList to track the remaining work and current phase.\\n</system-reminder>"
    `);
    expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Start a fresh turn" } ], "origin": { "kind": "user" }, "time": "<time>" }
      [emit] turn.started                { "turnId": 1, "origin": { "kind": "user" } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Start a fresh turn" } ], "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\n## 当前会话状态\\n\\n### 最近操作\\n\\n- ✅ Bash — printf original-result\\n\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "session_memory" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-5>", "turnId": "1", "step": 1 }, "time": "<time>" }
      [emit] turn.step.started           { "turnId": 1, "step": 1, "stepId": "<uuid-5>" }
      [emit] assistant.delta             { "turnId": 1, "delta": "Now the changed config is active." }
      [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-6>", "turnId": "1", "step": 1, "stepUuid": "<uuid-5>", "part": { "type": "text", "text": "Now the changed config is active." } }, "time": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-5>", "turnId": "1", "step": 1, "usage": { "inputOther": 158, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }, "time": "<time>" }
      [emit] turn.step.completed         { "turnId": 1, "step": 1, "stepId": "<uuid-5>", "usage": { "inputOther": 158, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn" }
      [wire] usage.record                { "model": "changed-model", "usage": { "inputOther": 158, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "model": "changed-model", "contextTokens": 170, "maxContextTokens": 1000000, "contextUsage": 0.00017, "planMode": false, "permission": "manual", "usage": { "byModel": { "mock-model": { "inputOther": 115, "output": 36, "inputCacheRead": 0, "inputCacheCreation": 0 }, "changed-model": { "inputOther": 158, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 273, "output": 48, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 158, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\n### 拦截日志\\n\\n- injection_delivered/injected: 1 次\\n  · 第0步: [session_memory] Injected session_memory (lv=D)\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "interception_log" } }, "time": "<time>" }
      [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\n【行为确认】本轮验证流程完整且代码质量合规。继续。\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "feedback_positive" } }, "time": "<time>" }
      [emit] turn.ended                  { "turnId": 1, "reason": "completed" }
    `);
    await ctx.expectResumeMatches();
  });
});

function toolNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (item === null || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      return typeof record['name'] === 'string' ? record['name'] : null;
    })
    .filter((name): name is string => name !== null);
}
