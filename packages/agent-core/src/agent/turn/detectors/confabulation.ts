/**
 * Confabulation Detector — residual-based anti-fabrication check.
 *
 * Detection paths:
 * - Evidence path active (has knowledge tools) → confidence 0
 * - Score what the model output exceeds available evidence
 *
 * Pure functions. No side effects. Does not read model output semantically.
 */

import type { StepSignature, ContextSnapshot } from '../signature';

export type Confidence = 0 | 1 | 2 | 3;

export interface DetectionResult {
  confidence: Confidence;
  reason: string;
  detail?: string;
}

/**
 * Detect confabulation via residual scoring.
 *
 * Pure function — deterministic, no side effects.
 */
export function detectConfabulation(
  sig: StepSignature,
  ctx: ContextSnapshot,
): DetectionResult {
  // ── Evidence path: knowledge tools active → skip ──
  if (sig.hasKnowledgeTools) {
    return { confidence: 0, reason: 'identity: step has knowledge tools' };
  }

  // ── Delivery phase: knowledge tools not expected ──
  if (ctx.deliveryPhase) {
    return { confidence: 0, reason: 'delivery phase: knowledge tools not expected' };
  }

  // ── Scoring ──
  let score = 0;
  const signals: string[] = [];

  // Signal 1: verbose output with no knowledge tools and no recent knowledge
  if (sig.outputLength > 200 && !sig.hasKnowledgeTools) {
    score += 2;
    signals.push('verbose output without evidence path');
  }

  // Signal 2: marker tokens present
  if (sig.markerTokenFound) {
    score += sig.outputLength > 200 ? 2 : 1;
    signals.push('authority marker tokens found');
  }

  // Signal 3: action-only step with long output (doing + claiming)
  if (sig.hasActionTools && !sig.hasKnowledgeTools && sig.outputLength > 150) {
    score += 1;
    signals.push('action-only step with substantive output');
  }

  // ── Normalize (v1: no-op) ──
  // score = Math.round(score * (1 - ctx.stepNormRate));

  // ── Confidence mapping ──
  if (score >= 3) {
    return { confidence: 3, reason: 'high: output exceeds evidence gap', detail: signals.join('; ') };
  }
  if (score >= 2) {
    return { confidence: 2, reason: 'medium: possible evidence gap', detail: signals.join('; ') };
  }
  if (score >= 1) {
    return { confidence: 1, reason: 'low: minor evidence gap', detail: signals.join('; ') };
  }
  return { confidence: 0, reason: 'normal' };
}
