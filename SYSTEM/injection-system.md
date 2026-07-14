---
tags: [type/reference, domain/injection, status/final]
keywords: [注入, injection, DynamicInjector, 残差, residual, 变体, variant]
updated: 2026-07-14
---

<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
# 注入系统 / Injection System [P0]

> **参见：** [`architecture-overview.md`](architecture-overview.md)（架构全景） | [`turn-control.md`](turn-control.md)（回合调度） | [`attention-system.md`](attention-system.md)（注意力分配） | [`API-REFERENCE.md`](API-REFERENCE.md)（接口签名） | [`pitfalls.md`](pitfalls.md)（踩坑记录）
>
> 指令权重体系、变体注册表、残差注意力门控、注入管线与预算系统。
> 15 个 DynamicInjector（Phase37 新增 DecisionTrace / SessionSummary，ToolResultRecovery 未注册）。
> **演变**：路径 B 已清零（Phase22）。路径 C (GuardInjector) 已完成迁移（Phase33）。
> Phase37 (2026-07-11)：stuck weight 30→0.6 | error-audit 删分析瘫痪支柱。
> **v3 (2026-07-14)**：PersistentSummaryInjector→废弃（被 ArchivalSummaryInjector 归档层替代）。
> TruncationTracker→Micro/ArchiveRecover 已废弃，自动恢复走归档层。

---

## 1. 指令权重体系 (Instruction Weight System)

指令权重分为五级 `S/A/B/C/D`，定义注入的**不可跳过性优先级**。

### 分级定义

| 等级 | 名称 | 语义 | 永不跳过 | compaction 保护 | 示例变体 |
|------|------|------|---------|----------------|---------|
| **S** | System | 系统级约束，必须始终呈现 | ✅ 绝对 | ✅ 永不压缩 | `intent_fix_bug`, `session_memory`, `feedback_positive`, `feedback_negative` |
| **A** | Advanced | 高级行为规则 | ✅ 绝对（除非预算耗尽） | ✅ 永不压缩 | `prepare_bash_file`, `post_edit` |
| **B** | Behavioral | 中级行为规则 | ❌ 残差衰减后可跳过 | ❌ | `guard_rule_3`, `guard_feedback_rule_3` |
| **C** | Common | 普通信息提示 | ❌ 残差衰减后可跳过 | ❌ | `intent_summarize`（~~anti_confabulation~~已删≈Phase38c） |
| **D** | Debug | 低级调试信息 | ❌ 受 budget 控制 | ❌ | `system_ref_stuck`, `session_memory`(某些场景) |

### 等级行为规则

- **S 级**: 每次 compaction 时标记为 `protected=true`，不会被任何形式的上下文压缩删除。
- **A 级**: 同理 `protected=true`，但在预算耗尽时仍可能被跳过注入。
- **B/C/D 级**: 受残差注意力系统控制，当距上次注入步数 Δs 足够大时注入，否则跳过。

---

## 2. 变体注册表 (Variant Registry)

定义于 `packages/agent-core/src/agent/turn/variant-registry.ts`。

### VariantMeta 接口

```typescript
export interface VariantMeta {
  /** 基础权重 (weight) — 决定首次注入的初始强度。通常 0.0 ~ 1.0 */
  weight: number;
  /** 衰减率 (decayPerStep) — 每步残差衰减的比率。0 < D < 1 */
  decayPerStep: number;
  /** 阈值 (threshold) — 残差低于此值则不注入。0 ≤ T ≤ 1 */
  threshold: number;
  /** 最小步数间隔 (minStepGap) — 距上次注入至少 N 步才允许再次注入 */
  minStepGap: number;
}
```

### 注入位置策略

定义于 `packages/agent-core/src/agent/injection/position-strategy.ts`。

`InsertPosition` 枚举，3 个实际值 + 1 个 bypass 路径，决定系统提醒注入到消息列表的位置，利用 Transformer 注意力曲线的 U 形特性：

| 枚举值 | 等级 | Prompt 区域 | 缓存影响 |
|--------|------|-------------|---------|
| `AFTER_SYSTEM` | S/A (head) | 系统提示后第一条 | **不变** → 高命中率 |
| `MID_CONTEXT` | B | 上下文中部 | 偶变 → 中等影响 |
| `AFTER_TOOL_CALL` | C/D/E (tail) | 消息列表末尾 | 不影响前缀 |
| *bypass* (summary) | — | `appendSystemReminder` 尾部 | **零影响** |

> 早期设计文档曾含 `'head'`/`'near_head'`/`'tail'`/`'CONTEXT_BOTTOM'`/`'ATTENTION_PEAK'` 五位置方案，代码实际使用 `InsertPosition` 三枚举值 + 注意力等级映射（`position-strategy.ts:29-54`）。

### 当前注册表（34 变体，见 variant-registry.ts:288-361）

| 变体名 | weight | decayPerStep | threshold | minStepGap | 等级 | 用途 |
|--------|--------|-------------|-----------|-----------|------|------|
| `system_ref_stuck` | 0.6 | 0.88 | 0.25 | 3 | D | 文件编辑/报错循环（Phase37: ctx.history替代stuckContext） |
| ~~`system_ref_anti_confabulation`~~ | — | — | — | — | — | **已删除** Phase38c（合并入 confabulationDetector） |
| ~~`quality_escalate`~~ 🗑️ | — | — | — | — | — | **已删除** Phase38j（由 qualityDegradeDetector 替代，走 InterceptionManager 统一管道） |
| `error-audit` | 0.5 | 0.85 | 0.2 | 2 | B | FAA 超时/耗时检测（分析瘫痪已砍） |
| `session_summary` | 0.8 | 0.88 | 0.3 | 3 | B | 会话摘要（step1或compaction后） |
| `persistent_summary` | — | — | — | — | — | ❌ **已废弃 v3**（被 ArchivalSummaryInjector 归档层替代） |
| `archival_summary` 🆕 | 0 | 0 | 0 | 0（自身频率控制） | — | 归档层结构化摘要，>50K触发，尾部append |
| `tool_result_recovery` 🆕 | 0.6 | 0.85 | 0.15 | 3 | B | 被mask的关键tool结果恢复 |
| `decision_trace` 🆕 | 0.5 | 0.85 | 0.15 | 5 | B | 决策链快照+循环检测（ILR>0.6） |
| `intent_*` (6变体) | 0.5 | 0.50 | 0.3 | 2 | A/B | 意图检测引导 |
| `prepare_*` (6变体) | 0.25 | 0.70 | 0.3 | 2 | B | 准备阶段注入 |
| `post_*` (6变体) | 0.20 | 0.50 | 0.3 | 2 | C | 执行后注入 |
| `step_after_*` (3变体) | 0.20 | 0.50 | 0.3 | 2 | C | 步后注入 |
| `guard_feedback_*` (4变体) | 0.7-0.9 | 0.85 | 0.25 | 3 | C | 行为规则反馈（Phase37: minStepGap 0→3） |
| `feedback_positive` | 0.6 | 0.80 | 0.4 | 3 | S | 正向反馈 |
| `scene_memory_recall` | 0.8 | 0.88 | 0.3 | 3 | B | 场景记忆召回 |
| `step_code_ref_quality` | 0.5 | 0.85 | 0.4 | 2 | C | 代码质量参考 |
| `code_quality_feedback` | 0.7 | 0.85 | 0.35 | 2 | C | 代码质量反馈 |
| `truncation_recover_guard` | 0.7 | 0.85 | 0.35 | 2 | C | 截断恢复守卫 |
| ~~`system_trigger`~~ | — | — | — | — | — | **已删除** Phase38c（死代码，interception extraInterceptions通道替代） |
| `deviation_chain_intercept` | 1.20 | 0.90 | 0.3 | 3 | A | 偏差链拦截 |

> Phase37 (2026-07-11) 变体变更：新增 tool_result_recovery + decision_trace；stuck weight 1.0→0.6 + threshold 0.18→0.25 + decay 0.85→0.88；error-audit weight 0.8→0.5 + threshold 0.35→0.2 + minStepGap 2；guard_feedback minStepGap 0→3；persistent_summary 退役。

```typescript
export function getScore(variant: string, stepDelta: number): number {
  const meta = VARIANT_META[variant];
  if (!meta) return 0;
  return meta.weight * Math.pow(meta.decayPerStep, stepDelta);
}
```

公式: **R = W × D^Δs**

- W = 基础权重
- D = 衰减率
- Δs = 距上次注入的步数差

---

## 3. 残差注意力系统 (Residual Attention System)

> 别名：残差注意力 / 残差门控 / ResidualGate
> 对应代码：TokenBudgetManager, ResidualScheduler

残差注意力是其核心门控机制：每次注入后，同一变体的注意力残差随时间指数衰减。只有当残差值 **低于** threshold 时（R < T），代表该规则的记忆已足够淡化，才会允许再次注入。

### 全链路判定流程

```
VariantMeta.weight ← 基础权重
  ×
  decayPerStep ^ (currentStep - lastInjectedStep)
  = 残差 R
  < T (当前阈值)?
    → 注入（R 低于阈值，规则已被遗忘）
    ≥ T?
    → 跳过（R 仍在阈值之上，规则还在生效）
```

### 附加门控

1. **Dedup 门控** (skipped_dedup): 同一 step 内已注入过同一变体 → 跳过
2. **MinStepGap 门控**: Δs < minStepGap → 跳过
3. **perStepLimit 门控** (skipped_perStepLimit): 本步注入已达到上限 → 跳过

### 当前使用者

`variant-registry.ts` 共注册 **34 个变体**，分为 13 组。所有 injector 循环共享同一套残差系统，`shouldInjectByResidual()` 在各个注入阶段对所有变体计算残差分数。

| 变体组 | 包含变体数量 | 典型 weight | 典型 decayPerStep | 注入器覆盖 |
|--------|------------|-------------|-------------------|-----------|
| ~~`system_trigger`~~🗑️ | — | — | — | **已删除** Phase38c（extraInterceptions 通道替代） |
| `deviation_chain_intercept` | 1 | 1.20 | 0.90 | 偏差链检测 |
| `intent_*` | 6 | 0.50 | 0.50 | intent-injector.ts |
| `prepare_*` | 6 | 0.25 | 0.70 | 6 个注入器 |
| `post_*` | 6 | 0.20 | 0.50 | 6 个注入器 |
| `step_after_*` | 3 | 0.20 | 0.50 | 6 个注入器 |
| `guard_feedback_*` | 5 | 0.40 | 0.85 | 行为反馈 |
| `scene_memory_recall` | 1 | 0.50 | 0.80 | scene_memory |
| `step_code_ref_quality` | 1 | 0.30 | 0.80 | 代码质量 |
| `code_quality_feedback` | 1 | 0.30 | 0.80 | 代码质量 |
| `system_ref_stuck` | 1 | 0.50 | 0.85 | stuck.ts |
| `truncation_recover_guard` | 1 | 0.50 | 0.80 | 截断恢复 |
| `error-audit` | 1 | 0.80 | 0.85 | error-audit-injector.ts |

详情见 `variant-registry.ts:288-345`。

---

## 4. 注入管线 (Injection Pipeline)

> 别名：注入管线 / InjectionRouter
> 对应代码：InjectionManager (manager.ts), InjectionRouter (router.ts)

融合后架构分为两层：**InjectionManager（高层 API）** → **InjectionRouter（调度内核）**。

```
InjectionManager          ← 对外接口层（manager.ts）
  └─ InjectionRouter      ← 调度内核（router.ts）
       ├─ DynamicInjector × N  ← 注入器注册表
       └─ VariantScheduler     ← 残差调度
```

### 4.1 InjectionRouter 调度内核

定义于 `packages/agent-core/src/agent/injection/router.ts`（291 行，融合后新增）。

```typescript
export class InjectionRouter {
  private readonly injectors = new Map<string, DynamicInjector>();
  private readonly scheduler = new VariantScheduler();
  private readonly disabled = new Set<string>();
  private remainingBudget: number | undefined;

  /** 注册注入器 */
  register(id: string, injector: DynamicInjector): void;

  /** 注销注入器 */
  unregister(id: string): boolean;

  /** 主调度入口：遍历所有注册注入器，scheduler 过滤，按位置优先级排序，返回结果 */
  async dispatch(context: InjectContext): Promise<InjectResult[]>;

  /** 生命周期：context 清除 */
  onContextClear(): void;

  /** 生命周期：context 压缩后重建注入器状态 */
  onContextCompacted(compactedCount: number): void;

  /** 生命周期：消息被移除时通知注入器 */
  onContextMessageRemoved(index: number): void;

  /** 运行时停用指定注入器 */
  disable(id: string): this;

  /** 运行时启用指定注入器 */
  enable(id: string): this;

  /** 查询注入器是否被禁用 */
  isDisabled(id: string): boolean;

  /** 获取所有被禁用 ID */
  getDisabledList(): string[];

  /** 获取注入器注册/禁用统计 */
  getStats(): { registered: number; disabled: string[]; active: string[]; injectedThisConversation: number };

  /** 设置 token 预算 */
  setBudget(budget: number | undefined): void;
}
```

**调度流程**:

```
InjectionRouter.dispatch(context)
  ├─ 遍历所有注册 injectors（按 priority 排序）
  │   ├─ 跳过 disabled 注入器
  │   ├─ getResidualConfig() 获取残差配置
  │   ├─ residualCfg === undefined → 跳过残差检查 + 预算过滤（Phase38j 已消除全部 bypass）
  │   ├─ residualCfg !== undefined → scheduler.shouldInject(id, context) → 残差过滤
  │   ├─ getCacheGroup(id) → 分组缓存管理
  │   ├─ injector.inject(context) → 实际生成注入内容（存入 _lastInjectContext）
  │   ├─ scheduler.record(id, enabledVariants) → 调度记录
  │   └─ tokenBudgetCheck(residualCfg) → 预算过滤（residualCfg===undefined 时跳过）
  ├─ 按位置优先级排序（getPositionPriorityBoost）
  └─ 返回排序后的 InjectResult[]
```

**缓存诊断**: `dispatch()` 末尾保存本轮注入结果到 `_lastInjectResults`，通过 `getLastInjectResults(): InjectResult[]` 暴露。`turn/index.ts:afterStep` 读取后传入 `buildAuditEntry` 写入审计日志。

**路径 B 迁移**: `turn/injectors/{stuck,anti_confabulation,quality,intent}.ts` 已删除。四个功能均包装为 DynamicInjector 子类注册于 `injection/` 目录。Phase38c/e/j 逐步消除 bypass：QualityInjector 已删除（由 qualityDegradeDetector 替代），anti_confabulation 已删除（由 confabulationDetector 替代）。详见 `ZHU/DECISIONS/方案-注入系统三路径统一设计.md`。

### 4.2 InjectionManager 接口

定义于 `packages/agent-core/src/agent/injection/manager.ts`（融合后重写）。InjectionManager 包裹 InjectionRouter，提供高层 API：

```typescript
export class InjectionManager {
  /** 注入一条系统提醒（入口调用，委托 router.dispatch） */
  inject(text: string, meta: Record<string, unknown>, budgetKey?: string): void;

  /** 获取内部 router 实例（供 turn/index.ts:1659 记录注入统计） */
  getRouter(): InjectionRouter;

  /** 清空注入器状态（委托 router.onContextClear） */
  onContextClear(): void;

  /** 压缩后重建注入器状态（委托 router.onContextCompacted） */
  onContextCompacted(compact: (text: string, meta: Record<string, unknown>) => void): void;

  // ── 变体残差调度 ─────────────────────────────

  canInject(variant: string, currentStep: number): boolean;
  getInjectionCount(variant: string): number;
  afterInject(variant: string, currentStep: number): void;
  resetForTurn(): void;
}
```

### 4.3 CacheGroup 分类

`router.ts:28-38` 将注入器 ID 分组，用于缓存管理（同组共享冷却）：

| 分组 | 注入器 ID | 清理策略 |
|------|----------|---------|
| `core` | plugin-session-start, plan-mode, permission-mode | 首次注入后缓存 |
| `context` | wolfpack, goal, working-set | 生命周期事件后刷新 |
| `feedback` | user-prefs, guard-feedback | 每轮评估 |
| `audit` | error-audit | 每轮评估 |
| `default` | 其他（todo-list, stuck, confabulation, quality, intent） | 临时缓存 |

### 4.4 注入占位符白名单

定义于 `packages/agent-core/src/agent/context/prefix-stabilizer.ts`。

`INJECTION_PLACEHOLDER_ALLOWLIST` 控制哪些模板变量允许出现在注入内容中：

```typescript
export const INJECTION_PLACEHOLDER_ALLOWLIST = [
  '{{timestamp}}', '{{uuid}}', '{{filePath}}',
  '{{cwd}}', '{{sessionId}}', '{{toolName}}', '{{toolResult}}',
];
```

白名单之外的占位符（如 `{{userMessage}}`、`{{agentResponse}}`）不会被 `prefixStabilizer.cleanInjection` 保留，可防止注入敏感/动态变量的越权访问。

### 4.5 注入日志

每次注入/跳过都会通过 `recordVariantLog` 记录到 `拦截日志` 中，格式：

```
variant_injected: [variant_name] Injected variant (lv=X)
variant_skipped/skipped_residual: [variant_name] R≥T for variant_name
variant_skipped/skipped_dedup: [variant_name] Dedup skip: variant already injected this step
variant_skipped/skipped_budget: [variant_name] Budget denies variant (budget info)
```

### 4.6 与 TurnFlow 的集成

```
TurnFlow.composeContextMessages()
  ├─ InjectionManager.inject() ← 入口调用（manager.ts）
  │    └─ InjectionRouter.dispatch() ← 调度所有注册注入器
  │         ├─ shouldInject() ← 残差过滤
  │         ├─ 各 injector.getInjection() ← 实际生成
  │         └─ recordInjection() ← 同步统计
  ├─ 合并 systemReminders + injected messages
  └─ 传递到 context()

TurnFlow.handleAfterStep()  ← 本轮工具调用后
  ├─ detectConfabulation()  ← 反事实检测（拦截仍在收敛门）
  ├─ runQualityDetection() → qualityIssue  ← 质量偏差检测（返回 QDetectionResult | null）
  ├─ injection.inject({stuckContext, confabulationResult, qualitySignals})  ← Step 6：统一注入管线
  │    └─ 通过 _lastInjectContext 传递给 StuckInjector / IntentInjector
  ├─ shouldContinueAfterStop()  ← 收敛门（含 confaBlocked 硬拦截）
  └─ 重置 step 级计数器
```

---

## 5. 注入预算 (Injection Budget)

每步注入受预算限制，避免单步过度注入。

### 预算规则

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxInjectionsPerStep` | 3 | 每步最多注入的系统提醒数量 |
| `budgetKey` | `'turn'` | 预算键值，同一 key 共享预算 |

### 预算耗尽行为

当 `stepInjectionBudget <= 0` 时，所有新的注入请求都会被跳过，日志记录 `skipped_budget`。

---

## 6. 注入器清单 (Injector Catalog)

> 别名：注入器列表 / DynamicInjector 清单
> 对应代码：DynamicInjector (injection/injector.ts) + 15 个注册子类

### 当前注入器

| 文件 | 变体名 | 位置 | 等级 | 触发条件 | 注册 |
|------|--------|------|------|---------|------|
| `user-prefs.ts` | `user_prefs` | AFTER_SYSTEM | S | 每轮 | ✅ |
| `decision-trace.ts` 🆕 | `decision_trace` | AFTER_SYSTEM | B | ILR>0.6 + step=1 | ✅ |
| `intent-injector.ts` | `intent_guidance` | AFTER_SYSTEM | A/B | 意图检测命中 | ✅ |
| `plan-mode.ts` | `plan_mode` | AFTER_SYSTEM | B | 计划模式 step | ✅ |
| `permission-mode.ts` | `permission_mode` | AFTER_SYSTEM | A/B | 权限模式切换 | ✅ |
| `working-set.ts` | `working_set` | MID_CONTEXT | B/C | working set 变化 | ✅ |
| `error-audit-injector.ts` | `error-audit` | MID_CONTEXT | B | FAA 趋势检测（超时死循环/耗时膨胀）**分析瘫痪已砍** | ✅ |
| `goal.ts` | `goal` | MID_CONTEXT | C | 计划模式 step | ✅ |
| `todo-list.ts` | `todo_list` | MID_CONTEXT | C | todo 列表变化 | ✅ |
| `session-summary.ts` 🆕 | `session_summary` | MID_CONTEXT | B | step=1 / compaction 后 | ✅ |
| `tool-result-recovery.ts` 🆕 | `tool_result_recovery` | MID_CONTEXT | B | ILR>0.3 + hasHighValue | ✅ |
| `wolfpack.ts` | `wolfpack` | MID_CONTEXT | C | WolfPack 调用 | ✅ |
| `plugin-session-start.ts` | `plugin_session_start` | MID_CONTEXT | C | 插件会话启动 | ✅ |
| ~~`anti_confabulation.ts`~~ 🗑️ | ~~`system_ref_anti_confabulation`~~ | — | — | — | ❌ | **已删除** Phase38c（合并入 confabulationDetector） |
| ~~`quality.ts`~~ 🗑️ | ~~`quality_escalate`~~ | ~~AFTER_TOOL_CALL~~ | — | — | ❌ | **已删除** Phase38j（由 qualityDegradeDetector 替代） |
| `stuck.ts` | `system_ref_stuck` | AFTER_TOOL_CALL | D | 同文件编辑≥3 / 同工具报错≥2（weight 30→0.6） | ✅ |
| `guard-injector.ts` | `guard-feedback` | AFTER_TOOL_CALL | C | **Phase38j 精简为仅 R1 阻断**（R2/R3/R4 由 permissionEnforcerDetector 接管） | ✅ |

> **注册总数**: 15 个。`guard-injector.ts` GuardInjector 已注册并通过统一管线调度。
> Phase37 (2026-07-11) 新增：DecisionTraceInjector（决策链）、ToolResultRecoveryInjector（工具恢复）、SessionSummaryInjector（会话摘要）。
> 迁移历程：v0.8.4 Phase 22 — 路径 B（4 个硬编码注入函数 stash/anti_confabulation/quality/intent）全部迁入路径 A（DynamicInjector 管线）。`turn/injectors/` 中旧版硬编码文件已删除。

### DynamicInjector 基类

所有注入器继承 `packages/agent-core/src/agent/injection/injector.ts` 的 `DynamicInjector`：

```typescript
export abstract class DynamicInjector {
  protected abstract injectionVariant: string;
  constructor(protected agent: Agent) {}

  /** 子类实现：生成注入内容，返回 undefined 则不注入 */
  protected abstract getInjection(): string | string[] | undefined;

  /** 默认位置：AFTER_TOOL_CALL */
  getTargetPosition(): InsertPosition { ... }

  /** 生命周期回调 */
  onContextClear(): void {}
  onContextCompacted(compactedCount: number): void {}
  onContextRemoved(index: number): void {}
  /** 可在子类中接收 InjectContext */
  inject(context: InjectContext): Promise<string | string[] | undefined>;
}
```

### GuardInjector（迁移完成 — 已走统一注入管线）

定义于 `packages/agent-core/src/agent/injection/guard-injector.ts`（新版，功能完整）。

- `injectionVariant`: `'guard-feedback'`
- 注册状态: ✅ 已注册 `manager.ts` → `router.register('guard-feedback', guardInjector)`
- 位置等级: C（AFTER_TOOL_CALL）
- 数据流:
  1. `turn/index.ts:runGuardDetection()` 调用 `guard-injector.ts:checkGuard()`
  2. Rule 2/3/4 观察结果 → `guardInjector.setGuardData(rule, feedback)`
  3. 下一轮 `injection.inject()` → `router.dispatch()` → `GuardInjector.getInjection()`
  4. 走统一残差/配额/去重管线
- Rule 1 (block) 不走此注入器 — 它设 `confabulationBlocked` 标记控制流程
- `beforeStep` 调 `clearGuardData()` 清除上一轮残留
- `collectConfabulationBlockReason` 读 `lastFeedback` 获取最近的反馈文本

### ErrorAuditInjector（Phase33 FAA Regeneration）

定义于 `packages/agent-core/src/agent/injection/error-audit-injector.ts`（165 行，Phase33 FAA Regeneration 替换）。

- `injectionVariant`: `'error-audit'`
- 注入位置: `MID_CONTEXT`（B 级）
- 注册 ID: `'error-audit'`
- 数据源: `agent.fileActionAudit.getRecentEntries(10)`（FAA 全量操作记录，最新 10 条）
- 触发条件（2 支柱，顺序执行，最多触发 1 条）:
  1. **超时死循环（P0）**: Bash 连续 ≥2 次失败且 `durationMs > 30_000ms` → `FATAL|TIMEOUT`
  2. **耗时膨胀（P0）**: 同工具类型最新耗时 > 均值 ×1.5（仅支柱一未命中时） → `WARN|INFLATE`
  ~~3. 分析瘫痪（已删除 Phase37）~~
- 注入格式: AI 原生 3 行定长（AI 50ms 解析）→ `PREFIX|CAT|key=val\nROOT|根因\nACT|opt1|opt2|opt3`
- Context Facts: 命中时调用 `recordFact('error-audit', ..., 'error')`
- VARIANT_META: `{ weight: 0.5, decayPerStep: 0.85, threshold: 0.2, minStepGap: 2 }`
- **运行时接线**: 需要 `agent.fileActionAudit` 实例在 agent 构造时注入，框架已就绪

### 注入器注册管理

所有注入器在 `manager.ts` 构造函数中通过 `InjectionRouter.register(id, injector)` 批量注册（实际代码 `manager.ts:22-48`）：

```typescript
const injectors: [string, DynamicInjector][] = [
  ['plugin-session-start', new PluginSessionStartInjector(agent)],
  ['wolfpack', new WolfPackInjector(agent)],
  ['plan-mode', new PlanModeInjector(agent)],
  ['permission-mode', new PermissionModeInjector(agent)],
  ['todo-list', new TodoListInjector(agent)],
  ['goal', new GoalInjector(agent)],
  ['working-set', new WorkingSetInjector(agent)],
  ['user-prefs', new UserPrefsInjector(agent)],
  ['system_ref_stuck', new StuckInjector()],
  ['anti_confabulation', new AntiConfabulationInjector()], // Phase38c 已删除；由 confabulationDetector 替代
  ['quality_escalate', new QualityInjector()], // Phase38j 已删除；此处为历史参考
  ['intent_guidance', new IntentGuidanceInjector(agent)],
  ['error-audit', new ErrorAuditInjector(agent)],
  ['guard-feedback', this.guardInjector],
  ['session-summary', new SessionSummaryInjector(agent)],
  ['tool-result-recovery', new ToolResultRecoveryInjector(agent)],
  ['decision-trace', new DecisionTraceInjector(agent)],
];
injectors.forEach(([id, inj]) => this.router.register(id, inj));
```

> **注册总数**: 15 个。Phase37 (2026-07-11) 新增：DecisionTraceInjector（决策链）、SessionSummaryInjector（会话摘要）。ToolResultRecoveryInjector 未注册（死代码保留但无注册）。
> Phase37 调整：stuck weight=30→0.6 + context.history 替代 stuckContext | guard-injector minStepGap=0→3 | error-audit 删分析瘫痪支柱 | ILR 数据驱动优化。

### 运行时停用/启用

通过 `InjectionRouter.disable(id)` / `enable(id)` 链式 API 运行时控制：

```typescript
// 禁用 error-audit 注入器
agent.injection.getRouter().disable('error-audit');
// 重新启用
agent.injection.getRouter().enable('error-audit');
```

### 增量摘要注入（Phase36 已接入统一管线）

**变更记录**：

| 阶段 | 状态 | 说明 |
|------|------|------|
| Phase23-34 | ❌ 绕过管线 | 直接 `appendSystemReminder()`，不走 dispatch |
| Phase35 | ❌ 临时切断 | 因 user 连续 400 注释调用 |
| **Phase36** | ✅ **接入统一管线** | 新建 `SessionSummaryInjector` + `PersistentSummaryInjector`，走 `InjectionRouter` 6 道门 |

**实现**：

- `session-summary.ts` — `SessionSummaryInjector`：`getInjection()` 返回 `agent.sessionMemory.getSessionSummary()`，在 step1 或 compaction 后触发
- `persistent-summary.ts` — `PersistentSummaryInjector`：基于 ILR（Information Loss Ratio）在 `computeILR(history) > 0` 时注入结构化摘要
- 注册于 `manager.ts:30-49` 的 `injectors` 数组，与 15 个既有注入器共享 `maxInjectionsPerStep=3` 预算
- 不再绕过 S/A/B/C/D 分级系统、残差调度、预算控制
- 不再有专门的 `removeSystemRemindersByPrefix('[summary]')` 清理（由调度系统自动管理）

**触发条件**：

| 注入器 | 触发 | 频率管控 |
|--------|------|---------|
| `session-summary` | step===1 或 compaction 后 | 受残差调度 + 预算限制 |
| `persistent-summary` | ILR > 0（有信息被 mask） | 受残差调度 + 预算限制 |

### 截断数据自动恢复（TruncationTracker，Phase24.2）— 🗑️ Micro/ArchiveRecover 已废弃

> **v3 废弃说明**：TruncationTracker 原依赖 Micro Compaction 存档 + ArchiveRecover 工具取回。
> Micro Compaction 已废弃（ROI 负）、ArchiveRecover 已注销注册。
> 截断数据自动恢复功能**不再由本管线承担**——由蒸馏塔保真层（错误不遮）+ 归档层（结构化摘要尾部 append）替代。

定义于 `turn/index.ts` 的 `turnTruncation`（`TruncationTracker` 实例），截断数据显示恢复（`turn/index.ts:1094-1126`）。

**触发时机**：每一步工具调用前（`beforeToolExecution`）：

```
TurnFlow.turnTruncation.hasUnrecovered() && currentStep > 1
  → contentArchive.recover(key) 自动取回
  → 取回内容（>200 token 截断预览）注入到 context
  → 变体：truncation_recover_guard
```

- **兜底提醒**：自动恢复失败时的消息提示（`turn/index.ts:1734-1741`）
- **退路**：ArchiveRecover tool（已废弃 v3，注销注册）
- **变体**：`truncation_recover_guard`（仍注册，不走残差管线，直接尾部 append）
- **Position**：`AFTER_TOOL_CALL`（尾部）

**v3 变更**：Micro Compaction（存档源）和 ArchiveRecover（取回工具）已在 `cache-stable-v1` 中废弃。
截断数据自动恢复的功能由蒸馏塔保真层（错误不遮）+ 归档层（结构化摘要尾部 append）替代。
`truncation_recover_guard` 当前仅作为兜底——正常运行时不触发。

### 预留注入器（Phase22 规划）

| 注入器 | 变体 | 等级 | 作用 | 状态 |
|--------|------|------|------|------|
| `injection/facts.ts` | `injector_facts` | C/D | 将注入器状态暴露为结构化 flat facts 给 AI | ⏸️ 未实现 |

---

## 7. 自适应调度 (Adaptive Scheduling) — v2（取代旧配额系统）

定义于 `variant-registry.ts` 的 `VariantScheduler`。自 v0.6.10+ 起取代了旧版 QUOTA_TABLE（配额系统已完全移除）。

### 核心公式

```
R = W × D^Δs           ← 残差
触发条件: Δs ≥ minStepGap 且 R < T
注入后: T = T × thresholdDecay   ← 阈值衰减（防脱敏）
```

- **W**: 基础权重 — 越大覆盖轮次越广
- **D**: 衰减率 — D<1 指数衰减，越大衰减越慢（覆盖更久）
- **T**: 当前阈值 — R 低于 T 才触发，每次注入后降低
- **thresholdDecay**: 阈值衰减系数（初定 0.65）
- **minStepGap**: 硬性最短间隔

### 防脱敏机制（无 quota 硬上限）

不再有 `maxPerConversation / cooldownSteps` 硬上限。防脱敏靠三要素自然配合：

| 机制 | 作用 | 效果 |
|------|------|------|
| 残差衰减 R = W × D^Δs | 每次注入后 R 重置为 W，逐渐衰减到 T 以下才再触 | 自然间隔 ~15-22 步 |
| 阈值衰减 T = T × thresholdDecay | 每次注入后 T 降低 | 第 2 次间隔拉长到 ~22 步，第 3 次 ~30+ |
| minStepGap | 硬性最短步数 | 防止连续步数刷屏 |

同一变体在整场 session 自动「密集→渐疏→极疏」，不会脱敏。

### VariantScheduler 接口

```typescript
export class VariantScheduler {
  shouldInject(variant: string, currentStep: number): boolean;
  record(variant: string, currentStep: number): void;
  getInjectionCount(variant: string): number;
  reset(): void;
}
```

### 运行流程

```
TurnFlow.inject(variant, text)
  → InjectionManager.canInject(variant, currentStep)
    → VariantScheduler.shouldInject(variant, currentStep)
      → ① Δs ≥ minStepGap?  ← 硬性最短间隔
      → ② R < T?             ← 残差低于当前阈值
    ↓ 不满足 → 跳过，记录 skipped_residual / skipped_minStep
    ↓ 满足   → 继续注入 + afterInject(variant, step)
      → VariantScheduler.record(variant, currentStep)
        → T = T × thresholdDecay  ← 阈值衰减
  ↓ 回合结束
TurnFlow.resetForTurn()
  → InjectionManager.resetForTurn()
    → VariantScheduler.reset()
      → T 恢复 T₀
```

---

## 8. 集成流程总图（融合后）

```
┌─────────────────────────────────────────────────────────────────┐
│                    TurnFlow.composeContextMessages()              │
│  ┌─────────────────────┐      ┌────────────────────────────┐   │
│  │ InjectionRouter      │      │ 原有 Reminder Injection   │   │
│  │ dispatch(context)    │      │  (system提醒硬编码注入)   │   │
│  │                     │      │                            │   │
│  │ ├─ scheduler过滤    │      └────────────────────────────┘   │
│  │ ├─ guard-feedback   │                  │                   │
│  │ ├─ error-audit      │                  │                   │
│  │ ├─ 其余 10 注入器   │                  │                   │
│  │ └─ 按位置优先级排序 │                  │                   │
│  └─────────┬───────────┘                  │                   │
│            │                              │                   │
│            ▼                              ▼                   │
│  ┌────────────────────────────────────────────────────────┐   │
│  │              ContextMessage[] (merged)                  │   │
│  └────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────────┐
│                     afterStep (本轮工具调用后)                     │
│  ┌────────────────┐   ┌────────────┐   ┌─────────────────────┐  │
│  │ facts          │   │ update     │   │ router.record       │  │
│  │ collection     │   │ stuck hist │   │ Injection(variant,  │  │
│  │ (collectFacts) │   │            │   │   step) — Step 6:   │  │
│  │                │   │            │   │   统一注入监控入口  │  │
│  └────────────────┘   └────────────┘   └─────────────────────┘  │
│                     ┌─────────────────────────────┐             │
│                     │ scheduler state update      │             │
│                     │ (VariantScheduler.record()) │             │
│                     └─────────────────────────────┘             │
└─────────────────────────────────────────────────────────────────┘
```

---

## § Context Facts 尾部聚合 (Phase B') [P3]

### 问题 [P3]

B 级注入器（error-audit、working-set、goal、todo-list、wolfpack、plugin-session-start）名义上设计为 `MID_CONTEXT` 位置，但实际代码中（`injector.ts:121-123`）`else` 分支不区分 `MID_CONTEXT` 和 `AFTER_TOOL_CALL`，全部调用 `appendSystemReminder()` → **全在尾部**。多个注入器在尾部形成 3-8 个独立碎片块，AI 在尾部需要多次扫描。

### 方案 [P3]

所有注入器通过 `recordFact(key, value, level)` 将关键状态写入 ContextMemory 的 `_contextFacts` Map。`router.dispatch()` 之后由 `manager.inject()` 统一调用 `flushContextFacts()` 格式化为 `[Context Facts]` 结构化块，通过 `appendSystemReminder()` 追加到尾部。

```
[Context Facts]
  ⚠ error-audit:  检测到连续超时
  • goal:         [active] Phase B' implementation
    working-set:  src/main.ts, src/utils/
```

#### 改动文件

- `context/index.ts`: 新增 `recordFact()` / `flushContextFacts()`（+27 行）
- `manager.ts`: `inject()` 在 dispatch 后调用 `flushContextFacts()`（+12 行，含 try/finally 异常保障）
- `error-audit-injector.ts`: 新增 `recordFact?.()`（+7 行，error 级别）
- `working-set.ts`: 新增 `recordFact?.()`（+7 行，info 级别）
- `goal.ts`: 新增 `recordFact?.()`（+11 行，含 status + objective 截断）
- `todo-list.ts`: 新增 `recordFact?.()`（+12 行，含完成进度）
- `wolfpack.ts`: 新增 `recordFact?.() 2 处（+4 行，状态切换）
- `plugin-session-start.ts`: 新增 `recordFact?.()`（+5 行，技能激活）
- `guard-injector.ts`: 新增 `recordFact?.()`（+13 行，规则触发，warn 级别）

所有 `recordFact` 调用使用可选链 `?.()`，确保 mock 环境不崩溃。

### 关键数据 [P3]

审计日志 2718 条记录实证：
- 稳定段（turn>10，排除 compaction）平均命中率 **98.13%**
- B 级注入器已在尾部（`appendSystemReminder`），内容变化不降低命中率（98.39% vs 98.16% 基线）
- 当前活跃 B 注入器仅 `error-audit`(24.1%)，其他 5 个零触发

### Phase M: 内容哈希测量埋点 [P3]

`DynamicInjector` 基类新增 `_lastContentHash` 属性 + `getLastContentHash()` 访问器。注入成功时记录 `simpleHash(injection)`，不注入时清空为 `null`。`InjectResult` 新增 `contentHash?: string` 可选字段。router dispatch 在成功/失败分支都注入 contentHash。

目的：为后续缓存命中率分析提供注入级数据支撑。

相关文件: `injector.ts`（+8 行）、`router.ts`（+4 行，3 处 dispatch 注入）

---

> **相关文件**: `SYSTEM-INDEX.md` (索引链入口) | `SYSTEM/API-REFERENCE.md` (接口定义) | `SYSTEM/architecture-overview.md` (架构总图) | `ZHU/DECISIONS/INDEX.md` (决策历史) | `ZHU/DECISIONS/ADR-7-注入位置优化与尾部聚合策略.md` (ADR)

### 融合计划落地状态

参照 `ZHU/DECISIONS/执行计划-注入系统融合执行计划.md`，当前融合实施状态：

| 阶段 | 文件 | 状态 |
|------|------|------|
| Step 0: 基础白名单 + 位置常量扩展 | `prefix-stabilizer.ts` / `position-strategy.ts` / `injection-system.md` | ✅ 完成 |
| Step 1: InjectionRouter 核心 | `router.ts`（291 行） | ✅ 完成 |
| Step 2: VariantScheduler 迁移入 Router | `router.ts` 内建 scheduler | ✅ 完成 |
| Step 3: PositionStrategy 标准化 | `position-strategy.ts`（112 行） | ✅ 完成 |
| Step 4: GuardInjector | `guard-injector.ts`（新版实现） | ✅ 完成（Phase33，统一管线） |
| Step 5: ErrorAuditInjector | `error-audit-injector.ts`（165 行，Phase33 2-Pillar） | ✅ 完成 |
| Step 6: inject() → router 记录同步（修正版） | `manager.ts` / `turn/index.ts:1659` | ✅ 完成 |
| Step 7: TokenBudget 过滤接口 | `router.ts` | ✅ 完成 |
| Step 8: Guard/Injector 边界清理 | 审计确认（0 文件改动） | ✅ 完成 |
| Step 9: disable/enable 链式 API | `router.ts` | ✅ 完成 |
| Step 10: ErrorAuditInjector 注册 | `manager.ts` | ✅ 完成（Phase30） |
| Step 11a: CacheGroup 分类 | `router.ts`（5 组） | ✅ 完成 |
| Step 11b: 双指数残差 | 待运行时基线数据 | ⏸️ 暂缓 |
| **Phase B': Context Facts 尾部聚合** | 7 个注入器 + `context/index.ts` | ✅ 完成 (2026-07-10) |
| **Phase M: 内容哈希测量埋点** | `injector.ts` / `router.ts` | ✅ 完成 (2026-07-10) |
| **Phase33: FAA Regeneration** | `error-audit-injector.ts` → 2-Pillar 趋势检测 | ✅ 完成 (2026-07-10) |

### archival_summary —— 归档层注入器（v3 新增）
- variant: archival_summary
- 类: ArchivalSummaryInjector extends DynamicInjector
- 位置: AFTER_TOOL_CALL（尾部 append，不碰缓存前缀）
- 触发: <50K 不触发 / 50K-100K 每3轮 / >100K 每轮
- 注册: injection/manager.ts
- 文件: injection/archival-summary.ts
- 取代: ActiveSummaryInjector (23行表格 head insert) → 废弃
