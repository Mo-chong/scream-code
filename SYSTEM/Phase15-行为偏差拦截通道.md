# Phase15 系统说明书 — 行为偏差拦截通道

> BEB（Behavior Escalation Bridge）：软约束到硬拦截的升级桥
> **执行文档：** `DECISIONS/执行方案-Phase15-行为偏差拦截通道-软约束到硬拦截的升级桥.md`

---

## 一、模块定位

Phase15 在**检测器层和拦截层之间架桥**——让重复的行为违规（Guard Rule 2/3/4、场景记忆、步级反馈）能物理拦截，不再只靠文本提醒。

### 现状

```
检测器层（牙齿多，但不咬人）:
  Guard Rule 2/3/4 → 只记录 eventLog          ❌ 无牙齿
  SceneMemoryDetector → inject(文本提醒)        ❌ 无牙齿
  CodeRefDetector → inject(文本提醒)             ❌ 无牙齿
  interception_log → inject(摘要)               ❌ 无牙齿

拦截层（牙齿硬，但条件窄）:
  deviation chain → 物理阻止                    ✅ 只有2个代码级条件
```

### Phase15 后

```
同上 + behaviorViolations ≥ interceptThreshold → deviation chain → 物理拦截 ✅
```

## 二、核心架构

### 2.1 行为偏差拦截通道（BEB）

```
S→S 升级 → trackBehaviorViolation(variant) → behaviorViolations[variant]++
                                              ↓
                                  behaviorViolations 跨回合累积
                                              ↓
                                  detectDeviationChain() 条件3
                                  遍历 behaviorViolations，检查阈值
                                              ↓
                                  deviationChainActive = true
                                              ↓
                                  shouldContinueAfterStop → 物理拦截 + 差异化指导消息
```

### 2.2 配表驱动

`VARIANT_META` 新增 `interceptThreshold?` 字段：

| Variant | W | interceptThreshold |
|---------|:-:|:------------------:|
| guard_feedback_rule_2 | 0.7 | 3 |
| guard_feedback_rule_3 | **0.8** | **2** |
| guard_feedback_rule_4 | 0.7 | 3 |
| scene_memory_recall | 0.8 | 3 |
| step_after_edit | 0.6 | 3 |
| step_after_verify_fail | 0.8 | 3 |

未配 `interceptThreshold` 的变体默认 0 = 从不拦截。非行为变体（feedback_positive、prepare_\*、post_\*、intent_\*）不加该字段。

### 2.3 白名单拦截

`INTERCEPT_VARIANTS` 硬编码 Set（6 个变体）确保只有"真·行为问题"能进入拦截通道。

## 三、数据驱动配置（非自动调参）

### D1 — rule_3 权重提升

**依据：** 拦截日志数据显示 rule_3（28 次）是 rule_2（7 次）的 4 倍。

| 字段 | 旧值 | 新值 |
|:-----|:----:|:----:|
| W | 0.7 | **0.8** |
| interceptThreshold | 3 | **2** |

### D2 — interception_log 穿透 budget

**依据：** interception_log 占所有注入的 30%，被 budget deny 后影响元日志报告。

interception_log 的 inject 调用完全短路 budget 检查 + registry 注册，直接注入。

## 四、增强日志基础设施

### H1 — level/tokenEstimate 字段

`InterceptionEvent` 加两个可选字段，INDEX.json 未来可展示 `byVariantDetail.byLevel`。

### H2 — behavior_feedback 事件

`VariantRegistry.onBehaviorObserved` 回调 → record(`behavior_feedback`) → INDEX.json 的 `byKind` 出现该分类 → 可计算行为观察率。

### H3 — 预算使用摘要

`event-log.ts` 新增 `getBudgetSummary()` → 日志文件每回合末尾追加 `budget: X used, M skipped, N residual`。

### H4 — INDEX.json v2

新增 `byVariantDetail`：每个 variant 的 `{ total, delivered, skipped, byLevel: {S, A, B, C, D} }`。旧 version=1 文件向前兼容。

## 五、关键时序逻辑

### 5.1 从 C 级触发到偏差链拦截

```
C→B (1回合) → B→A (1回合) → A→S (1回合) → S→S×3 (3回合) = ~9回合
```

这不是"一触发就拦"，是给了 AI 足够机会改善后的最后手段。

### 5.2 行为改善→计数重置

```typescript
// handleAfterStep Step 2 和 Step 3 之间
for (const variant of Object.keys(crossTurnFlags.behaviorViolations)) {
  if (variantRegistry.get(variant)?.behaviorObserved === true) {
    delete crossTurnFlags.behaviorViolations[variant];
  }
}
```

改好就放过——偏差链不是记仇系统。

### 5.3 跨回合生命周期

- `behaviorViolations` 在 `runOneTurn` 中**不重置**
- 只有 `resetObservedBehaviorViolations()` 有选择地删除 `behaviorObserved === true` 的条目
- 偏差链拦截后 `deviationChainActive` 阻止重复拦截

## 六、文件依赖

| 文件 | 依赖关系 |
|:-----|---------|
| `turn/index.ts` | 调 `VARIANT_META` 读 interceptThreshold + `eventLog.record()` 传 level/tokenEstimate + `eventBuffer.pushTurn()` 传 budgetSummary |
| `turn/variant-registry.ts` | `VariantMeta.interceptThreshold` 被 index.ts 的 `detectDeviationChain()` 读取。`onBehaviorObserved` 被 index.ts constructor 赋值 |
| `turn/event-log.ts` | `InterceptionEvent` 接口被 index.ts 和 event-snapshot.ts 使用 |
| `turn/event-snapshot.ts` | `SnapBufferEntry.budgetSummary` 在 pushTurn 时接收，`updateIndex` 处理 version 升级 |

## 七、修复记录

| 问题 | 原因 | 修复 |
|:-----|:-----|:-----|
| 偏差链不拦截行为违规 | 偏差链只认 2 个代码级条件 | 新增条件 3（behaviorViolations ≥ interceptThreshold） |
| 通知了但不知道 AI 改没改 | 无行为观察反馈数据 | H2: behavior_feedback 事件 + 行为观察率 |
| 预算不够时 interception_log 被跳过 | 元日志走 budget 检查 | D2: interception_log 短路 budget |

## 八、边界情况

| 场景 | 行为 | 正确性 |
|------|------|:------:|
| 同一个回合多个变体同时 S→S | 每个变体独立计数，拦截第一个达阈值的 | ✅ |
| behaviorObserved = true 后继续违规 | 计数重置后重新累积，不记仇 | ✅ |
| 不在白名单但达到 S→S | `trackBehaviorViolation()` 被 `INTERCEPT_VARIANTS` 阻止 | ✅ |
| interceptThreshold = 0（默认） | `threshold > 0` 检查 false，跳过 | ✅ |
| 旧 INDEX.json version=1 | `version < 2` 时升级到 v2，初始化 byVariantDetail | ✅ |
