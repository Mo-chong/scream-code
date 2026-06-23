/**
 * Step signature — low-dimensional compression of one execution step.
 *
 * Transforms full step context (tool calls, output text) into a compact signature
 * that detectors can work with. Pure functions only — no side effects, no `this`.
 */

import type { ContextMessage } from '../context';

// ── Tool classification ────────────────────────────────

/** Tools that acquire new information from external sources. */
const KNOWLEDGE_TOOLS = new Set([
  'Read',
  'Grep',
  'LSP',
  'WebSearch',
  'MemoryLookup',
  'FetchURL',
]);

/** Tools that modify files or execute commands. */
const ACTION_TOOLS = new Set([
  'Edit',
  'Write',
  'Bash',
]);

/** Marker tokens correlated with confabulation (authority-pretending phrases). */
const CONFA_MARKERS = [
  // Chinese authority markers
  '根据文档',
  '根据文档显示',
  '文档显示',
  '按照规范',
  '官方文档',
  '实际上',
  '准确地说',
  '严格来说',
  '你应该知道',
  '必须注意',
  '值得一提的是',
  // English authority markers
  'According to the documentation',
  'the docs show',
  'as per the specification',
  'officially',
];

// ── Types ──────────────────────────────────────────────

export interface StepSignature {
  /** Per-tool-name invocation count for this step. */
  toolCounts: Record<string, number>;
  /** Whether any knowledge-acquisition tool was called. */
  hasKnowledgeTools: boolean;
  /** Whether any action tool was called. */
  hasActionTools: boolean;
  /** Whether any verification tool was called. */
  hasVerificationTools: boolean;
  /** Whether the output text contains confabulation marker tokens. */
  markerTokenFound: boolean;
  /** Length of the step's text output in characters. */
  outputLength: number;
}

export interface ContextSnapshot {
  /** How many of the last few steps had knowledge tools (0-3). */
  recentKnowledgeSteps: number;
  /** Steps since the last knowledge tool (-1 if none this turn). */
  recentKnowledgeDepth: number;
  /** Expected probability of knowledge-tool use for this task/step. */
  stepNormRate: number;
  /** Whether this step is in delivery (wrapping up) phase. */
  deliveryPhase: boolean;
  /** Which step number within the turn (1-based). */
  turnStepNumber: number;
}

// ── Pure helpers ───────────────────────────────────────

function hasAnyTool(
  toolCounts: Record<string, number>,
  toolSet: Set<string>,
): boolean {
  for (const name of Object.keys(toolCounts)) {
    if (toolSet.has(name)) return true;
  }
  return false;
}

// ── Compress ───────────────────────────────────────────

/**
 * Compress a step's raw data into a low-dimensional StepSignature.
 *
 * Pure function. No side effects. Deterministic.
 */
export function compressStep(
  toolCounts: Record<string, number>,
  outputText: string,
): StepSignature {
  return {
    toolCounts,
    hasKnowledgeTools: hasAnyTool(toolCounts, KNOWLEDGE_TOOLS),
    hasActionTools: hasAnyTool(toolCounts, ACTION_TOOLS),
    hasVerificationTools: hasAnyTool(toolCounts, new Set(['Bash'])),
    markerTokenFound: CONFA_MARKERS.some((m) => outputText.includes(m)),
    outputLength: outputText.length,
  };
}

// ── Context snapshot ───────────────────────────────────

/**
 * Build context snapshot from turn state.
 *
 * Pure function.
 */
export function buildContextSnapshot(
  toolCounts: Record<string, number>,
  stepNumber: number,
): ContextSnapshot {
  const hasKnowledge = hasAnyTool(toolCounts, KNOWLEDGE_TOOLS);

  return {
    recentKnowledgeSteps: hasKnowledge ? 1 : 0,
    recentKnowledgeDepth: hasKnowledge ? 0 : -1,
    stepNormRate: hasKnowledge ? 0.70 : 0.25,
    deliveryPhase: false, // refined in later phases
    turnStepNumber: stepNumber,
  };
}

// ── Context extraction ─────────────────────────────────

/**
 * Extract the last assistant text content from context history.
 *
 * Walks backwards to find the most recent assistant message and
 * concatenates all text parts.
 */
export function extractLastAssistantText(
  history: readonly ContextMessage[],
): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg?.role === 'assistant') {
      return (msg.content as Array<{ type: string; text?: string }>)
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n');
    }
  }
  return '';
}
