# 注入系统 / Injection System

> 指令权重体系、变体注册表、残差注意力门控、注入管线与预算系统的完整规范。

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

`InsertPosition` 决定系统提醒注入到消息列表的位置，利用 Transformer 注意力曲线的 U 形特性：

| 位置 | 注意力等级 | 优先级权重 | 说明 |
|------|-----------|-----------|------|
| `'AFTER_SYSTEM'` | HIGH | 1000 | 系统提示之后（primacy effect），用于 S/A 级约束 |
| `'MID_CONTEXT'` | MEDIUM | 500 | 上下文中间位置 |
| `'AFTER_TOOL_CALL'` | LOW | 0 | 工具调用之后，默认 |
| `'CONTEXT_BOTTOM'` | NEAR_ZERO | -500 | 上下文底部，注意力最低（融合预留） |
| `'ATTENTION_PEAK'` | DYNAMIC | 9999 | 注意力峰值动态位置（融合预留，最高注入优先级） |

优先级通过 `getPositionPriorityBoost(pos: InsertPosition): number` 计算，dispatch 排序时使用。

### POSITION_ATTENTION 旧版映射

`position-strategy.ts:32-34` 保留旧版等级→位置映射兼容层：

```typescript
export const POSITION_ATTENTION: Record<string, InsertPosition> = {
  S: InsertPosition.AFTER_SYSTEM, A: InsertPosition.AFTER_SYSTEM,
  B: InsertPosition.MID_CONTEXT, C: InsertPosition.AFTER_TOOL_CALL, D: InsertPosition.AFTER_TOOL_CALL,
};
```

| 等级 | 映射位置 | 权重 |
|------|---------|------|
| S | AFTER_SYSTEM | 1000 |
| A | AFTER_SYSTEM | 1000 |
| B | MID_CONTEXT | 500 |
| C | AFTER_TOOL_CALL | 0 |
| D | AFTER_TOOL_CALL | 0 |

### 当前注册表（31 变体，见 variant-registry.ts:277-331）

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

`variant-registry.ts` 共注册 **31 个变体**，分为 11 组。所有 injector 循环共享同一套残差系统，`shouldInjectByResidual()` 在各个注入阶段对所有变体计算残差分数。

| 变体组 | 包含变体数量 | 典型 weight | 典型 decayPerStep | 注入器覆盖 |
|--------|------------|-------------|-------------------|-----------|
| `system_trigger_*` | 3 | 0.15 | 0.95 | 系统触发 |
| `deviation_chain_*` | 3 | 1.20 | 0.90 | 偏差链检测 |
| `intent_*` | 6 | 0.50 | 0.50 | intent.ts |
| `prepare_*` | 6 | 0.25 | 0.70 | 6 个注入器 |
| `post_*` | 6 | 0.20 | 0.50 | 6 个注入器 |
| `step_after_*` | 3 | 0.20 | 0.50 | 6 个注入器 |
| `guard_feedback_*` | 4 | 0.40 | 0.85 | 行为反馈 |
| `scene_memory_*` | 1 | 0.50 | 0.80 | scene_memory |
| `system_ref_stuck` | 1 | 0.50 | 0.85 | stuck.ts |
| `code_quality_*` | 1 | 0.30 | 0.80 | 代码质量 |
| `truncation_recover_guard` | 1 | 0.50 | 0.80 | 截断恢复 |

详情见 `variant-registry.ts:277-331`。

---

## 4. 注入管线 (Injection Pipeline)

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
  getStats(): { registered: number; disabled: string[]; active: string[] };

  /** 设置 token 预算 */
  setBudget(budget: number | undefined): void;
}
```

**调度流程**:

```
InjectionRouter.dispatch(context)
  ├─ 遍历所有注册 injectors（按注册顺序）
  │   ├─ 跳过 disabled 注入器
  │   ├─ scheduler.shouldInject(id, context) → 残差过滤
  │   ├─ getCacheGroup(id) → 分组缓存管理
  │   ├─ injector.inject(context) → 实际生成注入内容
  │   ├─ scheduler.record(id, enabledVariants) → 调度记录
  │   └─ tokenBudgetCheck() → 预算过滤
  ├─ 按位置优先级排序（getPositionPriorityBoost）
  └─ 返回排序后的 InjectResult[]
```

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

`router.ts` 按注入器 ID 将其分组，用于缓存管理和清理策略：

| 分组 | 注入器 ID | 清理策略 |
|------|----------|---------|
| `core` | system, step-summary, context-info, token-info, tool-result | 首次注入后缓存 |
| `context` | context-clear, context-compacted | 生命周期事件后刷新 |
| `feedback` | guard-feedback | 每轮评估 |
| `audit` | error-audit | 每轮评估 |
| `default` | 其他 | 临时缓存 |

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
  ├─ collectInjectorFacts()  ← 收集注入器状态（Phase22.2）
  ├─ 更新 stuck 检测历史
  ├─ router.recordInjection(variant, step) ← Step 6：统一注入监控
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

### 当前注入器

| 文件 | 变体数 | 等级 | 触发条件 | 注入内容 |
|------|-------|------|---------|---------|
| `goal.ts` | 3 | C | 计划模式 step | 计划目标提醒 |
| `memory-rules.ts` | 2 | C | 场景记忆匹配 | 记忆规则提示 |
| `permission-mode.ts` | 4 | A/B | 权限模式切换 | 模式限制说明 |
| `plan-mode.ts` | 5 | B | 计划模式行为 | 计划行为约束 |
| `plugin-session-start.ts` | 2 | C | 插件会话启动 | 会话初始提醒 |
| `todo-list.ts` | 3 | C | todo 列表变化 | todo 状态更新 |
| `user-prefs.ts` | 1 | S | 每轮（路径 B） | 用户偏好 |
| `wolfpack.ts` | 2 | C | WolfPack 调用 | WolfPack 行为说明 |
| `working-set.ts` | 6 | B/C | working set 变化 | 文件关注提醒 |
| `stuck.ts` | 1 | D | 同一文件连续编辑≥3步 | 文档导航提示 |
| `guard-injector.ts` | 1 | A | history ≥ 3 条（融合新增） | 守卫反馈（`injectionVariant: 'guard-feedback'`） |
| `error-audit-injector.ts` | 1 | B | 最近 5 条有失败记录（融合新增） | 文件操作审计错误摘要（`injectionVariant: 'error-audit'`） |

> **活跃总数**: 12 个注入器，约 31 变体。`quality.ts / confabulation.ts` 已弃用（功能迁移到 turn/index.ts 硬编码注入）。

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

### GuardInjector（融合新增）

定义于 `packages/agent-core/src/agent/injection/guard-injector.ts`（38 行，融合新增）。

- `injectionVariant`: `'guard-feedback'`
- 触发条件: `history.length ≥ 3`，调用 `checkGuard(history, StepToolSummary)`
- 注入内容: `checkGuard` 返回的反馈文本（`result.rule !== 0` 时）
- 位置等级: A（HIGH，AFTER_SYSTEM）
- 注册 ID: `'guard-feedback'`

### ErrorAuditInjector（融合新增）

定义于 `packages/agent-core/src/agent/injection/error-audit-injector.ts`（43 行，融合新增）。

- `injectionVariant`: `'error-audit'`
- 触发条件: `agent.fileActionAudit.getRecentEntries(5)` 中有失败记录
- 注入内容: 最近失败的文件操作审计摘要
- 位置等级: B（MEDIUM，MID_CONTEXT）
- 注册 ID: `'error-audit'`
- **运行时接线**: 需要 `agent.fileActionAudit` 实例在 agent 构造时注入，框架已就绪

### 注入器注册管理

所有注入器在 `manager.ts` 构造函数中通过 `InjectionRouter.register(id, injector)` 批量注册：

```typescript
const injectors: [string, DynamicInjector][] = [
  ['system', new SystemInjector(agent)],
  ['memory-rules', new MemoryRulesInjector(agent)],
  // ... 全部 12 个 ...
  ['guard-feedback', new GuardInjector(agent)],
  ['error-audit', new ErrorAuditInjector(agent)],
];
injectors.forEach(([id, inj]) => this.router.register(id, inj));
```

### 运行时停用/启用

通过 `InjectionRouter.disable(id)` / `enable(id)` 链式 API 运行时控制：

```typescript
// 禁用 error-audit 注入器
agent.injection.getRouter().disable('error-audit');
// 重新启用
agent.injection.getRouter().enable('error-audit');
```

### 预留注入器（Phase22 规划）

| 注入器 | 变体 | 等级 | 作用 |
|--------|------|------|------|
| `injectors/facts.ts` | `injector_facts` | C/D | 将注入器状态暴露为结构化 flat facts 给 AI |
| 未来：回环检测 | `loop_detector` | B | 检测 AI 陷入同一函数反复修改的循环 |
| 未来：上下文水位 | `context_watermark` | B | 检测 context 接近上限时注入压缩建议 |

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
| Step 4: GuardInjector | `guard-injector.ts`（38 行） | ✅ 完成 |
| Step 5: ErrorAuditInjector | `error-audit-injector.ts`（43 行） | ✅ 完成 |
| Step 6: inject() → router 记录同步（修正版） | `manager.ts` / `turn/index.ts:1659` | ✅ 完成 |
| Step 7: TokenBudget 过滤接口 | `router.ts` | ✅ 完成 |
| Step 8: Guard/Injector 边界清理 | 审计确认（0 文件改动） | ✅ 完成 |
| Step 9: disable/enable 链式 API | `router.ts` | ✅ 完成 |
| Step 10: ErrorAuditInjector 注册 | `manager.ts` | ✅ 完成 |
| Step 11a: CacheGroup 分类 | `router.ts`（5 组） | ✅ 完成 |
| Step 11b: 双指数残差 | 待运行时基线数据 | ⏸️ 暂缓 |
