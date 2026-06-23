import {
  APIContextOverflowError,
  grandTotal as ltodGrandTotal,
  type ContentPart,
} from '@scream-code/ltod';

import type { Agent } from '..';
import {
  ErrorCodes,
  type ScreamErrorPayload,
  isScreamError,
  makeErrorPayload,
  toScreamErrorPayload,
} from '#/errors';
import { isAbortError, isMaxStepsExceededError } from '../../loop/errors';
import {
  createLoopEventDispatcher,
  runTurn,
  type ExecutableToolResult,
  type LoopEvent,
  type LoopRecordedEvent,
  type LoopTurnStopReason,
} from '../../loop/index';
import type { AgentEvent, TurnEndedEvent } from '../../rpc';
import { abortable, userCancellationReason } from '../../utils/abort';
import { USER_PROMPT_ORIGIN, type PromptOrigin, type ContextMessage } from '../context';
import { renderUserPromptHookBlockResult, renderUserPromptHookResult } from '../../session/hooks';
import { looksLikeVerificationCommand } from '../working-set';
import { ToolCallDeduplicator } from './tool-dedup';
import { compressStep, buildContextSnapshot, extractLastAssistantText } from './signature';
import { detectConfabulation } from './detectors/confabulation';
import { injectAntiConfabulation } from './injectors/anti_confabulation';
import { VariantRegistry, detectWeightLevel, repeatDecay, shouldInjectByResidual, shouldUseShortText, shortenText, VARIANT_META, type WeightLevel } from './variant-registry';
import { TurnEventLog } from './event-log';
import { EventSnapshotBuffer } from './event-snapshot';
import { detectQualityIssue, observeBehavior } from './detectors/quality';
import { escalateQuality } from './injectors/quality';
import { detectIntent } from './detectors/intent';
import { injectIntentGuidance } from './injectors/intent';
import { InjectBudget } from './injectors/budget';
import { checkGuard, type StepToolSummary } from './guard-engine';
import { searchBehaviorRules, formatBehaviorRule, detectSceneQuery, searchPendingDoc, formatPendingDocInject } from './memory-rules';

interface ActiveTurn {
  controller: AbortController;
  promise: Promise<TurnEndResult>;
}

interface BufferedSteer {
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

export interface TurnEndResult {
  readonly event: TurnEndedEvent;
  readonly stopReason?: LoopTurnStopReason;
}

export const GOAL_COMPLETION_REMINDER_NAME = 'goal_completion_summary';
export const GOAL_BLOCKED_REMINDER_NAME = 'goal_blocked_reason';

const GOAL_CONTINUATION_PROMPT = [
  'Continue working toward the active goal.',
  'Keep the self-audit brief. Do not explore unrelated interpretations once the goal can be',
  'decided. If the objective is simple, already answered, impossible, unsafe, or contradictory,',
  'do not run another goal turn. Explain briefly if useful, then call UpdateGoal with `complete`',
  'or `blocked` in the same turn. Otherwise, weigh the objective and any completion criteria',
  'against the work done so far. Goal mode is iterative: do one coherent slice of work, then',
  'reassess. Call UpdateGoal with `complete` only when all required work is done, any stated',
  'validation has passed, and there is no useful next action. Do not mark complete after only',
  'producing a plan, summary, first pass, or partial result. If an external condition or required',
  'user input prevents progress, or the objective cannot be completed as stated, call UpdateGoal',
  'with `blocked`. Otherwise keep going — use the existing conversation context and your tools,',
  'and do not ask the user for input unless a real blocker prevents progress.',
].join(' ');

const GOAL_CONTINUATION_ORIGIN: PromptOrigin = {
  kind: 'system_trigger',
  name: 'goal_continuation',
};

export class TurnFlow {
  private steerBuffer: BufferedSteer[] = [];
  private turnId = -1;
  private currentTurnId = -1;
  private activeTurn: 'resuming' | ActiveTurn | null = null;
  private readonly currentStepByTurn = new Map<number, number>();
  private currentStep = 0;
  private todoSeenThisTurn = false;
  private convergenceInjections = 0;
  private currentStepHadContent = false;
  private lastToolFailure: { toolName: string; isExploratory: boolean } | null = null;
  private readonly MAX_CONVERGENCE_INJECTIONS = 5;
  private summaryGuardInjected = false;
  private turnStartWorkingSetPathCount = 0;
  private turnStartVerificationCount = 0;
  private verificationFailureInjected = false;
  private readonly MIN_FINAL_RESPONSE_LENGTH = 60;

  // ── Injection injector fields ────────────────────────────────
  private stepInjectedVariants = new Set<string>();
  private hasCalledLspReferencesThisStep = false;
  private searchHadResultsThisStep = false;
  private verifyFailedThisStep = false;
  private editCalledSuccessThisStep = false;
  private editWithoutLookupCount = 0;
  private stepToolCounts: Record<string, number> = {};
  private static readonly BASH_FILE_OPS_RE = /\b(cat|head|tail|less|more)\s+/i;

  // ── Toxicity early interception fields ───────────────────────
  private deviationChainActive = false;
  private deviationChainReason = '';
  private deviationChainBypassUsed = false;

  // ── Deviation chain: resolved tracking (Phase 8) ─────────────
  private deviationChainResolved = false;

  // ── Phase 8: 三路硬化字段 ─────────────────────────────────────
  private confabulationBlocked = false;
  private verifyFailStep = -1;
  private toolCountsBeforeVerifyRetry: Record<string, number> = {};

  // ── Phase 9: Convergence gate: turn-level LSP/edit tracking ──
  private turnHasCalledAnyLsp = false;
  private totalStepsWithEditsThisTurn = 0;

  // ── Guard 规则引擎 (Phase 11) ────────────────────────────────
  private lastBashExitCode: number | null = null;
  private hasKnowledgeToolsThisStep = false;
  private hasWriteToolsThisStep = false;

  // ── Quality escalation (P2) ───────────────────────────────────
  private variantRegistry = new VariantRegistry();

  // ── Inject budget (Phase 5) ───────────────────────────────────
  private readonly injectBudget = new InjectBudget();

  // ── Interception event log (Phase 10) ──────────────────────────
  private readonly eventLog = new TurnEventLog();

  // ── Event snapshot persistence (Phase 10+) ─────────────────────
  private eventBuffer!: EventSnapshotBuffer;

  constructor(protected readonly agent: Agent) {
    this.eventBuffer = new EventSnapshotBuffer(agent);
  }

  /** 刷新拦截事件日志到磁盘（会话关闭前调用）。 */
  async flushEventLog(): Promise<void> {
    await this.eventBuffer.flush();
  }

  // Returns the new turnId, or null if the turn was marked as resuming.
  prompt(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    this.agent.records.logRecord({
      type: 'turn.prompt',
      input,
      origin,
    });
    return this.launch(input, origin);
  }

  // Returns the new turnId, or null if the input was buffered as a steer
  // message or the turn was marked as resuming.
  steer(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): number | null {
    this.agent.records.logRecord({
      type: 'turn.steer',
      input,
      origin,
    });
    if (this.activeTurn) {
      this.steerBuffer.push({ input, origin });
      return null;
    }
    return this.launch(input, origin);
  }

  private launch(input: readonly ContentPart[], origin: PromptOrigin): number | null {
    if (this.activeTurn) {
      this.agent.emitEvent({
        type: 'error',
        ...makeErrorPayload(
          'turn.agent_busy',
          `Cannot launch a new turn while another turn (ID ${this.turnId}) is active`,
          { details: { turnId: this.turnId } },
        ),
      });
      return null;
    }

    // Initialize dream tracker and record new session on first turn
    if (this.turnId === -1) {
      void this.agent.dreamTracker.init().then(() =>
        this.agent.dreamTracker.recordNewSession(),
      );
    }

    // Per-turn setup (usage window, `turn.started`, appending the prompt)
    // lives in `runOneTurn`, so a goal-driven run emits a clean start/end
    // pair per continuation turn rather than one mega-turn.
    const turnId = this.allocateTurnId();
    const controller = new AbortController();
    const promise = this.turnWorker(turnId, input, origin, controller.signal);
    this.activeTurn = { controller, promise };
    return turnId;
  }

  restorePrompt(): void {
    if (this.activeTurn) {
      return;
    }
    this.turnId += 1;
    this.activeTurn = 'resuming';
  }

  restoreSteer(input: readonly ContentPart[], origin: PromptOrigin): void {
    if (this.activeTurn) {
      this.steerBuffer.push({ input, origin });
      return;
    }
    this.turnId += 1;
    this.activeTurn = 'resuming';
  }

  cancel(turnId?: number, reason?: unknown): void {
    this.agent.records.logRecord({ type: 'turn.cancel', turnId });
    if (turnId !== undefined && turnId !== this.currentId) {
      return;
    }
    const cancelReason = reason ?? userCancellationReason();
    // Close the cancelled turn's usage window — runOneTurn's cleanup path
    // may not reach it if a new prompt() advanced currentId before the old
    // turnWorker's microtask resumed.
    this.agent.usage.endTurn();
    this.abortTurn(cancelReason);
    this.agent.subagentHost?.cancelAll(cancelReason);
  }

  get currentId() {
    return this.turnId;
  }

  get hasActiveTurn(): boolean {
    return this.activeTurn !== null && this.activeTurn !== 'resuming';
  }

  waitForCurrentTurn(signal?: AbortSignal | undefined): Promise<TurnEndResult> {
    const active = this.activeTurn;
    if (active === null || active === 'resuming') {
      return Promise.reject(new Error('No active turn'));
    }
    signal?.throwIfAborted();
    if (signal === undefined) return active.promise;

    const turnId = this.currentId;
    const onAbort = (): void => {
      this.agent.turn.cancel(turnId, signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });

    return abortable(active.promise, signal).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  }

  private abortTurn(reason: unknown) {
    if (this.activeTurn !== 'resuming') {
      // The reason (a user cancellation by default, or the originating signal's
      // reason when propagated) travels as signal.reason so tools settling on
      // this signal can report a deliberate user interruption distinctly from a
      // timeout/system abort. linkAbortSignal forwards it to linked subagents.
      this.activeTurn?.controller.abort(reason);
    }
    this.activeTurn = null;
  }

  private flushSteerBuffer(): boolean {
    const steers = this.steerBuffer;
    if (steers.length === 0) return false;
    for (const steer of steers) {
      this.agent.context.appendUserMessage(steer.input, steer.origin);
    }
    steers.length = 0;
    return true;
  }

  finishResume(): void {
    if (this.activeTurn === 'resuming') {
      this.activeTurn = null;
    }
    this.steerBuffer.length = 0;
  }

  private async turnWorker(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndResult> {
    const ownsActiveTurn = (): boolean =>
      this.activeTurn !== null &&
      this.activeTurn !== 'resuming' &&
      this.activeTurn.controller.signal === signal;
    try {
      const initialGoalStatus = this.agent.goal.getGoal().goal?.status;
      if (initialGoalStatus === 'active') {
        return await this.driveGoal(turnId, input, origin, signal);
      }
      const end = await this.runOneTurn(turnId, input, origin, signal, true);
      const resumedFromPausedOrBlocked =
        initialGoalStatus === 'paused' || initialGoalStatus === 'blocked';
      const currentGoalStatus = this.agent.goal.getGoal().goal?.status;
      if (
        resumedFromPausedOrBlocked &&
        currentGoalStatus === 'active' &&
        end.event.reason !== 'cancelled' &&
        end.event.reason !== 'failed'
      ) {
        return await this.driveGoal(
          this.allocateTurnId(),
          [{ type: 'text', text: GOAL_CONTINUATION_PROMPT }],
          GOAL_CONTINUATION_ORIGIN,
          signal,
        );
      }
      return end;
    } finally {
      if (ownsActiveTurn()) {
        this.activeTurn = null;
      }
    }
  }

  /**
   * Drives an active goal as a sequence of ordinary turns. Each iteration runs
   * one full turn, then reads the goal status the model set via UpdateGoal.
   */
  private async driveGoal(
    firstTurnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndResult> {
    const DEFAULT_MAX_GOAL_TURNS = 50;
    const configuredMaxGoalTurns = this.agent.screamConfig?.loopControl?.maxGoalTurns;
    const effectiveMaxGoalTurns = configuredMaxGoalTurns ?? DEFAULT_MAX_GOAL_TURNS;

    let turnId = firstTurnId;
    let turnInput = input;
    let turnOrigin = origin;
    while (true) {
      const goalBeforeTurn = this.agent.goal.getGoal().goal;
      if (goalBeforeTurn?.status === 'active') {
        // Hard convergence guard: if the model has not set its own turn budget
        // and has consumed the default allowance, block the goal so it cannot
        // spin forever and burn tokens.
        if (
          effectiveMaxGoalTurns > 0 &&
          goalBeforeTurn.budget.turnBudget === null &&
          goalBeforeTurn.turnsUsed >= effectiveMaxGoalTurns
        ) {
          await this.agent.goal.markBlocked({
            reason: `Reached the goal turn limit (${effectiveMaxGoalTurns})`,
          });
          const ended = await this.endGoalTurnWithoutModel(turnId, turnInput, turnOrigin);
          return { event: ended };
        }

        if (goalBeforeTurn.budget.overBudget) {
          await this.agent.goal.markBlocked({ reason: 'A configured budget was reached' });
          const ended = await this.endGoalTurnWithoutModel(turnId, turnInput, turnOrigin);
          return { event: ended };
        }
      }

      await this.agent.goal.incrementTurn();
      const end = await this.runOneTurn(turnId, turnInput, turnOrigin, signal, false);

      if (end.event.reason === 'cancelled') {
        await this.agent.goal.pauseOnInterrupt({ reason: 'Paused after interruption' });
        return end;
      }
      if (end.event.reason === 'failed') {
        const reason = end.event.error?.message ?? 'Turn failed';
        await this.agent.goal.pauseActiveGoal({ reason });
        return end;
      }

      const goal = this.agent.goal.getGoal().goal;
      if (goal === null || goal.status !== 'active') {
        return end;
      }
      if (goal.budget.overBudget) {
        await this.agent.goal.markBlocked({ reason: 'A configured budget was reached' });
        return end;
      }

      turnId = this.allocateTurnId();
      turnInput = [{ type: 'text', text: GOAL_CONTINUATION_PROMPT }];
      turnOrigin = GOAL_CONTINUATION_ORIGIN;
    }
  }

  private async endGoalTurnWithoutModel(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
  ): Promise<TurnEndedEvent> {
    this.agent.usage.beginTurn();
    this.agent.emitEvent({ type: 'turn.started', turnId, origin });
    const ended: TurnEndedEvent = { type: 'turn.ended', turnId, reason: 'completed' };
    this.agent.usage.endTurn();
    this.agent.emitEvent(ended);
    return ended;
  }

  private allocateTurnId(): number {
    this.turnId += 1;
    return this.turnId;
  }

  /**
   * Runs exactly one logical turn end to end: per-turn bookkeeping,
   * `turn.started`, the prompt + goal reminder, the step loop, and `turn.ended`.
   * Goal-agnostic — the driver layers goal semantics on top. Never throws;
   * abnormal ends are mapped to a `cancelled`/`failed` `turn.ended` and returned.
   */
  private async runOneTurn(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
    standalone: boolean,
  ): Promise<TurnEndResult> {
    this.todoSeenThisTurn = false;
    this.convergenceInjections = 0;
    this.currentStepHadContent = false;
    this.lastToolFailure = null;
    this.currentTurnId = turnId;
    this.agent.workingSet.decay(turnId);
    this.summaryGuardInjected = false;
    this.verificationFailureInjected = false;
    this.turnStartWorkingSetPathCount = this.agent.workingSet.getPaths().length;
    this.turnStartVerificationCount = this.agent.workingSet.getVerificationCount();
    this.currentStepByTurn.set(turnId, 0);
    this.currentStep = 0;
    this.agent.fullCompaction.resetForTurn();
    this.agent.injection.resetForTurn();
    this.editWithoutLookupCount = 0;
    this.deviationChainActive = false;
    this.deviationChainReason = '';
    this.deviationChainBypassUsed = false;
    this.deviationChainResolved = false;
    this.confabulationBlocked = false;
    this.verifyFailStep = -1;
    this.toolCountsBeforeVerifyRetry = {};
    this.turnHasCalledAnyLsp = false;
    this.totalStepsWithEditsThisTurn = 0;
    this.variantRegistry.reset();
    this.currentStep = 0;
    this.injectBudget.reset();
    this.resetInjectorStepState();
    this.eventLog.clear();
    this.lastBashExitCode = null;
    this.agent.usage.beginTurn();
    this.agent.emitEvent({ type: 'turn.started', turnId, origin });
    this.agent.context.appendUserMessage(input, origin);

    // ── Phase 4: 回合意图注入 ─────────────────────────────
    if (origin.kind === 'user') {
      const intentDetection = detectIntent(input);
      if (intentDetection) {
        injectIntentGuidance(intentDetection, (text, meta) => {
          this.inject(text, meta);
        });
      }
    }

    // ── Phase 11: 回合开局规则记忆注入 ────────────────────
    if (origin.kind === 'user' && this.agent.memoStore) {
      const userText = input.map(c => c.type === 'text' ? (c.text ?? '') : '').join(' ');
      const sceneQuery = detectSceneQuery(input);
      if (!sceneQuery && userText.length > 0) {
        // 无场景关键词匹配时，用用户输入作为搜索 query
        const turnRules = await searchBehaviorRules(this.agent.memoStore, userText, 1);
        if (turnRules.length > 0) {
          this.inject(
            formatBehaviorRule(turnRules[0]!),
            { kind: 'system_trigger', name: 'behavior_rule' },
          );
        }
      } else if (sceneQuery) {
        const turnRules = await searchBehaviorRules(this.agent.memoStore, sceneQuery, 1);
        if (turnRules.length > 0) {
          this.inject(
            formatBehaviorRule(turnRules[0]!),
            { kind: 'system_trigger', name: 'behavior_rule' },
          );
        }
      }
    }

    // ── Phase 12: pending-doc 检测（开局注入）─────────────────
    if (origin.kind === 'user' && this.agent.memoStore) {
      const pendingDocs = await searchPendingDoc(this.agent.memoStore);
      if (pendingDocs.length > 0) {
        const hasP0 = pendingDocs.some(m => m.userNeed.includes('[P0]'));
        this.inject(
          formatPendingDocInject(pendingDocs),
          { kind: 'system_trigger', name: hasP0 ? 'convergence_gate' : 'injection' },
        );
      }
    }

    let ended: TurnEndedEvent;
    let completedStopReason: LoopTurnStopReason | undefined;
    let errorEvent: AgentEvent | undefined;
    try {
      const promptHookEnded = await this.applyUserPromptHook(
        turnId,
        input,
        origin,
        signal,
      );
      if (promptHookEnded !== undefined) {
        ended = promptHookEnded;
      } else {
        const stopReason = await this.runTurn(turnId, signal);
        completedStopReason = stopReason;
        ended = {
          type: 'turn.ended',
          turnId,
          reason: stopReason === 'aborted' ? 'cancelled' : 'completed',
        };
      }
    } catch (error) {
      if (isAbortError(error)) {
        ended = {
          type: 'turn.ended',
          turnId,
          reason: 'cancelled',
        };
      } else {
        const summary = summarizeTurnError(error, turnId);
        this.agent.sessionMemory.recordError(
          `${summary.name}: ${summary.message}`,
          this.currentStep,
        );
        void this.agent.hooks?.fireAndForgetTrigger('StopFailure', {
          matcherValue: summary.name,
          inputData: {
            errorType: summary.name,
            errorMessage: summary.message,
          },
        });
        ended = {
          type: 'turn.ended',
          turnId,
          reason: 'failed',
          error: summary,
        };
        errorEvent = { type: 'error', ...summary };
      }
    }
    // Emit the terminal turn.ended and (for a standalone turn) release the active
    // turn in the SAME synchronous frame, so the session is observably idle the
    // instant turn.ended fires. A goal drive keeps the active turn across its
    // continuation turns and releases it in `turnWorker` instead (`standalone`
    // is false for those).
    if (this.currentId === turnId) {
      this.agent.usage.endTurn();
    }
    this.agent.emitEvent(ended);
    if (standalone && this.currentId === turnId) {
      this.activeTurn = null;
    }
    if (errorEvent !== undefined) {
      this.agent.emitEvent(errorEvent);
    }

    // 🆕 Phase 10+: 回合拦截事件持久化（异步，不阻塞）
    const turnEvents = this.eventLog.getTurnEvents(turnId);
    this.eventBuffer.pushTurn(turnId, turnEvents, this.currentStep);

    this.currentStepByTurn.delete(turnId);
    return {
      event: ended,
      stopReason: completedStopReason,
    };
  }

  private async applyUserPromptHook(
    turnId: number,
    input: readonly ContentPart[],
    origin: PromptOrigin,
    signal: AbortSignal,
  ): Promise<TurnEndedEvent | undefined> {
    if (origin.kind !== 'user') return undefined;
    signal.throwIfAborted();
    const promptHookResults = await this.agent.hooks?.trigger('UserPromptSubmit', {
      matcherValue: input,
      signal,
      inputData: { prompt: input },
    });
    signal.throwIfAborted();
    const blockResult = renderUserPromptHookBlockResult(promptHookResults);
    if (blockResult !== undefined) {
      this.agent.context.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: blockResult.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: 'UserPromptSubmit', blocked: true },
      });
      this.agent.emitEvent({
        type: 'hook.result',
        turnId,
        hookEvent: blockResult.event,
        content: blockResult.message,
        blocked: true,
      });
      return {
        type: 'turn.ended',
        turnId,
        reason: 'completed',
      };
    }

    const hookResult = renderUserPromptHookResult(promptHookResults);
    if (hookResult === undefined) return undefined;

    this.agent.context.appendUserMessage([{ type: 'text', text: hookResult.text }], {
      kind: 'hook_result',
      event: 'UserPromptSubmit',
    });
    this.agent.emitEvent({
      type: 'hook.result',
      turnId,
      hookEvent: hookResult.event,
      content: hookResult.message,
    });
    return undefined;
  }

  private async runTurn(turnId: number, signal: AbortSignal): Promise<LoopTurnStopReason> {
    let stopHookContinuationUsed = false;
    const deduper = new ToolCallDeduplicator();
    await this.agent.mcp?.waitForInitialLoad(signal);
    while (true) {
      signal.throwIfAborted();
      const model = this.agent.config.model;
      const loopControl = this.agent.screamConfig?.loopControl;
      try {
        const result = await runTurn({
          turnId: String(turnId),
          signal,
          llm: this.agent.llm,
          buildMessages: () => this.agent.context.messages,
          dispatchEvent: this.buildDispatchEvent(turnId),
          tools: this.agent.tools.loopTools,
          log: this.agent.log,
          maxSteps: loopControl?.maxStepsPerTurn,
          maxRetryAttempts: loopControl?.maxRetriesPerStep,
          hooks: {
            beforeStep: async ({ signal: stepSignal, stepNumber }) => {
              this.flushSteerBuffer();
              this.currentStepHadContent = false;
              this.injectBudget.beginStep(stepNumber);
              await this.agent.fullCompaction.beforeStep(stepSignal);

              const goal = this.agent.goal.getGoal().goal;
              if (stepNumber === 1 && goal?.status === 'active' && !this.todoSeenThisTurn) {
                this.inject(
                  'This turn is working toward an active goal. You MUST call TodoList to create or update the plan before making changes.',
                  { kind: 'system_trigger', name: 'todo_required' },
                );
              }
              if (stepNumber === 2 && !this.todoSeenThisTurn) {
                this.inject(
                  'This task spans multiple steps. Use TodoList to track the remaining work and current phase.',
                  { kind: 'system_trigger', name: 'todo_suggested' },
                );
              }

              if (stepNumber === 1 || this.agent.fullCompaction.shouldInjectSessionSummary()) {
                const sessionSummary = this.agent.sessionMemory.getSessionSummary();
                if (sessionSummary.length > 0) {
                  this.inject(sessionSummary, {
                    kind: 'injection',
                    variant: 'session_memory',
                  });
                }
              }

              // Suggest /dream on the first step when conditions are met
              if (stepNumber === 1 && this.agent.dreamTracker.shouldSuggest()) {
                this.inject(
                  this.agent.dreamTracker.getSuggestionMessage(),
                  { kind: 'injection', variant: 'dream_suggestion' },
                );
              }

              await this.agent.injection.inject();
              deduper.beginStep();
              return;
            },
            afterStep: async ({ usage }) => {
              this.agent.usage.record(model, usage, 'turn');
              await this.agent.goal.recordTokenUsage(ltodGrandTotal(usage));
              await this.agent.fullCompaction.afterStep();
              deduper.endStep();

              // 🆕 C组: 步级反馈注入 — afterStep
              if (this.editCalledSuccessThisStep && !this.hasCalledLspReferencesThisStep) {
                this.editWithoutLookupCount++;
                if (this.editWithoutLookupCount >= 2) {
                  this.inject(
                    'MUST check callers. Missing LSP.references before edit.',
                    { kind: 'injection', variant: 'step_after_edit' },
                  );
                } else {
                  this.inject(
                    'Edit done → consider verifying before continuing.',
                    { kind: 'injection', variant: 'step_after_edit' },
                  );
                }
              } else if (this.editCalledSuccessThisStep) {
                this.editWithoutLookupCount = 0;
              }
              if (this.searchHadResultsThisStep && !this.editCalledSuccessThisStep) {
                this.inject(
                  'Refs found. Design change before editing.',
                  { kind: 'injection', variant: 'step_after_search' },
                );
              }
              if (this.verifyFailedThisStep) {
                this.inject(
                  'NEVER downgrade. Fix the root cause, re-run verification.',
                  { kind: 'injection', variant: 'step_after_verify_fail' },
                );
              }
              // ── 毒性早期检测：偏差链追踪 ─────────────────────────
              if (this.editWithoutLookupCount >= 3 && !this.deviationChainActive) {
                this.deviationChainActive = true;
                this.deviationChainReason =
                  '连续多次 Edit 未查 LSP.references：已触发偏差拦截。';
              }
              if (!this.deviationChainActive && this.verifyFailedThisStep) {
                this.deviationChainActive = true;
                this.deviationChainReason =
                  '验证失败：已触发偏差拦截。';
              }

              // ── 反事实检测 ──────────────────────────────────────
              const lastText = extractLastAssistantText(this.agent.context.history);
              const sig = compressStep(this.stepToolCounts, lastText);
              const snap = buildContextSnapshot(this.stepToolCounts, this.currentStep);
              const confaResult = detectConfabulation(sig, snap);
              injectAntiConfabulation(
                confaResult,
                this.stepInjectedVariants,
                (text, meta) => this.inject(text, meta),
              );
              // 🆕 Phase 8: 反事实高置信度 → 设置阻断标志
              if (confaResult.confidence >= 3) {
                this.confabulationBlocked = true;
                this.eventLog.record({
                  kind: 'confabulation', variant: '', action: 'detected',
                  step: this.currentStep, turnId: this.currentTurnId,
                  reason: `High-confidence unfounded claims (score=${confaResult.confidence})`,
                });
              }

              // ── 质量升级检测 ────────────────────────────────────
              observeBehavior(this.variantRegistry, sig);
              const qualityIssue = detectQualityIssue(
                this.variantRegistry, sig, this.currentStep,
              );
              if (qualityIssue) {
                escalateQuality(
                  qualityIssue,
                  this.stepInjectedVariants,
                  (text, meta) => {
                    this.inject(text, meta);
                  },
                );
                // P1 关键修复: 升级后回写原始变体权重，实现 C→B→A→S 渐进升级
                this.variantRegistry.updateLevel(
                  qualityIssue.targetVariant,
                  qualityIssue.suggestedLevel,
                  this.currentStep,
                );
              }

              // 🆕 Phase 8: 偏差链修复跟踪
              if (this.deviationChainActive && !this.deviationChainResolved) {
                if (this.deviationChainReason.includes('Edit 未查引用')) {
                  if (this.hasCalledLspReferencesThisStep) {
                    this.deviationChainResolved = true;
                  }
                } else if (this.deviationChainReason.includes('验证失败')) {
                  const lastText = extractLastAssistantText(this.agent.context.history);
                  const sig = compressStep(this.stepToolCounts, lastText);
                  if (sig.hasVerificationTools) {
                    this.deviationChainResolved = true;
                  }
                }
              }

              // 🆕 Phase 9: Turn-level LSP + edit tracking for convergence gate
              if (this.hasCalledLspReferencesThisStep) this.turnHasCalledAnyLsp = true;
              if (this.editCalledSuccessThisStep) this.totalStepsWithEditsThisTurn++;

              // 🆕 Phase 10: 增量回合摘要注入（每步新事件）
              const eventSummary = this.eventLog.getNewTurnSummary(this.currentTurnId);
              if (eventSummary.length > 0) {
                this.inject(eventSummary, {
                  kind: 'injection', variant: 'interception_log',
                });
              }

              // 🆕 Phase 10+: 元日志健康检查 — 超 10 步无日志时后台报警
              if (this.currentStep > 10 && this.eventLog.getTurnEvents(this.currentTurnId).length === 0) {
                this.agent.log.warn('eventLog empty but turn > 10 steps', {
                  turnId: this.currentTurnId,
                  step: this.currentStep,
                });
              }

              // 🆕 Phase 11: Guard 规则引擎检测 — afterStep
              const guardResult = checkGuard(this.agent.context.history, {
                hasKnowledgeTools: this.hasKnowledgeToolsThisStep,
                hasWriteTools: this.hasWriteToolsThisStep,
                lastBashExitCode: this.lastBashExitCode,
              });
              if (guardResult.rule > 0) {
                if (guardResult.block) {
                  // Rule 1: 谎报测试通过 → 硬拦截
                  this.confabulationBlocked = true;
                  this.eventLog.record({
                    kind: 'confabulation', variant: 'guard_rule_1', action: 'detected',
                    step: this.currentStep, turnId: this.currentTurnId,
                    reason: guardResult.reason,
                  });
                } else {
                  // Rule 2/3: 观察模式 → 只记录
                  this.eventLog.record({
                    kind: 'guard_observe', variant: `guard_rule_${guardResult.rule}`, action: 'detected',
                    step: this.currentStep, turnId: this.currentTurnId,
                    reason: guardResult.reason,
                  });
                }
              }

              // 🆕 Phase 11: 记忆主动注入 — 场景触发注入（afterStep）
              const lastAssistantText = extractLastAssistantText(this.agent.context.history);
              if (lastAssistantText.length > 0 && this.agent.memoStore) {
                const sceneQuery = detectSceneQuery(
                  [{ type: 'text' as const, text: lastAssistantText }],
                );
                if (sceneQuery) {
                  const sceneRules = await searchBehaviorRules(this.agent.memoStore, sceneQuery, 1);
                  if (sceneRules.length > 0) {
                    this.inject(
                      formatBehaviorRule(sceneRules[0]!),
                      { kind: 'system_trigger', name: 'behavior_rule' },
                    );
                  }
                }
              }

              this.resetInjectorStepState();
            },
            // oxlint-disable-next-line no-loop-func -- stop hook continuation state is scoped to this turn.
            shouldContinueAfterStop: async ({ signal }) => {
              if (this.flushSteerBuffer()) return { continue: true };
              signal.throwIfAborted();

              // ── 毒性早期拦截：偏差链打断（优先级高于 convergence gate）─
              if (this.deviationChainActive && !this.deviationChainBypassUsed) {
                this.deviationChainBypassUsed = true;
                this.eventLog.record({
                  kind: 'deviation_chain', variant: 'deviation_chain_intercept', action: 'gate_held',
                  step: this.currentStep, turnId: this.currentTurnId,
                  reason: this.deviationChainReason,
                });
                this.inject(
                  '偏差链检测到：' + this.deviationChainReason + '\n' +
                  '- MUST verify all claims with tool calls.\n' +
                  '- NEVER fabricate outputs. Each claim needs tool evidence.\n' +
                  '- Fix the root cause. Do NOT work around.',
                  { kind: 'injection', variant: 'deviation_chain_intercept' },
                );
                return { continue: true };
              }

              // Convergence gate: prevent the turn from ending on an empty step,
              // a missing TodoList update for an active goal, a blocking (non-exploratory)
              // tool failure, or a failed verification command. We no longer force
              // verification just because files were touched — the agent decides whether
              // a verification pass is appropriate based on the user's intent and the
              // system prompt guidance.
              const latestVerification = this.agent.workingSet.getLatestVerificationForTurn(this.currentTurnId);
              const hasPassedVerificationThisTurn = latestVerification?.passed === true;

              if (this.convergenceInjections < this.MAX_CONVERGENCE_INJECTIONS) {
                const reasons: string[] = [];

                if (!this.currentStepHadContent) {
                  reasons.push(
                    'The last assistant step produced no content or tool calls. Continue the task.',
                  );
                }

                const goal = this.agent.goal.getGoal().goal;
                if (goal?.status === 'active' && !this.todoSeenThisTurn) {
                  reasons.push(
                    'An active goal exists but no TodoList update was made this turn. Update TodoList and continue.',
                  );
                }
                if (this.lastToolFailure?.isExploratory === false && !hasPassedVerificationThisTurn) {
                  reasons.push(
                    `A required tool (${this.lastToolFailure.toolName}) failed this turn. ` +
                      'Analyze the error and fix it before reporting completion.',
                  );
                }
                if (latestVerification && !latestVerification.passed && !this.verificationFailureInjected) {
                  this.verificationFailureInjected = true;
                  reasons.push(
                    `The last verification command failed (${latestVerification.command}). ` +
                      'Fix the failure before re-running verification. Do NOT downgrade to runtime smoke tests.',
                  );
                }
                // 🆕 Phase 8: 反事实阻断 — 高置信度编造且无证据链
                if (this.confabulationBlocked) {
                  const sig = compressStep(this.stepToolCounts,
                    extractLastAssistantText(this.agent.context.history));
                  if (sig.hasKnowledgeTools) {
                    this.confabulationBlocked = false;
                  } else {
                    reasons.push(
                      'High-confidence unfounded claims detected. Provide tool evidence before ending.',
                    );
                    // 🆕 Phase 11: 收敛门增强 — 注入相关规则记忆
                    if (this.agent.memoStore) {
                      searchBehaviorRules(this.agent.memoStore, '编造 证据 工具调用 检查发现', 1)
                        .then(convaRules => {
                          if (convaRules.length > 0) {
                            this.inject(
                              formatBehaviorRule(convaRules[0]!),
                              { kind: 'system_trigger', name: 'behavior_rule' },
                            );
                          }
                        });
                    }
                  }
                }
                // 🆕 Phase 8: 偏差链修复跟踪 — 已激活但未修复
                if (this.deviationChainActive && !this.deviationChainResolved) {
                  reasons.push(
                    `Deviation chain still active: ${this.deviationChainReason}. ` +
                    'Resolve the underlying issue before ending the turn.',
                  );
                }
                // 🆕 Phase 8: 验证假通过 — verifyFailStep 未解除
                if (this.verifyFailStep >= 0) {
                  reasons.push(
                    'The last verification pass may be a false pass — no substantive changes were made. ' +
                    'Make an actual fix and re-verify.',
                  );
                }
                // 🆕 Phase 9: 整回合无 LSP 但修改了大量文件
                if (!this.turnHasCalledAnyLsp && this.totalStepsWithEditsThisTurn >= 3) {
                  reasons.push(
                    'Edited ' + this.totalStepsWithEditsThisTurn + '+ files this turn without any ' +
                    'LSP.references call. Verify callers before reporting completion.',
                  );
                }
                // 🆕 Phase 12: pending-doc 未写入检测
                if (reasons.length === 0 && this.agent.memoStore) {
                  const pendingDocs = await searchPendingDoc(this.agent.memoStore);
                  if (pendingDocs.some(m => m.userNeed.includes('[P0]'))) {
                    reasons.push(
                      '有 P0 级待写入知识未处理。请先写入 SYSTEM/*.md / DECISIONS/*.md / pitfalls.md 再交付。\n' +
                      formatPendingDocInject(pendingDocs),
                    );
                  }
                }

                if (reasons.length > 0) {
                  this.convergenceInjections += 1;
                  const heldReason = reasons[0] ?? 'unspecified';
                  this.eventLog.record({
                    kind: 'convergence_gate', variant: '', action: 'gate_held',
                    step: this.currentStep, turnId: this.currentTurnId,
                    reason: heldReason.length > 120 ? heldReason.slice(0, 117) + '...' : heldReason,
                  });
                  this.inject(
                    reasons.join('\n') +
                      '\n\nDo not report completion until the above is resolved.',
                    { kind: 'system_trigger', name: 'convergence_gate' },
                  );
                  return { continue: true };
                }
              }
              // Summary guard: when the turn produced actual work (file changes,
              // verification runs, etc.) but the model's final response is too
              // brief or just an empty acknowledgment, give it one chance to
              // produce a structured deliverability summary before yielding.
              if (
                !this.summaryGuardInjected &&
                this.turnHadMeaningfulWork() &&
                this.lastAssistantMessageIsTrivial()
              ) {
                this.summaryGuardInjected = true;
                this.inject(
                  'Your final response is too brief or only acknowledges completion. ' +
                    'Before ending the turn, provide a concise but complete summary: ' +
                    'what was done, which files changed, the verification result, and any ' +
                    'remaining work or blockers.',
                  { kind: 'system_trigger', name: 'convergence_gate' },
                );
                return { continue: true };
              }

              // Stop hooks get one continuation; otherwise a hook that always blocks would loop forever.
              if (stopHookContinuationUsed) return { continue: false };
              const stopBlock = await this.agent.hooks?.triggerBlock('Stop', {
                signal,
                inputData: { stopHookActive: stopHookContinuationUsed },
              });
              signal.throwIfAborted();
              if (stopBlock !== undefined) {
                stopHookContinuationUsed = true;
                this.agent.context.appendUserMessage(
                  [{ type: 'text', text: stopBlock.reason }],
                  {
                    kind: 'system_trigger',
                    name: 'stop_hook',
                  },
                );
                return { continue: true };
              }
              // 🆕 Phase 10: 收敛门放行记录
              if (this.convergenceInjections > 0) {
                this.eventLog.record({
                  kind: 'convergence_gate', variant: '', action: 'gate_passed',
                  step: this.currentStep, turnId: this.currentTurnId,
                  reason: `Turn allowed to end after ${this.convergenceInjections} gate holds`,
                });
              }
              return { continue: false };
            },
            prepareToolExecution: async (ctx) => {
              const cached = deduper.checkSameStep(
                ctx.toolCall.id,
                ctx.toolCall.name,
                ctx.args,
              );
              if (cached !== null) return { syntheticResult: cached };

              // Hard-skip redundant verification commands. The WorkingSet
              // records recent successful verification runs; if the same
              // command is requested again within the dedup window and no
              // unverified file has been touched since, we return the cached
              // result instead of re-executing the shell command.
              if (
                ctx.toolCall.name === 'Bash' &&
                typeof (ctx.args as { command?: string }).command === 'string'
              ) {
                const command = (ctx.args as { command: string }).command;
                const cwd = (ctx.args as { cwd?: string }).cwd ?? this.agent.config.cwd;
                if (looksLikeVerificationCommand(command)) {
                  const candidate = this.agent.workingSet.findSkipCandidate(
                    command,
                    cwd,
                    Number(ctx.turnId),
                  );
                  if (candidate !== null) {
                    return {
                      syntheticResult: {
                        output: `${candidate.output}
[system: verification skipped — identical successful run within the last ${Math.round(
                          (Date.now() - candidate.timestamp) / 1000,
                        )}s]`,
                      },
                    };
                  }
                }
              }

              // 🆕 A组: 工具执行前注入 — prepareToolExecution
              if (ctx.toolCall.name === 'Edit') {
                this.inject(
                  'MUST update all callers after edit. Use LSP.references.',
                  { kind: 'injection', variant: 'prepare_edit' },
                );
              }
              if (ctx.toolCall.name === 'Write') {
                const path = (ctx.args as { path?: string }).path ?? '';
                const text = path.endsWith('.md')
                  ? 'MUST verify markdown output format after write.'
                  : path.endsWith('.ts') || path.endsWith('.tsx')
                    ? 'MUST verify build after writing new code.'
                    : 'MUST check output correctness after write.';
                this.inject(text, {
                  kind: 'injection',
                  variant: 'prepare_write',
                });
              }
              if (ctx.toolCall.name === 'Grep' || ctx.toolCall.name === 'LSP') {
                this.inject(
                  'NEVER edit after seeing only one match. Evaluate ALL results.',
                  { kind: 'injection', variant: 'prepare_search' },
                );
              }
              if (ctx.toolCall.name === 'MemoryLookup') {
                this.inject(
                  'MUST check whatFailed before repeating approach.',
                  { kind: 'injection', variant: 'prepare_memory' },
                );
              }
              if (ctx.toolCall.name === 'Bash') {
                const cmd = (ctx.args as { command?: string }).command ?? '';
                if (TurnFlow.BASH_FILE_OPS_RE.test(cmd)) {
                  this.inject(
                    'NEVER use Bash for file reads. Use Read/Edit/Grep.',
                    { kind: 'injection', variant: 'prepare_bash_file' },
                  );
                }
              }
              if (ctx.toolCall.name === 'Bash') {
                const cmd = (ctx.args as { command?: string }).command ?? '';
                if (looksLikeVerificationCommand(cmd)) {
                  this.inject(
                    'Fail → fix. NEVER downgrade verification.',
                    { kind: 'injection', variant: 'prepare_verify' },
                  );
                }
              }

              return undefined;
            },
            authorizeToolExecution: async (ctx) => {
              return this.agent.permission.beforeToolCall(ctx);
            },
            finalizeToolResult: async (ctx) => {
              // Resolve dedup BEFORE firing the PostToolUse hook so same-step
              // dups (whose ctx.result is the dedup placeholder) report the
              // original's real outcome, not an empty success.
              const finalResult = await deduper.finalizeResult(
                ctx.toolCall.id,
                ctx.toolCall.name,
                ctx.args,
                ctx.result,
              );
              const { isError, output } = finalResult;

              // Record in session memory for post-compaction context injection
              this.agent.sessionMemory.recordToolExecution(
                ctx.toolCall.name,
                summarizeToolArgs(ctx.args),
                isError === true,
                ctx.stepNumber,
              );

              // Track accessed files for the working-set reminder.
              this.recordWorkingSetPaths(
                ctx.toolCall.name,
                ctx.args,
                Number(ctx.turnId),
              );

              // Record verification commands (passed or failed) so the convergence
              // gate can enforce fix-then-re-verify behavior and skip recently
              // passed checks. A passing verification also marks all touched files
              // as verified, since the command covered the current working set.
              if (
                ctx.toolCall.name === 'Bash' &&
                typeof (ctx.args as { command?: string }).command === 'string'
              ) {
                const command = (ctx.args as { command: string }).command;
                const cwd = (ctx.args as { cwd?: string }).cwd ?? this.agent.config.cwd;
                if (looksLikeVerificationCommand(command)) {
                  this.agent.workingSet.recordVerification(
                    command,
                    cwd,
                    isError === true ? 1 : 0,
                    toolOutputText(output),
                    Number(ctx.turnId),
                  );
                  if (isError !== true) {
                    this.agent.workingSet.markAllVerified();
                    // A passing verification resolves any earlier Bash failure
                    // for this turn (e.g. a failing test run before the fix).
                    if (this.lastToolFailure?.toolName === 'Bash') {
                      this.lastToolFailure = null;
                    }
                  }
                }
              }
              // 🆕 Phase 8: 验证假通过检测 — 跟踪失败→通过的改动量
              if (ctx.toolCall.name === 'Bash') {
                const cmd = (ctx.args as { command?: string }).command ?? '';
                if (looksLikeVerificationCommand(cmd) && isError === true && this.verifyFailStep < 0) {
                  this.verifyFailStep = this.currentStep;
                  this.toolCountsBeforeVerifyRetry = { ...this.stepToolCounts };
                }
                if (looksLikeVerificationCommand(cmd) && isError !== true && this.verifyFailStep >= 0) {
                  const editDelta = (this.stepToolCounts['Edit'] ?? 0) -
                    (this.toolCountsBeforeVerifyRetry['Edit'] ?? 0);
                  const writeDelta = (this.stepToolCounts['Write'] ?? 0) -
                    (this.toolCountsBeforeVerifyRetry['Write'] ?? 0);
                  if (editDelta === 0 && writeDelta === 0) {
                    this.inject(
                      '验证通过但本轮无实质性改动，可能是假通过。重新验证确认。',
                      { kind: 'injection', variant: 'post_verify_pass' },
                    );
                    if (this.convergenceInjections > 0) this.convergenceInjections--;
                  } else {
                    this.verifyFailStep = -1;
                  }
                }
              }

              // When the verify agent reports its result, record the structured
              // verification status so the convergence gate can enforce fix-then-
              // re-verify behavior.
              if (ctx.toolCall.name === 'Agent') {
                const subagentType = (ctx.args as { subagent_type?: string }).subagent_type;
                if (subagentType === 'verify') {
                  const status = parseVerificationStatus(toolOutputText(output));
                  if (status !== undefined && status.command !== 'none') {
                    this.agent.workingSet.recordVerification(
                      status.command,
                      this.agent.config.cwd,
                      status.passed ? 0 : status.exitCode,
                      toolOutputText(output),
                      Number(ctx.turnId),
                    );
                    if (status.passed) {
                      this.agent.workingSet.markAllVerified();
                      // A passing verification resolves any earlier verify/Bash
                      // failure for this turn.
                      if (this.lastToolFailure?.toolName === 'Bash' || this.lastToolFailure?.toolName === 'Agent') {
                        this.lastToolFailure = null;
                      }
                    }
                  }
                }
              }

              if (ctx.toolCall.name === 'TodoList') {
                this.todoSeenThisTurn = true;
              }

              if (isError === true && ['Edit', 'Write', 'Bash', 'Agent'].includes(ctx.toolCall.name)) {
                const command =
                  ctx.toolCall.name === 'Bash'
                    ? String((ctx.args as { command?: string }).command ?? '')
                    : '';
                const subagentType =
                  ctx.toolCall.name === 'Agent'
                    ? String((ctx.args as { subagent_type?: string }).subagent_type ?? '')
                    : '';
                const isExploratory =
                  ctx.toolCall.name === 'Agent'
                    ? subagentType !== 'verify' && subagentType !== 'reviewer' && subagentType !== 'explore'
                    : this.isExploratoryBashCommand(command);
                this.lastToolFailure = { toolName: ctx.toolCall.name, isExploratory };
              } else if (isError !== true && this.lastToolFailure?.toolName === ctx.toolCall.name) {
                // A successful execution of the same tool type resolves a previous
                // exploratory failure (e.g. `npx tsc` missing the compiler, then
                // `npx -p typescript tsc` succeeding). Blocking failures are only
                // cleared when the turn resets.
                if (this.lastToolFailure.isExploratory) {
                  this.lastToolFailure = null;
                }
              }

              // 🆕 B组: 工具执行后追踪 (finalizeToolResult)
              if (isError !== true) {
                this.stepToolCounts[ctx.toolCall.name] =
                  (this.stepToolCounts[ctx.toolCall.name] ?? 0) + 1;
                if (ctx.toolCall.name === 'LSP' || ctx.toolCall.name === 'Grep') {
                  this.searchHadResultsThisStep = true;
                  this.hasKnowledgeToolsThisStep = true;
                }
                if (ctx.toolCall.name === 'Edit') {
                  this.editCalledSuccessThisStep = true;
                  this.hasWriteToolsThisStep = true;
                }
                if (ctx.toolCall.name === 'Write') {
                  this.hasWriteToolsThisStep = true;
                }
              }
              // Track LSP.references specifically for C1 upgrade detection
              if (ctx.toolCall.name === 'LSP') {
                const operation = (ctx.args as { operation?: string }).operation;
                if (operation === 'references') this.hasCalledLspReferencesThisStep = true;
              }
              // Track Bash exit code for Guard Rule 1
              if (ctx.toolCall.name === 'Bash') {
                const outputText = toolOutputText(output);
                // Parse exit code from tool output
                const exitMatch = outputText.match(/Command failed with exit code: (\d+)/);
                this.lastBashExitCode = exitMatch ? Number(exitMatch[1]) : (isError === true ? 1 : 0);
              }
              // Track verify failure for C3
              if (ctx.toolCall.name === 'Bash' && isError === true) {
                const cmd = (ctx.args as { command?: string }).command ?? '';
                if (looksLikeVerificationCommand(cmd)) {
                  this.verifyFailedThisStep = true;
                  this.eventLog.record({
                    kind: 'verify_fail', variant: '', action: 'gate_held',
                    step: this.currentStep, turnId: this.currentTurnId,
                    reason: `Verification failed: ${cmd.slice(0, 80)}`,
                  });
                }
              }

              // 🆕 B组: 工具执行后注入 — finalizeResult
              if (ctx.toolCall.name === 'Edit' && isError !== true) {
                this.inject(
                  'NEVER leave callers unverified without update.',
                  { kind: 'injection', variant: 'post_edit' },
                );
              }
              if ((ctx.toolCall.name === 'Grep' || ctx.toolCall.name === 'LSP') && isError !== true) {
                const hasContent = toolOutputText(output).trim().length > 0;
                if (hasContent) {
                  this.inject(
                    'Full picture ready. NOW design and apply the change.',
                    { kind: 'injection', variant: 'post_search' },
                  );
                }
              }
              if (ctx.toolCall.name === 'Write' && isError !== true) {
                const text = toolOutputText(output);
                if (text.length > 500) {
                  this.inject(
                    'Large output written. MUST review for correctness.',
                    { kind: 'injection', variant: 'post_write_large' },
                  );
                }
              }
              if (ctx.toolCall.name === 'Bash' && isError !== true) {
                const cmd = (ctx.args as { command?: string }).command ?? '';
                if (looksLikeVerificationCommand(cmd)) {
                  this.inject(
                    'Verification passed. Deliver the result.',
                    { kind: 'injection', variant: 'post_verify_pass' },
                  );
                }
              }
              if (ctx.toolCall.name === 'Bash' && isError === true) {
                const cmd = (ctx.args as { command?: string }).command ?? '';
                if (looksLikeVerificationCommand(cmd)) {
                  this.inject(
                    'NEVER downgrade verification. Fix the root cause.',
                    { kind: 'injection', variant: 'post_verify_fail' },
                  );
                }
              }
              if (ctx.toolCall.name === 'MemoryLookup' && isError !== true) {
                const hasContent = toolOutputText(output).trim().length > 0;
                if (hasContent) {
                  this.inject(
                    'NOW apply whatFailed lessons from results above.',
                    { kind: 'injection', variant: 'post_memory' },
                  );
                }
              }

              const event = isError === true ? 'PostToolUseFailure' : 'PostToolUse';
              void this.agent.hooks?.fireAndForgetTrigger(event, {
                matcherValue: ctx.toolCall.name,
                inputData: {
                  toolName: ctx.toolCall.name,
                  toolInput: toolInputRecord(ctx.args),
                  toolCallId: ctx.toolCall.id,
                  error: isError === true ? toScreamErrorPayload(toolOutputText(output)) : undefined,
                  toolOutput: isError === true ? undefined : toolOutputText(output).slice(0, 2000),
                },
              });
              return finalResult;
            },
          },
        });

        return result.stopReason;
      } catch (error) {
        if (
          error instanceof APIContextOverflowError ||
          (isScreamError(error) && error.code === ErrorCodes.CONTEXT_OVERFLOW)
        ) {
          await this.agent.fullCompaction.handleOverflowError(signal, error);
          continue; // Retry with compacted context
        }
        if (isMaxStepsExceededError(error)) {
          this.agent.log.warn('turn hit max steps', {
            turnId,
            steps: this.currentStepByTurn.get(turnId) ?? this.currentStep,
            limit: isScreamError(error) ? error.details?.['maxSteps'] : undefined,
          });
        } else {
          this.agent.log.error('turn failed', { turnId, error });
        }
        throw error;
      }
    }
  }

  /** Track files touched by builtin tools. Bash-modified files are NOT tracked. */
  private recordWorkingSetPaths(toolName: string, args: unknown, turnId: number): void {
    const workingSet = this.agent.workingSet;
    if (toolName === 'Read' || toolName === 'ReadGroup' || toolName === 'ReadMediaFile') {
      const paths =
        toolName === 'ReadGroup'
          ? (args as { paths?: string[] }).paths
          : [(args as { path?: string }).path];
      for (const path of paths ?? []) {
        if (path !== undefined) workingSet.markRead(path, turnId);
      }
    }
    if (toolName === 'Edit' || toolName === 'Write') {
      const path = (args as { path?: string }).path;
      if (path !== undefined) workingSet.touch(path, turnId);
    }
  }

  private buildDispatchEvent(turnId: number) {
    return createLoopEventDispatcher({
      appendTranscriptRecord: async (event: LoopRecordedEvent) => {
        this.agent.context.appendLoopEvent(event);
      },
      emitLiveEvent: (event: LoopEvent) => {
        this.updateCurrentStepFromLoopEvent(event, turnId);
        const mapped = mapLoopEvent(event, turnId);
        if (mapped !== undefined) this.agent.emitEvent(mapped);
      },
    });
  }

  private updateCurrentStepFromLoopEvent(event: LoopEvent, turnId: number): void {
    if (event.type === 'step.begin') {
      this.beginTrackedStep(turnId, event.step);
      return;
    }
    if (
      event.type === 'text.delta' ||
      event.type === 'thinking.delta' ||
      event.type === 'tool.call'
    ) {
      this.currentStepHadContent = true;
    }
  }

  private beginTrackedStep(turnId: number, step: number): void {
    this.currentStepByTurn.set(turnId, step);
    this.currentStep = step;
  }

  // ── Inject budget + unified injection (Phase 5) ──────────────
  /**
   * 带预算检查 + 权重感知 + VariantRegistry 记录的注入包装。
   *
   * system_trigger 穿透预算（收敛机制不应被 budget 拦截）。
   * quality_escalate_ 穿透预算（升级本身就是 budget 不足的补救）。
   */
  /**
   * 带去重 + 预算 + 权重感知 + VariantRegistry 记录的注入包装。
   *
   * 所有 callsite 只需传 text 和 meta。去重/注册由本方法统一处理。
   * system_trigger 和 quality_escalate_ 穿透预算，走各自独立路径。
   */
  private inject(text: string, meta: PromptOrigin): void {
    // 提取 variant 名（部分 PromptOrigin 不含 variant）
    const variant = typeof meta === 'object' && 'variant' in meta &&
      typeof meta.variant === 'string' ? meta.variant : undefined;

    // system_trigger: 穿透一切（收敛机制）
    if (meta.kind === 'system_trigger') {
      this.agent.context.appendSystemReminder(text, meta);
      return;
    }

    // quality_escalate_: 穿透预算，去重由 escalateQuality() 负责
    if (variant?.startsWith('quality_escalate_')) {
      this.agent.context.appendSystemReminder(text, meta);
      return;
    }

    // 重复衰减: 同变体触发 5+ 次 → 跳过
    if (variant) {
      const record = this.variantRegistry.get(variant);
      if (repeatDecay(record) === 'skip') return;
    }

    // 🆕 Phase 9: ResNet 残差注意力 — 注意力还够时跳过注入
    if (variant) {
      const vm = VARIANT_META[variant];
      if (vm) {
        const record = this.variantRegistry.get(variant);
        if (!shouldInjectByResidual(record, this.currentStep, vm)) {
          this.eventLog.record({
            kind: 'injection_skipped', variant, action: 'skipped_residual',
            step: this.currentStep, turnId: this.currentTurnId,
            reason: `R≥T for ${variant}`,
          });
          return;
        }
        // 残差刚过阈值用短文本
        if (shouldUseShortText(record, this.currentStep, vm)) {
          text = shortenText(text);
        }
      }
    }

    // 步级去重: 同一步同一 variant 只注入一次
    if (variant && this.stepInjectedVariants.has(variant)) {
      this.eventLog.record({
        kind: 'injection_skipped', variant, action: 'skipped_dedup',
        step: this.currentStep, turnId: this.currentTurnId,
        reason: `Dedup skip: ${variant} already injected this step`,
      });
      return;
    }
    if (variant) this.stepInjectedVariants.add(variant);

    const estimatedTokens = Math.ceil(text.length / 4);
    const level = detectWeightLevel(text);
    const effectiveLevel = this.getEffectiveLevel(meta, level);

    // 毒性绕过: 偏差链激活 → 跳过预算
    if (this.deviationChainActive) this.injectBudget.bypassBudget();

    if (!this.injectBudget.canInject(estimatedTokens, effectiveLevel)) {
      this.eventLog.record({
        kind: 'injection_skipped', variant: variant ?? '', action: 'skipped_budget',
        step: this.currentStep, turnId: this.currentTurnId,
        reason: `Budget denies ${variant ?? 'unknown'} (t≈${estimatedTokens}, lv=${effectiveLevel})`,
      });
      return;
    }

    this.agent.context.appendSystemReminder(text, meta);
    this.injectBudget.record(estimatedTokens);

    // 注册到 VariantRegistry（残差系统依赖）
    if (variant) {
      this.variantRegistry.record(variant, effectiveLevel, this.currentStep);
    }
    this.injectBudget.syncVariantCount(this.variantRegistry.size);

    this.eventLog.record({
      kind: 'injection_delivered', variant: variant ?? '', action: 'injected',
      step: this.currentStep, turnId: this.currentTurnId,
      reason: `Injected ${variant ?? 'unknown'} (lv=${effectiveLevel})`,
    });
  }

  /**
   * 残差路径优化: 如果变体的行为已被观察，降级预算占用。
   * 行为已观察 → identity path 直通 → 不需要高预算空间重注入。
   */
  private getEffectiveLevel(meta: PromptOrigin, defaultLevel: WeightLevel): WeightLevel {
    if (typeof meta !== 'object' || !('variant' in meta)) return defaultLevel;
    const record = this.variantRegistry.get(meta.variant as string);
    if (record?.behaviorObserved === true) {
      return 'C';
    }
    return defaultLevel;
  }

  /** Reset per-step injection tracking state (called at runOneTurn and afterStep). */
  private resetInjectorStepState(): void {
    this.stepInjectedVariants.clear();
    this.hasCalledLspReferencesThisStep = false;
    this.searchHadResultsThisStep = false;
    this.verifyFailedThisStep = false;
    this.editCalledSuccessThisStep = false;
    this.hasKnowledgeToolsThisStep = false;
    this.hasWriteToolsThisStep = false;
    this.stepToolCounts = {};
  }

  private turnHadMeaningfulWork(): boolean {
    const workingSet = this.agent.workingSet;
    const hasNewPaths = workingSet.getPaths().length > this.turnStartWorkingSetPathCount;
    const hasNewVerification = workingSet.getVerificationCount() > this.turnStartVerificationCount;
    const hasCurrentTurnVerification = workingSet.hasVerificationForTurn(this.currentTurnId);
    return hasNewPaths || hasNewVerification || hasCurrentTurnVerification;
  }

  private lastAssistantMessageIsTrivial(): boolean {
    const history = this.agent.context.history;
    for (let i = history.length - 1; i >= 0; i--) {
      const message = history[i];
      if (message === undefined || message.role !== 'assistant') continue;
      const text = getAssistantMessageText(message);
      const trimmed = text.trim();
      if (trimmed.length === 0) continue;
      return (
        trimmed.length < this.MIN_FINAL_RESPONSE_LENGTH ||
        TRIVIAL_COMPLETION_RE.test(trimmed)
      );
    }
    return false;
  }

  /**
   * Classify a Bash command as "exploratory" (probing the environment) vs
   * "blocking" (a command whose failure means the task cannot be delivered).
   * Exploratory failures (e.g. probing for tsc, ls, which) do not block once
   * the turn has produced a successful resolution.
   */
  private isExploratoryBashCommand(command: string): boolean {
    const normalized = command.toLowerCase().trim();
    // Probing for toolchain binaries or inspecting the environment should not
    // keep the turn alive once a working alternative has been found. These
    // patterns can appear anywhere in the command (e.g. after `cd ... && `).
    const exploratoryPatterns = [
      /\bwhich\s+/,
      /\bwhereis\s+/,
      /\bcommand\s+-v\s+/,
      /\btype\s+/,
      /\bls\s+/,
      /\bfind\s+/,
      /\bglob\s+/,
      /\bnpm\s+list\s+-g/,
      /\bcat\s+/,
      /\bhead\s+/,
      /\btail\s+/,
      /\becho\s+/,
      /\btest\s+-[efdx]/,
      /\[\s+-[efdx]/,
      // Trying to invoke `tsc`/`tsx`/etc. without the package installed is an
      // environment probe. The real verification happens once typescript/tsx
      // is available (e.g. `npx -p typescript tsc`).
      /(^|;\s*|&&\s*)\s*npx\s+tsc\s/,
      /(^|;\s*|&&\s*)\s*npx\s+tsx\s/,
      /(^|;\s*|&&\s*)\s*npx\s+typescript\s/,
      /(^|;\s*|&&\s*)\s*tsc\s/,
      /(^|;\s*|&&\s*)\s*tsx\s/,
      // Installing typescript/tsx to enable verification is also exploratory.
      /(^|;\s*|&&\s*)\s*npm\s+install\s+(--no-save\s+)?typescript/,
      /(^|;\s*|&&\s*)\s*npm\s+install\s+(--no-save\s+)?tsx/,
      /(^|;\s*|&&\s*)\s*pnp[ms]\s+add\s+(--global\s+)?typescript/,
      /(^|;\s*|&&\s*)\s*pnp[ms]\s+add\s+(--global\s+)?tsx/,
      /(^|;\s*|&&\s*)\s*yarn\s+add\s+(--dev\s+)?typescript/,
      /(^|;\s*|&&\s*)\s*yarn\s+add\s+(--dev\s+)?tsx/,
      // Common read-only / exploratory probes
      /\bgit\s+status\b/,
      /\bgit\s+diff\b/,
      /\bgit\s+log\b/,
      /\bgrep\s+/,
      /\brg\s+/,
      /\bnode\s+-e\s+/,
      /\bpython\b/,
      /\bpython3\b/,
      /\bwc\s+/,
      /\bsort\s+/,
      /\buniq\b/,
      /\bdiff\s+/,
      /\bfile\s+/,
      /\bstat\s+/,
      /\bdf\s+/,
      /\bdu\s+/,
    ];
    return exploratoryPatterns.some((pattern) => pattern.test(normalized));
  }


}
function getAssistantMessageText(message: ContextMessage): string {
  if (message.role !== 'assistant') return '';
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

const TRIVIAL_COMPLETION_RE =
  /^\s*(done|ok|okay|完成|好了|ok\.?|done\.?|completed\.?|finished\.?|tests?\s+passed\.?|passed\.?|it\s+works\.?|looks\s+good\.?|fixed\.?|resolved\.?|verified\.?|all\s+good\.?|一切正常\.?|已完成\.?)\s*$/iu;

function mapLoopEvent(event: LoopEvent, turnId: number): AgentEvent | undefined {
  switch (event.type) {
    case 'step.begin':
      return {
        type: 'turn.step.started',
        turnId,
        step: event.step,
        stepId: event.uuid,
      };
    case 'step.end':
      return {
        type: 'turn.step.completed',
        turnId,
        step: event.step,
        stepId: event.uuid,
        usage: event.usage,
        finishReason: event.finishReason,
        llmFirstTokenLatencyMs: event.llmFirstTokenLatencyMs,
        llmStreamDurationMs: event.llmStreamDurationMs,
        providerFinishReason: event.providerFinishReason,
        rawFinishReason: event.rawFinishReason,
      };
    case 'step.retrying':
      return {
        type: 'turn.step.retrying',
        turnId,
        step: event.step,
        stepId: event.stepUuid,
        failedAttempt: event.failedAttempt,
        nextAttempt: event.nextAttempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        errorName: event.errorName,
        errorMessage: event.errorMessage,
        statusCode: event.statusCode,
      };
    case 'content.part':
      return undefined;
    case 'tool.call':
      return {
        type: 'tool.call.started',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        args: event.args,
        description: event.description,
        display: event.display,
      };
    case 'tool.result':
      return {
        type: 'tool.result',
        turnId,
        toolCallId: event.toolCallId,
        output: event.result.output,
        isError: event.result.isError,
      };
    case 'turn.interrupted':
      if (event.activeStep === undefined) return undefined;
      return {
        type: 'turn.step.interrupted',
        turnId,
        step: event.activeStep,
        reason: event.reason,
        message: event.message,
      };
    case 'text.delta':
      return {
        type: 'assistant.delta',
        turnId,
        delta: event.delta,
      };
    case 'thinking.delta':
      return {
        type: 'thinking.delta',
        turnId,
        delta: event.delta,
      };
    case 'tool.call.delta':
      return {
        type: 'tool.call.delta',
        turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        argumentsPart: event.argumentsPart,
      };
    case 'tool.progress':
      return {
        type: 'tool.progress',
        turnId,
        toolCallId: event.toolCallId,
        update: event.update,
      };
  }
}

const LLM_NOT_SET_MESSAGE =
  'No model configured. Run `scream config` or use `/model` to set a default model.';

function summarizeTurnError(error: unknown, turnId: number): ScreamErrorPayload {
  const payload = toScreamErrorPayload(error);
  const details = { ...payload.details, turnId };

  // Substitute a friendlier TUI-aware message for model-not-configured.
  // The raw "Model not set" / "Provider not set" text is not actionable;
  // this string points the user at the login flow.
  if (payload.code === 'model.not_configured') {
    return { ...payload, message: LLM_NOT_SET_MESSAGE, details };
  }

  return { ...payload, details };
}

function toolInputRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

/**
 * Parse a `[verification_status]` block from verify-agent output.
 * Returns undefined if no block is found.
 */
function parseVerificationStatus(
  output: string,
): { passed: boolean; command: string; exitCode: number } | undefined {
  const match = output.match(/\[verification_status\]\s*\n([\s\S]*?)(?=\n\n|\n?$)/);
  if (!match || match[1] === undefined) return undefined;
  const block = match[1];
  const passedMatch = block.match(/^passed:\s*(true|false)\s*$/im);
  const commandMatch = block.match(/^command:\s*(.+)$/im);
  const exitCodeMatch = block.match(/^exit_code:\s*(\d+)\s*$/im);
  if (
    !passedMatch ||
    !commandMatch ||
    !exitCodeMatch ||
    passedMatch[1] === undefined ||
    commandMatch[1] === undefined ||
    exitCodeMatch[1] === undefined
  ) {
    return undefined;
  }
  return {
    passed: passedMatch[1].toLowerCase() === 'true',
    command: commandMatch[1].trim(),
    exitCode: Number.parseInt(exitCodeMatch[1], 10),
  };
}


function toolOutputText(output: ExecutableToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<(typeof output)[number], { type: 'text' }> => {
      return typeof part === 'object' && part !== null && part.type === 'text';
    })
    .map((part) => part.text)
    .join('');
}



/** Extract a short human-readable summary from tool arguments. */
function summarizeToolArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const a = args as Record<string, unknown>;
  // Common tool arg patterns — try each in priority order
  if (typeof a['file_path'] === 'string') return a['file_path'];
  if (typeof a['path'] === 'string') return a['path'];
  if (typeof a['description'] === 'string') return truncateArg(a['description']);
  if (typeof a['subject'] === 'string') return a['subject'];
  if (typeof a['command'] === 'string') return truncateArg(a['command']);
  if (typeof a['query'] === 'string') return truncateArg(a['query']);
  if (typeof a['url'] === 'string') return a['url'];
  return '';
}

function truncateArg(s: string): string {
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}
