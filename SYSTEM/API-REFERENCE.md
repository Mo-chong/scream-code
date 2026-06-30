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

### prefix-stabilizer.ts

Pure function module. Exports two functions:

| Function | Input | Returns | Purpose |
|----------|-------|---------|---------|
| `stabilizePrefix` | `readonly ContextMessage[]` | `ContextMessage[]` | Maps over messages; replaces timestamps (`TIMESTAMP_RE`) and UUIDs (`UUID_RE`) in system-role `text` parts only. Returns unchanged reference when no mutation needed. |
| `stabilizeSystemPrompt` | `string` | `string` | Same replacement on a standalone system prompt string (for Anthropic-style APIs with separate system param). |

**Regex patterns:** `TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g`, `UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi`. Both target machine-generated output only — low false-positive risk on user-authored content.

**Integration point:** called from `compact()` → `stabilizePrefix()` → `project()` chain in `context/index.ts`.

**Pipeline counter:** `_stabilizeHitCount` increments when `JSON.stringify(msgs)` is identical before/after stabilization (prefix was already stable). See `getMetrics()` below.

- `utils/mask-tool-observations.ts` — Phase B: old tool result masking (keeps last 3, pure function)
- `agent/compaction/micro.ts` — Phase C: batch-gated detect() (BATCH_SIZE=8, configurable via `flags.asNumber('micro.batchSize')` / env `SCREAM_CODE_MICRO_BATCH_SIZE`)
- `agent/context/index.ts` — integration point: `compact() → stabilizePrefix() → project()`, with pipeline counters (`getMetrics() → { microCompactCount, stabilizeHitCount }`)
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

### Pipeline counters (getMetrics)

`AgentContextRegister.getMetrics()` returns:

| Counter | Meaning |
|---------|---------|
| `microCompactCount` | Number of turns where micro-compaction actually reduced messages (fewer msgs after compact than before). |
| `stabilizeHitCount` | Number of turns where prefix stabilizer produced no mutations (= JSON.stringify is identical before/after). A **hit** indicates the prefix is already stable and the KV-cache was reused without invalidation. |

**`stabilizeHitCount` implementation note:** `stabilizePrefix()` never changes the messages array length — a length-only comparison would always increment on every turn and provide no signal. Instead the counter uses `JSON.stringify()` comparison of the full message list, which correctly detects whether any volatile field (timestamp, UUID) was actually replaced.

### Phase C — Batch-gated MicroCompaction detect()

`MicroCompaction.detect()` increments `stepsSinceLastDetect` on each call. It only evaluates the context window when the counter reaches `BATCH_SIZE` (default 8; configurable via `SCREAM_CODE_MICRO_BATCH_SIZE` env or `flags.asNumber('micro.batchSize')`). Before returning, it resets the counter to 0.

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

---

## 18. ContentArchive — 保留缓冲区 (v1.0)

**Files:**
- `agent/context/content-archive.ts` — ContentArchive 类（纯内存 LRU+TTL，零外部依赖）
- `agent/context/types.ts:97` — 类型声明 `contentArchive?: ContentArchive`
- `agent/index.ts:45/129/171` — import、属性声明、构造初始化
- `agent/context/index.ts:276-285` — Point A: `pushToolEvent` 截断前存档工具输出
- `agent/compaction/micro.ts:156-171` — Point B: `compact()` 截断前存档原始工具结果
- `agent/compaction/full.ts:324-335` — Point C: docs-only（设计上不做 archive，注释说明理由）
- `flags/registry.ts:27-31` — `content-archive` flag（default: true）

### API

```typescript
class ContentArchive {
  constructor(config?: { ttlMs?: number; maxEntries?: number })
  archive(key: string, content: string | ContentPart[], source?: string): ArchiveResult
  recover(key: string): string | ContentPart[] | undefined
  list(): string[]
  get size(): number
  prune(): number
  clear(): void
}
```

### Key design

| Property | Value | Rationale |
|----------|-------|-----------|
| Default TTL | 300_000 ms (5 min) | Covers typical multi-turn recovery window |
| Max entries | 50 | Soft ceiling — oldest evicted on overflow |
| Key format | `{source}:{toolCallId}` | Caller prefix avoids key collision |
| Integration points | 2 (A+B) + 1 docs-only (C) | All gated by `content-archive` flag |

### Integration order

```
Point A (context/index.ts): pushToolEvent → archive() → truncateLoopEvents()
Point B (micro.ts):         compact() → archive() → trimTailApplyWindow()
Point C (full.ts):          (comment only — FullCompact rewrites messages via LLM, raw recovery not useful)
```

### Flag gate

`flags.enabled('content-archive')` controls all integration points. Default `true` — pure memory buffer with zero external deps is safe to keep enabled. Disable via `SCREAM_CODE_EXPERIMENTAL_CONTENT_ARCHIVE=false` env var.

### Recovery path

The `recover(key)` method reads an entry by key while refreshing its TTL and boosting priority (+0.1). Expired or missing keys return `undefined`. The companion `ArchiveRecoverTool` (§20) wraps this as a built-in agent tool for model-facing access.\r
\r
### v2.1 — sharedStore（跨子 agent 共享）\r
\r
**Added 2026-06-29.** ContentArchive 新增静态全局共享储存，解决子 agent 隔离导致的主 agent 存档内容不可见问题。\r
\r
```typescript\r
class ContentArchive {\r
  // 新增：静态全局 Map，所有 Agent 实例共享\r
  static readonly sharedStore = new Map<string, ContentArchiveEntry>()\r
\r
  archive(key: string, content: string | ContentPart[], options?: ArchiveOptions): ArchiveResult {\r
    // 同步写入 sharedStore（不增加本地限制）\r
  }\r
\r
  recover(key: string): string | ContentPart[] | undefined {\r
    // 先查本地 store → 未命中回退 sharedStore\r
    // copy-on-access：从 sharedStore 找到后写入本地供后续访问\r
  }\r
}\r
```\r
\r
**设计要点：**\r
- `sharedStore` 是 `static` 字段，所有 Agent 构造函数创建的实例共享同一块内存\r
- `archive()` 写入本地 store 的同时同步写入 `sharedStore`（不变更 TTL/priority）\r
- `recover()` 先查本地 store → 未命中则回退查 `sharedStore` → 找到后 copy-on-access 写回本地\r
- 不破坏子 agent 隔离：本地 store 独立，共享只作 fallback 寻址\r
- 不增加 sharedStore 的 TTL/eviction 开销——sharedStore 的条目由各个实例的 archive/prune 连带管理\r
\r
**集成点：** 同上（Point A / Point B / Point C），自动生效无需新增 flag。\r
\r
### v2.0 changes (2026-06)\r
\r
| Change | Before | After |\r
|--------|--------|-------|\r
| Max entries | 50 | 2000 |\r
| TTL | 5 min | 30 min |\r
| Eviction | FIFO (oldest) | Weighted scoring (`priority × decay × accessBoost`) |\r
| Archive signature | `archive(key, content, source?)` | `archive(key, content, options?)` |\r
| Options arg | bare `source` string | `{ priority?, source? }` |\r
| Priority floor | none | `< 0.1` hard-skip from eviction |\r
| Protection | none | `priority >= 100` protected from eviction |\r
| Dead-loop guard | none | `for (attempt < 3)` + break |\r
| Error boundary | none | `throw ContentArchiveError('NO_EVICTABLE_ENTRY')` |\r
| Consolation bonus | none | `priority += 0.5` for survivors |\r
| Scoring formula | — | `score = priority × Math.exp(-ageMs/TTL) × (1 - ageFactor × 0.5)` |\r
\r
**Scoring notes:**\r
- `decay` uses full TTL ratio, not discrete buckets\r
- `accessBoost` = `1 - ageFactor × 0.5` where `ageFactor` = time since last access / TTL, clamped to [0, 1]\r
- Survivors get `priority += 0.5` after `evictOne()`\r
\r
**Flag:** `content-archive` (default: true) unchanged.\r
\r
---\r
\r
## 19. FileActionAudit — 文件修改审计日志\r
\r
**Files:**\r
- `agent/audit/file-action-audit.ts` — FileActionAudit 类（FlushBuffer 子类，熔断+日切）\r
- `agent/index.ts:16/97/174/586` — import、属性声明、构造初始化、退出兜底 flush\r
- `agent/turn/index.ts:1210-1233` — B 组工具结果处理段（Edit/Write 成功后 push）\r
- `flags/registry.ts:31-35` — `file-action-audit` flag（default: false）\r
\r
### API\r
\r
```typescript\r
interface FileActionAuditEntry {\r
  action: 'edit' | 'write'\r
  toolCallId: string\r
  timestamp: number\r
  resultPreview: string\r
  success: boolean\r
  durationMs: number\r
}\r
\r
abstract class FlushBuffer<T> {\r
  constructor(maxBufferSize?: number)     // default 50\r
  push(entry: T): void\r
  flush(): Promise<void>                  // 前置重置 error，退出路径可重试\r
  protected abstract drainBatch(): Promise<void>\r
}\r
\r
class FileActionAudit extends FlushBuffer<FileActionAuditEntry> {\r
  // 熔断: 连续 5 次失败 → circuitOpen = true → 跳过刷盘\r
  // 防抖: 两次 flush 间隔 < 30s 直接 return\r
  // 日切: 追加写入 <screamHome>/audit/YYYY-MM-DD.jsonl\r
\r
  // v2: 环状缓冲区（最近 50 条），用于查错注入\r
  private static KEEP_RECENT_MAX = 50\r
  private recentEntries: FileActionAuditEntry[] = []\r
  getRecentEntries(n: number): FileActionAuditEntry[]\r
}\r
```\r
\r
### Key design\r
\r
| Property | Value | Rationale |\r
|----------|-------|-----------|\r
| Flag default | false | 审计日志不是所有场景必需，有 IO 开销 |\r
| Buffer | 50 entries | Accumulates entries before flush |\r
| Debounce | 30_000 ms | Prevents too-frequent disk writes |\r
| Circuit breaker | 5 consecutive failures | Prevents audit failures from impacting agent |\r
| Day rotation | `.jsonl` per calendar day | Simple rotation, easy to grep/archive |\r
| Exit flush | `fileActionAudit.flush()` in `extractMemoriesOnExit` finally | Best-effort drain on session end |\r
| Reset on flush | `this.error = null` before `ensureFlush()` | Exit path gets a retry chance |\r
| Ring buffer | 50 entries (v2) | `getRecentEntries(n)` returns last n entries newest-first |\r
\r\n### v2 additions (2026-06-29)\r
\r
#### 环状缓冲区 / getRecentEntries\r
\r\n```typescript\r
// file-action-audit.ts\r
static KEEP_RECENT_MAX = 50\r
private recentEntries: FileActionAuditEntry[] = []\r
\r\npush(entry: FileActionAuditEntry): void {\r
  // override: 同步写入环状缓冲区\r
  this.recentEntries.push(entry)\r
  if (this.recentEntries.length > FileActionAudit.KEEP_RECENT_MAX)\r
    this.recentEntries.shift()\r
  // 保持原刷盘路径\r
  super.push(entry)\r
}\r\n\r
getRecentEntries(n: number): FileActionAuditEntry[] {\r
  // 返回最近 n 条（从新到旧）\r
  return [...this.recentEntries].reverse().slice(0, n)\r
}\r\n```\r
\r
#### 查错自动注入（turn/index.ts L1882-1889）\r
\r\n**链路：** tool 执行失败 → `lastToolFailure` 非 exploratory 且未经验证 → 附加最近 5 条 FAA 记录到失败提示\r
\r
```typescript\r
// turn/index.ts — formatToolFailureFeedback()\r
if (this.lastToolFailure?.isExploratory === false && !hasPassed) {\r
  const faaEntries = this.agent.fileActionAudit?.getRecentEntries(5)\r
  const faaSnippet = faaEntries?.length\r
    ? `\\n\\nRecent file audit entries:\\n${faaEntries.map(e =>\r
        `  ${e.action} — ${e.resultPreview} (${e.success ? 'OK' : 'FAIL'}, ${e.durationMs}ms)`\r
      ).join('\\n')}`\r
    : ''\r
  return `A required tool failed this turn.${faasSnippet}`\r
}\r
```\r
\r
注入仅在 `file-action-audit` flag 开启时生效（空安全 `?.` 调用）。\r
\r
### Integration flow\r
\r
```\r
B 组工具结果处理 (turn/index.ts)\r
  └─ Edit/Write 成功 → FileActionAudit.push(entry)\r
     ├─ 环状缓冲区 ← 同步写入 getRecentEntries 可用\r
     └─ shouldFlush() → 熔断检查 → 防抖检查\r
        └─ scheduleFlush() / flush()\r
           └─ drainBatch() → append to <screamHome>/audit/YYYY-MM-DD.jsonl\r
\r
Agent 退出 (agent/index.ts)\r
  └─ extractMemoriesOnExit()\r
     └─ finally → fileActionAudit.flush() .catch(log)\r
\r\n查错注入 (turn/index.ts L1882-1889)\r
  └─ tool 失败 → getRecentEntries(5) → 附加到失败提示\r
```\r
\r
---\r
\r\n## §20 — ArchiveRecoverTool（内容存档恢复工具）\r
\r
**Added 2026-06.** `ArchiveRecoverTool` 是对 ContentArchive.recover() 的 tool wrapper，以内置工具形式暴露给 LLM agent。所有 agent（包括子 agent）均可调用 `/recover` 恢复先前存档的任何内容。\r
\r
### 文件位置\r
\r
- **定义：** `packages/agent-core/src/tools/builtin/context/archive-recover.ts`\r
- **注册：** `packages/agent-core/src/agent/tool/index.ts` L630-650（Agent 构造函数中按条件注册）\r
- **联动：** `packages/agent-core/src/agent/context/content-archive.ts`（ContentArchive v2.1）\r
\r
### API\r
\r
```typescript\r
// 输入 schema（zod）\r
const ArchiveRecoverInputSchema = z.object({\r
  key: z.string().optional().describe('精确匹配 key，返回单条内容'),\r
  query: z.string().optional().describe('模糊搜索 key（key.includes(query)），返回所有匹配'),\r
}).strict()\r
\r\n// 工具实现\r
class ArchiveRecoverTool implements BuiltinTool<ArchiveRecoverInput> {\r
  readonly name = 'ArchiveRecover'  // 内置工具名\r
  readonly description = '从内容存档中按 key 或关键词恢复之前截断/存档的内容。' +\r
    '不传参数则列出所有可用 key（仅索引，不含内容）。' +\r
    '传 key 精确匹配单条，传 query 模糊搜索全部匹配。'\r
\r
  constructor(contentArchive: ContentArchive) {}\r
\r
  // resolveExecution 模式（非 execute）\r
  resolveExecution(args: ArchiveRecoverInput): ToolExecution {\r
    return {\r
      description: 'ArchiveRecover',\r
      approvalRule: this.name,\r
      execute: async (_ctx): Promise<ExecutableToolResult> => {\r
        if (args.key) {\r
          const content = this.contentArchive.recover(args.key)\r
          return { output: content ?? '未找到该 key 对应的存档内容' }\r
        }\r
        if (args.query) {\r
          const keys = this.contentArchive.list()\r
            .filter((k) => k.includes(args.query!))\r
          const matched = keys.map(k => ({ key: k, content: this.contentArchive.recover(k) })).filter(e => e.content !== undefined)
          return { output: JSON.stringify({ count: matched.length, entries: matched }) }\r
        }\r
        return { output: JSON.stringify({ keys: this.contentArchive.list() }) }\r
      },\r
    }\r
  }\r
}\r
```\r
\r
### 注册条件\r
\r
Agent 构造函数 `packages/agent-core/src/agent/tool/index.ts` L630-650 注册。原有 `this.agent.type === 'main' &&` 限制（2026-06-29 已移除）。所有 agent 均可注册。实例化前提是 agent 有 `contentArchive` 实例（受 `contentArchive` flag 控制）。\r
\r
### 与其他模块的关系\r
\r
| 模块 | 关系 |\r
|------|------|\r
| `ContentArchive` | ArchiveRecoverTool 是 recover() 的 tool 壳，不封装 archive() |\r
| `contentArchive` flag | 控制是否启用 ContentArchive 实例——无 ContentArchive 则 register 失败跳过 |\r
| `context/index.ts` Point A | ContentArchive.archive() 在 tool result 入 context 历史前执行，存档原始输出 |\r
| sharedStore | ArchiveRecoverTool 通过 ContentArchive.recover() 自动寻址 sharedStore |\r
| 子 agent | 子 agent 可通过 /recover 读取主 agent 放入 sharedStore 的内容 |\r
\r\n### 使用场景\r
\r\n1. **超大输出截断后找回：** Bash 输出超 8000 token 被 truncateToolOutput() 截断，调用 /recover 取原始数据\r\n2. **跨子 agent 数据传递：** 主 agent archive() → sharedStore → 子 agent /recover 读取\r\n3. **诊断调试：** 在 fail 信息中看到 ContentArchive 引用时（Point B），/recover 读取存档线索\r\n4. **子 agent 自救：** 子 agent 使用共享 tool 导致异常，/recover 查看主 agent 先前上下文\r
\r\n### 约束\r\r
- 不封装 archive()：工具模型不应直接写 archive（应通过工具结果自然触发 archive）\r
- 不暴露内部 TTL/priority：recover 对模型是黑箱寻址\r
- expired 条目返回 undefined 而非错误信息\r\n
