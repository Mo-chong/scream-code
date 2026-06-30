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

### 当前注册表

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

残差注意力是其核心门控机制：每次注入后，同一变体的"注意力残差"随时间指数衰减。只有当残差值 ≥ threshold 时，才会允许再次注入。

### 全链路判定流程

```
VariantMeta.weight ← 基础权重
  ×
  decayPerStep ^ (currentStep - lastInjectedStep)
  = 残差 R
  ≥ threshold?
    → 注入
    < threshold?
    → 跳过 (skipped_residual)
```

### 附加门控

1. **Dedup 门控** (skipped_dedup): 同一 step 内已注入过同一变体 → 跳过
2. **MinStepGap 门控**: Δs < minStepGap → 跳过
3. **Budget 门控** (skipped_budget): 本步注入预算已耗尽 → 跳过
4. **配额门控** (Phase22.3): 变体已达到 per-conversation 配额 → 跳过

### 当前使用者

| 注入器 | 注册变体 | 等级 |
|--------|---------|------|
| `stuck.ts` (痛点感知) | `system_ref_stuck` | D |

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

  // ── Phase22.3: 变体配额调度 ─────────────────────────────────

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

| 文件 | 变体 | 等级 | 触发条件 | 注入内容 |
|------|------|------|---------|---------|
| `injectors/stuck.ts` | `system_ref_stuck` | D | 同一文件连续编辑≥3步 或 同一工具连续报错≥2步 ± 残差门控通过 | 文档导航提示 |

### 预留注入器（Phase22 规划）

| 注入器 | 变体 | 等级 | 作用 |
|--------|------|------|------|
| `injectors/facts.ts` | `injector_facts` | C/D | 将注入器状态暴露为结构化 flat facts 给 AI |
| 未来：回环检测 | `loop_detector` | B | 检测 AI 陷入同一函数反复修改的循环 |
| 未来：上下文水位 | `context_watermark` | B | 检测 context 接近上限时注入压缩建议 |

---

## 7. 配额系统 (Quota System) — Phase22.3（已实现）

定义于 `variant-registry.ts`，通过 `VariantScheduler` 管理。
自 v0.6.10+ 起，`InjectionManager` 的三个方法已接入 `VariantScheduler`，配额调度实际生效。

### QUOTA_TABLE

```typescript
export interface VariantQuota {
  /** 整轮对话中该变体最大注入次数 */
  maxPerConversation: number;
  /** 注入后的冷却步数（该步数内不再次注入该变体） */
  cooldownSteps: number;
  /** 滑动窗口大小（步数），用于控制注入频率 */
  windowSize?: number;
}

// 默认配额配置
const QUOTA_TABLE: Record<string, VariantQuota> = {
  default: { maxPerConversation: 20, cooldownSteps: 1, windowSteps: 100 },
  low:     { maxPerConversation: 8,  cooldownSteps: 3, windowSteps: 50 },
};
```

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
    → VariantScheduler.shouldInject(variant, currentStep)    ← 四层配额检查
      → ① minStepGap（距上次注射步数）
      → ② cooldownSteps（冷却期）
      → ③ maxPerConversation（对话总次数上限）
      → ④ 滑动窗口（最近 N 步内已注入次数）
  ↓ 超限 → 跳过注入，记录 injection_skipped 事件
  ↓ 通过 → 继续注入 + afterInject(variant, step)
    → VariantScheduler.record(variant, currentStep)
  ↓ 回合结束
TurnFlow.resetForTurn()
  → InjectionManager.resetForTurn()
    → VariantScheduler.reset()
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
