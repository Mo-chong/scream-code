# Turn Module API Reference

> AI-readable interface reference — organized by action flow, not by file structure.
>
> 📖 系统说明书 & 踩坑记录 → `D:/AI/ScreamCode/SYSTEM-INDEX.md` → `SYSTEM/*.md`；`SYSTEM/pitfalls.md`

---

## Architecture overview

**4 injection triggers + 7 pure-function detectors + 1 guard engine (4 rules) + 1 memory-rule injector + 1 unified inject route.**

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
| SceneMemoryDetector | `detectors/scene-memory.ts` | User input + hasMemoryLookup | `SceneMemoryIssue` |
| CodeRefDetector | `detectors/code-ref.ts` | Assistant text | `CodeRefIssue` |
| CodeQualityDetector | `detectors/code-quality.ts` | Written code + file path | `CodeQualityResult` |

### GuardEngine (behavior rules, not pure — reads history)

| Check | File | Logic |
|-------|------|-------|
| Rule 1 (block) | `guard-engine.ts` | "test passed" claim + Bash exit ≠ 0 → block |
| Rule 2 (observe) | `guard-engine.ts` | "I can see" claim + no Read/Grep/LSP → observe |
| Rule 3 (observe) | `guard-engine.ts` | "already edited" claim + no Edit/Write → observe |
| Rule 4 (observe) | `guard-engine.ts` | MemoryLookup used + code assertion + no Read/Grep → observe |

### MemoryRulesInjector (async, searches memo store)

| Function | File | Trigger |
|----------|------|---------|
| `searchBehaviorRules` | `memory-rules.ts` | Guard rule fires + memoStore exists (tags: chundu) |
| `detectSceneQuery` | `memory-rules.ts` | afterStep, scans assistant text for topic keywords |
| `searchPendingDoc` | `memory-rules.ts` | Turn pre-close check — pending-doc tags reminder |

### Unified inject route

All triggers and detectors call `inject(text, meta)` at `index.ts:1199`, which handles:

```
inject(text, meta) →
  ├─ system_trigger kind → bypass budget, inject directly
  ├─ quality_escalate_ variant → bypass budget, inject directly
  ├─ interception_log variant → bypass budget, inject directly (Phase15: meta-log)
  ├─ behavior_feedback variant → meta-log only, never injected (Phase15)
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
| `step_after_edit` | A | `editOnCodeFileThisStep && editWithoutLookupCount ≥ 2` | `"MUST check callers. Missing LSP.references before edit."` |
| `step_after_edit` | B | `editOnCodeFileThisStep && editWithoutLookupCount === 1` | `"Edit done → consider verifying before continuing."` |
| — reset | — | Edit on code file + LSP.references both called | `editWithoutLookupCount = 0` |
| — no-op | — | Edit on non-code file (.md/.json/.yaml etc) | skip (not a function/API change) |

### Deviation chain (toxicity intercept)

```
editWithoutLookupCount ≥ 3 → deviationChainActive = true
verifyFailedThisStep → deviationChainActive = true
behaviorViolations[variant] ≥ interceptThreshold → deviationChainActive = true  (Phase15)
→ shouldContinueAfterStop: inject deviation_chain_intercept (S)
  "偏差链检测到：连续多次 Edit 未查 LSP.references" / "行为变体 X 连续 N 回合 S→S..."
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

### Code ref quality detector (`detectors/code-ref.ts`)

纯函数检测 AI 输出中的代码块是否带路径/行号引用。

| Signal | Condition | Action |
|--------|-----------|--------|
| Missing ref | code block without file path in previous line | inject step_code_ref_quality reminder |

低权重（W=0.5）低频（gap=6），不打扰正常流程。

### Scene memory detector (`detectors/scene-memory.ts`)

纯函数检测用户输入中是否有"上次/以前"等回溯关键词，判断 AI 是否查了记忆。

| Signal | Condition | Action |
|--------|-----------|--------|
| Recall missed | user says "上次/以前" + no MemoryLookup call | inject scene_memory_recall reminder |

High-weight（W=0.8, T=0.30）确保 AI 迅速学会——用户提"上次"时不查记忆就提醒。

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
| `variant === 'interception_log'` | Skip budget + skip registry (Phase15: meta-log bypasses entirely) |
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
| `markBehaviorObserved` | `(variant) => void` | Mark variant as effective; fires `onBehaviorObserved` callback |
| `markBehaviorNotObserved` | `(variant) => void` | Mark variant as ineffective; fires `onBehaviorObserved` callback |
| `markEscalated` | `(variant, step) => void` | Mark escalated |
| `updateLevel` | `(variant, newLevel, step) => void` | In-place level update |
| `reset` | `() => void` | Clear all (turn start) |
| `hasIntentVariants` | `() => boolean` | Quick intent check |
| `size` | `getter: number` | Record count |

### Callback

- `onBehaviorObserved?: (variant: string, observed: boolean) => void` — fires on `markBehaviorObserved`/`markBehaviorNotObserved`. Used by TurnFlow to record `behavior_feedback` events.

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

| Variant | W | D | threshold | minStepGap | interceptThreshold | Notes |
|---------|:-:|:-:|:---------:|:----------:|:------------------:|-------|
| system_trigger | 1.0 | 0.99 | 0.1 | 0 | — | Never skipped |
| deviation_chain_intercept | 1.0 | 0.99 | 0.1 | 0 | — | Never skipped |
| prepare_edit | 0.8 | 0.85 | 0.35 | 4 | — | |
| prepare_write | 0.8 | 0.85 | 0.35 | 4 | — | |
| prepare_search | 0.7 | 0.85 | 0.40 | 3 | — | |
| prepare_memory | 0.7 | 0.85 | 0.40 | 3 | — | |
| prepare_bash_file | 0.5 | 0.82 | 0.40 | 3 | — | |
| prepare_verify | 0.8 | 0.85 | 0.35 | 4 | — | |
| post_edit | 0.6 | 0.80 | 0.40 | 4 | — | |
| post_search | 0.6 | 0.80 | 0.40 | 4 | — | |
| post_write_large | 0.5 | 0.80 | 0.40 | 4 | — | |
| post_verify_pass | 0.5 | 0.80 | 0.40 | 4 | — | |
| post_verify_fail | 0.9 | 0.88 | 0.30 | 3 | — | High weight = urgent |
| post_memory | 0.6 | 0.80 | 0.40 | 4 | — | |
| step_after_edit | 0.6 | 0.80 | 0.40 | 5 | **3** | S→S ×3 → deviation chain |
| step_after_search | 0.5 | 0.80 | 0.40 | 5 | — | |
| step_after_verify_fail | 0.8 | 0.85 | 0.35 | 4 | **3** | S→S ×3 → deviation chain |
| guard_feedback_rule_2 | 0.7 | 0.85 | 0.35 | 4 | **3** | S→S ×3 → deviation chain |
| guard_feedback_rule_3 | **0.8** | 0.85 | 0.35 | 4 | **2** | S→S ×2 → deviation chain (higher W + lower threshold) |
| guard_feedback_rule_4 | 0.7 | 0.85 | 0.35 | 4 | **3** | S→S ×3 → deviation chain |
| scene_memory_recall | 0.8 | 0.88 | 0.30 | 5 | **3** | S→S ×3 → deviation chain |
| intent_* (all 6) | 0.7-0.9 | 0.88-0.92 | 0.30 | 0 | — | Injected once at turn start |

Unconfigured variants (e.g., `session_memory`, `dream_suggestion`) are passed through without residual check. Non-behavior variants (`feedback_positive`, `prepare_*`, `post_*`, `intent_*`) have no `interceptThreshold` (default 0 → never intercept).

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
| C (afterStep) | step_after_edit(A/B), step_after_search(B), step_after_verify_fail(A), step_code_ref_quality(C) |
| D (runOneTurn) | intent_fix_bug(B/A), intent_refactor(B/A), intent_add_feature(B/A), intent_review(B/A), intent_research(B/A), intent_document(B/A) |
| E (afterStep — guard feedback) | guard_feedback_rule_2(C), guard_feedback_rule_3(C), guard_feedback_rule_4(C), feedback_positive(D) |
| F (afterStep — scene) | scene_memory_recall(C) |
| G (Phase15 — behavior feedback) | behavior_feedback (meta-log only, not injected) |
| Special | deviation_chain_intercept(S), quality_escalate_*(penetrate), system_trigger(penetrate), interception_log(penetrate) |

---

## 12. Interception Event Log

**File:** `event-log.ts`, `event-snapshot.ts`

Records system-level interception events — what the injection system did, not what the AI did. 9 hardcoded `record()` calls inside `inject()` (4), `afterStep` (1), `finalizeToolResult` (1), and `shouldContinueAfterStop` (3). AI has no bypass capability.

### TurnEventLog (event-log.ts)

In-memory ring buffer (200 events max). Per-turn incremental summary injected into AI context via `getNewTurnSummary()`.

```typescript
interface InterceptionEvent {
  seq: number;                              // Monotonic sequence
  kind: string;                             // injection_skipped | injection_delivered | convergence_gate | deviation_chain | confabulation | verify_fail | behavior_feedback
  variant: string;                          // Variant name (empty string for non-variant events)
  step: number;                             // Turn step number
  action: string;                           // skipped_residual | skipped_budget | skipped_dedup | injected | gate_held | gate_passed | detected | observed | not_observed
  reason: string;                           // Human-readable description
  turnId: number;
  level?: string;                           // Phase15: injected weight level (delivered/skipped events)
  tokenEstimate?: number;                   // Phase15: budget estimate (budget skip events)
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
<screamHome>/interception-logs/        ← screamHome = resolveScreamHome()
  ├── 2026-06-22.md          ← Markdown, per-date, [sessionId] prefix per entry
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

---

## 13. Guard Engine (guard-engine.ts)

**File:** `guard-engine.ts`
**Pure function:** `checkGuard(history, tools) → GuardResult`

4 rules run in `afterStep` via `runGuardDetection()`. Rules are checked in priority order (1 > 2 > 3 > 4) — only the first match is returned.

### StepToolSummary

| Field | Type | Description |
|-------|------|-------------|
| `hasKnowledgeTools` | boolean | Read/Grep/LSP called this step |
| `hasWriteTools` | boolean | Edit/Write called this step |
| `lastBashExitCode` | number \| null | Bash exit code (null if not run) |
| `hasMemoryLookup` | boolean | MemoryLookup called this step |
| `hasCurrentCodeTools` | boolean | Read/Grep/LSP this step (Phase 13) |

### Guard Rules

| Rule | Priority | Trigger | Action | Inject variant |
|------|:--------:|---------|--------|:--------------:|
| Rule 1 | 1 (blocking) | "test passed" / "验证通过" in text + Bash exit ≠ 0 | `confabulationBlocked = true` | `guard_rule_1` (via eventLog) |
| Rule 2 | 2 (observe) | "检查发现"/"我可以看到" in text + no knowledge tools | inject feedback | `guard_feedback_rule_2` |
| Rule 3 | 3 (observe) | "已修改"/"已编辑" in text + no write tools | inject feedback | `guard_feedback_rule_3` |
| Rule 4 | 4 (observe) | MemoryLookup used + code assertion + no Read/Grep | inject feedback | `guard_feedback_rule_4` |

### Integration in index.ts

```
handleAfterStep →
  Step 2: guard/false-facts + quality detection
    detectConfabulation → injectAntiConfabulation
  Step 5: detector sequence
    detectSceneMemoryIssue()
    await runGuardDetection()      ← Guard Engine here
    await injectBehaviorRulesAfterStep()
```

**Behavior rule injection** (Phase 12): When a guard rule fires and `memoStore` exists, `runGuardDetection()` calls `searchBehaviorRules()` with a query matching the rule's topic. If a `chundu`-tagged memo is found, its content is appended to the guard feedback.

---

## 14. afterStep flow (index.ts:1532)

The complete `handleAfterStep` pipeline:

```
Step 1: Step feedback + deviation chain
  ├─ injectStepAfterVariants()       → step_after_edit/search/verify_fail
  └─ detectDeviationChain()          → deviationChainActive (3 conditions)

Step 2: False facts + quality detection
  ├─ detectConfabulation(sig, snap)  → injectAntiConfabulation()
  ├─ runQualityDetection(sig)        → observeBehavior + escalateQuality
  └─ resetObservedBehaviorViolations()     ← Phase 15

Step 3: Deviation chain resolve + turn-level stats
  ├─ tryResolveDeviationChain()
  ├─ turnHasCalledAnyLsp tracking
  └─ totalStepsWithEditsThisTurn tracking

Step 4: Event log + health check
  ├─ injectInterceptionSummary()     → interception_log inject
  └─ checkEventLogHealth()           → warn if 10+ steps with 0 events

Step 5: Detector sequence
  ├─ detectSceneMemoryIssue()        → scene_memory_recall inject
  ├─ await runGuardDetection()       → Guard Engine (Phase 12)
  └─ await injectBehaviorRulesAfterStep()  → memory-rule inject (Phase 12)

Step 6: Positive feedback + CodeRef
  ├─ injectPositiveFeedbackThisTurn()  → feedback_positive inject
  └─ detectCodeRefIssue()              → step_code_ref_quality inject

Step 7: Reset step state
  └─ resetInjectorStepState()
```

### Phase 12 Guard Rules + Memory integration

```
runGuardDetection():
  checkGuard(history, tools) → GuardResult
  if rule > 0:
    lastGuardFeedback = guardResult.feedback
    if memoStore exists:
      searchBehaviorRules(memoStore, query)  ── chundu-tagged memos
      if found: append formatBehaviorRule(nearest) to feedback
    if guardResult.block:                      ── Rule 1 only
      confabulationBlocked = true
      eventLog.record(confabulation/guard_rule_1)
    else:                                      ── Rules 2-4
      eventLog.record(guard_observe/guard_rule_N)
      inject(feedback, guard_feedback_rule_N)
```

### Phase 15: Behavior violation tracking (index.ts:1631-1678)

**Intercept variants:** `guard_feedback_rule_2`, `guard_feedback_rule_3`, `guard_feedback_rule_4`, `scene_memory_recall`, `step_after_edit`, `step_after_verify_fail`

```
  quality escalation S→S:
    trackBehaviorViolation(variant)
      → crossTurnFlags.behaviorViolations[variant]++

  deviation chain condition 3:
    if behaviorViolations[variant] >= VARIANT_META[variant].interceptThreshold
      → deviationChainActive = true

  deviation chain intercept inject:
    buildBehaviorInterceptMsg(variant) → injected with deviation_chain_intercept (S)
```

### Phase 18: Code quality tracking

Code quality violations are tracked via `scanCodeQuality()` and accumulated in `codeQualityViolations`. At the end of each turn:

```
  if codeQualityViolationsThisTurn > 0
    → deviationChainActive (condition 4)
  if codeQualityViolations cleaned up (thisTurn === 0)
    → deviationChainResolved
```

---

## 15. afterStep detectors (full reference)

### SceneMemoryDetector (detectors/scene-memory.ts)

Pure function detecting Chinese recall keywords ("上次"/"以前"/"之前") in user input.

```
detectSceneMemory(userInput, hasMemoryLookup) → SceneMemoryIssue
  if recall keyword found + no MemoryLookup call → needsReminder = true
```

Integration in `index.ts:1741`:

```
detectSceneMemoryIssue():
  if step 1 + user input has recall keyword + no MemoryLookup
    → inject("用户提到了"上次/以前"——先用 MemoryLookup 查历史记录", scene_memory_recall)
```

### CodeRefDetector (detectors/code-ref.ts)

Scans assistant output for code blocks without preceding file path annotations.

```
detectCodeRefQuality(assistantText) → CodeRefIssue
  high-confidence (score ≥ 2) → inject step_code_ref_quality
```

### CodeQualityDetector (detectors/code-quality.ts)

**New in Phase 18.** Pure function. Run on Write/Edit output.

```
scanCodeQuality(code, filePath) → CodeQualityResult
  S1: .js/.jsx file forbidden (allow .ts/.tsx only)
  S2: `: any` type annotation forbidden (allow eslint-disable-next-line)
  S3: function parameters and return values must have explicit type signatures
```

Integration:

```
runOneTurn → finalizeToolResult:
  if Write/Edit on code file:
    scanCodeQuality(output, filePath)
    if violations found:
      codeQualityViolations.push(...)
      codeQualityViolationsThisTurn++
      inject(formatCodeQualityFeedback(result), code_quality_feedback)

handleAfterTurn:
  if codeQualityViolationsThisTurn > 0
    → deviation chain activation
```

### positiveFeedback (index.ts:1798)

```
injectPositiveFeedbackThisTurn():
  conditions (all must be true):
    ├─ not confabulationBlocked
    ├─ not deviationChainActive
    ├─ not verifyFailedThisStep
    ├─ (hasCalledLspReferencesThisStep OR editWithoutLookupCount === 0)
    ├─ codeQualityViolationsThisTurn === 0        ← Phase 18
    └─ at least 1 step completed
  → inject "【行为确认】本轮验证流程完整且代码质量合规。继续。" (feedback_positive)
```

### MemoryRulesInjector (memory-rules.ts)

Three entry points:

| Entry | Called from | What it does |
|-------|-------------|-------------|
| `searchBehaviorRules` | `runGuardDetection()` + `collectConfabulationBlockReason` | Searches `chundu`-tagged memos matching guard rule topic |
| `detectSceneQuery` | `injectBehaviorRulesAfterStep()` | Matches assistant text keywords → search query → inject formatted rule |
| `searchPendingDoc` + `formatPendingDocInject` | `finishTurnDoc()` via `collectPendingDocReason()` | End-of-turn check for pending-doc tagged memos → inject before close |

### finishTurnDoc — pending-doc 集成

```
finishTurnDoc(reasons) →
  collectPendingDocReason(reasons):
    if memoStore exists + no other block reasons:
      searchPendingDoc(memoStore)  ── search tags: pending-doc, outcome: pending
      if found: formatPendingDocInject(memos) → add to reasons list
  if reasons.length > 0:
    inject(reasons.join('\n'), interception_log)
```

---

## 16. All registered variants (updated flat list)

| Group | Variants |
|:-----:|----------|
| A (prepareToolExecution) | prepare_edit(A), prepare_write(A), prepare_search(A), prepare_memory(A), prepare_bash_file(C), prepare_verify(C) |
| B (finalizeToolResult) | post_edit(A), post_search(B), post_write_large(B), post_verify_pass(B), post_verify_fail(A), post_memory(B) |
| C (afterStep) | step_after_edit(A/B), step_after_search(B), step_after_verify_fail(A), step_code_ref_quality(C) |
| D (runOneTurn) | intent_fix_bug(B/A), intent_refactor(B/A), intent_add_feature(B/A), intent_review(B/A), intent_research(B/A), intent_document(B/A) |
| E (afterStep — guard feedback) | guard_feedback_rule_2(C), guard_feedback_rule_3(C), guard_feedback_rule_4(C), feedback_positive(D) |
| F (afterStep — scene) | scene_memory_recall(C) |
| G (afterStep — code quality) | code_quality_feedback(C) |
| H (Phase15 — behavior feedback) | behavior_feedback (meta-log only, never injected) |
| I (Phase15 — S→S intercept variants) | guard_feedback_rule_2, guard_feedback_rule_3, guard_feedback_rule_4, scene_memory_recall, step_after_edit, step_after_verify_fail |
| Special | deviation_chain_intercept(S), quality_escalate_*(penetrate), system_trigger(penetrate), interception_log(penetrate) |

### ResNet configuration — new variants

| Variant | W | D | threshold | minStepGap | interceptThreshold | Notes |
|---------|:-:|:-:|:---------:|:----------:|:------------------:|-------|
| code_quality_feedback | 0.7 | 0.85 | 0.35 | 4 | **3** | Added Phase 18 |

Behavior feedback (`behavior_feedback`) is meta-log only — never injected, never hits budget or ResNet. Interception log events from guard_rule_1, guard_observe_*, code_quality are recorded in the event log system (section 12).

---

## 17. Message pipeline — KV-cache prefix stabilization (v0.7)

**Files:**
- `agent/context/prefix-stabilizer.ts` — Phase A: regex-based volatile-field replacement (ISO timestamps → `[timestamp]`, UUIDs → `[uuid]`)
- `utils/mask-tool-observations.ts` — Phase B: old tool result masking (keeps last 3, pure function)
- `agent/compaction/micro.ts` — Phase C: batch-gated detect() (BATCH_SIZE=8)
- `agent/context/index.ts` — integration point: `compact() → stabilizePrefix() → project()`
- `loop/turn-step.ts` — integration point: `buildMessages() → maskToolObservations() → llm.chat()`

### Pipeline order

```
context.get messages() (index.ts):
  history → microCompaction.compact() → stabilizePrefix() → project() → assertWireFormat()

executeLoopStep (turn-step.ts):
  buildMessages() → maskToolObservations() → llm.chat() → log cache metrics
```

### Phase A — Prefix stabilization

Pure function. Scans `role === 'system'` messages for ISO timestamps and UUIDs, replaces them with fixed placeholders. The message array stays structurally identical (same length, same roles) — only text content changes.

**Why it works:** KV-cache matches on byte-identical prefix. A single character change in any system message invalidates the entire cache, because the cache key is the full messages array up to the cache_control breakpoint (Anthropic) or the implicit prefix (OpenAI/Gemini).

**TokenPilot baseline:** Prefix stabilization alone → cache misses from 5.94M to 1.59M (-73%). Source: arXiv 2606.17016, §4.1.

### Phase B — Observation masking

Pure function. Finds all `role === 'tool'` messages, keeps the last N (default 3) verbatim, replaces all earlier tool results with `[Old tool output: obscured — tool may be re-invoked if needed]`.

**Design constraint:** Operates on the **projected message list**, not `context.history`. The original tool results survive for the next micro-compaction or undo. The mask is re-applied each step by the pure function — no state, no polling.

**KV-cache note:** Masking the tool-result tail does NOT affect cache hit rate. The cache prefix ends at the `cache_control` breakpoint (on system prompt). The masked tail is post-breakpoint and was never cached to begin with. The value of O-Mask is purely token reduction (~5-15% fewer input tokens in long sessions).

### Phase C — Batch-gated MicroCompaction detect()

`MicroCompaction.detect()` increments `stepsSinceLastDetect` on each call. It only evaluates the context window when the counter reaches `BATCH_SIZE=8`. Before returning, it resets the counter to 0.

**Why BATCH_SIZE=8:** MicroCompaction's detect() advances the cutoff line whenever context usage > 50%. Before this gate, the cutoff could move every step, changing the message array structure. On providers with implicit prefix matching (OpenAI, Gemini), any structural change in the messages array invalidates the cache — even if the content is semantically identical. Batching to 8 steps means the cutoff line moves at most 1× per 8 steps instead of up to 8× in the same window.

**Full compaction exception:** `full.ts beforeStep()` calls `detect(true)`, bypassing the batch gate. Full compaction's LLM call already invalidates the cache (it produces a new summary message), so the gate would provide no benefit and only delay the reset.

### Cache metrics logging

After `llm.chat()` in `turn-step.ts:124-133`:

```typescript
log.info('llm cache metrics', {
  cacheRead: usage.inputCacheRead,
  cacheCreation: usage.inputCacheCreation,
  inputOther: usage.inputOther,
  step: currentStep,
});
```

### Provider-specific cache behavior

| Provider | Cache mechanism | Phase A benefit | Phase B benefit | Phase C benefit |
|----------|----------------|:---------------:|:---------------:|:---------------:|
| Anthropic | Explicit `cache_control` breakpoints | High — stabilizes system prompt in cached prefix | None — operates on post-breakpoint tail | None — `cache_control` ignores cutoff movement |
| OpenAI | Implicit prefix matching (first N tokens) | High — stabilizes system prompt text | Low — reduces tokens but doesn't affect cache key | High — stabilizes cutoff line to minimize cache invalidation |
| Gemini | Implicit prefix matching | High — same as OpenAI | Low — same as OpenAI | High — same as OpenAI |

### Build verification

Pure functions (`stabilizePrefix`, `maskToolObservations`, `BATCH_SIZE`) can be verified without importing the dist bundle, which fails due to `neverBundle` external deps (`ltod`, `jian`). Verification method: inline-copy the pure function logic (zero external deps) into a test script and assert against known inputs. 13/13 assertions pass (prefix regex replacement, tool masking at various keepLastN values, batch gate edge cases).

All 8 new/exported symbols confirmed present in `dist/index.mjs` via regex scan. Both agent-core (1.46 MB, tsdown 6.0s) and scream-code (10.92 MB, tsdown 6.5s) bundles rebuilt successfully. Source timestamps verified ≤ bundle timestamp for all 6 modified + 2 new files.
