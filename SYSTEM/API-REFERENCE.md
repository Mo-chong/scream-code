---
tags: [type/reference, domain/api, status/final]
keywords: [API, 接口, 参考, 签名, 域]
updated: 2026-07-11
---

<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
# API Reference

> AI 接口参考。10 域，每 `##` 独立 knowledge chunk。
> 
> **维护规范：** 10 域编号固定，新增接口归入对应域；域内的 `###` 列表化（不超过 20 行/子段），签名用 TypeScript 类型块，参数用表格；禁止加入踩坑/版本历史/说明性文字。

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

### 1.5 注意力信号闭环 🆕
<!-- ref: attentionSignals -->

在每轮 afterStep 结束时自动解析 AI 回复中的状态标记，存入 `crossTurnFlags.attentionSignals`：

```typescript
// turn/index.ts:2020-2033
parseAttentionSignals():
  [DONE]   → signals.done = true    — AI 确认已完成
  [NEED]   → signals.need = true    — AI 表示还需要更多
  [CONFIRM] → signals.confirm = true — AI 需要用户确认
```

> Phase37 (2026-07-11) 新增。供行为规则/注入器在下一轮决策时参考 AI 的显式意图。
> 不会自动触发任何动作，只是标记。消费方需要单独实现。

### 1.6 停止条件
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

**Phase38b 新增：拦截预批准通道**
`InjectContext` 新增 `extraInterceptions?: readonly InterceptionMessage[]`。
`turn/index.ts` → `interception.execute(ctx)` → `InterceptionMessage[]` → `manager.ts inject()` Step 0 预批准优先占 budget 槽。
拦截消息跳过残差（递进替代），共享 `maxInjectionsPerStep` 上限。

### 3.2 17 个注入器（全部注册，统一管线 Phase37）
<!-- ref: injectors -->

| 注入器 | 源文件 | 变体数 | 位置 | 触发条件 | 注册 | 备注 |
|--------|--------|--------|------|---------|------|------|
| UserPrefsInjector | `agent/injection/user-prefs.ts` | 1 | AFTER_SYSTEM | 每轮 | ✅ | |
| DecisionTraceInjector 🆕 | `agent/injection/decision-trace.ts` | 1 | AFTER_SYSTEM | ILR>0.6 + step=1 | ✅ | Phase37 |
| IntentGuidanceInjector | `agent/injection/intent-injector.ts` | 1 | AFTER_SYSTEM | 意图检测命中 | ✅ | |
| PlanModeInjector | `agent/injection/plan-mode.ts` | 1 | AFTER_SYSTEM | 计划模式 step | ✅ | |
| PermissionModeInjector | `agent/injection/permission-mode.ts` | 1 | AFTER_SYSTEM | 权限模式切换 | ✅ | |
| WorkingSetInjector | `agent/injection/working-set.ts` | 1 | MID_CONTEXT | working set 变化 | ✅ | |
| ErrorAuditInjector | `agent/injection/error-audit-injector.ts` | 1 | MID_CONTEXT | FAA 趋势检测（超时/耗时膨胀）**分析瘫痪已砍** | ✅ | Phase37 |
| SessionSummaryInjector 🆕 | `agent/injection/session-summary.ts` | 1 | MID_CONTEXT | step=1 / compaction 后 | ✅ | Phase33 |
| ToolResultRecoveryInjector 🆕 | `agent/injection/tool-result-recovery.ts` | 1 | MID_CONTEXT | ILR>0.3 + hasHighValue | ✅ | Phase37 |
| GoalInjector | `agent/injection/goal.ts` | 1 | MID_CONTEXT | 计划模式 step | ✅ | |
| TodoListInjector | `agent/injection/todo-list.ts` | 1 | MID_CONTEXT | todo 列表变化 | ✅ | |
| WolfPackInjector | `agent/injection/wolfpack.ts` | 1 | MID_CONTEXT | WolfPack 调用 | ✅ | |
| PluginSessionStartInjector | `agent/injection/plugin-session-start.ts` | 1 | MID_CONTEXT | 插件会话启动 | ✅ | |
| AntiConfabulationInjector | `agent/injection/anti_confabulation.ts` | 1 | AFTER_TOOL_CALL | ConfabulationDetector ≥2 | ✅ | |
| QualityInjector | `agent/injection/quality.ts` | 1 | AFTER_TOOL_CALL | QualityDetector 信号 | ✅ | |
| StuckInjector | `agent/injection/stuck.ts` | 1 | AFTER_TOOL_CALL | 同文件编辑≥3步（weight 30→0.6） | ✅ | Phase37 |
| GuardInjector | `agent/injection/guard-injector.ts` | 1 | AFTER_TOOL_CALL | checkGuard Rule 2/3/4 观察（minStepGap 0→3） | ✅ | Phase37 |

> 各注入器变体数均为 1。34 个调度变体在 `variant-registry.ts` 中独立注册，不与注入器一一对应。
> `MemoryRulesInjector` 不存在（早期概念文件）。
> Phase37（07-11）：新增 DecisionTraceInjector + ToolResultRecoveryInjector + SessionSummaryInjector。stuck weight=30→0.6。guard-injector minStepGap=0→3。error-audit 删除分析瘫痪支柱。
> **完整变体列表见** `variant-registry.ts:288-345`。

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

removeSystemRemindersByPrefix(prefix: string): void
  // 遍历 history，删除所有 system-reminder 消息中内容包含 prefix 的（protected 消息跳过）
  // 保留最近一条匹配消息不删（防尾部死消息沉积）
  // 由 updatePersistentSummary 在注入新摘要前调用

protectHighLevelReminders(highOrigins: Set<string>): void
  // 遍历 history，匹配 highOrigins 的消息设置 protected: true
  // 在 applyCompaction() 末尾调用
  // ⚠️ 实际效果有限（compaction 后历史已被替换）

// Phase B': Context Facts 尾部聚合接口
recordFact(key: string, value: string, level?: string): void
  // 记录一个事实到 _contextFacts Map，供尾部聚合使用
  // key: 注入器标识（如 'error-audit', 'working-set'）
  // value: 事实内容（如 '检测到连续超时'）
  // level: 'info' | 'warn' | 'error'（默认 'info'），影响显示图标
  // 由各注入器在 getInjection() 中调用
  // 事实在每次 dispatch 周期开始时自动清空

flushContextFacts(): string | null
  // 格式化所有已记录的事实为 [Context Facts] 结构化块
  // 返回格式化文本，若没有事实则返回 null
  // injectionManager.inject() 在 router.dispatch() 之后调用
  // 结果通过 appendSystemReminder() 追加到尾部
```

### 3.6 appendSystemReminder 签名
<!-- ref: appendSystemReminder -->

```typescript
// 三态签名
appendSystemReminder(content, origin, undefined)  // 不设 protected
appendSystemReminder(content, origin, true)        // 设 protected
appendSystemReminder(content, origin, false)       // 设 protected = true（语义上"不保护"仍设 true）
```

### 3.7 pushHistory 过滤 🔒
<!-- ref: pushHistoryFilter -->

```typescript
// agent/context/index.ts:488-491
private pushHistory(...messages: ContextMessage[]): void {
  for (const message of messages) {
    // 注入/系统触发的消息不进 replay → 不触发 TUI 重渲染 → 不闪烁
    if (message.origin?.kind === 'injection' || message.origin?.kind === 'system_trigger') {
      continue;
    }
    this.agent.replayBuilder.push({ type: 'message', message });
  }
}
```

> Phase37 (2026-07-11) 新增过滤。origin.kind 为 `injection`（DynamicInjector）或 `system_trigger`（行为规则/收敛门）的消息跳过 replayBuilder，不影响 _history（AI 仍可看到）。
> 配合 session-replay.ts:235 的回放过滤，形成双保险。

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

### 6.1 ContentArchive（v2.2）
<!-- ref: ContentArchive -->

**文件**: `packages/agent-core/src/agent/context/content-archive.ts`

```typescript
class ContentArchive {
  static readonly sharedStore = new Map<string, ContentArchiveEntry>()

  constructor(config?: ContentArchiveConfig)  // 默认: ttlMs=4h, hardTtlMs=24h, maxEntries=2000

  archive(key: string, content: string | ContentPart[], options?: ArchiveOptions): void
  recover(key: string): string | ContentPart[] | undefined  // TTL: now - lastAccessedAt > ttlMs || now - timestamp > hardTtlMs
  invalidateByPath(filePath: string): number                 // 按文件路径失效缓存
  getStats(): { localSize: number; sharedSize: number; hits: number; misses: number }
  pruneAll(): void
  size(): number
  list(): ContentArchiveEntry[]
  prune(): number
}

interface ContentArchiveConfig {
  ttlMs?: number           // 软 TTL（lastAccessedAt），默认 14_400_000（4h）
  hardTtlMs?: number       // 硬 TTL（timestamp），默认 86_400_000（24h）
  maxEntries?: number      // 默认 2000
}

interface ArchiveOptions {
  source?: string
  protected?: boolean
}

interface ContentArchiveEntry {
  content: string | ContentPart[]
  timestamp: number          // 创建时间（硬 TTL 判据）
  source: string
  priority: number           // 0.0~1.0，recover() 升权
  protected: boolean
  lastAccessedAt: number     // 最近访问（软 TTL 判据，持续 recover 续命）
  filePath?: string          // 关联文件路径（文件缓存一致性 stat 校验）
  fileMtime?: number
  fileSize?: number
}
```

| 配置 | 默认值 | 说明 |
|------|--------|------|
| ttlMs | 4h（14_400_000） | 软 TTL，基于 lastAccessedAt，持续 recover 续命 |
| hardTtlMs | 24h（86_400_000） | 硬 TTL，基于 timestamp，强制过期上限 |
| maxEntries | 2000 | 超过后加权淘汰 |
| priority floor | < 0.1 | 硬跳过淘汰 |
| protected threshold | >= 100 | 保护不淘汰 |
| dead-loop guard | 3 attempts | 淘汰循环安全门 |
| consolation bonus | +0.5 | 幸存者加分 |

**Flag 控制**：`contentArchive.ttlMs`（`SCREAM_CODE_CONTENT_ARCHIVE_TTL_MS`）覆盖 ttlMs 默认值。

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

interface InjectionEvent {
  variant: string           // 注入变体名（stuck / guard-feedback 等）
  success: boolean          // 是否成功注入
  level?: string            // S/A/B/C/D 注意力等级（仅 success=true）
  position?: string         // H(头部) / M(中部) / T(尾部)
  contentHash?: string      // 内容哈希，用于缓存命中率分析 (Phase M)
  reason?: string           // 失败原因: residual/dedup/quota/error（仅 success=false）
  tokenEstimate?: number    // 注入内容预估 token 数
}

interface AuditLogEntry {
  sessionId: string        // 对话会话 ID
  turn: number             // 轮次
  model: string            // 模型标识
  modelChanged: boolean    // 本轮是否切换了模型
  ts: string               // ISO 时间戳
  totalInput: number       // 总输入 tokens
  cacheHit: number         // 缓存命中 tokens
  cacheMiss: number        // 缓存未命中 tokens
  hitRatio: number         // 缓存命中率（目标 >0.97）
  compacted: boolean       // 是否刚 compaction
  compactedTokens: number  // compaction 压缩掉的 tokens
  alerts: string[]         // 告警列表
  injected: InjectionEvent[]  // 注入事件详情（空=本轮无注入）
  apiKeySwitched: boolean  // 启发式检测：model不变+无注入+缓存率骤降→疑似API key切到不同后端
  archiveHit: number       // ContentArchive 命中计数（Phase33）
  archiveMiss: number      // ContentArchive 未命中计数（Phase33）
  turnStepCount: number    // 上轮用户消息步数（评估摘要阈值）
  pendingRecoverKeys: number  // 自动恢复失败的截断 key 数
  summaryTriggered: boolean   // 本轮是否触发了增量 LLM 摘要
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
  turn: number,
  model: string,
  sessionId: string,
  metrics: CacheMetrics,
  compacted: boolean,
  compactedTokens: number,
  injectedEvents?: InjectionEvent[],  // 注入事件详情数组（旧版为 string[] 变体名列表）
  modelChanged?: boolean,
  apiKeySwitched?: boolean,
  archiveStats?: { hits: number; misses: number },
  turnStepCount?: number,              // 上轮用户消息步数
  pendingRecoverKeys?: number,         // 自动恢复失败截断 key 数
  summaryTriggered?: boolean,          // 本轮是否触发摘要
): AuditLogEntry

function detectApiKeySwitch(
  prevMetrics: CacheMetrics | null,
  currMetrics: CacheMetrics,
  modelChanged: boolean,
  compacted: boolean,
  injectedCount: number
): boolean
  // 启发式：model未变 + 无注入 + 非compaction + 前步缓存>30% + 输入量比<3x +
  //   expectedHitTokens(prevRatio×currInput)  vs  actualHitTokens
  //   实际/期望 < 30% 且 降幅≥20pp → true (疑似API key切到不同后端)
  // DeepSeek 公共前缀缓存仍可能部分命中，故用比值而非硬阈值
  // ALERT_RULES: hitRatio<0.2→告警, hitRatio<0.3→低警告, >0.8→静默
```

输出路径: `workspace/cache-audit-YYYY-MM-DD.ndjson`（按日轮转，每轮追加一行）
告警格式: `ALERT: hitRatio < 0.2 (0.15) — awaiting recovery`
切换判断: `modelChanged=true` → 模型切换；`apiKeySwitched=true` → 同模型但不同后端

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

**文件**: `utils/mask-tool-observations.ts`

```typescript
const MASK_TEXT_WITH_TOOL = '[已遮蔽·{toolName}·已存档·ArchiveRecover可恢复]'
const MASK_TEXT_DEFAULT  = '[已遮蔽·已存档·ArchiveRecover可恢复]'

function maskToolObservations(
  messages: readonly Message[],
  keepLastN?: number,                          // flag mask.keepLastN (默认 3)，< 100 chars 不遮蔽
  toolNameMap?: ReadonlyMap<string, string>   // {toolCallId → toolName}
): Message[]
  // 遮蔽旧 tool result，保留最近 keepLastN 条原文
  // 纯函数，不修改 context.history
  // 工具结果 < 100 chars 跳过遮蔽（短输出保护）
```

**无接口变更**（新增可选参数，向下兼容）。

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

	### 7.9 CompactionReport（v0.8.4 upstream）
	<!-- ref: CompactionReport -->

	**文件**: `agent/compaction/strategy.ts`

	```typescript
	interface CompactionReport {
	  summary: string
	  usage: TokenUsage | null
	  tokensBefore: number
	  tokensAfter: number
	}
	```

	### 7.10 renderMessagesToText（v0.8.4 upstream）
	<!-- ref: renderMessagesToText -->

	**文件**: `agent/compaction/render-messages.ts`（新建）

	```typescript
	renderMessagesToText(messages: ContextMessage[], opts?: {
	  includeRoleLabels?: boolean
	}): string
	  // 消息列表 → LLM 可消费的纯文本

	countMessageTokens(text: string, model?: string): number
	  // 文本 → token 计数
	```

	### 7.11 增量 LLM 摘要（compaction/summary.ts）
	<!-- ref: summary -->

	**文件**: `agent/compaction/summary.ts`

	```typescript
	summarizeWithLLM(
	  llm: LLM,
	  existingSummary: string,
	  recentAssistantTexts: string[],
	  stepOffset: number,
	): Promise<string>
	  // 调 LLM 做增量摘要
	  // existingSummary：旧摘要（合并用）
	  // recentAssistantTexts：最近 ~6K token 的 assistant 回复
	  // stepOffset：当前步数（用于生成 step 号）
	  // 返回格式：emoji bullet list，最多 6 条
	```

	**触发位置**: `turn/index.ts:updatePersistentSummary()`
	- beforeStep 中调用，上轮 ≥ 8 步时触发
	- 走 `system_trigger` → `appendSystemReminder` → 尾部（不破坏缓存前缀）
	- 注入前 `context.removeSystemRemindersByPrefix('[summary]')` 清理旧摘要
	- 成本：~$0.0004/次，~$0.02/天（3756 步/天真实数据）

	### 7.12 knowledge-web / knowledge-store（v0.8.4 upstream）
	<!-- ref: knowledge-web -->

	**文件**: `apps/scream-code/src/tui/commands/knowledge-web.ts`（新建）
	**文件**: `apps/scream-code/src/tui/commands/knowledge-store.ts`（新建）

	TUI 知识库 Web 管理命令，上游新增。

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
-- 6 张核心表 + 3 个 FTS5 全文索引
sources           — 文件来源记录（name/path/type/status/timestamps）
documents         — 文档单元（source_id/title/path/page/metadata）
chunks            — 文档切片 + 向量索引（document_id/content/embedding_vec）
entities          — LLM 抽取的命名实体（type/name/normalized_name/description，UNIQUE(source_id,type,normalized_name) 去重）
events            — LLM 抽取的结构化事件（title/description/actors/roles/category/keywords）
event_entities    — 事件-实体关联边（event_id/entity_id/role，INSERT OR IGNORE 去重）

-- FTS5 全文索引
sources_fts        — 来源名称/路径全文索引
documents_fts      — 文档标题全文索引
chunks_fts         — 切片内容全文索引
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
| 去重 | 实体和边层面 UNIQUE/INSERT OR IGNORE 去重。文件层面重复摄入报错（ingest.ts 行132-139），需先 deleteSource 再重新 ingest |

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
| 注册条件 | `this.agent.type === 'main' && this.agent.knowledgeStore`（与 Memory 工具对等） |
| 适用场景 | SYSTEM docs + project source docs 中的概念/定义/问题症状查询 |
| 不适用场景 | 对话经验（用 MemoryLookup）|

### 9.5 向量模型
<!-- ref: EmbeddingModel, createFastEmbedEngine, loadEmbedder -->

| 属性 | 值 |
|------|-----|
| 模型 | BAAI/bge-small-zh-v1.5（384 维） |
| 推理 | 本地 ONNX（fastembed npm 包，FlagEmbedding） |
| 缓存引擎 | `engineCache`（`packages/memory/src/embeddings.ts`）— 同一 cacheDir 共享 Engine 实例，防并发重复下载 |
| 缓存路径 | `cacheDir` 参数可配置；默认 fallback `local_cache/`（绝对路径，基于 monorepo 根） |
| 模型加载 | 惰性加载（首次 embedBatch 触发 `loadEmbedder(cacheDir)`），初始化前 `mkdirSync` 确保目录存在 |
| 超时保护 | `initWithTimeout` 5min 超时（`EMBED_INIT_TIMEOUT_MS = 300_000`） |
| 重试机制 | 失败后最多重试 3 次；`TAR_BAD_ARCHIVE`/`zlib`/`tokenizer.json` → `cleanFastembedCache()` 自动清理损坏缓存 |
| Sidecar 补全 | `ensureFastembedModelSidecars()` — 缺失 tokenizer/config 文件自动从 HF mirror 下载 |
| Fallback | `createRequire` 兜底尝试替换 fastembed 导入路径 |
| 自动重试循环 | `store.ts` 中 `startEmbeddingLoadLoop()` — 加载失败后每 5 分钟重试直到成功 |
| 可用性检查 | `packages/memory/src/embeddings.ts` — `loadFailed` 标记后可重试 |

### 9.6 记忆价值分类器
<!-- ref: value-classifier.ts, category-tagger.ts (v0.8.5 upstream) -->

| 组件 | 路径 | 说明 |
|------|------|------|
| ValueClassifier | `packages/memory/src/classifiers/value-classifier.ts` | 自动判断记忆价值等级：`critical`/`valuable`/`normal`/`low` |
| CategoryTagger | `packages/memory/src/classifiers/category-tagger.ts` | 自动推断记忆的类别标签 |

---

## 10. All Registered Variants

参考源文件：`variant-registry.ts:288-345`。34 个变体（VARIANT_META 注册）。

| 键 | 类型 | 参数说明 | 源文件 |
|----|------|---------|--------|
| deviation_chain_intercept | variant | weight:1.0, decay:0.99, thr:0.1 | variant-registry.ts（Phase38c: system_trigger 死代码已删） |
| intercept_confabulation | variant | Phase38e: P0_block 防幻 | interception/detectors/confabulation.ts |
| intent_fix_bug | variant | weight:0.9, decay:0.92, thr:0.3 | variant-registry.ts |
| intent_refactor | variant | weight:0.9, decay:0.92, thr:0.3 | variant-registry.ts |
| intent_add_feature | variant | weight:0.9, decay:0.92, thr:0.3 | variant-registry.ts |
| intent_review | variant | weight:0.8, decay:0.90, thr:0.3 | variant-registry.ts |
| intent_research | variant | weight:0.8, decay:0.90, thr:0.3 | variant-registry.ts |
| intent_document | variant | weight:0.7, decay:0.88, thr:0.3 | variant-registry.ts |
| prepare_edit/write/search/memory/bash_file/verify | variant | 6 variants, weight 0.5–0.8 | variant-registry.ts |
| post_edit/search/write_large/verify_pass/verify_fail/memory | variant | 6 variants, weight 0.5–0.9 | variant-registry.ts |
| step_after_edit/search/verify_fail | variant | 3 variants, weight 0.5–0.8 | variant-registry.ts |
| guard_feedback_rule_1/2/3/4 | variant | 4 variants, weight 0.7–0.9, minStepGap:3（Phase37: 0→3） | guard-injector.ts |
| feedback_positive | variant | weight:0.6, decay:0.80, thr:0.4 | variant-registry.ts |
| scene_memory_recall | variant | weight:0.8, decay:0.88, thr:0.3 | variant-registry.ts |
| step_code_ref_quality | variant | weight:0.5, decay:0.85, thr:0.4 | variant-registry.ts |
| code_quality_feedback | variant | weight:0.7, decay:0.85, thr:0.35 | variant-registry.ts |
| system_ref_stuck | variant | weight:0.6（Phase37: 30→0.6）, decay:0.88, thr:0.25, minStepGap:3 | stuck.ts |
| truncation_recover_guard | variant | weight:0.7, decay:0.85, thr:0.35 | variant-registry.ts |
| error-audit | variant | weight:0.5, decay:0.85, thr:0.2, minStepGap:2（Phase37: 分析瘫痪已砍） | error-audit-injector.ts |
| session_summary | variant | weight:0.8, decay:0.88, thr:0.3 | session-summary.ts |
| tool_result_recovery 🆕 | variant | weight:0.6, decay:0.85, thr:0.15, minStepGap:3 + hasHighValue过滤 | tool-result-recovery.ts |
| decision_trace 🆕 | variant | weight:0.5, decay:0.85, thr:0.15, minStepGap:5 | decision-trace.ts |
| persistent_summary | variant | ❌ 已替换为 tool_result_recovery | persistent-summary.ts（保留可回退） |

> Phase37 (2026-07-11): stuck weight 30→0.6; guard-injector minStepGap 0→3; error-audit 删分析瘫痪支柱;
> 新增 tool_result_recovery + decision_trace; persistent_summary 退役。