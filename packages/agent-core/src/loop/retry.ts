import { sleep } from '@antfu/utils';
import * as retry from 'retry';
import {
  APIContextOverflowError,
  APIProviderRateLimitError,
  calculateRateLimitBackoffMs,
} from '@scream-code/ltod';

import type { Logger } from '#/logging/types';

import { abortable } from '../utils/abort';
import type { LoopEventDispatcher } from './events';
import { isAbortError } from './errors';
import type { LLM, LLMChatParams, LLMChatResponse } from './llm';

export const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

const RETRY_MIN_TIMEOUT_MS = 300;
const RETRY_MAX_TIMEOUT_MS = 5000;
const RETRY_FACTOR = 2;

export interface ChatWithRetryInput {
  readonly llm: LLM;
  readonly params: LLMChatParams;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
  readonly maxAttempts?: number;
  readonly log?: Logger | undefined;
}

export async function chatWithRetry(input: ChatWithRetryInput): Promise<LLMChatResponse> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;

  if (input.llm.isRetryableError === undefined || maxAttempts <= 1) {
    const effectiveMaxAttempts = Math.max(maxAttempts, 1);
    try {
      return await input.llm.chat(paramsForAttempt(input, 1, effectiveMaxAttempts));
    } catch (error) {
      logRequestFailure(input, error, 1, effectiveMaxAttempts);
      throw error;
    }
  }

  const delays = retryBackoffDelays(maxAttempts);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await input.llm.chat(paramsForAttempt(input, attempt, maxAttempts));
    } catch (error) {
      // Overflow errors can't be fixed by retrying — they need compaction.
      // Fail fast so the turn-level handler can trigger emergency compaction
      // without wasting retry attempts on the same overflow.
      // NOTE: only instanceof APIContextOverflowError is checked here.
      // If a provider wraps the overflow as ScreamError(CONTEXT_OVERFLOW),
      // it will be retried. This is an edge case for non-ltod provider adapters.
      if (error instanceof APIContextOverflowError) {
        logRequestFailure(input, error, attempt, maxAttempts);
        throw error;
      }

      // Quota-exhaustion 429s won't clear in the retry window — the account is
      // out of daily/monthly quota. Fail fast so the user sees "switch
      // credential" instead of waiting through a 30min backoff ×3.
      if (error instanceof APIProviderRateLimitError && error.reason === 'QUOTA_EXHAUSTED') {
        logRequestFailure(input, error, attempt, maxAttempts);
        throw error;
      }

      if (attempt >= maxAttempts || !input.llm.isRetryableError(error)) {
        logRequestFailure(input, error, attempt, maxAttempts);
        throw error;
      }

      // Rate-limited requests get reason-aware backoff instead of the default
      // exponential 300ms-5s. A 529 (MODEL_CAPACITY) needs 45-75s; a per-minute
      // rate limit needs 30s; the default exponential stays for network/timeout.
      const delayMs = computeDelayMs(error, delays, attempt);
      input.params.signal.throwIfAborted();
      input.dispatchEvent({
        type: 'step.retrying',
        turnId: input.turnId,
        step: input.currentStep,
        stepUuid: input.stepUuid,
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        ...retryErrorFields(error),
      });
      await sleepForRetry(delayMs, input.params.signal);
    }
  }
}

function computeDelayMs(error: unknown, delays: number[], attempt: number): number {
  if (error instanceof APIProviderRateLimitError) {
    return calculateRateLimitBackoffMs(error.reason);
  }
  return delays[attempt - 1] ?? 0;
}

function logRequestFailure(
  input: ChatWithRetryInput,
  error: unknown,
  attempt: number,
  maxAttempts: number,
): void {
  if (isAbortError(error) || input.params.signal.aborted) return;
  input.log?.warn('llm request failed', {
    turnStep: `${input.turnId}.${String(input.currentStep)}`,
    attempt: `${String(attempt)}/${String(maxAttempts)}`,
    model: input.llm.modelName,
    ...retryErrorFields(error),
  });
}

function paramsForAttempt(
  input: ChatWithRetryInput,
  attempt: number,
  maxAttempts: number,
): LLMChatParams {
  return {
    ...input.params,
    requestLogContext: {
      turnId: input.turnId,
      step: input.currentStep,
      stepUuid: input.stepUuid,
      attempt,
      maxAttempts,
    },
  };
}

export function retryBackoffDelays(maxAttempts: number): number[] {
  return retry.timeouts({
    retries: Math.max(maxAttempts - 1, 0),
    minTimeout: RETRY_MIN_TIMEOUT_MS,
    maxTimeout: RETRY_MAX_TIMEOUT_MS,
    factor: RETRY_FACTOR,
    randomize: true,
  });
}

export async function sleepForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await abortable(sleep(delayMs), signal);
}

interface RetryErrorFields {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

function retryErrorFields(error: unknown): RetryErrorFields {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    statusCode: maybeStatusCode(error),
  };
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}
