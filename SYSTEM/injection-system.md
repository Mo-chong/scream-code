---
tags: [type/reference, domain/injection, status/final]
keywords: [注入, injection, DynamicInjector, 残差, residual, 变体, variant]
updated: 2026-07-08
---

<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
# 注入系统 / Injection System [P0]

> **参见：** [`architecture-overview.md`](architecture-overview.md)（架构全景） | [`turn-control.md`](turn-control.md)（回合调度） | [`attention-management.md`](attention-management.md)（注意力分配） | [`API-REFERENCE.md`](API-REFERENCE.md)（接口签名） | [`pitfalls.md`](pitfalls.md)（踩坑记录）
>
> 指令权重体系、变体注册表、残差注意力门控、注入管线与预算系统。
> 14 个 DynamicInjector（路径 A 原生 11 个 + 路径 B 迁移 2 个 + GuardInjector 接管）。
> 路径 B 已清零（Phase22，2026-07-08）。详见 ZHU/DECISIONS/方案-注入系统三路径统一设计.md。
> 路径 C (GuardInjector) 已完成迁移（Phase33，2026-07-10）— 注册并走统一注入管线。

---

## 1. 指令权重体系 (Instruction Weight System)

指令权重分为五级 `S/A/B/C/D`，定义注入的**不可跳过性优先级**。

### 分级定义

| 等级 | 名称 | 语义 | 永不跳过 | compaction 保护 | 示例变体 |
|------|------|------|---------|----------------|---------|
| **S** | System | 系统级约束，必须始终呈现 | ✅ 绝对 | ✅ 永不压缩 | `intent_fix_bug`, `session_memory`, `feedback_positive`, `feedback_negative` |
| **A** | Advanced | 高级行为规则 | ✅ 绝对（除非预算耗尽） | ✅ 永不压缩 | `prepare_bash_file`, `post_edit` |
| **B** | Behavioral | 中级行为规则 | ❌ 残差衰减后可跳过 | ❌ | `guard_rule_3`, `guard_feedback_rule_3` |
| **C** | Common | 普通信息提示 | ❌ 残差衰减后可跳过 | ❌ | `anti_confabulation`, `intent_summarize` |
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
| `system_ref_stuck` | 1.0 | 0.85 | 0.18 | 3 | D | 痛点感知：检测 AI 钻牛角尖后注入文档导航 |

### 残差衰减函数

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
| `system_trigger` | 1 | 0.15 | 0.95 | 系统触发 |
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
| `error-audit` | 1 | 0.50 | 0.80 | error-audit-injector.ts |

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
  │   ├─ residualCfg === undefined → 跳过残差检查 + 预算过滤（如 QualityInjector）
  │   ├─ residualCfg !== undefined → scheduler.shouldInject(id, context) → 残差过滤
  │   ├─ getCacheGroup(id) → 分组缓存管理
  │   ├─ injector.inject(context) → 实际生成注入内容（存入 _lastInjectContext）
  │   ├─ scheduler.record(id, enabledVariants) → 调度记录
  │   └─ tokenBudgetCheck(residualCfg) → 预算过滤（residualCfg===undefined 时跳过）
  ├─ 按位置优先级排序（getPositionPriorityBoost）
  └─ 返回排序后的 InjectResult[]
```

**缓存诊断**: `dispatch()` 末尾保存本轮注入结果到 `_lastInjectResults`，通过 `getLastInjectResults(): InjectResult[]` 暴露。`turn/index.ts:afterStep` 读取后传入 `buildAuditEntry` 写入审计日志。

**路径 B 迁移**: `turn/injectors/{stuck,anti_confabulation,quality,intent}.ts` 已删除。四个功能均包装为 DynamicInjector 子类注册于 `injection/` 目录。getResidualConfig() 返回 undefined 的注入器（QualityInjector）绕过预算检查。详见 `ZHU/DECISIONS/方案-注入系统三路径统一设计.md`。

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
  │    └─ 通过 _lastInjectContext 传递给 StuckInjector / AntiConfabulationInjector / QualityInjector
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
> 对应代码：DynamicInjector (injection/injector.ts) + 14 个子类（14 注册）

### 当前注入器

| 文件 | 变体名 | 位置 | 等级 | 触发条件 | 注册 |
|------|--------|------|------|---------|------|
| `user-prefs.ts` | `user_prefs` | AFTER_SYSTEM | S | 每轮 | ✅ |
| `intent-injector.ts` | `intent_guidance` | AFTER_SYSTEM | A/B | 意图检测命中 | ✅ |
| `plan-mode.ts` | `plan_mode` | AFTER_SYSTEM | B | 计划模式 step | ✅ |
| `permission-mode.ts` | `permission_mode` | AFTER_SYSTEM | A/B | 权限模式切换 | ✅ |
| `working-set.ts` | `working_set` | MID_CONTEXT | B/C | working set 变化 | ✅ |
| `error-audit-injector.ts` | `error-audit` | MID_CONTEXT | B | 最近 5 条有失败 | ✅ |
| `goal.ts` | `goal` | MID_CONTEXT | C | 计划模式 step | ✅ |
| `todo-list.ts` | `todo_list` | MID_CONTEXT | C | todo 列表变化 | ✅ |
| `wolfpack.ts` | `wolfpack` | MID_CONTEXT | C | WolfPack 调用 | ✅ |
| `plugin-session-start.ts` | `plugin_session_start` | MID_CONTEXT | C | 插件会话启动 | ✅ |
| `anti_confabulation.ts` | `system_ref_anti_confabulation` | AFTER_TOOL_CALL | C | ConfabulationDetector ≥2 | ✅ |
| `quality.ts` | `quality_escalate` | AFTER_TOOL_CALL | —(跳过 budget) | QualityDetector 信号 | ✅ |
| `stuck.ts` | `system_ref_stuck` | AFTER_TOOL_CALL | D | 同文件编辑≥3 / 同工具报错≥2 | ✅ |
| `guard-injector.ts` | `guard-feedback` | AFTER_TOOL_CALL | C | checkGuard Rule 2/3/4 观察 | ✅ |

> **注册总数**: 14 个。`guard-injector.ts` GuardInjector 已注册并通过统一管线调度。
> `memory-rules.ts` 不存在——早期概念文件，代码仓库中无对应源文件。
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
  1. `turn/index.ts:runGuardDetection()` 调用 `guard-engine.ts:checkGuard()`
  2. Rule 2/3/4 观察结果 → `guardInjector.setGuardData(rule, feedback)`
  3. 下一轮 `injection.inject()` → `router.dispatch()` → `GuardInjector.getInjection()`
  4. 走统一残差/配额/去重管线
- Rule 1 (block) 不走此注入器 — 它设 `confabulationBlocked` 标记控制流程
- `beforeStep` 调 `clearGuardData()` 清除上一轮残留
- `collectConfabulationBlockReason` 读 `lastFeedback` 获取最近的反馈文本

### ErrorAuditInjector（融合新增）

定义于 `packages/agent-core/src/agent/injection/error-audit-injector.ts`（43 行，融合新增）。

- `injectionVariant`: `'error-audit'`
- 触发条件: `agent.fileActionAudit.getRecentEntries(5)` 中有失败记录
- 注入内容: 最近失败的文件操作审计摘要
- 位置等级: B（MEDIUM，MID_CONTEXT）
- 注册 ID: `'error-audit'`
- **运行时接线**: 需要 `agent.fileActionAudit` 实例在 agent 构造时注入，框架已就绪

### ErrorAuditInjector（融合新增）

定义于 `packages/agent-core/src/agent/injection/error-audit-injector.ts`（43 行，融合新增）。

- `injectionVariant`: `'error-audit'`
- 触发条件: `agent.fileActionAudit.getRecentEntries(5)` 中有失败记录
- 注入内容: 最近失败的文件操作审计摘要
- 位置等级: B（MEDIUM，MID_CONTEXT）
- 注册 ID: `'error-audit'`
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
  ['anti_confabulation', new AntiConfabulationInjector()],
  ['quality_escalate', new QualityInjector()],
  ['intent_guidance', new IntentGuidanceInjector(agent)],
  ['error-audit', new ErrorAuditInjector(agent)],
];
injectors.forEach(([id, inj]) => this.router.register(id, inj));
```

> **注意**: `guard-injector.ts`（GuardInjector）已在 `manager.ts` 注册，通过统一管线调度。

### 运行时停用/启用

通过 `InjectionRouter.disable(id)` / `enable(id)` 链式 API 运行时控制：

```typescript
// 禁用 error-audit 注入器
agent.injection.getRouter().disable('error-audit');
// 重新启用
agent.injection.getRouter().enable('error-audit');
```

### 增量摘要注入（不经过本管线）

**增量 LLM 摘要**（`compaction/summary.ts` + `turn/index.ts:updatePersistentSummary()`）：

- 走 `kind: 'injection'` → `appendSystemReminder()` → 消息尾部
- **完全绕过** S/A/B/C/D 分级系统、残差调度、InjectionRouter 管线
- 触发时机：每轮结束、上轮 ≥ 8 步时 → beforeStep 注入（不干扰工具调用）
- 改用 `lastTurnStepCount` 字段记录上轮步数（废弃 `totalSteps` 固定步数硬切）
- 尾部内容变化不影响 KV cache 前缀 → 不影响 97.41% 缓存命中率
- 不注册变体、不走 `shouldInjectByResidual()`、不受预算控制
- 每次注入前 `removeSystemRemindersByPrefix('[summary]')` 清理旧摘要防沉积
- 成本：~$0.0004/次、~$0.02/天（3756 步/天真实数据）

**为什么不在本系统内**：摘要是"上轮决策链的即时快照"，不是"根据残差衰减决定是否注入的变体"。残差系统是为重复提醒设计的（衰减→再提醒），摘要只需要"在下一轮开始前看一眼上轮做了什么"，语义不同。

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

> **相关文件**: `SYSTEM-INDEX.md` (索引链入口) | `SYSTEM/API-REFERENCE.md` (接口定义) | `SYSTEM/architecture-overview.md` (架构总图) | `ZHU/DECISIONS/INDEX.md` (决策历史)

### 融合计划落地状态

参照 `ZHU/DECISIONS/执行计划-注入系统融合执行计划.md`，当前融合实施状态：

| 阶段 | 文件 | 状态 |
|------|------|------|
| Step 0: 基础白名单 + 位置常量扩展 | `prefix-stabilizer.ts` / `position-strategy.ts` / `injection-system.md` | ✅ 完成 |
| Step 1: InjectionRouter 核心 | `router.ts`（291 行） | ✅ 完成 |
| Step 2: VariantScheduler 迁移入 Router | `router.ts` 内建 scheduler | ✅ 完成 |
| Step 3: PositionStrategy 标准化 | `position-strategy.ts`（112 行） | ✅ 完成 |
| Step 4: GuardInjector | `guard-injector.ts`（新版实现） | ✅ 完成（Phase33，统一管线） |
| Step 5: ErrorAuditInjector | `error-audit-injector.ts`（43 行） | ✅ 完成 |
| Step 6: inject() → router 记录同步（修正版） | `manager.ts` / `turn/index.ts:1659` | ✅ 完成 |
| Step 7: TokenBudget 过滤接口 | `router.ts` | ✅ 完成 |
| Step 8: Guard/Injector 边界清理 | 审计确认（0 文件改动） | ✅ 完成 |
| Step 9: disable/enable 链式 API | `router.ts` | ✅ 完成 |
| Step 10: ErrorAuditInjector 注册 | `manager.ts` | ✅ 完成 |
| Step 11a: CacheGroup 分类 | `router.ts`（5 组） | ✅ 完成 |
| Step 11b: 双指数残差 | 待运行时基线数据 | ⏸️ 暂缓 |
