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

定义于 `packages/agent-core/src/agent/injection/manager.ts`。

### InjectionManager 接口

```typescript
export class InjectionManager {
  /**
   * 注入一条系统提醒。
   * @param text   提醒文本
   * @param meta   { variant: string, level?: 'S'|'A'|'B'|'C'|'D', ... }
   * @param budgetKey 预算键（不传则不占用预算）
   */
  inject(text: string, meta: Record<string, unknown>, budgetKey?: string): void;

  /** 清空注入器状态（用于 context clear） */
  onContextClear(): void;

  /** 压缩后重建注入器状态 */
  onContextCompacted(compact: (text: string, meta: Record<string, unknown>) => void): void;

  // ── Phase? 变体残差调度 ─────────────────────────────

  /**
   * 检查变体是否在配额限制内。
   * 委托给 VariantScheduler.shouldInject()。
   * 在 TurnFlow.inject() 注入前调用。
   */
  canInject(variant: string, currentStep: number): boolean;

  /**
   * 查询变体已注入次数（用于配额日志）。
   * 委托给 VariantScheduler.getInjectionCount()。
   */
  getInjectionCount(variant: string): number;

  /**
   * 注入后回调：记录变体注入到调度器。
   * 委托给 VariantScheduler.record()。
   */
  afterInject(variant: string, currentStep: number): void;

  /**
   * 回合重置：清空调度器计数器。
   * 委托给 VariantScheduler.reset()。
   * 由 TurnFlow.resetForTurn() 调用。
   */
  resetForTurn(): void;
}
```

### 注入日志

每次注入/跳过都会通过 `recordVariantLog` 记录到 `拦截日志` 中，格式：

```
variant_injected: [variant_name] Injected variant (lv=X)
variant_skipped/skipped_residual: [variant_name] R≥T for variant_name
variant_skipped/skipped_dedup: [variant_name] Dedup skip: variant already injected this step
variant_skipped/skipped_budget: [variant_name] Budget denies variant (budget info)
```

### 与 TurnFlow 的集成

```
TurnFlow.composeContextMessages()
  ├─ InjectionManager.inject() ← 被注入器（stuck.ts 等）调用
  ├─ 合并 systemReminders + injected messages
  └─ 传递到 context()

TurnFlow.handleAfterStep()  ← 本轮工具调用后
  ├─ collectInjectorFacts()  ← 收集注入器状态（Phase22.2）
  ├─ 更新 stuck 检测历史
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

> **活跃总数**: 10 个注入器，约 29 变体。`quality.ts / confabulation.ts` 已弃用（功能迁移到 turn/index.ts 硬编码注入）。
> **注意**: 路径 B（turn/index.ts 硬编码注入）绕过 VariantScheduler 调度，计划迁移回 DynamicInjector 体系。详见 [注入系统融合计划](../workspace/注入系统融合计划.md)。

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

## 8. 集成流程总图

```
┌─────────────────────────────────────────────────────────────┐
│                     Turn.composeContextMessages()            │
│  ┌──────────┐   ┌────────────┐   ┌──────────────────────┐  │
│  │ Injectors │──→│ Reminder   │──→│ ContextMessage[]     │  │
│  │ (facts,   │   │ Injection  │   │ (system + injected)  │  │
│  │  stuck, …)│   │ merge     │   │                      │  │
│  └──────────┘   └────────────┘   └──────────────────────┘  │
│                      │                                      │
└──────────────────────┼──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                 afterStep (本轮工具调用后)                    │
│  ┌────────────┐   ┌────────────┐   ┌──────────────────┐    │
│  │ facts      │   │ update     │   │ update           │    │
│  │ collection │   │ stuck hist │   │ scheduler state  │    │
│  └────────────┘   └────────────┘   └──────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

> **相关文件**: `SYSTEM-INDEX.md` (索引链入口) | `SYSTEM/API-REFERENCE.md` (接口定义) | `SYSTEM/architecture-overview.md` (架构总图) | `ZHU/DECISIONS/INDEX.md` (决策历史)
