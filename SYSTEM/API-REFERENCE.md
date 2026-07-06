<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
# API Reference

> AI 接口参考。10 域，每 `##` 独立 knowledge chunk。版本历史/踩坑在 `SYSTEM/pitfalls.md`，设计文档在对应 `SYSTEM/*.md`。**维护规范：10 域编号固定，新增接口归入对应域；域内的 `###` 列表化（不超过 20 行/子段），签名用 TypeScript 类型块，参数用表格；禁止加入踩坑/版本历史/说明性文字。**

---

## 1. 回合生命周期

### 1.1 Turn 主流程
<!-- ref: TurnFlow -->

```
dispatch(stepTool) → shouldContinueAfterStop
  ├─ runOneTurn() → [convergenceGate → inject → LLM → executeTool → afterStep]
  ├─ stop triggers: [toolLimit, converged, injectionFails, hasBlocked, hasFinalResult]
  └─ shouldContinueAfterStop: [not stopped] → continue | [stopped] → return
```

| 组件 | 文件 | 关键方法 |
|------|------|---------|
| TurnFlow | `agent/turn/index.ts` | runOneTurn(), afterStep(), shouldContinueAfterStop() |
| ConvergenceGate | `agent/turn/index.ts:1356-1359` | inject() — 收敛门注入，受 budget 限制 |
| Context | `agent/context/index.ts` | appendUserMessage(), appendSystemReminder() |

### 1.2 afterStep 流程
<!-- ref: afterStep -->

```
afterStep(lastToolResult, stepToolSummary):
  1. toolResultRecorder.record(toolName, step)
  2. 更新 lastToolFailure（失败时记录 exitCode/verifyFailed）
  3. B 组工具结果处理（Edit/Write 成功后 FileActionAudit.push）
  4. 质量检测 + 反事实检测（QualityDetector → ConfabulationDetector）
  5. 场景记忆检测（SceneMemoryDetector）
  6. 代码引用检测（CodeRefDetector）
  7. 代码质量检测（CodeQualityDetector）
  8. 收敛门检查 + 注入（如需要）
  9. 检查是否应该停止（shouldContinueAfterStop）
```

### 1.3 收敛门
<!-- ref: ConvergenceGate -->

```
convergenceGate:
  - 检测 stuck 模式（同文件连续编辑≥3步/同工具连续报错≥2步）
  - 检测 confabulation（编造事实）
  - 检测收敛条件（工具使用频率/代码文件比例/错误率）
  - 最多注入 3 次，超过后放弃
  - system_trigger 穿透预算（turn/index.ts:1356-1359）
```

### 1.4 inject() 注入链路
<!-- ref: inject -->

```
inject(content, origin):
  1. 重复衰减检查（相同内容最近 3 步内已注入 → 跳过）
  2. 残差调度检查（R = W×D^Δs < threshold → 跳过）
  3. 去重检查（已存在完全相同的 content → 跳过）
  4. 预算检查（canInject() → VariantScheduler 残差 → 超限跳过）
  5. 注册（afterInject() → 记录步号+计数）
  6. 注入为 <system-reminder> 消息
```

### 1.5 停止条件
<!-- ref: stopTriggers -->

| 条件 | 触发位置 | 说明 |
|------|---------|------|
| toolLimit 耗尽 | 每步 | 已达到最大工具调用次数 |
| 收敛门已收敛 | afterStep | shouldContinueAfterStop 返回 false |
| 注入失败 | afterStep | 收敛门注入失败 |
| 已阻断 | prepareToolExecution | Guard 阻断 |
| 有最终结果 | afterStep | 工具已返回最终结果 |
| 工具空转 | afterStep | 连续相同工具无进展 |

---

## 2. 工具执行链路

### 2.1 通用模板
<!-- ref: toolExecutionTemplate -->

所有工具的执行链路统一为 3 阶段：

```
prepareToolExecution(options):
  └─ 工具特定 guard 检查 → 返回 executionAllowed | blocked

execute(options):
  └─ 核心逻辑 → 返回 ToolResult

finalizeToolResult(result, stepToolSummary):
  └─ 后处理 → ContentArchive.archive() → UserMessage 入历史

afterStep(lastToolResult, stepToolSummary):
  └─ 质量检测 → 反事实检测 → 收敛门
```

### 2.2 工具差异表
<!-- ref: toolDiffTable -->

| 工具 | prepareToolExecution guard | execute 入口 | finalizeToolResult 后处理 | 特殊行为 |
|------|--------------------------|-------------|--------------------------|---------|
| Edit | 查 LSP references 否（未查则黑名单） | `edit.ts` | 走 B 组→FileActionAudit.push | 改后 LSP.diagnostics 验证 |
| Read | 无 | `read.ts` | 直接入历史 | — |
| Write | 无 | `write.ts` | 走 B 组→FileActionAudit.push | — |
| Glob | 无 | `glob.ts` | 直接入历史 | — |
| Grep | 无 | `grep.ts` | 直接入历史 | — |
| Bash | 无 | `bash.ts` | ToolResultBuilder sanitize | 失败时注入 FAA 审计 |
| LSP | 无 | `lsp.ts` | 直接入历史 | — |
| MemoryLookup | 无 | `memory-lookup.ts` | 直接入历史 | — |
| MemoryWrite | 无 | `memory-write.ts` | 直接入历史 | — |
| MemoryEdit | 无 | `memory-edit.ts` | 直接入历史 | — |

### 2.3 ToolExecution 接口
<!-- ref: ToolExecution -->

```typescript
interface ToolExecution {
  description: string
  approvalRule?: string
  execute: (ctx: ToolExecutionContext) => Promise<ExecutableToolResult>
}

interface ExecutableToolResult {
  output: string
  toolResult?: object
}
```

### 2.4 ToolResultBuilder
<!-- ref: ToolResultBuilder -->

```typescript
interface ToolResultBuilderOptions {
  maxChars?: number
  maxTailChars?: number
  maxLineLength?: number | null
  sanitize?: boolean  // Phase20: 过 sanitizeOutput()
}

class ToolResultBuilder {
  constructor(options?: ToolResultBuilderOptions)
  write(text: string): number  // sanitize=true 时自动调 sanitizeOutput()
  ok(): ToolResult
  error(): ToolResult
}

function sanitizeOutput(text: string): string
  // 1. stripAnsi() — 正则删除全部 ANSI 序列
  // 2. collapseCarriageReturnLines() — \r 空行跳过
```

| 调用方 | sanitize | 文件 |
|--------|----------|------|
| shell/bash.ts execute | true | 所有 Bash 输出 |
| 其他工具 | false (默认) | — |

---

## 3. 注入器体系

### 3.1 InjectionManager
<!-- ref: InjectionManager -->

```typescript
class InjectionManager {
  canInject(variant: string, currentStep: number): boolean      // → scheduler.shouldInject
  getInjectionCount(variant: string): number                    // → scheduler.getInjectionCount
  afterInject(variant: string, currentStep: number): void       // → scheduler.record
  resetForTurn(): void                                           // → scheduler.reset
}
```

### 3.2 10 个注入器
<!-- ref: injectors -->

| 注入器 | 源文件 | 变体数 | 触发条件 |
|--------|--------|--------|---------|
| GoalInjector | `agent/injection/goal.ts` | 3 | 计划模式 |
| MemoryRulesInjector | `agent/injection/memory-rules.ts` | 2 | 场景记忆匹配 |
| PermissionModeInjector | `agent/injection/permission-mode.ts` | 4 | 权限模式切换 |
| PlanModeInjector | `agent/injection/plan-mode.ts` | 5 | 计划模式行为 |
| PluginSessionStartInjector | `agent/injection/plugin-session-start.ts` | 2 | 插件会话启动 |
| TodoListInjector | `agent/injection/todo-list.ts` | 3 | Todo 列表变化 |
| UserPrefsInjector | `agent/injection/user-prefs.ts` | 1 | 每轮（路径 B） |
| WolfPackInjector | `agent/injection/wolfpack.ts` | 2 | WolfPack 调用 |
| WorkingSetInjector | `agent/injection/working-set.ts` | 6 | Working Set 变化 |
| StuckInjector | `agent/injection/stuck.ts` | 1 | 同文件编辑≥3步 |

> **已弃用**: QualityInjector (`quality.ts`), ConfabulationInjector (`confabulation.ts`) — 功能迁移到 turn/index.ts 硬编码注入，计划下一步迁回 DynamicInjector。
> **完整变体列表见** §10 All Registered Variants。

### 3.3 VariantScheduler（残差调度，取代旧 QUOTA_TABLE）
<!-- ref: VariantScheduler -->

自 v0.6.10+ 起取代旧版 QUOTA_TABLE（配额系统已完全移除）。

```typescript
/* 核心公式: R = W × D^Δs
   触发条件: Δs ≥ minStepGap 且 R < T
   注入后:   T = T × thresholdDecay  */

class VariantScheduler {
  shouldInject(variant: string, currentStep: number): boolean  // 残差调度检查
  record(variant: string, currentStep: number): void           // 注入后记录
  reset(): void                                                 // 恢复 T₀
  getInjectionCount(variant: string): number
  getLastStep(variant: string): number | undefined
}
```

| 方法 | 检查条件 |
|------|---------|
| shouldInject | minStepGap 未过 + R < T |
| record | 更新 lastInjectionStep + T = T × thresholdDecay |
| reset | T 恢复 T₀ |

> **旧版迁移**: QUOTA_TABLE 的 `maxPerConversation` / `cooldownSteps` / `windowSteps` 已由残差公式 + 阈值衰减 + minStepGap 三要素取代。详见 `SYSTEM/injection-system.md §7`。

### 3.4 collectInjectorFacts（已弃用）
<!-- ref: collectInjectorFacts -->

旧版占位函数，未接入 handleAfterStep。功能已由 `VariantScheduler.getInjectionCount` + `InterceptionEvent` 日志取代。

### 3.5 ContextMessage.protected
<!-- ref: ContextMessageProtected -->

```typescript
// agent/context/types.ts
export interface SystemReminderRecord {
  content: string
  origin: PromptOrigin
  protected?: boolean  // true → compaction 跳过
}

// agent/context/index.ts
appendSystemReminder(content: string, origin: PromptOrigin, isProtected?: boolean): SystemReminderRecord
  // isProtected 默认 undefined → 不设置字段

protectHighLevelReminders(highOrigins: Set<string>): void
  // 遍历 history，匹配 highOrigins 的消息设置 protected: true
  // 在 applyCompaction() 末尾调用
  // ⚠️ 实际效果有限（compaction 后历史已被替换）
```

### 3.6 appendSystemReminder 签名
<!-- ref: appendSystemReminder -->

```typescript
// 三态签名
appendSystemReminder(content, origin, undefined)  // 不设 protected
appendSystemReminder(content, origin, true)        // 设 protected
appendSystemReminder(content, origin, false)       // 设 protected = true（语义上"不保护"仍设 true）
```

---

## 4. 检测器体系

### 4.1 SceneMemoryDetector
<!-- ref: SceneMemoryDetector -->

**文件**: `agent/detection/scene-memory.ts`

```typescript
class SceneMemoryDetector {
  detect(history: ContextMessage[], latestCommands: StepToolSummary): SceneMemoryMatch[]
}

interface SceneMemoryMatch {
  signal: 'memory_consult_required' | 'memory_write_required'
  confidence: number  // 0-1
  trigger: string     // 触发原因
}
```

**检测条件：**
- memory_consult_required: 遇到已知问题/复用模式时未查记忆
- memory_write_required: 完成重要任务后未写记忆

### 4.2 CodeRefDetector
<!-- ref: CodeRefDetector -->

**文件**: `agent/detection/code-ref.ts`

```typescript
class CodeRefDetector {
  detect(history: ContextMessage[], tools: StepToolSummary): CodeRefIssue[]
}

interface CodeRefIssue {
  file: string
  symbol: string
  issue: 'references_not_checked' | 'caller_not_updated'
  severity: 'P0' | 'P1' | 'P2'
}
```

**检测条件：**
- references_not_checked: Edit 文件前未调 LSP.references
- caller_not_updated: 修改函数签名后未更新调用方

### 4.3 CodeQualityDetector
<!-- ref: CodeQualityDetector -->

**文件**: `agent/detection/code-quality.ts`

```typescript
class CodeQualityDetector {
  detect(history: ContextMessage[], tools: StepToolSummary): CodeQualityIssue[]
}

interface CodeQualityIssue {
  file: string
  issue: 'TODO_left' | 'stub_implementation' | 'no_test' | 'console_log_left'
  severity: 'P0' | 'P1' | 'P2'
}
```

### 4.4 ConfabulationDetector
<!-- ref: ConfabulationDetector -->

**文件**: `agent/detection/confabulation.ts`

```typescript
class ConfabulationDetector {
  detect(history: ContextMessage[], tools: StepToolSummary): ConfabulationAlert[]
}

interface ConfabulationAlert {
  claim: string
  evidence: 'tool_result' | 'memory' | 'none'
  confidence: number
}
```

**检测模式：**
- 声称"已修改"但无 Edit/Write 调用
- 声称"测试通过"但 Bash exit code = 1
- 声称"检查发现"但无 Read/Grep/LSP 调用
- 声称"可以看到"但无 Read/Grep 工具调用
- 声称"在我的记忆中"但无 MemoryLookup 调用

### 4.5 QualityDetector
<!-- ref: QualityDetector -->

**文件**: `agent/detection/quality.ts`

```typescript
class QualityDetector {
  detect(history: ContextMessage[], tools: StepToolSummary): QualitySignal[]
}

interface QualitySignal {
  signal: 1 | 2 | 3 | 4 | 5
  description: string
}

// Signal 定义:
// 1: 工具调用次数过多（> 规定阈值）
// 2: bash 输出 > 3000 chars → 升一级 + concise-summary constraint
// 3: 连续使用相同工具无进展
// 4: 文档阅读过多（> 阈值）
// 5: 工具之间切换频繁（> 阈值）
```

---

## 5. Guard 规则引擎

### 5.1 guard-engine.ts
<!-- ref: guardEngine -->

**文件**: `packages/agent-core/src/agent/turn/guard-engine.ts`

```typescript
function guardEngine(history: ContextMessage[], tools: StepToolSummary): GuardResult

interface GuardResult {
  block: boolean
  reason?: string
  ruleId: number
}
```

### 5.2 4 条规则
<!-- ref: guardRules -->

| 规则 | 触发条件 | 行为 | 优先级 |
|------|---------|------|--------|
| Rule 1: 矛盾阻断 | lastBashExitCode=1 + 文本含"测试通过" | block=true, 阻止继续 | HIGH |
| Rule 2: 无证据声称 | 无 Read/Grep/LSP 调用 + 文本含"检查发现\|可以看到\|我发现" | block=false, 标记 | MEDIUM |
| Rule 3: 无编辑声称改 | 无 Write/Edit 调用 + 文本含"已修改\|已删除\|已重构\|已调整" | block=false, 标记 | MEDIUM |
| Rule 4: 记忆仅代码断言 | 有 MemoryLookup + 无 Read/Grep/LSP 调用 + 含特定 claim | block=false, 标记 | LOW |

### 5.3 测试
<!-- ref: guardEngineTests -->

**文件**: `test/agent/turn/guard-engine.test.ts` — 14 测试，全部通过。

---

## 6. 数据层

### 6.1 ContentArchive（v2.1）
<!-- ref: ContentArchive -->

**文件**: `packages/agent-core/src/agent/context/content-archive.ts`

```typescript
class ContentArchive {
  static readonly sharedStore = new Map<string, ContentArchiveEntry>()

  constructor(maxEntries?: number, ttl?: number)  // 默认 2000, 30min

  archive(key: string, content: string | ContentPart[], options?: ArchiveOptions): ArchiveResult
  recover(key: string): string | ContentPart[] | undefined
  list(): string[]
  prune(): number
}

interface ArchiveOptions {
  priority?: number       // 0-100, 默认 0.5
  source?: string
}

interface ContentArchiveEntry {
  content: string | ContentPart[]
  priority: number
  createdAt: number
  lastAccessAt: number
}
```

| 配置 | 默认值 | 说明 |
|------|--------|------|
| maxEntries | 2000 | 超过后加权淘汰 |
| TTL | 30 min | 超时后 recover 返回 undefined |
| priority floor | < 0.1 | 硬跳过淘汰 |
| protected threshold | >= 100 | 保护不淘汰 |
| dead-loop guard | 3 attempts | 淘汰循环安全门 |
| consolation bonus | +0.5 | 幸存者加分 |

**淘汰公式：**
```
score = priority × Math.exp(-ageMs / TTL) × (1 - ageFactor × 0.5)
```

### 6.2 sharedStore（跨子 agent 共享）
<!-- ref: sharedStore -->

- `static sharedStore: Map<string, ContentArchiveEntry>` — 所有 Agent 实例共享
- `archive()` 写入本地 store 时同步写入 sharedStore
- `recover()` 先查本地 → 未命中回退 sharedStore → copy-on-access 写回本地
- 不破坏子 agent 隔离（本地 store 独立，共享只作 fallback）

### 6.3 集成点
<!-- ref: archiveIntegrationPoints -->

| 位置 | 行为 |
|------|------|
| Point A (context/index.ts) | tool result 入历史前存档原始输出 |
| Point B (turn/index.ts) | 压缩截断时存档 |
| Point C (context/index.ts) | 截断触发时存档 |

### 6.4 FileActionAudit
<!-- ref: FileActionAudit -->

**文件**: `agent/audit/file-action-audit.ts`

```typescript
interface FileActionAuditEntry {
  action: 'edit' | 'write'
  toolCallId: string
  timestamp: number
  resultPreview: string
  success: boolean
  durationMs: number
}

abstract class FlushBuffer<T> {
  constructor(maxBufferSize?: number)  // default 50
  push(entry: T): void
  flush(): Promise<void>               // 前置重置 error，退出路径可重试
  protected abstract drainBatch(): Promise<void>
}

class FileActionAudit extends FlushBuffer<FileActionAuditEntry> {
  // 熔断: 连续 5 次失败 → circuitOpen = true → 跳过刷盘
  // 防抖: 两次 flush 间隔 < 30s 直接 return
  // 日切: 追加写入 <screamHome>/audit/YYYY-MM-DD.jsonl
  // v2: 环状缓冲区（最近 50 条），用于查错注入

  private static KEEP_RECENT_MAX = 50
  private recentEntries: FileActionAuditEntry[] = []
  getRecentEntries(n: number): FileActionAuditEntry[]
}
```

| 属性 | 值 | 说明 |
|------|-----|------|
| Flag default | false | 有 IO 开销 |
| Buffer | 50 entries | 累积后刷盘 |
| Debounce | 30_000 ms | 防止频繁写盘 |
| Circuit breaker | 5 次失败 | 防止审计影响 agent |
| Day rotation | `.jsonl` 文件 | 按日历日分片 |
| Exit flush | `extractMemoriesOnExit` finally | 退出兜底 |

**FAA 查错注入（三级分类）：**

```
tool 失败 → getRecentEntries(5) → 三级分类决定注入模板:
  BLOCKER:  verifyFailedThisStep === true  → "验证失败，不要跳过" + FAA
  CRITICAL: exitCode ∈ {137, 124}          → "异常退出" + FAA
  WARNING:  其他错误                        → "报告错误，检查输出" + FAA
```

### 6.5 VariantRegistry
<!-- ref: VariantRegistry -->

**文件**: `agent/turn/variant-registry.ts`

```typescript
class VariantRegistry {
  getInjectionCount(variant: string): number
  getLastStep(variant: string): number | undefined
}

function getScore(variant: string, stepDelta: number): number  // 恢复导出
```

### 6.6 拦截事件日志
<!-- ref: InterceptionEventLog -->

**文件**: `agent/interception/event-log.ts`

```typescript
class InterceptionEventLog {
  // 环形缓冲区 + W 驱动采样 + 磁盘持久化
  // 每回合刷盘到 wire.jsonl
}
```

### 6.7 TokenUsage（Phase26）
<!-- ref: TokenUsage -->

**文件**: `packages/ltod/src/usage.ts`

```typescript
interface TokenUsage {
  inputOther?: number
  inputCacheRead?: number
  inputCacheCreation?: number
  cacheHitTokens?: number    // Phase26: DeepSeek 缓存命中 token 数
  cacheMissTokens?: number   // Phase26: DeepSeek 缓存未命中 token 数
  // ... 其他字段
}
```

解析位置: `packages/ltod/src/providers/openai-common.ts:242-254`
- 条件: `typeof u['prompt_cache_hit_tokens'] === 'number'`
- 不检查模型名。任何返回此字段的 API 自动识别

### 6.8 CacheAudit（Phase26 新增）
<!-- ref: CacheAudit -->

**文件**: `agent/usage/audit-log.ts`

```typescript
interface CacheMetrics {
  hitRatio: number    // 0-1，命中率
  hitTokens: number   // 缓存命中 token 总数
  missTokens: number  // 缓存未命中 token 总数
}

interface AuditLogEntry {
  turnId: string
  model: string
  timestamp: string
  cache: CacheMetrics
  compacted: boolean
  compactedTokens: number
  alerts: string[]
}

function computeCacheMetrics(usage: TokenUsage): CacheMetrics
  // hitRatio = hitTokens / (hitTokens + missTokens)
  // 注意: 总和为 0 时返回 0

class AuditLogWriter {
  constructor(config?: { dir?: string })
  init(): void           // 创建 log dir，吞错误不阻塞
  write(entry: AuditLogEntry): void  // 追加 ndjson 行
  flush(): void
  destroy(): void
}

function buildAuditEntry(
  turnId: string,
  model: string,
  metrics: CacheMetrics,
  compacted: boolean,
  compactedTokens: number
): AuditLogEntry
  // 检查 ALERT_RULES: hitRatio<0.2 → 告警, >0.8 → 静默
```

输出路径: `workspace/cache-audit.ndjson`（每轮追加一行）
告警格式: `ALERT: hitRatio < 0.2 (0.15) — awaiting recovery`

---

## 7. 消息管道

### 7.1 前缀稳定化
<!-- ref: stabilizePrefix -->

**文件**: `agent/context/stabilize.ts`

```typescript
function stabilizePrefix(history: ContextMessage[]): ContextMessage[]
  // 前缀稳定化 — 提升 KV-cache 命中率
  // 在每次 LLM 调用前执行
```

### 7.2 Observation Masking
<!-- ref: maskToolObservations -->

**文件**: `agent/context/masking.ts`

```typescript
function maskToolObservations(history: ContextMessage[], maxRecent?: number): ContextMessage[]
  // 遮蔽旧 tool result，保留最近 maxRecent（默认 3）条
  // 压缩/对话双路径独立处理
```

### 7.3 MicroCompaction 批次门控
<!-- ref: MicroCompactionConfig -->

```typescript
interface MicroCompactionConfig {
  BATCH_SIZE: number           // 默认 8，env SCREAM_CODE_MICRO_BATCH_SIZE
  minContextUsageRatio: number // 默认 0.5
  keepRecentMessages: number   // 默认 30 (Phase26 从 20 扩到 30)
}

function microCompact(messages: ContextMessage[]): ContextMessage[]
  // 3 道关卡:
  // 1. 截断旧 tool.result
  // 2. Supersede 旧 Read
  // 3. Point B 存档到 ContentArchive
```

### 7.4 Pipeline Counters
<!-- ref: PipelineMetrics -->

```typescript
interface PipelineMetrics {
  microCompactCount: number
  stabilizeHitCount: number
}

function getMetrics(): PipelineMetrics
  // stabilizeHitCount 用 JSON.stringify 比较
```

### 7.5 ToolResultBuilder sanitize
<!-- ref: sanitizeOutput -->

```typescript
// bash.ts 中 ToolResultBuilder 默认 sanitize: true
// sanitize 行为:
//   1. stripAnsi() — 正则删除全部 ANSI 序列
//   2. collapseCarriageReturnLines() — \r 空行跳过
// 配对方:
//   - truncateToolOutput() 中的 collapseDuplicateLines(text, threshold=3)
//   - quality.ts Signal 3: bash 输出 >3000 chars 时升一级
```

### 7.6 CompactionStrategy 接口（Phase26）
<!-- ref: CompactionStrategy -->

**文件**: `agent/compaction/strategy.ts`

```typescript
interface CompactionStrategy {
  shouldCompact(usedSize: number): boolean
  recordRound(tokensUsed: number): void          // Phase26: 喂 token 数据给预测器
  shouldBlock(usedSize: number): boolean
  computeCompactCount(messages, source): number
}

class DefaultCompactionStrategy implements CompactionStrategy {
  readonly predictor: GrowthPredictor

  shouldCompact(usedSize: number): boolean
    // 优先级: predictor > triggerRatio
    // 1. predictor.shouldCompact(currentUsage, maxSize) → true 则触发
    // 2. 否则 fallback 到 usedSize >= maxSize * triggerRatio (默认 0.75)

  recordRound(tokensUsed: number): void
    // 委托: this.predictor.recordRound(tokensUsed)
}
```

### 7.7 GrowthPredictor（Phase26）
<!-- ref: GrowthPredictor -->

**文件**: `packages/agent-core/src/agent/compaction/predictor.ts`

```typescript
class GrowthPredictor {
  recordRound(tokensUsed: number): void
    // 追加到 recentRounds (max 10), 超过则 shift

  predictNextGrowth(): number
    // EMA（α=0.4）替代简单平均，对突发 spikes 更鲁棒
    // 时间间隔归一化
    // × 1.2 安全系数；<2 轮数据返回 0

  shouldCompact(currentUsage: number, maxSize: number): boolean
    // currentUsage + predictNextGrowth() > maxSize × 0.85
    // 无历史时退化为 currentUsage > maxSize × 0.85
}
```

### 7.8 ContentHashCache（Phase26）
<!-- ref: ContentHashCache -->

**文件**: `packages/agent-core/src/agent/turn/content-cache.ts`

```typescript
class ContentHashCache {
  isDuplicate(variant: string, content: string, prefixLen?: number): boolean
    // 与上一步相同 variant 的内容 prefix 对比。重复返回 true 跳过注入
    // prefixLen 默认 60，variant 编号归一化（post_step_1=post_step_2）

  reset(): void
    // compaction 后调用，所有缓存强制失效

  clearVariant(variant: string): void
    // 清除指定 variant 的缓存条目

  get size(): number
    // 当前缓存的 variant 数
}
```

### 7.9 InterceptionEvent.agentType（Phase26）
<!-- ref: InterceptionEvent -->

**文件**: `packages/agent-core/src/agent/turn/event-log.ts`

```typescript
interface InterceptionEvent {
  kind: 'injection_skipped' | 'injection_delivered'
  variant: string
  action: string
  step: number
  turnId: string
  reason: string
  level?: WeightLevel
  tokenEstimate?: number
  agentType?: 'main' | 'sub' | 'independent'   // 主体类型，用于主子 agent 日志区分
}
```

---

## 8. 特殊模块

### 8.1 TruncationTracker（Phase24.2）
<!-- ref: TruncationTracker -->

**文件**: `agent/turn/truncation-tracker.ts`

```typescript
interface TruncationEntry {
  readonly key: string
  readonly toolName: string
  readonly step: number
  readonly originalLength?: number
  readonly truncatedLength?: number
}

interface TruncationTrackerConfig {
  maxStepAge?: number            // 默认 40
  maxConsecutiveBlocks?: number  // 默认 3
  readOnlyTools?: Set<string>   // 默认 new Set(['Bash'])
}
```

| 方法 | 用途 | 引入 |
|------|------|------|
| register(key, toolName, step, originalLength?, truncatedLength?) | 注册截断数据 | Phase24.1 |
| isReadOnly(toolName) | 查询工具是否为只读 | Phase24.2 |
| hasUnrecovered() | 是否存在未 recover 的截断数据 | Phase24 |
| pendingKeys() | 获取未 recover 的 key 列表 | Phase24 |
| markRecovered(key) | 标记 key 已恢复 | Phase24.1 |
| markStepRecovered(key, step) | 步级标记，防并行重复 | Phase24.2 |
| isAlreadyRecoveredThisStep(key, step) | 查询本步是否已 recover | Phase24.2 |
| clearStepRecovered(step) | 清理指定步的 recover 记录 | Phase24.2 |
| forceResume(reason?) | 熔断逃生：清空 entries + stepRecovered | Phase24.1 |
| dispose() | 安全清理：解绑 static current + 清空 entries | Phase24.1 |
| prune(currentStep, maxStepAgeOverride?) | 清理过期条目 | Phase24 |

**自动恢复流程（turn/index.ts）：**

```
prepareToolExecution guard:
  hasUnrecovered && step > 1 && !isReadOnly(toolName):
    1. 遍历 pendingKeys
    2. 每 key: 检查 isAlreadyRecoveredThisStep → 跳过已恢复的
    3. 未恢复: ContentArchive.recover(key) → 诊断式预览
    4. 诊断预览: >200 字符则显示前 200 + 总长度，否则全部显示
    5. inject() 预览到上下文 → markRecovered + markStepRecovered
    6. 仍有 unrecovered → incrementBlockAndCheck() 熔断检查

finalizeToolResult: truncated === true → register(key, toolName, step, ...)
afterStep: clearStepRecovered(currentStep) → prune(currentStep)
```

### 8.2 ArchiveRecoverTool
<!-- ref: ArchiveRecoverTool -->

**文件**: `packages/agent-core/src/tools/builtin/context/archive-recover.ts`

```typescript
// 输入: { key?: string, query?: string }
// 输出: 按 key 精确匹配 / 按 query 模糊搜索 / 不传参返回所有可用 key 索引

class ArchiveRecoverTool implements BuiltinTool {
  readonly name = 'ArchiveRecover'
  readonly description = '从内容存档中按 key 或关键词恢复之前截断/存档的内容。'
  // resolveExecution 模式，非 execute
  resolveExecution(args): ToolExecution { ... }
}
```

| 属性 | 值 |
|------|-----|
| 注册条件 | 所有 agent 均可（已移除 main 限制） |
| 联动 | ContentArchive.recover()，自动寻址 sharedStore |
| 用途 | 超大输出截断找回/跨子 agent 数据传递/诊断调试 |

### 8.3 约束
<!-- ref: archiveRecoverConstraints -->

- ArchiveRecoverTool 不封装 archive()（工具模型不应直接写 archive）
- 不暴露内部 TTL/priority（recover 对模型是黑箱寻址）
- expired 条目返回 undefined 而非错误信息

---

## 9. 知识库

### 9.1 KnowledgeStore
<!-- ref: KnowledgeStore -->

**文件**: `packages/knowledge/src/store.ts`

```sql
-- 4 张核心表
chunks    — 文档切片（含 embedding BLOB + FTS5 索引）
events    — LLM 抽取的结构化事件（title/summary/category/keywords）
entities  — LLM 抽取的命名实体（type/name/description）
relations — 实体-事件-实体关系嵌入
```

```typescript
// 文档管理
createSource(name: string, dirName: string | null): Promise<number>
createDocument(sourceId: number, filePath: string): Promise<number>

// 切片存储
insertChunk(chunk: ChunkRecord): Promise<void>

// 事件/实体/关系
insertEvent(event: EventRecord): Promise<number>
insertEntity(entity: EntityRecord, overwriteName: boolean): Promise<number>
insertEventEntity(eventId: number, entityId: number, role: string): Promise<void>

// 检索
searchChunksByVector(vector: Float32Array, limit: number): Promise<ScoredChunk[]>
ftsSearchChunks(query: string, limit: number): Promise<ScoredChunk[]>
findEntitiesByName(name: string, limit: number): Promise<EntityRecord[]>
findEntitiesByVector(vector: Float32Array, limit: number): Promise<ScoredEntity[]>
findEventsByEntity(entityId: number, limit: number): Promise<EventRecord[]>
```

### 9.2 ingestFile
<!-- ref: ingestFile -->

**文件**: `packages/knowledge/src/ingest.ts:83`

```typescript
async function ingestFile(
  store: KnowledgeStore,
  llm: LlmCaller,
  filePath: string,
  onProgress?: IngestProgressCallback,
): Promise<{ documentId: number; chunkCount: number; eventCount: number; entityCount: number }>
```

**摄入流程：** Read → chunkDocument() → embedBatch (fastembed) → extractEventsFromChunk (LLM) → insertChunk/Event/Entity → 事务 commit

| 属性 | 值 |
|------|-----|
| 支持格式 | .md, .markdown, .txt |
| 依赖 | Python + fastembed 包 |
| LLM 调用 | 每 chunk 1 次（并发 3） |
| 事务 | 单文件事务保护，失败自动回滚 |
| 去重 | 支持文件路径去重（重复摄入自动跳过） |

### 9.3 multiSearch
<!-- ref: multiSearch -->

**文件**: `packages/knowledge/src/search.ts:63-122`

```typescript
async function multiSearch(
  store: KnowledgeStore,
  llm: LlmCaller,
  query: string,
  options?: KnowledgeSearchOptions,
): Promise<KnowledgeSearchResult[]>
```

**7 步检索链路：**
1. Embedding 向量化 (fastembed)
2. Entity Recall: LLM 抽取查询实体 → DB 查找匹配 (limit 20)
3. Seed Events: 匹配实体关联事件 (limit 30)
4. BFS Expand: 1 hop 图展开 (上限 100 事件)
5. Coarse Rank: 去重 + 排序 (top 50)
6. LLM Rerank: query 与候选事件语义相关度重排 (top K，默认 5)
7. Chunk Dedup + Backfill

**降级策略：** LLM 不可用 → 仅向量检索；embedding 不可用 → FTS5 fallback

### 9.4 KnowledgeLookupTool
<!-- ref: KnowledgeLookupTool -->

**文件**: `packages/agent-core/src/tools/builtin/knowledge/knowledge-lookup.ts`

```typescript
class KnowledgeLookupTool implements StepTool
```

| 属性 | 值 |
|------|-----|
| 注册条件 | `this.agent.type === 'main' && this.agent.knowledgeStore` |
| 适用场景 | 概念/定义/背景查询，WebSearch 优先本地 |
| 不适用场景 | 代码/文件操作 (MemoryLookup/Read/Grep) |

### 9.5 向量模型
<!-- ref: EmbeddingModel -->

| 属性 | 值 |
|------|-----|
| 模型 | BAAI/bge-small-zh-v1.5（384 维） |
| 推理 | 本地 ONNX（fastembed Python 包） |
| 首次加载 | 自动下载 ~30MB |
| 可用性检查 | `packages/knowledge/src/index.ts:38` — 加载失败标记 `available=false` |

---

## 10. All Registered Variants

| 键 | 类型 | 说明 | 所属注入器 | 文件 |
|----|------|------|-----------|------|
| code_quality | variant | 质量检测注入 | QualityInjector | variant-registry.ts |
| confabulation | variant | 反事实纠正注入 | ConfabulationInjector | variant-registry.ts |
| memory_rule | variant | 记忆规则注入 | MemoryRulesInjector | variant-registry.ts |
| memory_goal | variant | 计划目标注入 | MemoryGoalInjector | variant-registry.ts |
| stuck | variant | 偏差纠正注入 | StuckInjector | variant-registry.ts |
| memory_consult | system_trigger | 收敛门记忆查询 | — | turn/index.ts |
| convergence_gate | system_trigger | 收敛门注入 | — | turn/index.ts |
| memory_archive | system_trigger | 记忆归档 | — | turn/index.ts |
| test | variant | 测试用例 | — | variant-registry.ts |