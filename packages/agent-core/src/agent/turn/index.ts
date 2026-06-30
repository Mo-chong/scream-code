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
import { injectStuckInjector } from './injectors/stuck';

import { VariantRegistry, detectWeightLevel, repeatDecay, shouldInjectByResidual, shouldUseShortText, shortenText, VARIANT_META, getScore, type WeightLevel } from './variant-registry';
import { TurnEventLog } from './event-log';
import { EventSnapshotBuffer } from './event-snapshot';
import { detectQualityIssue, observeBehavior } from './detectors/quality';
import { escalateQuality } from './injectors/quality';
import { detectIntent } from './detectors/intent';
import { injectIntentGuidance } from './injectors/intent';
import { InjectBudget } from './injectors/budget';
import { checkGuard, type StepToolSummary } from './guard-engine';
import { searchBehaviorRules, formatBehaviorRule, detectSceneQuery, searchPendingDoc, formatPendingDocInject } from './memory-rules';
import { detectSceneMemory } from './detectors/scene-memory';
import { detectCodeRefQuality } from './detectors/code-ref';
import { scanCodeQuality, formatCodeQualityFeedback, type CodeQualityViolation } from './detectors/code-quality';

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

/** Phase 14: 收敛条件接口 — 每个条件是一个 check 函数 + 优先级 */
interface ConvergenceCondition {
  readonly check: () => string | null;
  readonly priority: number;
}

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
  /** Did the Edit touch a code file (as opposed to docs/markdown)? Only this triggers the "MUST check LSP.references" rule. */
  private editOnCodeFileThisStep = false;
  private editWithoutLookupCount = 0;
  private stepToolCounts: Record<string, number> = {};
  private static readonly BASH_FILE_OPS_RE = /\b(cat|head|tail|less|more)\s+/i;
  /** Only these file extensions trigger the "must check LSP.references" rule. */
  private static readonly CODE_FILE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go']);

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
  /** Only code-file edits (.ts/.js/.py/.rs/.go) — docs (.md/.json/.yaml) excluded. */
  private totalCodeFileEditsThisTurn = 0;

  // ── Phase 16-17: Code exploration tool priority — 4D smart enforcement ─
  /** Has any mcp__codegraph__codegraph_* been called this turn (resets per turn). */
  private hasCalledCodegraphThisTurn = false;
  /**
   * Exploratory Read/Grep steps this turn without codegraph (excludes verification reads).
   * Verification reads: Edit/Write-刚改过的文件；Grep(具体路径)。
   * ≥3 → injection; ≥5 → hard block via syntheticResult.
   */
  private exploratoryStepsWithoutCodegraph = 0;
  /** Paths edited/written this turn — Read of these = verification (not exploratory). */
  private recentlyModifiedPathsThisTurn: Set<string> = new Set();

  // ── Phase 18: 代码质量追踪 ─────────────────────────────────
  /** 本回合代码质量违规记录列表 */
  private codeQualityViolations: CodeQualityViolation[] = [];
  /** 本回合代码质量违规检测总次数 */
  private codeQualityViolationsThisTurn = 0;

  // ── Guard 规则引擎 (Phase 11) ────────────────────────────────
  private lastBashExitCode: number | null = null;
  private hasKnowledgeToolsThisStep = false;
  private hasWriteToolsThisStep = false;

  // ── Phase 12: Guard feedback ────────────────────────────────────
  private lastGuardFeedback: string | null = null;

  // ── Phase 13: 行为闭环与展示规范 ────────────────────────────────
  private lastStepCalledMemoryLookup = false;
  private hasCurrentCodeToolsThisStep = false;
  private lastUserInputText = '';

  // ── Phase 14: 正反馈每回合一次 ─────────────────────────────────
  private positiveFeedbackGivenThisTurn = false;

  // ── Phase 14: 收敛条件数组（可组合） ───────────────────────────
  private convergenceConditions: ConvergenceCondition[] = [];

  // ── Phase 14: 跨回合标记 ───────────────────────────────────────
  private crossTurnFlags: {
    lastTurnHadGuardRule1: boolean;
    lastTurnHadDeviation: boolean;
    /** 🆕 Phase15: 跨回合 S→S 升级计数（跨回合累积，behaviorObserved 时单个变体重置） */
    behaviorViolations: Record<string, number>;
  } = { lastTurnHadGuardRule1: false, lastTurnHadDeviation: false, behaviorViolations: {} };
  /** 🆕 Phase14 fix: Guard Rule 1 单独追踪（区分于 confabulationBlocked） */
  private guardRule1FiredThisTurn = false;

  // ── Quality escalation (P2) ───────────────────────────────────
  private variantRegistry = new VariantRegistry();

  // ── Inject budget (Phase 5) ───────────────────────────────────
  private readonly injectBudget = new InjectBudget();

  // ── Phase 21: Stuck injection state ───────────────────────────
  /** 上次注入 system_ref_stuck 的 step (-1 = 从未注入) */
  private stuckInjectedAtStep = -1;
  /** 本轮 Edit 的文件路径（用于 stuck 检测） */
  private editFileThisStep: string | undefined;
  /** 本轮工具报错（用于 stuck 检测） */
  private toolErrorThisStep: string | undefined;
  /** 文件编辑历史 (最近 30 次) */
  private editFileHistory: string[] = [];
  /** 工具报错历史 (最近 30 次) */
  private errorHistory: string[] = [];
  // ── Interception event log (Phase 10) ──────────────────────────
  private readonly eventLog = new TurnEventLog();

  // ── Event snapshot persistence (Phase 10+) ─────────────────────
  private eventBuffer!: EventSnapshotBuffer;

  constructor(protected readonly agent: Agent) {
    this.eventBuffer = new EventSnapshotBuffer(agent);
    // 🆕 Phase15+: variantRegistry 行为观察回调 → 记录 behavior_feedback 事件
    this.variantRegistry.onBehaviorObserved = (v, observed) => {
      this.eventLog.record({
        kind: 'behavior_feedback', variant: v, action: observed ? 'observed' : 'not_observed',
        step: this.currentStep, turnId: this.currentTurnId,
        reason: observed
          ? '行为已观察：AI 遵守了该变体的约束'
          : '行为未观察：AI 忽略了该变体的约束',
      });
    };
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
    this.totalCodeFileEditsThisTurn = 0;
    this.hasCalledCodegraphThisTurn = false;
    this.exploratoryStepsWithoutCodegraph = 0;
    this.recentlyModifiedPathsThisTurn = new Set();
    this.variantRegistry.reset();
    this.currentStep = 0;
    this.injectBudget.reset();
    this.resetInjectorStepState();
    this.eventLog.clear();
    this.lastBashExitCode = null;
    this.lastGuardFeedback = null;
    this.lastUserInputText = input.map(c => c.type === 'text' ? (c.text ?? '') : '').join(' ');
    this.positiveFeedbackGivenThisTurn = false;
    this.guardRule1FiredThisTurn = false;
    this.codeQualityViolations = [];
    this.codeQualityViolationsThisTurn = 0;
    this.initConvergenceConditions();
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
    // 🆕 Phase15+: 传预算摘要给持久化
    const budgetSummary = this.eventLog.getBudgetSummary(turnId);
    this.eventBuffer.pushTurn(turnId, turnEvents, this.currentStep, budgetSummary ?? undefined);

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
              if (stepNumber === 1) {
                this.injectCrossTurnFlags();
                if (goal?.status === 'active' && !this.todoSeenThisTurn) {
                  this.inject(
                    'This turn is working toward an active goal. You MUST call TodoList to create or update the plan before making changes.',
                    { kind: 'system_trigger', name: 'todo_required' },
                  );
                }
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

              await this.handleAfterStep();
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
                // 🆕 Phase15: 差异化拦截消息 — 行为违规 vs 代码级条件
                let interceptMsg: string;
                if (this.deviationChainReason.includes('行为变体')) {
                  // 行为违规累积触发
                  const violatingVariant = this.detectTriggerVariant();
                  interceptMsg = this.buildBehaviorInterceptMsg(violatingVariant);
                } else {
                  interceptMsg = '偏差链检测到：' + this.deviationChainReason + '\n' +
                    '- MUST verify all claims with tool calls.\n' +
                    '- NEVER fabricate outputs. Each claim needs tool evidence.\n' +
                    '- Fix the root cause. Do NOT work around.';
                }
                this.inject(interceptMsg, { kind: 'injection', variant: 'deviation_chain_intercept' });
                return { continue: true };
              }

              // Convergence gate: runs all conditions; pure conditions use the
              // convergenceConditions array, async/side-effect conditions use named methods.
              const latestVerification = this.agent.workingSet.getLatestVerificationForTurn(this.currentTurnId);
              const hasPassedVerificationThisTurn = latestVerification?.passed === true;

              if (this.convergenceInjections < this.MAX_CONVERGENCE_INJECTIONS) {
                const reasons: string[] = [];

                // — 纯条件（来自数组，按优先级排序）—
                for (const cond of this.convergenceConditions) {
                  const reason = cond.check();
                  if (reason) reasons.push(reason);
                }

                // — 带副作用的条件（confabulation 含 searchBehaviorRules）—
                this.collectConfabulationBlockReason(reasons);

                // — 带 await 的条件（pending-doc 需要异步搜索）—
                await this.collectPendingDocReason(reasons);

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
              // 🆕 Phase 14: 跨回合标记序列化 — 下回合预防性提醒
              if (this.guardRule1FiredThisTurn) this.crossTurnFlags.lastTurnHadGuardRule1 = true;
              if (this.deviationChainActive) this.crossTurnFlags.lastTurnHadDeviation = true;
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
                  '修改函数/API 后，必须更新所有调用方。先调 LSP.references 查找所有引用点。',
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
                  '搜到一个匹配后不要立即编辑。评估所有搜索结果后再动手。',
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
                    '验证失败后必须修复根因重新跑完整验证，不准降低验证标准。',
                    { kind: 'injection', variant: 'prepare_verify' },
                  );
                }
              }
              // 🆕 Phase 17: 4D 智能拦截 — 探索 vs 验证 / 可用性 / 渐进 escal / 疲劳重置
              if (ctx.toolCall.name === 'Read' || ctx.toolCall.name === 'ReadGroup' || ctx.toolCall.name === 'ReadMediaFile' || ctx.toolCall.name === 'Grep') {
                const codegraphAvailable = this.agent.tools.data().some(t => t.name.startsWith('mcp__codegraph__codegraph'));
                if (codegraphAvailable && !this.hasCalledCodegraphThisTurn && this.isExploratoryReadGrep(ctx)) {
                  const n = this.exploratoryStepsWithoutCodegraph;
                  if (n >= 5) {
                    return {
                      syntheticResult: {
                        isError: true,
                        output: `已连续 ${n} 次使用 Read/Grep 探索代码而未调用 codegraph。请先用 mcp__codegraph__codegraph_explore 获取相关符号源码+调用路径。确认 Read/Grep 是验证行为而非探索后，可先调一次 codegraph 再继续。`,
                        stopTurn: false,
                      },
                    };
                  }
                  if (n >= 4) {
                    this.inject(
                      `已连续 ${n} 次 Read/Grep 探索代码未调 codegraph。下一步再不调用 codegraph 将被阻断。mcp__codegraph__codegraph_explore 一次返回完整上下文。`,
                      { kind: 'injection', variant: 'step_code_explore' },
                    );
                  } else if (n >= 3) {
                    this.inject(
                      '已连续多次用 Read/Grep 探索代码。建议先用 mcp__codegraph__codegraph_explore — 一次调用返回相关符号源码+调用路径，比多轮 Read/Grep 更高效。',
                      { kind: 'injection', variant: 'step_code_explore' },
                    );
                  }
                }
              }

              // ── Phase 18: 代码质量偏差链阻断（Write/Edit 尝试时）──
              if ((ctx.toolCall.name === 'Write' || ctx.toolCall.name === 'Edit') &&
                  this.deviationChainActive && !this.deviationChainResolved &&
                  this.deviationChainReason.includes('代码质量')) {
                return {
                  syntheticResult: {
                    isError: true,
                    output: '偏差链活跃：代码质量违规未修正。违规列表：\n'
                      + this.codeQualityViolations.map(v => `  - ${v.file}: ${v.detail}`).join('\n')
                      + '\n修正违规后再写新代码。',
                    stopTurn: false,
                  },
                };
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
                // Edit/Write/Agent are deterministic — a later success of the
                // same tool means the prior failure (e.g. stale old_string) is
                // resolved. Bash is non-deterministic: a passing `ls` does
                // not fix a failing `tsc`, so blocking Bash failures are only
                // cleared by a passing verification (markAllVerified above).
                if (ctx.toolCall.name !== 'Bash' || this.lastToolFailure.isExploratory) {
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
                  this.hasCurrentCodeToolsThisStep = true;
                }
                if (ctx.toolCall.name === 'Read' || ctx.toolCall.name === 'ReadGroup' || ctx.toolCall.name === 'ReadMediaFile') {
                  this.hasCurrentCodeToolsThisStep = true;
                  this.hasKnowledgeToolsThisStep = true;
                  // D1 (Phase 17): Only count exploratory reads — reads of recently-modified files are verification
                  if (!this.hasCalledCodegraphThisTurn && this.isExploratoryReadGrep(ctx)) {
                    this.exploratoryStepsWithoutCodegraph++;
                  }
                }
                if (ctx.toolCall.name === 'MemoryLookup') {
                  this.lastStepCalledMemoryLookup = true;
                }
                if (ctx.toolCall.name.startsWith('mcp__codegraph__codegraph')) {
                  this.hasCalledCodegraphThisTurn = true;
                  this.exploratoryStepsWithoutCodegraph = 0;
                }
                if (ctx.toolCall.name === 'Edit') {
                  this.editCalledSuccessThisStep = true;
                  const editPath = (ctx.args as { path?: string }).path ?? '';
                  const ext = editPath.slice(editPath.lastIndexOf('.')).toLowerCase();
                  if (TurnFlow.CODE_FILE_EXTS.has(ext)) {
                    this.editOnCodeFileThisStep = true;
                    this.totalCodeFileEditsThisTurn++;
                  }
                  this.hasWriteToolsThisStep = true;
                  // D1 (Phase 17): Track modified paths so subsequent reads count as verification
                  if (editPath) {
                    this.recentlyModifiedPathsThisTurn.add(editPath);
                    this.editFileThisStep = editPath; // Phase 21: track for stuck detection
                  }
                }
                if (ctx.toolCall.name === 'Write') {
                  this.hasWriteToolsThisStep = true;
                  const writePath = (ctx.args as { path?: string }).path ?? '';
                  if (writePath) this.recentlyModifiedPathsThisTurn.add(writePath);
                }

                // 🆕 FileActionAudit: 记录成功的文件操作
                if ((ctx.toolCall.name === 'Edit' || ctx.toolCall.name === 'Write') && ctx.toolCall.id) {
                  const filePath = (ctx.args as { path?: string }).path ?? '';
                  const actionType = ctx.toolCall.name === 'Edit' ? 'edit' : 'write';
                  this.agent.fileActionAudit.push({
                    toolCallId: ctx.toolCall.id,
                    action: `${actionType}:${filePath}`,
                    timestamp: Date.now(),
                    resultPreview: filePath,
                    success: true,
                    durationMs: 0,
                  });
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
                if (isError === true) this.toolErrorThisStep = ctx.toolCall.name;
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
                    '验证失败后必须修复根因重新跑完整验证，不准降低验证标准。',
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

              // ── Phase 18: 代码质量检测（Write/Edit 成功时）──
              if (isError !== true && (ctx.toolCall.name === 'Write' || ctx.toolCall.name === 'Edit')) {
                const fp = (ctx.args as { path?: string }).path ?? '';
                if (/\.(ts|tsx|js|jsx)$/.test(fp)) {
                  const content = toolOutputText(output);
                  if (content.length > 0) {
                    const qcResult = scanCodeQuality(content, fp);
                    if (qcResult.hasViolations) {
                      this.codeQualityViolations.push(...qcResult.violations);
                      this.codeQualityViolationsThisTurn += qcResult.violations.length;
                      this.inject(formatCodeQualityFeedback(qcResult), { kind: 'injection', variant: 'code_quality_feedback' });
                      this.eventLog.record({
                        kind: 'code_quality', variant: 'violation', action: 'feedback',
                        step: this.currentStep, turnId: this.currentTurnId,
                        reason: `代码质量违规: ${qcResult.violations.map(v => v.type).join(', ')}`,
                      });
                    }
                  }
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

    // Phase22.3: 变体配额调度 — 委托 VariantScheduler
    if (variant && !this.agent.injection.canInject(variant, this.currentStep)) {
      this.eventLog.record({
        kind: 'injection_skipped', variant, action: 'skipped_quota',
        step: this.currentStep, turnId: this.currentTurnId,
        reason: `Quota denies ${variant} (count=${this.agent.injection.getInjectionCount(variant)})`,
      });
      return;
    }

    const estimatedTokens = Math.ceil(text.length / 4);
    const level = detectWeightLevel(text);
    const effectiveLevel = this.getEffectiveLevel(meta, level);

    // 🆕 Phase15: interception_log 穿透 budget — 元日志不是行为约束，且不占用预算/注册表
    if (variant === 'interception_log') {
      this.agent.context.appendSystemReminder(text, meta);
      this.eventLog.record({
        kind: 'injection_delivered', variant: 'interception_log', action: 'injected',
        step: this.currentStep, turnId: this.currentTurnId,
        reason: `Injected interception_log (lv=${effectiveLevel})`,
        level: effectiveLevel, tokenEstimate: estimatedTokens,
      });
      return;
    }

    // 毒性绕过: 偏差链激活 → 跳过预算
    if (this.deviationChainActive) this.injectBudget.bypassBudget();

    if (!this.injectBudget.canInject(estimatedTokens, effectiveLevel)) {
      this.eventLog.record({
        kind: 'injection_skipped', variant: variant ?? '', action: 'skipped_budget',
        step: this.currentStep, turnId: this.currentTurnId,
        reason: `Budget denies ${variant ?? 'unknown'} (t≈${estimatedTokens}, lv=${effectiveLevel})`,
        level: effectiveLevel, tokenEstimate: estimatedTokens,
      });
      return;
    }

    this.agent.context.appendSystemReminder(text, meta);
    this.injectBudget.record(estimatedTokens);

    // 注册到 VariantRegistry（残差系统依赖）
    if (variant) {
      this.variantRegistry.record(variant, 'D' as any, this.currentStep);
    }

    // Phase22.3: 记录到 VariantScheduler
    if (variant) {
      this.agent.injection.afterInject(variant, this.currentStep);
    }

    this.eventLog.record({
      kind: 'injection_delivered', variant: variant ?? '', action: 'injected',
      step: this.currentStep, turnId: this.currentTurnId,
      reason: `Injected ${variant ?? 'unknown'} (lv=${effectiveLevel})`,
      level: effectiveLevel, tokenEstimate: estimatedTokens,
    });
  }

  // ── Phase 14: afterStep 分段命名化 ─────────────────────────────

  /**
   * afterStep 组织层 — 按行为分 7 步执行所有检测和注入。
   * 每个子方法不超过 45 行。
   */
  private async handleAfterStep(): Promise<void> {
    // Step 1: 步级反馈 + 偏差链追踪
    this.injectStepAfterVariants();
    this.detectDeviationChain();

    // Step 2: 反事实检测 + quality 检测
    const sig = compressStep(this.stepToolCounts, extractLastAssistantText(this.agent.context.history));
    const snap = buildContextSnapshot(this.stepToolCounts, this.currentStep);
    const confaResult = detectConfabulation(sig, snap);
    injectAntiConfabulation(confaResult, this.stepInjectedVariants, (text, meta) => this.inject(text, meta));
    if (confaResult.confidence >= 3) {
      this.confabulationBlocked = true;
      this.eventLog.record({
        kind: 'confabulation', variant: '', action: 'detected',
        step: this.currentStep, turnId: this.currentTurnId,
        reason: `High-confidence unfounded claims (score=${confaResult.confidence})`,
      });
    }
    this.runQualityDetection(sig);

    // 🆕 Phase15: 行为已观察的变体 → 重置跨回合违规计数
    this.resetObservedBehaviorViolations();

    // Step 3: 偏差链修复 + turn-level 统计
    this.tryResolveDeviationChain();
    if (this.hasCalledLspReferencesThisStep) this.turnHasCalledAnyLsp = true;
    if (this.editCalledSuccessThisStep) this.totalStepsWithEditsThisTurn++;

    // Step 4: 拦截日志增量 + 健康检查
    this.injectInterceptionSummary();
    this.checkEventLogHealth();

    // Step 5: 检测器序列（scene, guard, behavior rules, stuck）
    this.detectSceneMemoryIssue();
    this.stuckInjectedAtStep = injectStuckInjector(
      (msg, meta) => this.inject(msg, { kind: 'injection', ...meta }),
      this.currentStep,
      this.stuckInjectedAtStep,
      this.stepInjectedVariants,
      this.editFileThisStep,
      this.toolErrorThisStep,
      this.editFileHistory,
      this.errorHistory,
    );
    await this.runGuardDetection();
    await this.injectBehaviorRulesAfterStep();

    // Step 6: 正反馈 + CodeRef
    this.injectPositiveFeedbackThisTurn();
    this.detectCodeRefIssue();

    // Phase22.2: 收集注入器状态为 flat facts，可选注入
    // (由 Phase22.3 VariantScheduler 通过 manage.ts 门控注入)

    // Step 7: 重置
    this.resetInjectorStepState();
  }

  /** C组: 步级反馈注入 — 基于当前步工具调用模式注入对应提醒 */
  private injectStepAfterVariants(): void {
    if (this.editOnCodeFileThisStep && !this.hasCalledLspReferencesThisStep) {
      this.editWithoutLookupCount++;
      if (this.editWithoutLookupCount >= 2) {
        this.inject('编辑前必须先查 LSP.references 找调用方。', { kind: 'injection', variant: 'step_after_edit' });
      } else {
        this.inject('编辑完成。在继续前先用 LSP.references 检查调用方。', { kind: 'injection', variant: 'step_after_edit' });
      }
    } else if (this.editOnCodeFileThisStep) {
      this.editWithoutLookupCount = 0;
    }
    if (this.searchHadResultsThisStep && !this.editCalledSuccessThisStep) {
      this.inject('找到引用点了。设计好改动方案后再编辑。', { kind: 'injection', variant: 'step_after_search' });
    }
    if (this.verifyFailedThisStep) {
      this.inject('验证失败后必须修复根因重新跑完整验证，不准降低验证标准。', { kind: 'injection', variant: 'step_after_verify_fail' });
    }
  }

  /** 毒性早期检测：偏差链追踪 */
  private detectDeviationChain(): void {
    // 条件 1: Edit 脱链（已有）
    if (this.editWithoutLookupCount >= 3 && !this.deviationChainActive) {
      this.deviationChainActive = true;
      this.deviationChainReason = '连续多次 Edit 未查 LSP.references：已触发偏差拦截。';
    }

    // 条件 2: 验证失败（已有）
    if (!this.deviationChainActive && this.verifyFailedThisStep) {
      this.deviationChainActive = true;
      this.deviationChainReason = '验证失败：已触发偏差拦截。';
    }

    // 🆕 条件 3: 行为违规累积 → 偏差拦截
    if (!this.deviationChainActive) {
      for (const [variant, count] of Object.entries(this.crossTurnFlags.behaviorViolations)) {
        const meta = VARIANT_META[variant];
        const threshold = meta?.interceptThreshold ?? 0;
        if (threshold > 0 && count >= threshold) {
          this.deviationChainActive = true;
          this.deviationChainReason = `行为变体 ${variant} 连续 ${count} 回合 S→S 升级但行为未见改善。`;
          break;
        }
      }
    }

    // 🆕 Phase 18: 代码质量违规 → 偏差链（跨回合累积，interceptThreshold=3）
    if (!this.deviationChainActive && this.codeQualityViolationsThisTurn > 0) {
      this.deviationChainActive = true;
      this.deviationChainReason = '代码质量违规：存在 ' + this.codeQualityViolationsThisTurn + ' 个未修正的规范违反。';
    }
  }

  /** 🆕 Phase15: 可进入偏差链拦截的变体白名单 */
  private static readonly INTERCEPT_VARIANTS = new Set([
    'guard_feedback_rule_2',
    'guard_feedback_rule_3',
    'guard_feedback_rule_4',
    'scene_memory_recall',
    'step_after_edit',
    'step_after_verify_fail',
  ]);

  /** 🆕 Phase15: 追踪行为变体的跨回合 S→S 违规计数 */
  private trackBehaviorViolation(variant: string): void {
    // 只跟踪白名单中的变体
    if (!TurnFlow.INTERCEPT_VARIANTS.has(variant)) return;
    // 递增计数（首次设为 1）
    this.crossTurnFlags.behaviorViolations[variant] =
      (this.crossTurnFlags.behaviorViolations[variant] || 0) + 1;
  }

  /** 🆕 Phase15: 检测触发拦截的具体变体 */
  private detectTriggerVariant(): string {
    for (const [variant, count] of Object.entries(this.crossTurnFlags.behaviorViolations)) {
      const meta = VARIANT_META[variant];
      const threshold = meta?.interceptThreshold ?? 0;
      if (threshold > 0 && count >= threshold) return variant;
    }
    return 'unknown';
  }

  /** 🆕 Phase15: 生成行为违规拦截的指导消息 */
  private buildBehaviorInterceptMsg(variant: string): string {
    const variantGuidance: Record<string, string> = {
      guard_feedback_rule_2: '— 系统检测到你声称"检查发现"但实际无 Read/Grep/LSP 调用。',
      guard_feedback_rule_3: '— 系统检测到你声称"已修改"但实际无 Edit/Write 调用。',
      guard_feedback_rule_4: '— 系统检测到你依赖记忆替代了实际代码验证。',
      scene_memory_recall:   '— 系统检测到用户提"上次/以前"但你未查 MemoryLookup。',
      step_after_edit:       '— 系统检测到 Edit 后未查 LSP.references。',
      step_after_verify_fail:'— 系统检测到验证失败后未按要求修复。',
    };
    const specificGuidance = variantGuidance[variant] ?? '— 系统检测到重复行为违规。';
    const count = this.crossTurnFlags.behaviorViolations[variant] ?? 0;
    return [
      `偏差链检测到：行为变体 ${variant} 连续 ${count} 回合 S→S 升级但行为未见改善。`,
      specificGuidance,
      '- 要求：MUST 用工具调用验证所有声明。NEVER 声称有证据但实际没有。',
      '- 修正前本回合将持续拦截。',
    ].join('\n');
  }

  /** 质量升级检测 */
  private runQualityDetection(sig: ReturnType<typeof compressStep>): void {
    observeBehavior(this.variantRegistry, sig);
    const qualityIssue = detectQualityIssue(this.variantRegistry, sig, this.currentStep);
    if (qualityIssue) {
      // 升级前的 level（旧值）
      const currentLevel = this.variantRegistry.get(qualityIssue.targetVariant)?.level;
      escalateQuality(qualityIssue, this.stepInjectedVariants, (text, meta) => this.inject(text, meta));
      this.variantRegistry.updateLevel(qualityIssue.targetVariant, qualityIssue.suggestedLevel, this.currentStep);

      // 🆕 Phase15: S→S 追踪 — 升级前已是 S 级 = S→S 升级
      if (currentLevel === 'S') {
        this.trackBehaviorViolation(qualityIssue.targetVariant);
      }
    }
  }

  /** 偏差链修复跟踪 */
  private tryResolveDeviationChain(): void {
    if (!this.deviationChainActive || this.deviationChainResolved) return;
    if (this.deviationChainReason.includes('Edit 未查 LSP.references')) {
      if (this.hasCalledLspReferencesThisStep) this.deviationChainResolved = true;
    } else if (this.deviationChainReason.includes('验证失败')) {
      const lastText = extractLastAssistantText(this.agent.context.history);
      const sig = compressStep(this.stepToolCounts, lastText);
      if (sig.hasVerificationTools) this.deviationChainResolved = true;
    }
    // Phase 18: 代码质量偏差链 — 违规消失则已修复
    if (this.deviationChainReason.includes('代码质量')) {
      if (this.codeQualityViolationsThisTurn === 0) {
        this.deviationChainResolved = true;
      }
    }
  }

  /** 拦截日志增量注入 */
  private injectInterceptionSummary(): void {
    const eventSummary = this.eventLog.getNewTurnSummary(this.currentTurnId);
    if (eventSummary.length > 0) {
      this.inject(eventSummary, { kind: 'injection', variant: 'interception_log' });
    }
  }

  /** 元日志健康检查 */
  private checkEventLogHealth(): void {
    if (this.currentStep > 10 && this.eventLog.getTurnEvents(this.currentTurnId).length === 0) {
      this.agent.log.warn('eventLog empty but turn > 10 steps', { turnId: this.currentTurnId, step: this.currentStep });
    }
  }

  /** 🆕 Phase15: behaviorObserved 已标记的变体 → 重置跨回合违规计数 */
  private resetObservedBehaviorViolations(): void {
    for (const variant of Object.keys(this.crossTurnFlags.behaviorViolations)) {
      const record = this.variantRegistry.get(variant);
      if (record?.behaviorObserved === true) {
        delete this.crossTurnFlags.behaviorViolations[variant];
      }
    }
  }

  /** SceneMemoryDetector — 用户说了"上次/以前"但 AI 没查记忆 */
  private detectSceneMemoryIssue(): void {
    if (!this.lastUserInputText || this.currentStep !== 1) return;
    const sceneMemoryIssue = detectSceneMemory(this.lastUserInputText, this.lastStepCalledMemoryLookup);
    if (sceneMemoryIssue.needsReminder) {
      this.inject('用户提到了"上次/以前"——先用 MemoryLookup 查历史记录，不要靠猜。', { kind: 'injection', variant: 'scene_memory_recall' });
    }
  }

  /** Guard 规则引擎检测 + 记忆关联 */
  private async runGuardDetection(): Promise<void> {
    const guardResult = checkGuard(this.agent.context.history, {
      hasKnowledgeTools: this.hasKnowledgeToolsThisStep,
      hasWriteTools: this.hasWriteToolsThisStep,
      lastBashExitCode: this.lastBashExitCode,
      hasMemoryLookup: this.lastStepCalledMemoryLookup,
      hasCurrentCodeTools: this.hasCurrentCodeToolsThisStep,
    });
    if (guardResult.rule > 0) {
      this.lastGuardFeedback = guardResult.feedback;
      if (this.agent.memoStore) {
        const memQuery = guardResult.rule === 1 ? '测试 验证 谎报 通过'
          : guardResult.rule === 2 ? '检查发现 证据 工具调用'
          : guardResult.rule === 3 ? '已修改 编辑 未改 编造'
          : '记忆 代替 Read 验证 代码';
        const relatedRules = await searchBehaviorRules(this.agent.memoStore, memQuery, 1);
        if (relatedRules.length > 0) {
          this.lastGuardFeedback += '\n\n' + formatBehaviorRule(relatedRules[0]!);
        }
      }
      if (guardResult.block) {
        this.confabulationBlocked = true;
        this.guardRule1FiredThisTurn = true;
        this.eventLog.record({ kind: 'confabulation', variant: 'guard_rule_1', action: 'detected', step: this.currentStep, turnId: this.currentTurnId, reason: guardResult.reason });
      } else {
        this.eventLog.record({ kind: 'guard_observe', variant: `guard_rule_${guardResult.rule}`, action: 'detected', step: this.currentStep, turnId: this.currentTurnId, reason: guardResult.reason });
        this.inject(this.lastGuardFeedback, { kind: 'injection', variant: 'guard_feedback_rule_' + guardResult.rule });
      }
    } else {
      this.lastGuardFeedback = null;
    }
  }

  /** 记忆主动注入 — afterStep 场景触发 */
  private async injectBehaviorRulesAfterStep(): Promise<void> {
    const lastAssistantText = extractLastAssistantText(this.agent.context.history);
    if (lastAssistantText.length > 0 && this.agent.memoStore) {
      const sceneQuery = detectSceneQuery([{ type: 'text' as const, text: lastAssistantText }]);
      if (sceneQuery) {
        const sceneRules = await searchBehaviorRules(this.agent.memoStore, sceneQuery, 1);
        if (sceneRules.length > 0) {
          this.inject(formatBehaviorRule(sceneRules[0]!), { kind: 'system_trigger', name: 'behavior_rule' });
        }
      }
    }
  }

  /** 正反馈注入 — 每回合一次 */
  private injectPositiveFeedbackThisTurn(): void {
    if (this.positiveFeedbackGivenThisTurn) return;

    // 行为正反馈（原逻辑）
    const behaviorClean =
      !this.confabulationBlocked &&
      !this.deviationChainActive &&
      !this.verifyFailedThisStep;

    const hasGoodBehavior =
      this.hasCalledLspReferencesThisStep ||   // 查了引用
      this.editWithoutLookupCount === 0;        // 没跳步编辑

    // 代码质量正反馈（Phase 18 新增）
    const codeQualityClean = this.codeQualityViolationsThisTurn === 0;
    const hasNonEmptyTurn = this.currentStep >= 1;

    if (behaviorClean && hasGoodBehavior && codeQualityClean && hasNonEmptyTurn) {
      this.positiveFeedbackGivenThisTurn = true;
      this.inject('【行为确认】本轮验证流程完整且代码质量合规。继续。', { kind: 'injection', variant: 'feedback_positive' });
    }
  }

  /** CodeRefDetector — 检测代码块是否缺路径/行号 */
  private detectCodeRefIssue(): void {
    const codeRefAssistantText = extractLastAssistantText(this.agent.context.history);
    if (codeRefAssistantText.length > 100 && this.currentStep > 1) {
      const codeRefIssue = detectCodeRefQuality(codeRefAssistantText);
      if (codeRefIssue.hasMissingRef) {
        this.inject('Code blocks without file references. ALWAYS prefix with path and line range.', { kind: 'injection', variant: 'step_code_ref_quality' });
      }
    }
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

  // ── Phase 14: 收敛条件初始化 ────────────────────────────────────
  private initConvergenceConditions(): void {
    this.convergenceConditions = [
      {
        priority: 10,
        check: () => !this.currentStepHadContent
          ? 'The last assistant step produced no content or tool calls. Continue the task.'
          : null,
      },
      {
        priority: 9,
        check: () => {
          const goal = this.agent.goal.getGoal().goal;
          return goal?.status === 'active' && !this.todoSeenThisTurn
            ? 'An active goal exists but no TodoList update was made this turn. Update TodoList and continue.'
            : null;
        },
      },
      {
        priority: 8,
        check: () => {
          const latestVerification = this.agent.workingSet.getLatestVerificationForTurn(this.currentTurnId);
          const hasPassed = latestVerification?.passed === true;
          if (this.lastToolFailure?.isExploratory === false && !hasPassed) {
            const faaEntries = this.agent.fileActionAudit?.getRecentEntries(5);
            const faaSnippet = faaEntries && faaEntries.length > 0
              ? `\n\nRecent file audit entries (most recent first):\n${faaEntries.map(e =>
                  `  ${e.action} — ${e.resultPreview}  (${e.success ? 'OK' : 'FAIL'}, ${e.durationMs}ms)`
                ).join('\n')}`
              : '';
            // 三级分类：BLOCKER（验证失败）/ CRITICAL（OOM/超时）/ WARNING（其他）
            if (this.verifyFailedThisStep) {
              return `Step verification failed (${this.lastToolFailure.toolName})。不要跳过验证，修复根因后继续。${faaSnippet}`;
            }
            const criticalExit = this.lastBashExitCode;
            if (criticalExit === 137 || criticalExit === 124) {
              return `工具 ${this.lastToolFailure.toolName} 异常退出 (exit ${criticalExit})。可能资源耗尽或超时，检查状态后重试。${faaSnippet}`;
            }
            return `工具 ${this.lastToolFailure.toolName} 报告错误。检查最近的输出修复它。${faaSnippet}`;
          }
          return null;
        },
      },
      {
        priority: 7,
        check: () => {
          const latestVerification = this.agent.workingSet.getLatestVerificationForTurn(this.currentTurnId);
          if (latestVerification && !latestVerification.passed && !this.verificationFailureInjected) {
            this.verificationFailureInjected = true;
            return `The last verification command failed (${latestVerification.command}). Fix the failure before re-running verification. Do NOT downgrade to runtime smoke tests.`;
          }
          return null;
        },
      },
      {
        priority: 6,
        check: () => this.deviationChainActive && !this.deviationChainResolved
          ? `Deviation chain still active: ${this.deviationChainReason}. Resolve the underlying issue before ending the turn.`
          : null,
      },
      {
        priority: 5,
        check: () => this.verifyFailStep >= 0
          ? 'The last verification pass may be a false pass — no substantive changes were made. Make an actual fix and re-verify.'
          : null,
      },
      {
        priority: 4,
        check: () => !this.turnHasCalledAnyLsp && this.totalCodeFileEditsThisTurn >= 3
          ? 'Edited ' + this.totalCodeFileEditsThisTurn + '+ code files this turn without any LSP.references call. Verify callers before reporting completion.'
          : null,
      },
    ];
  }

  /** 反事实阻断条件（含 searchBehaviorRules 副作用，提取为命名方法） */
  private collectConfabulationBlockReason(reasons: string[]): void {
    if (!this.confabulationBlocked) return;
    const sig = compressStep(this.stepToolCounts, extractLastAssistantText(this.agent.context.history));
    if (sig.hasKnowledgeTools) {
      this.confabulationBlocked = false;
      return;
    }
    if (this.lastGuardFeedback) {
      reasons.push(this.lastGuardFeedback);
    } else {
      reasons.push('High-confidence unfounded claims detected. Provide tool evidence before ending.');
    }
    if (this.agent.memoStore) {
      searchBehaviorRules(this.agent.memoStore, '编造 证据 工具调用 检查发现', 1)
        .then(convaRules => {
          if (convaRules.length > 0) {
            this.inject(formatBehaviorRule(convaRules[0]!), { kind: 'system_trigger', name: 'behavior_rule' });
          }
        });
    }
  }

  /** pending-doc 未写入检测（含 await） */
  private async collectPendingDocReason(reasons: string[]): Promise<void> {
    if (reasons.length > 0 || !this.agent.memoStore) return;
    const pendingDocs = await searchPendingDoc(this.agent.memoStore);
    if (pendingDocs.some(m => m.userNeed.includes('[P0]'))) {
      reasons.push('有 P0 级待写入知识未处理。请先写入 SYSTEM/*.md / DECISIONS/*.md / pitfalls.md 再交付。\n' + formatPendingDocInject(pendingDocs));
    }
  }

  /** Phase 14: 跨回合标记注入 — 上回合有拦截事件时下回合预防性提醒 */
  private injectCrossTurnFlags(): void {
    // 消费旧值后立即复位（避免 runOneTurn 提前清零导致永不起效）
    if (this.crossTurnFlags.lastTurnHadGuardRule1) {
      this.inject(
        '上回合检测到测试结果矛盾或高置信度无依据声明。本回合请真实运行工具验证后再报告。',
        { kind: 'system_trigger', name: 'behavior_rule' },
      );
    }
    if (this.crossTurnFlags.lastTurnHadDeviation) {
      this.inject(
        '上回合因偏差链被拦截。本回合如涉及修改代码，请先查 LSP.references。',
        { kind: 'system_trigger', name: 'behavior_rule' },
      );
    }
    this.crossTurnFlags.lastTurnHadGuardRule1 = false;
    this.crossTurnFlags.lastTurnHadDeviation = false;
  }

  /** Reset per-step injection tracking state (called at runOneTurn and afterStep). */
  private resetInjectorStepState(): void {
    this.stepInjectedVariants.clear();
    this.hasCalledLspReferencesThisStep = false;
    this.searchHadResultsThisStep = false;
    this.verifyFailedThisStep = false;
    this.editCalledSuccessThisStep = false;
    this.editOnCodeFileThisStep = false;
    this.hasKnowledgeToolsThisStep = false;
    this.hasWriteToolsThisStep = false;
    this.lastStepCalledMemoryLookup = false;
    this.hasCurrentCodeToolsThisStep = false;
    this.stepToolCounts = {};
    // Phase 21: reset per-step state for stuck injection
    this.editFileThisStep = undefined;
    this.toolErrorThisStep = undefined;
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

  // ── Phase 17: 维度1 — 探索 vs 验证区分 ────────────────────────────
  /**
   * 区分探索型 Read/Grep 与验证型 Read/Grep。
   *
   * Read 刚改过的文件、Grep 具体路径 = 验证（不计数）。
   * Grep 无路径/通配、Read 未知路径 = 探索（计入阈值）。
   *
   * toolCallContext 参数复用了 prepareToolExecution/finalizeToolResult 的 ctx 类型，
   * 包含了 toolCall.name 和 args。
   */
  private isExploratoryReadGrep(ctx: { toolCall: { name: string }; args: unknown }): boolean {
    if (ctx.toolCall.name === 'Grep') {
      const args = ctx.args as { path?: string; pattern?: string };
      // Grep 有具体路径 → 验证/定位，不计数
      if (args.path && !/[*?[{]/.test(args.path)) return false;
      // Grep 无路径或通配 → 探索
      return true;
    }
    // Read / ReadGroup / ReadMediaFile
    if (ctx.toolCall.name === 'Read' || ctx.toolCall.name === 'ReadGroup' || ctx.toolCall.name === 'ReadMediaFile') {
      const args = ctx.args as { path?: string };
      if (!args.path) return false; // no path can't be classified
      const readPath = args.path;
      // 读刚改过的文件 → 验证
      for (const modifiedPath of this.recentlyModifiedPathsThisTurn) {
        if (readPath === modifiedPath || readPath.endsWith('/' + modifiedPath) || modifiedPath.endsWith('/' + readPath)) {
          return false;
        }
      }
      // 其他 → 探索（查看未知代码路径）
      return true;
    }
    return false;
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
        display:
          event.result.isError === true ? undefined : event.result.display,
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
