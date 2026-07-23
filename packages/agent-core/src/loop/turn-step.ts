/**
 * Executes one provider step.
 *
 * A step owns the provider call, atomic transcript envelope, streaming callback
 * wiring, tool-call lifecycle, and post-step hooks. Provider usage is recorded
 * immediately after `llm.chat` returns so a later abort during tool execution
 * does not lose model usage that was already spent.
 */

import { randomUUID } from 'node:crypto';
import { CheckpointManager } from '../utils/checkpoint';
import type { SnipHint } from '../utils/mask-tool-observations';
import { maskingStats, type MaskingStats } from '../utils/masking-stats';

/** Session-wide checkpoint safety net for file rewind/forward. */
export const checkpoint = new CheckpointManager();

import type { TokenUsage } from '@scream-code/ltod';
import type { Logger } from '#/logging/types';

import type { LoopEventDispatcher } from './events';
import type { LLM, LLMChatParams, LLMChatResponse } from './llm';
import { chatWithRetry } from './retry';
import { runToolCallBatch, type ToolCallStepContext } from './tool-call';
import type { ExecutableTool, LoopHooks, LoopMessageBuilder, LoopStepStopReason } from './types';
import { maskToolObservations } from '../utils/mask-tool-observations';

type ChatStreamingCallbacks = Pick<
  LLMChatParams,
  'onTextDelta' | 'onThinkDelta' | 'onToolCallDelta' | 'onTextPart' | 'onThinkPart'
>;

export interface ExecuteLoopStepDeps {
  readonly turnId: string;
  readonly signal: AbortSignal;
  readonly buildMessages: LoopMessageBuilder;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly llm: LLM;
  readonly tools?: readonly ExecutableTool[] | undefined;
  readonly hooks?: LoopHooks | undefined;
  readonly log?: Logger | undefined;
  readonly currentStep: number;
  readonly maxRetryAttempts?: number;
  readonly recordUsage: (usage: TokenUsage) => void;
  readonly hasPendingSteer?: (() => boolean) | undefined;
}

export async function executeLoopStep(deps: ExecuteLoopStepDeps): Promise<{
  readonly usage: TokenUsage;
  readonly stopReason: LoopStepStopReason;
}> {
  const {
    turnId,
    signal,
    buildMessages,
    dispatchEvent,
    llm,
    tools,
    hooks,
    log,
    currentStep,
    maxRetryAttempts,
    recordUsage,
  } = deps;

  checkpoint.beginTurn(currentStep);

  if (hooks?.beforeStep !== undefined) {
    const beforeStep = await hooks.beforeStep({
      turnId,
      stepNumber: currentStep,
      signal,
      llm,
    });
    if (beforeStep?.block === true) {
      throw new Error(beforeStep.reason ?? `Step ${String(currentStep)} was blocked`);
    }
  }

  signal.throwIfAborted();

  let messages = await buildMessages();
  // Observation masking: replace old tool results with a placeholder
  // to reduce attention overhead. Operates post-compaction on projected
  // messages — does not affect context.history.
  // Build tool name map from assistant tool_calls for enriched masking.
  const toolNameMap = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        if (tc.id && tc.name) toolNameMap.set(tc.id, tc.name);
      }
    }
  }
  // SnipHint 声明：工具输出裁剪策略
  const snipHints = new Map<string, SnipHint>([
    ['Bash', { head: 5, tail: 10 }],
    ['Read', { head: 20 }],
    ['LSP', { head: 10, tail: 30 }],
    ['Grep', { head: 10, tail: 5 }],
    ['Glob', { head: 20 }],
  ]);

  const { messages: maskMsgs, stats } = maskToolObservations(messages, undefined, toolNameMap, snipHints);
  messages = maskMsgs;
  // Per-step snapshot of masking stats (not cumulative — avoids O(N²) double-count)
  const p = maskingStats.perTurn;
  if (stats.total > 0) {
    p.total = stats.total;
    p.preservedError = stats.preservedError;
    p.resolvedError = stats.resolvedError;
    p.preservedStructured = stats.preservedStructured;
    p.compressed = stats.compressed;
    p.snipped = stats.snipped;
    p.fullyMasked = stats.fullyMasked;
    p.bytesSaved = stats.bytesSaved;
    p.codegraphStripped = stats.codegraphStripped;
  }
  signal.throwIfAborted();

  const stepUuid = randomUUID();

  const step: ToolCallStepContext = {
    tools,
    hooks,
    log,
    dispatchEvent,
    llm,
    signal,
    turnId,
    currentStep,
    stepUuid,
    hasPendingSteer: deps.hasPendingSteer,
  };

  await dispatchEvent({
    type: 'step.begin',
    uuid: stepUuid,
    turnId,
    step: currentStep,
  });

  const chatParams: LLMChatParams = {
    messages,
    tools: tools ?? [],
    signal,
    ...createChatStreamingCallbacks({
      dispatchEvent,
      turnId,
      currentStep,
      stepUuid,
    }),
  };
  const response: LLMChatResponse = await chatWithRetry({
    llm,
    params: chatParams,
    dispatchEvent,
    turnId,
    currentStep,
    stepUuid,
    maxAttempts: maxRetryAttempts,
    log,
  });
  const usage = response.usage;
  recordUsage(usage);
  // Log cache metrics for observability — the baseline we need before
  // evaluating whether further cache_control tuning is warranted.
  if (log !== undefined) {
    log.info('llm cache metrics', {
      cacheRead: usage.inputCacheRead,
      cacheCreation: usage.inputCacheCreation,
      inputOther: usage.inputOther,
      step: currentStep,
    });
  }
  const stopReason = deriveStepStopReason(response);

  // Execute tools only when the normalized response shape represents a tool
  // step. Provider terminal diagnostics such as filtering or truncation must
  // not trigger side-effecting tool execution even if a malformed response also
  // contains tool calls.
  let effectiveStopReason = stopReason;
  if (stopReason === 'tool_use') {
    // Pre-execution checkpoint: snapshot files before writer tools
    for (const tc of response.toolCalls ?? []) {
      const toolName = tc.name ?? tc.function?.name;
      if (toolName !== 'Edit' && toolName !== 'Write') continue;
      const args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : tc.parsedArgs;
      if (args?.path) checkpoint.snapshot(args.path);
    }
    const toolBatch = await runToolCallBatch(step, response);
    if (toolBatch.stopTurn) effectiveStopReason = 'end_turn';
  }

  // When a tool batch runs, it drains paired `tool.result` events even when
  // cancellation is requested. Check the signal here before sealing the step.
  signal.throwIfAborted();

  await dispatchEvent({
    type: 'step.end',
    uuid: stepUuid,
    turnId,
    step: currentStep,
    usage,
    finishReason: effectiveStopReason,
    llmFirstTokenLatencyMs: response.streamTiming?.firstTokenLatencyMs,
    llmStreamDurationMs: response.streamTiming?.streamDurationMs,
    ...stepEndProviderDiagnostics(response, effectiveStopReason),
  });

  if (hooks?.afterStep !== undefined) {
    try {
      await hooks.afterStep({
        turnId,
        stepNumber: currentStep,
        usage,
        stopReason: effectiveStopReason,
        signal,
        llm,
      });
    } catch {
      // The step is already sealed; observer hooks cannot change the result.
    }
  }

  return { usage, stopReason: effectiveStopReason };
}

function deriveStepStopReason(response: LLMChatResponse): LoopStepStopReason {
  switch (response.providerFinishReason) {
    case 'truncated':
      return 'max_tokens';
    case 'filtered':
      return 'filtered';
    case 'paused':
      return 'paused';
    case 'other':
      return 'unknown';
    case 'completed':
    case undefined:
      return response.toolCalls.length > 0 ? 'tool_use' : 'end_turn';
    case 'tool_calls':
      return response.toolCalls.length > 0 ? 'tool_use' : 'unknown';
    default: {
      const _exhaustive: never = response.providerFinishReason;
      return _exhaustive;
    }
  }
}

function stepEndProviderDiagnostics(
  response: LLMChatResponse,
  stopReason: LoopStepStopReason,
): Pick<LLMChatResponse, 'providerFinishReason' | 'rawFinishReason'> {
  const providerFinishReason = response.providerFinishReason;
  if (
    (providerFinishReason === 'completed' && stopReason === 'end_turn') ||
    (providerFinishReason === 'tool_calls' && stopReason === 'tool_use')
  ) {
    return {};
  }

  return {
    ...(providerFinishReason !== undefined ? { providerFinishReason } : {}),
    ...(response.rawFinishReason !== undefined
      ? { rawFinishReason: response.rawFinishReason }
      : {}),
  };
}

function createChatStreamingCallbacks(deps: {
  readonly dispatchEvent: LoopEventDispatcher;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
}): ChatStreamingCallbacks {
  const { dispatchEvent, turnId, currentStep, stepUuid } = deps;

  return {
    onTextDelta: (delta) => {
      dispatchEvent({ type: 'text.delta', delta });
    },
    onThinkDelta: (delta) => {
      dispatchEvent({ type: 'thinking.delta', delta });
    },
    onToolCallDelta: (delta) => {
      dispatchEvent({
        type: 'tool.call.delta',
        toolCallId: delta.toolCallId,
        name: delta.name,
        argumentsPart: delta.argumentsPart,
      });
    },
    onTextPart: async (part) => {
      await dispatchEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId,
        step: currentStep,
        stepUuid,
        part,
      });
    },
    onThinkPart: async (part) => {
      await dispatchEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId,
        step: currentStep,
        stepUuid,
        part,
      });
    },
  };
}
