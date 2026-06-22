# Turn Module API Reference

> AI-readable interface reference for the turn system modules.
> Not user-facing documentation.

---

## signature.ts — StepSignature (BottleNeck)

**File:** `turn/signature.ts`
**Role:** 压缩层。纯函数，不依赖任何检测器/注入器。

### Types

```typescript
interface StepSignature {
  toolCounts: Record<string, number>;   // 本步每种工具调用次数
  hasKnowledgeTools: boolean;           // Read/Grep/LSP/WebSearch/MemoryLookup/FetchURL
  hasActionTools: boolean;              // Edit/Write/Bash
  hasVerificationTools: boolean;        // Bash (仅名称匹配)
  markerTokenFound: boolean;            // 编造标记词命中
  outputLength: number;                 // 输出文本字符数
}

interface ContextSnapshot {
  recentKnowledgeSteps: number;         // 前几步有知识工具的步数
  recentKnowledgeDepth: number;         // 距最近知识工具步数差
  stepNormRate: number;                 // 场景归一化系数
  deliveryPhase: boolean;               // 是否交付阶段
  turnStepNumber: number;               // 本回合第几步
}
```

### Functions

| 函数 | 签名 | 说明 |
|------|------|------|
| `compressStep` | `(toolCounts, outputText) => StepSignature` | 压缩步数据为低维签名。纯函数 |
| `buildContextSnapshot` | `(toolCounts, stepNumber) => ContextSnapshot` | 构建上下文快照。纯函数 |
| `extractLastAssistantText` | `(history) => string` | 从历史中提取最后一条 assistant 文本 |

---

## variant-registry.ts — VariantRegistry (纯数据层)

**File:** `turn/variant-registry.ts`
**Role:** 回合级注入变体元数据注册表。纯数据，不依赖任何检测器/注入器。

### Types

```typescript
type WeightLevel = 'S' | 'A' | 'B' | 'C' | 'D';

interface VariantRecord {
  variant: string;                    // 变体名称
  level: WeightLevel;                 // 注入时的权重等级
  stepInjected: number;               // 本回合第几步注入
  turnStep: number;                   // 全局步号
  behaviorObserved: boolean | null;   // 行为观察状态
  lastEscalatedAtStep: number;        // 上次升级时的步号
}
```

### Class: VariantRegistry

| 方法 | 签名 | 说明 |
|------|------|------|
| `record` | `(variant, level, step) => void` | 记录变体。同变体只记第一次 |
| `get` | `(variant) => VariantRecord \| undefined` | 获取变体记录 |
| `getAll` | `() => VariantRecord[]` | 获取全部记录 |
| `getStale` | `(currentStep, maxAge) => VariantRecord[]` | 获取过期变体 |
| `markBehaviorObserved` | `(variant) => void` | 标记行为已观察 |
| `markBehaviorNotObserved` | `(variant) => void` | 标记行为未观察 |
| `markEscalated` | `(variant, step) => void` | 标记已升级 |
| `updateLevel` | `(variant, newLevel, step) => void` | 更新变体权重（原地改，用于升级链） |
| `stepsSinceLastEscalation` | `(variant, currentStep) => number` | 距上次升级的步数 |
| `reset` | `() => void` | 回合开始清空 |
| `hasIntentVariants` | `() => boolean` | 快速检查是否含有 intent_ 前缀变体（供 observeBehavior 优化） |
| `size` | `getter: number` | 当前记录数 |

### Pure Functions

| 函数 | 签名 | 说明 |
|------|------|------|
| `detectWeightLevel` | `(text: string) => WeightLevel` | 根据文本模式判断权重等级。100% 规则匹配 |
| `escalateLevel` | `(level: WeightLevel) => WeightLevel` | 权重提升一级。C/D→B, B→A, A→S, S→S |

### Weight detection rules (pure text pattern, no NL)

| 等级 | 匹配条件 |
|:----:|---------|
| S | `<system-reminder` 开头 或 `<\|im_start\|>` 包含 |
| A | `MUST`/`NEVER`/`ALWAYS`/`REQUIRED` 单词边界 |
| B | `^Step \d`/`^\d+\.`/`^-\s`/`^In one sentence`/`If...then` |
| C | `DO NOT`/`不要`/`Never`/`不得` |
| D | 其他（默认 fallback） |

### Upgrade path

```
C ──→ B ──→ A ──→ S
D ──→ B ──→ A ──→ S
```

每次只升一级。不提两级以防止模型感知异常。

---

## detectors/confabulation.ts — ConfabulationDetector

**File:** `turn/detectors/confabulation.ts`
**Role:** 检测器层。纯函数。残差评分算法。

### Types

```typescript
type Confidence = 0 | 1 | 2 | 3;

interface DetectionResult {
  confidence: Confidence;
  reason: string;
  detail?: string;
}
```

### Functions

| 函数 | 签名 | 说明 |
|------|------|------|
| `detectConfabulation` | `(StepSignature, ContextSnapshot) => DetectionResult` | 反事实检测。纯函数 |

### Scoring signals

| Signal | Condition | Score |
|--------|-----------|:----:|
| 1. 输出超证据 | `outputLength>200 && !hasKnowledgeTools` | +2 |
| 2a. 标记+短输出 | `markerTokenFound && !verbose` | +1 |
| 2b. 标记+长输出 | `markerTokenFound && verbose` | +2 |
| 3. 操作+断言 | `hasActionTools && !hasKnowledgeTools && outputLength>150` | +1 |

**Identity path:** `hasKnowledgeTools == true` → 直通 confidence 0

---

## detectors/quality.ts — QualityDetector (P2)

**File:** `turn/detectors/quality.ts`
**Role:** 注入质量衰退检测器。纯函数。

### Types

```typescript
type QConfidence = 0 | 1 | 2;
type QSignal = 'decay' | 'escalate' | 'none';

interface QDetectionResult {
  confidence: QConfidence;
  signal: QSignal;
  targetVariant: string;
  currentLevel: WeightLevel;
  suggestedLevel: WeightLevel;
  reason: string;
}
```

### Functions

| 函数 | 签名 | 说明 |
|------|------|------|
| `detectQualityIssue` | `(registry, sig, currentStep) => QDetectionResult \| null` | 检测注入衰退 |
| `observeBehavior` | `(registry, sig) => void` | 推断注入变体是否生效 |

### Detection signals

| Signal | Condition | Confidence | 说明 |
|--------|-----------|:----------:|------|
| decay | 注入 ≥3 步 + behaviorObserved === null | 1 | 注入可能被忽略 |
| escalate | 权重为 C/D + hasActionTools + outputLength>200 | 2 | 权重不足 |

**Identity path:** `behaviorObserved === true` → 跳过（注入生效中）

### Behavior observation rules (tool-call based, no NL)

| Variant | Observation condition |
|---------|----------------------|
| `post_edit` | sig.hasKnowledgeTools |
| `prepare_bash_file` | sig.toolCounts['Read'] > 0 |
| `prepare_search` | sig.hasKnowledgeTools（仅知识工具，action 不算） |
| `post_memory` | sig.hasKnowledgeTools |
| `prepare_verify` | sig.hasVerificationTools |

---

## injectors/anti_confabulation.ts — Injector C5

**File:** `turn/injectors/anti_confabulation.ts`
**Role:** 消费 DetectionResult，不实现检测逻辑。

### Functions

| 函数 | 签名 | 说明 |
|------|------|------|
| `injectAntiConfabulation` | `(result, dedupSet, appendReminder) => void` | 注入反事实提醒 |

**Threshold:** confidence < 2 → 不注入

---

## injectors/quality.ts — Injector Q (P2)

**File:** `turn/injectors/quality.ts`
**Role:** 消费 QDetectionResult，按权重金字塔升级注入。

### Functions

| 函数 | 签名 | 说明 |
|------|------|------|
| `escalateQuality` | `(result, dedupSet, appendReminder) => void` | 按权重金字塔升级 |

### Upgrade injection text strategy

| 升级路径 | 注入策略 |
|:--------:|---------|
| C/D → B | Step 1/2/3 结构化格式 |
| B → A | MUST/NEVER 祈使 |
| A → S | ALWAYS/structural requirement 最高级 |
| S → S | fallback A 级（未来：compaction 检测后重注入） |

---

## turn/index.ts — TurnFlow (集成点)

**File:** `turn/index.ts`
**Role:** 注入器系统宿主。

### Relevant fields

| Field | Type | Description |
|-------|------|-------------|
| `stepInjectedVariants` | `Set<string>` | 本步已注入 variant 集合 |
| `stepToolCounts` | `Record<string, number>` | 本步各工具累计次数 |
| `currentStep` | `number` | 当前步号 |
| `variantRegistry` | `VariantRegistry` | 回合级注入元数据注册表（P2） |
| `agent.context.appendSystemReminder` | `(text, origin) => void` | 注入方法 |

### Integration pattern (afterStep)

```typescript
// 反事实检测
const lastText = extractLastAssistantText(this.agent.context.history);
const sig = compressStep(this.stepToolCounts, lastText);
const snap = buildContextSnapshot(this.stepToolCounts, this.currentStep);
const confaResult = detectConfabulation(sig, snap);
injectAntiConfabulation(confaResult, this.stepInjectedVariants, ...);

// 质量升级检测 (P2)
observeBehavior(this.variantRegistry, sig);
const qualityIssue = detectQualityIssue(this.variantRegistry, sig, this.currentStep);
if (qualityIssue) {
  escalateQuality(qualityIssue, this.stepInjectedVariants, ...);
}
```

### Registered variants (weight levels in parentheses)

**A组 (prepareToolExecution):** prepare_edit(A), prepare_write(A), prepare_search(A), prepare_memory(A), prepare_bash_file(C), prepare_verify(C)

**B组 (finalizeToolResult):** post_edit(A), post_search(B), post_write_large(B), post_verify_pass(B), post_verify_fail(A), post_memory(B)

**C组 (afterStep):** step_after_edit(A/B), step_after_search(B), step_after_verify_fail(A)

**D组 (runOneTurn, intent-based):** intent_fix_bug(B/A), intent_refactor(B/A), intent_add_feature(B/A), intent_review(B/A), intent_research(B/A), intent_document(B/A)

---

## detectors/intent.ts — IntentDetector (Phase 4)

**File:** `turn/detectors/intent.ts`
**Role:** 回合级用户意图检测。纯函数。在 runOneTurn 中注入。

### Types

```typescript
type IntentConfidence = 'low' | 'high';

interface IntentDetection {
  variant: string;            // 'intent_fix_bug', etc.
  confidence: IntentConfidence;
  weightLevel: WeightLevel;   // low→B, high→A
  guidanceText: string;       // 预制好注入文本
  reason: string;
}
```

### Functions

| 函数 | 签名 | 说明 |
|------|------|------|
| `detectIntent` | `(input: ContentPart[]) => IntentDetection \| null` | 分析 user prompt 返回最匹配意图 |

### Detection rules

| Variant | Keywords | High threshold | High markers | Exclude |
|---------|----------|:--------------:|--------------|---------|
| `intent_fix_bug` | fix, bug, error, fail, broken, crash, incorrect, wrong, regression | 2 | reproduction | — |
| `intent_refactor` | refactor, restructure, rewrite, clean up, reorganize, modernize, migrate | 2 | all callers, compatibility shim, clean cutover | test, config |
| `intent_add_feature` | add, feature, new, implement, create, build, integrate | 2 | — | test, config, setting |
| `intent_review` | review, audit, check, inspect, scan | 2 | only review, read only, examine | fix, refactor, add |
| `intent_research` | research, investigate, find out, explore, learn about, search for | 2 | deep dive, thorough, compare | — |
| `intent_document` | document, write docs, explain, tutorial, readme | 2 | api reference, user guide | — |

**Weight level:** low confidence → B（结构化步骤提示）, high confidence → A（MUST/NEVER 祈使）

**Identity path:** no keyword match → null（0 开销）

### Integration (in runOneTurn)

```typescript
if (origin.kind === 'user') {
  const intentDetection = detectIntent(input);
  if (intentDetection) {
    injectIntentGuidance(intentDetection, (text, meta) => {
      this.agent.context.appendSystemReminder(text, meta);
    });
    this.variantRegistry.record(
      intentDetection.variant, intentDetection.weightLevel, this.currentStep,
    );
  }
}
```

意图变体注入后通过 VariantRegistry **自动参与** `detectQualityIssue` + `escalateQuality` 的残差升级链。

---

## injectors/intent.ts — Injector D (Phase 4)

**File:** `turn/injectors/intent.ts`
**Role:** 消费 IntentDetection，按置信度注入预制文本。

### Functions

| 函数 | 签名 | 说明 |
|------|------|------|
| `injectIntentGuidance` | `(detection, appendReminder) => void` | 注入意图指导文本 |

**No dedup check needed** — `detectIntent` returns a single detection per turn, and the integration point runs once per turn (not per step).

### Behavior observation (in detectors/quality.ts observeBehavior)

| Variant | Observation condition |
|---------|----------------------|
| `intent_fix_bug` | sig.toolCounts['Edit'] > 0 |
| `intent_refactor` | sig.hasKnowledgeTools |
| `intent_add_feature` | sig.toolCounts['Read'] > 0 \|\| sig.toolCounts['Glob'] > 0 |
| `intent_review` | sig.toolCounts['Read'] > 0 && !sig.hasActionTools |
| `intent_research` | sig.hasKnowledgeTools |
| `intent_document` | sig.hasKnowledgeTools \|\| sig.toolCounts['Edit'] > 0 \|\| sig.toolCounts['Write'] > 0 |

---

## injectors/budget.ts — InjectBudget (Phase 5)

**File:** `turn/injectors/budget.ts`
**Role:** 回合级注入预算控制。权重感知，与残差系统融合。

### Class: InjectBudget

| 方法 | 签名 | 说明 |
|------|------|------|
| `canInject` | `(estimatedTokens, weightLevel) => boolean` | 检查是否可注入（含 stepNorm + degradationFactor） |
| `record` | `(actualTokens) => void` | 记录注入 token |
| `syncVariantCount` | `(count) => void` | 同步外部 variant 计数（供 degradationFactor） |
| `beginStep` | `(stepNumber) => void` | 每步开始重置 step 计数器 |
| `reset` | `() => void` | 每回合重置全部计数器 |
| `turnUsage` | `getter: number` | 当前回合累计 token |
| `stepUsage` | `getter: number` | 当前步累计 token |

### Budget thresholds (per weight level, before decay)

| Level | perTurn | perStep | Override allowed |
|:-----:|:-------:|:-------:|:----------------:|
| S | 800 | 250 | Yes (2x) |
| A | 600 | 200 | Yes (1.5x) |
| B | 500 | 150 | No |
| C | 300 | 100 | No |
| D | 200 | 80 | No |

### Dynamic decay factors

**stepNorm:** `1 + (1 / (stepNumber + 1))` — perStep cap shrinks as steps advance.
| step | factor | B-perStep effective |
|:----:|:------:|:-------------------:|
| 1 | 1.50 | 100 |
| 3 | 1.25 | 120 |
| 5 | 1.17 | 128 |
| 10 | 1.09 | 137 |

**degradationFactor:** `max(0.4, 1 - variantCount × 0.1)` — more variants = less budget per new inject.
| variantCount | factor | B-perTurn effective |
|:-----------:|:------:|:-------------------:|
| 0 | 1.00 | 500 |
| 3 | 0.70 | 350 |
| 5 | 0.50 | 250 |
| 6+ | 0.40 | 200 |

Actual cap = `floor(configCap × stepNorm × degradationFactor)`

**NOTE:** Both decay factors are heuristic parameters. Tune after gathering production metrics.

### Integration

```typescript
// TurnFlow 字段:
private readonly injectBudget = new InjectBudget();

// beforeStep 中:
this.injectBudget.beginStep(stepNumber);

// runOneTurn 中:
this.injectBudget.reset();

// 统一注入包装（替代所有直接 appendSystemReminder）:
private inject(text: string, meta: PromptOrigin): void {
  // system_trigger / quality_escalate_ → 穿透
  // 其他 → detectWeightLevel + getEffectiveLevel + canInject + record
  // 注册到 VariantRegistry + 同步 variantCount
}
```

### Bypass rules

- `meta.kind === 'system_trigger'`: 穿透预算（收敛机制不应被 budget 拦截）
- `variant.startsWith('quality_escalate_')`: 穿透预算（升级本身就是 budget 不足的补救）
- `behaviorObserved === true`: 降级到 C 级预算占用（identity path）

---

## Future detector integration pattern

```typescript
// 任何新检测器只需要:
const sig = compressStep(this.stepToolCounts, extractLastAssistantText(this.agent.context.history));
const snap = buildContextSnapshot(this.stepToolCounts, this.currentStep);
const result = yourDetector(sig, snap);     // ← 你的纯函数
yourInjector(result, this.stepInjectedVariants, (text, meta) =>
  this.inject(text, meta));
// signature.ts 已提供 compressStep + buildContextSnapshot
// variant-registry.ts 提供行为追踪和权重检测
// injectors/budget.ts 提供预算控制
```
