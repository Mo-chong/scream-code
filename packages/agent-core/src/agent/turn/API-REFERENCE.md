# Turn Module API Reference

> AI-readable interface reference — organized by action flow, not by file structure.

---

## Architecture overview

**4 injection triggers + 3 pure-function detectors + 1 unified inject route.**

### Triggers (when injection happens)

| Trigger | Code location | Timing |
|---------|:------------:|--------|
| `prepareToolExecution` | `index.ts:811` | Before each tool call |
| `finalizeToolResult` | `index.ts:911` | After each tool result |
| `afterStep` | `index.ts:623` | End of each execution step |
| `runOneTurn` | `index.ts:394` | Turn start (intent injection) |

### Detectors (pure functions, stateless, testable)

| Detector | File | Input | Output |
|----------|------|-------|--------|
| IntentDetector | `detectors/intent.ts` | User prompt text | `IntentDetection \| null` |
| QualityDetector | `detectors/quality.ts` | VariantRegistry + StepSignature | `QDetectionResult \| null` |
| ConfabulationDetector | `detectors/confabulation.ts` | StepSignature + ContextSnapshot | `DetectionResult` |

### Unified inject route

All triggers and detectors call `inject(text, meta)` at `index.ts:1199`, which handles:

```
inject(text, meta) →
  ├─ system_trigger kind → bypass budget, inject directly
  ├─ quality_escalate_ variant → bypass budget, inject directly
  ├─ repeatDecay(record) === 'skip' → silent discard (triggerCount ≥5)
  ├─ ResNet: !shouldInjectByResidual(record, step, meta) → silent skip (attention still sufficient)
  │     (variant must have a VariantMeta entry; unconfigured variants pass through)
  ├─ ResNet: shouldUseShortText → shortenText(text) (mild attention decay, shorter reminder)
  ├─ deviationChainActive → bypassBudget() before check
  ├─ canInject(estimatedTokens, effectiveLevel) → false → silent discard
  └─ appendSystemReminder + budget.record() + variantRegistry.record()
```

ResNet residual formula: `R = W × D^Δs` where:
- W = static weight (0-1), higher = more important
- D = decay per step (0.8-0.99), higher = slower decay
- Δs = steps since last injection of this variant
- R < threshold → inject. R >= threshold → skip.

See §9.5 **ResNet injection scheduling** for the full variant configuration table.

---

## 1. When I call Edit

### prepareToolExecution (before Edit runs)

| Field | Value |
|-------|-------|
| variant | `prepare_edit` |
| weight | A (MUST) |
| inject text | `"MUST update all callers after edit. Use LSP.references."` |
| trigger condition | `ctx.toolCall.name === 'Edit'` |

### finalizeToolResult (after Edit succeeds)

| Field | Value |
|-------|-------|
| variant | `post_edit` |
| weight | A (MUST) |
| inject text | `"NEVER leave callers unverified without update."` |
| trigger condition | Edit succeeded (`isError !== true`) |

### afterStep (behavior check)

| Variant | Weight | Condition | Inject text |
|---------|:------:|-----------|-------------|
| `step_after_edit` | A | `editWithoutLookupCount ≥ 2` | `"MUST check callers. Missing LSP.references before edit."` |
| `step_after_edit` | B | `editWithoutLookupCount === 1` | `"Edit done → consider verifying before continuing."` |
| — reset | — | Edit + LSP.references both called | `editWithoutLookupCount = 0` |

### Deviation chain (toxicity intercept)

```
editWithoutLookupCount ≥ 3 → deviationChainActive = true
→ shouldContinueAfterStop: inject deviation_chain_intercept (S)
  "偏差链检测到：连续多次 Edit 未查 LSP.references"
  "MUST verify all claims with tool calls. NEVER fabricate."
```

### Behavior observation (afterStep, `detectors/quality.ts:observeBehavior`)

| Variant | Observed when |
|---------|--------------|
| `prepare_edit` | `sig.hasKnowledgeTools` |
| `post_edit` | `sig.hasKnowledgeTools` |
| `step_after_edit` | `sig.hasKnowledgeTools` |

When observed → quality detector skips escalation.

---

## 2. When I call Grep or LSP

### prepareToolExecution

| Field | Value |
|-------|-------|
| variant | `prepare_search` |
| weight | A (MUST) |
| inject text | `"NEVER edit after seeing only one match. Evaluate ALL results."` |
| trigger | Grep or LSP call |

### finalizeToolResult

| Field | Value |
|-------|-------|
| variant | `post_search` |
| weight | B (structured) |
| inject text | `"Full picture ready. NOW design and apply the change."` |
| trigger | Grep/LSP returned non-empty content |

### afterStep

| Variant | Weight | Condition | Inject text |
|---------|:------:|-----------|-------------|
| `step_after_search` | B | Search had results but no Edit this step | `"Refs found. Design change before editing."` |

### Behavior observation

| Variant | Observed when |
|---------|--------------|
| `prepare_search` | `sig.hasKnowledgeTools` |
| `step_after_search` | `sig.hasActionTools` |

---

## 3. When I call Bash

### prepareToolExecution

| Variant | Weight | Condition | Inject text |
|---------|:------:|-----------|-------------|
| `prepare_bash_file` | C (negative) | matches `cat|head|tail|less|more` | `"NEVER use Bash for file reads. Use Read/Edit/Grep."` |
| `prepare_verify` | C (negative) | `looksLikeVerificationCommand(cmd)` | `"Fail → fix. NEVER downgrade verification."` |

### finalizeToolResult

| Variant | Weight | Condition | Inject text |
|---------|:------:|-----------|-------------|
| `post_verify_pass` | B | Verify succeeded | `"Verification passed. Deliver the result."` |
| `post_verify_fail` | A (MUST) | Verify failed | `"NEVER downgrade verification. Fix the root cause."` |

### Deviation chain

```
verifyFailedThisStep → deviationChainActive = true
→ shouldContinueAfterStop: inject deviation_chain_intercept (S)
  "验证失败：已触发偏差拦截。"
  "MUST verify all claims..."
```

### Behavior observation

| Variant | Observed when |
|---------|--------------|
| `prepare_bash_file` | `sig.toolCounts['Read'] > 0` |
| `prepare_verify` | `sig.hasVerificationTools` |
| `step_after_verify_fail` | `sig.hasVerificationTools` |

---

## 4. When I call Write

### prepareToolExecution

| Field | Value |
|-------|-------|
| variant | `prepare_write` |
| weight | A (MUST) |
| inject text | depends on file extension: `.md` → verify format; `.ts/.tsx` → verify build; other → check correctness |
| trigger | Write call |

### finalizeToolResult

| Variant | Weight | Condition | Inject text |
|---------|:------:|-----------|-------------|
| `post_write_large` | B | Output > 500 chars | `"Large output written. MUST review for correctness."` |

### Behavior observation

| Variant | Observed when |
|---------|--------------|
| `prepare_write` | `sig.hasVerificationTools` |

---

## 5. When I call MemoryLookup

### prepareToolExecution

| Field | Value |
|-------|-------|
| variant | `prepare_memory` |
| weight | A (MUST) |
| inject text | `"MUST check whatFailed before repeating approach."` |
| trigger | MemoryLookup call |

### finalizeToolResult

| Variant | Weight | Condition | Inject text |
|---------|:------:|-----------|-------------|
| `post_memory` | B | MemoryLookup returned content | `"NOW apply whatFailed lessons from results above."` |

### Behavior observation

| Variant | Observed when |
|---------|--------------|
| `prepare_memory` | `sig.hasKnowledgeTools` |
| `post_memory` | `sig.hasKnowledgeTools` |

---

## 6. Turn start — intent injection

**Trigger:** `runOneTurn`, after `appendUserMessage`.

**Detector:** `detectors/intent.ts` — pure function matching user prompt keywords.

```typescript
function detectIntent(input: ContentPart[]): IntentDetection | null
```

### Intent rules

| Variant | Keywords (≥2 → high) | Exclude | High markers |
|---------|----------------------|---------|--------------|
| `intent_fix_bug` | fix, bug, error, fail, broken, crash, incorrect, wrong, regression | — | reproduction |
| `intent_refactor` | refactor, restructure, rewrite, clean up, reorganize, modernize, migrate | test, config | all callers, compatibility shim, clean cutover |
| `intent_add_feature` | add, feature, new, implement, create, build, integrate | test, config, setting | — |
| `intent_review` | review, audit, check, inspect, scan | fix, refactor, add | only review, read only, examine |
| `intent_research` | research, investigate, find out, explore, learn about, search for | — | deep dive, thorough, compare |
| `intent_document` | document, write docs, explain, tutorial, readme | — | api reference, user guide |

**Weight mapping:** low confidence → B (structured steps), high confidence → A (MUST/NEVER).

**Injector:** `injectors/intent.ts` — passes detected text to `inject()`.

**Integration** (in `runOneTurn`):
```typescript
if (origin.kind === 'user') {
  const intent = detectIntent(input);
  if (intent) {
    injectIntentGuidance(intent, (text, meta) => this.inject(text, meta));
  }
}
```

### Behavior observation

| Variant | Observed when |
|---------|--------------|
| `intent_fix_bug` | `sig.toolCounts['Edit'] > 0` |
| `intent_refactor` | `sig.hasKnowledgeTools` |
| `intent_add_feature` | `sig.toolCounts['Read'] > 0 \|\| sig.toolCounts['Glob'] > 0` |
| `intent_review` | `sig.toolCounts['Read'] > 0 && !sig.hasActionTools` |
| `intent_research` | `sig.hasKnowledgeTools` |
| `intent_document` | `sig.hasKnowledgeTools \|\| sig.toolCounts['Edit'] > 0 \|\| sig.toolCounts['Write'] > 0` |

---

## 7. Step end — quality & confabulation detection

Runs in `afterStep` (`index.ts:623-701`), in this order:

```
1. observeBehavior(registry, sig)        → mark variants as observed
2. detectQualityIssue(registry, sig, step) → check for decay
3. if issue → escalateQuality(issue, dedupSet, inject) → quality_escalate_ variant
4. detectConfabulation(sig, snap)         → check for unsupported claims
5. if high confidence → injectAntiConfabulation(result, dedupSet, inject)
```

### Quality detector (`detectors/quality.ts`)

```typescript
function detectQualityIssue(
  registry: VariantRegistry,
  sig: StepSignature,
  currentStep: number,
): QDetectionResult | null

function observeBehavior(
  registry: VariantRegistry,
  sig: StepSignature,
): void
```

| Signal | Condition | Confidence |
|--------|-----------|:----------:|
| decay | Injected ≥3 steps ago + `behaviorObserved === null` | 1 |
| escalate | Weight C/D + `hasActionTools` + output > 200 | 2 |

**Escalation path:** C/D → B → A → S (one level per trigger).

**Behavior observed:** variant is tracked as effective — quality skips it.

### Quality injector (`injectors/quality.ts`)

```typescript
function escalateQuality(
  result: QDetectionResult,
  dedupSet: Set<string>,
  appendReminder: (text, meta) => void,
): void
```

| Path | Strategy | Text includes |
|:----:|----------|-------------|
| C/D → B | Structured "Step 1/2/3" format | variant name + reason |
| B → A | MUST/NEVER | variant name + reason |
| A → S | ALWAYS / structural requirement | variant name + reason |
| S → S | fallback A | variant name + reason |

Reason format: `"{variant}: injected {N} steps ago (triggered {M}x), behavior not observed; escalating {level}→{newLevel}"`

### Confabulation detector (`detectors/confabulation.ts`)

```typescript
function detectConfabulation(
  sig: StepSignature,
  ctx: ContextSnapshot,
): DetectionResult
```

| Signal | Condition | Score |
|--------|-----------|:----:|
| 1. Verbose without evidence | output > 200 && !hasKnowledgeTools | +2 |
| 2a. Markers + short output | markerTokenFound && !verbose | +1 |
| 2b. Markers + long output | markerTokenFound && verbose | +2 |
| 3. Action + assertion | hasActionTools && !hasKnowledgeTools && output > 150 | +1 |

**Evidence path:** `hasKnowledgeTools === true` → confidence 0 (skip).

### Confabulation injector (`injectors/anti_confabulation.ts`)

```typescript
function injectAntiConfabulation(
  result: DetectionResult,
  dedupSet: Set<string>,
  appendReminder: (text, meta) => void,
): void
```

Threshold: confidence < 2 → no inject. confidence 2 → gentle hint. confidence 3 → MUST/NEVER.

---

## 8. Budget system (cross-cutting)

**File:** `injectors/budget.ts`
**Class:** `InjectBudget`

Controls how many injection tokens can be used per turn and per step.

### Budget thresholds

| Level | Per turn | Per step | Override allowed |
|:-----:|:--------:|:--------:|:----------------:|
| S | 800 | 250 | 2x |
| A | 600 | 200 | 1.5x |
| B | 500 | 150 | No |
| C | 300 | 100 | No |
| D | 200 | 80 | No |

### Dynamic factors

**stepNorm:** `1 + (1 / (stepNumber + 1))` — more budget early, less later.
**degradationFactor:** `max(0.4, 1 - variantCount × 0.1)` — more variants = less budget per new inject.

Actual cap = `floor(configCap × stepNorm × degradationFactor)`

### Bypass rules

| Condition | Effect |
|-----------|--------|
| `meta.kind === 'system_trigger'` | Skip budget (convergence) |
| `variant.startsWith('quality_escalate_')` | Skip budget (escalation is remedy for budget-limit) |
| `behaviorObserved === true` | Effective level = C (lowest budget cost) |
| `deviationChainActive` | `bypassBudget()` called — single-use override |
| `repeatDecay(record) === 'skip'` | Variant not injected (never hits budget) |

### Integration

```typescript
// TurnFlow fields:
private readonly injectBudget = new InjectBudget();

// beforeStep:
this.injectBudget.beginStep(stepNumber);

// runOneTurn:
this.injectBudget.reset();

// inject():
this.injectBudget.canInject(estimatedTokens, effectiveLevel) → boolean
this.injectBudget.record(actualTokens)
this.injectBudget.syncVariantCount(this.variantRegistry.size)
```

---

## 9. VariantRegistry — data layer

**File:** `variant-registry.ts`

Per-turn metadata for all injected variants. Records weight, timing, behavior observation, and trigger count.

```typescript
interface VariantRecord {
  variant: string;
  level: WeightLevel;                 // S/A/B/C/D
  stepInjected: number;               // Last injection step (updated on re-inject)
  turnStep: number;                   // Global step number
  behaviorObserved: boolean | null;   // True = effective, false = ignored, null = unknown
  lastEscalatedAtStep: number;        // Last escalation step
  triggerCount: number;               // Cross-step trigger count (≥5 → repeatDecay skip)
}

type WeightLevel = 'S' | 'A' | 'B' | 'C' | 'D';
```

### Methods

| Method | Signature | Description |
|--------|-----------|-------------|
| `record` | `(variant, level, step) => void` | Record variant. Re-inject: increment triggerCount, update stepInjected |
| `get` | `(variant) => VariantRecord \| undefined` | Get record by name |
| `getAll` | `() => VariantRecord[]` | All records |
| `markBehaviorObserved` | `(variant) => void` | Mark variant as effective |
| `markBehaviorNotObserved` | `(variant) => void` | Mark variant as ineffective |
| `markEscalated` | `(variant, step) => void` | Mark escalated |
| `updateLevel` | `(variant, newLevel, step) => void` | In-place level update |
| `reset` | `() => void` | Clear all (turn start) |
| `hasIntentVariants` | `() => boolean` | Quick intent check |
| `size` | `getter: number` | Record count |

### Pure functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `detectWeightLevel` | `(text) => WeightLevel` | Text pattern → weight: `<system-reminder`→S, MUST/NEVER/ALWAYS→A, Step→B, DO NOT/Never→C, else→D |
| `escalateLevel` | `(level) => WeightLevel` | One-level up: C/D→B, B→A, A→S, S→S |
| `repeatDecay` | `(record) => 'full' \| 'skip'` | triggerCount ≥5 && behaviorObserved !== true → skip |

### 9.5 ResNet injection scheduling (Phase 9)

**Model:** Residual attention = `W × D^Δs`. When the remaining attention drops below a threshold, the variant triggers. This replaces the old "always inject on trigger point" strategy with an attention-aware scheduler.

**Integration point:** Inside `TurnFlow.inject()` (index.ts), after `repeatDecay` and before step dedup. Calls are zero-change for existing callsites — the check is transparent.

#### Full configuration table

| Variant | W | D | threshold | minStepGap | Notes |
|---------|:-:|:-:|:---------:|:----------:|-------|
| system_trigger | 1.0 | 0.99 | 0.1 | 0 | Never skipped |
| deviation_chain_intercept | 1.0 | 0.99 | 0.1 | 0 | Never skipped |
| prepare_edit | 0.8 | 0.85 | 0.35 | 4 | |
| prepare_write | 0.8 | 0.85 | 0.35 | 4 | |
| prepare_search | 0.7 | 0.85 | 0.40 | 3 | |
| prepare_memory | 0.7 | 0.85 | 0.40 | 3 | |
| prepare_bash_file | 0.5 | 0.82 | 0.40 | 3 | |
| prepare_verify | 0.8 | 0.85 | 0.35 | 4 | |
| post_edit | 0.6 | 0.80 | 0.40 | 4 | |
| post_search | 0.6 | 0.80 | 0.40 | 4 | |
| post_write_large | 0.5 | 0.80 | 0.40 | 4 | |
| post_verify_pass | 0.5 | 0.80 | 0.40 | 4 | |
| post_verify_fail | 0.9 | 0.88 | 0.30 | 3 | High weight = urgent |
| post_memory | 0.6 | 0.80 | 0.40 | 4 | |
| step_after_edit | 0.6 | 0.80 | 0.40 | 5 | |
| step_after_search | 0.5 | 0.80 | 0.40 | 5 | |
| step_after_verify_fail | 0.8 | 0.85 | 0.35 | 4 | |
| intent_* (all 6) | 0.7-0.9 | 0.88-0.92 | 0.30 | 0 | Injected once at turn start |

Unconfigured variants (e.g., `session_memory`, `dream_suggestion`) are passed through without residual check.

#### Short-text adaptation

When `shouldUseShortText()` returns true (residual > threshold × 0.5), the inject text is shortened by `shortenText()`:
1. First MUST/NEVER/ALWAYS imperative line is used
2. Fallback: first non-empty line of original text

Example: `"NEVER leave callers unverified without update."` instead of the full multi-line reminder.

#### Key design property

**Old callsite zero-change.** Every existing `this.inject(text, meta)` call automatically receives attention-aware scheduling. The variant just needs an entry in `VARIANT_META`. If there is no entry, the variant passes through unchanged.

---

## 10. Signature utility

**File:** `signature.ts`

Low-dimensional compression of one execution step. Pure functions.

```typescript
interface StepSignature {
  toolCounts: Record<string, number>;   // Per-tool call counts this step
  hasKnowledgeTools: boolean;           // Read/Grep/LSP/WebSearch/MemoryLookup/FetchURL
  hasActionTools: boolean;              // Edit/Write/Bash
  hasVerificationTools: boolean;        // Bash (verify commands only)
  markerTokenFound: boolean;            // Fabrication markers detected
  outputLength: number;                 // Assistant output char count
}

interface ContextSnapshot {
  recentKnowledgeSteps: number;         // Steps since last knowledge tool
  recentKnowledgeDepth: number;         // Steps since nearest knowledge tool
  stepNormRate: number;                 // Scenario normalization coefficient
  deliveryPhase: boolean;               // Is this the delivery phase?
  turnStepNumber: number;               // Current step in turn
}
```

| Function | Signature | Description |
|----------|-----------|-------------|
| `compressStep` | `(toolCounts, outputText) => StepSignature` | Compress step data |
| `buildContextSnapshot` | `(toolCounts, stepNumber) => ContextSnapshot` | Build context snapshot |
| `extractLastAssistantText` | `(history) => string` | Extract last assistant message text |

---

## 11. Integration pattern

```typescript
// afterStep — all detectors run in sequence:
const sig = compressStep(this.stepToolCounts, extractLastAssistantText(this.agent.context.history));
const snap = buildContextSnapshot(this.stepToolCounts, this.currentStep);

observeBehavior(this.variantRegistry, sig);
const qualityIssue = detectQualityIssue(this.variantRegistry, sig, this.currentStep);
if (qualityIssue) {
  escalateQuality(qualityIssue, this.stepInjectedVariants,
    (text, meta) => this.inject(text, meta));
}
const confaResult = detectConfabulation(sig, snap);
injectAntiConfabulation(confaResult, this.stepInjectedVariants,
  (text, meta) => this.inject(text, meta));

// Adding a new detector:
// 1. Pure function: (sig, snap) => result
// 2. Injector: consumes result, calls inject(text, meta)
// 3. Wire in afterStep or runOneTurn
// signature.ts, variant-registry.ts, injectors/budget.ts are all reusable
```

## All registered variants (flat list)

| Group | Variants |
|:-----:|----------|
| A (prepareToolExecution) | prepare_edit(A), prepare_write(A), prepare_search(A), prepare_memory(A), prepare_bash_file(C), prepare_verify(C) |
| B (finalizeToolResult) | post_edit(A), post_search(B), post_write_large(B), post_verify_pass(B), post_verify_fail(A), post_memory(B) |
| C (afterStep) | step_after_edit(A/B), step_after_search(B), step_after_verify_fail(A) |
| D (runOneTurn) | intent_fix_bug(B/A), intent_refactor(B/A), intent_add_feature(B/A), intent_review(B/A), intent_research(B/A), intent_document(B/A) |
| Special | deviation_chain_intercept(S), quality_escalate_*(penetrate), system_trigger(penetrate) |

---

## 12. Interception Event Log

**File:** `event-log.ts`, `event-snapshot.ts`

Records system-level interception events — what the injection system did, not what the AI did. 9 hardcoded `record()` calls inside `inject()` (4), `afterStep` (1), `finalizeToolResult` (1), and `shouldContinueAfterStop` (3). AI has no bypass capability.

### TurnEventLog (event-log.ts)

In-memory ring buffer (200 events max). Per-turn incremental summary injected into AI context via `getNewTurnSummary()`.

```typescript
interface InterceptionEvent {
  seq: number;                              // Monotonic sequence
  kind: string;                             // injection_skipped | injection_delivered | convergence_gate | deviation_chain | confabulation | verify_fail
  variant: string;                          // Variant name (empty string for non-variant events)
  step: number;                             // Turn step number
  action: string;                           // skipped_residual | skipped_budget | skipped_dedup | injected | gate_held | gate_passed | detected
  reason: string;                           // Human-readable description
  turnId: number;
}
```

### Sampling (W-driven)

Uses `VARIANT_META.W` (ResNet weight) to calculate sampling rate:

```
sampleRate = clamp(W × 0.5 + 0.1, 0.1, 1.0)
未配置 variant → 1.0 (全量)
```

Deterministic hash-based sampling (not `Math.random`) ensures stable behavior per variant per turn. Only affects persistence and memory — injection flow is untouched.

### EventSnapshotBuffer (event-snapshot.ts)

Async persistence buffer. Collects turn-end snapshots and flushes to disk when thresholds are met. Architecture reuses `FileSystemAgentRecordPersistence` pattern: `pendingEntries → shouldFlush → scheduleFlush → ensureFlush → drainBatch`.

**Flush triggers** (any match):
- 5 pending rounds
- Degradation threshold: `max(1, 5 - floor(eventCount/25))` — more events = more aggressive
- 30 minutes since last flush
- Session close

**Disk format** (human-readable Markdown):

```
<agentsDir>/interception-logs/        ← agentsDir = dirname(agent.homedir)
  ├── 2026-06-22.md          ← Markdown, per-date
  ├── 2026-06-21.md
  └── INDEX.json             ← atomicWrite protected
```

`INDEX.json` accumulates cross-session statistics (totalEvents, byKind, byVariant). Written via `atomicWrite` (write-tmp → fsync → rename) for crash safety.

### Integration points in index.ts

| Location | What happens |
|----------|-------------|
| `runOneTurn` reset | `eventLog.clear()` — clear per-turn state |
| `inject()` residual skip | `eventLog.record(injection_skipped/skipped_residual)` |
| `inject()` budget skip | `eventLog.record(injection_skipped/skipped_budget)` |
| `inject()` delivered | `eventLog.record(injection_delivered/injected)` |
| `inject()` step dedup skip | `eventLog.record(injection_skipped/skipped_dedup)` |
| `finalizeToolResult` verify fail | `eventLog.record(verify_fail/gate_held)` |
| `afterStep` confabulation | `eventLog.record(confabulation/detected)` |
| `afterStep` summary | `eventLog.getNewTurnSummary() → inject(interception_log)` |
| `afterStep` health check | `agent.log.warn` if 10+ steps with 0 events |
| `shouldContinueAfterStop` deviation chain | `eventLog.record(deviation_chain/gate_held)` |
| `shouldContinueAfterStop` convergence held | `eventLog.record(convergence_gate/gate_held)` |
| `shouldContinueAfterStop` convergence passed | `eventLog.record(convergence_gate/gate_passed)` |
| `runOneTurn` turn end | `eventBuffer.pushTurn()` (async, non-blocking) |
