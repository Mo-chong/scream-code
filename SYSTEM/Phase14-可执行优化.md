# Phase14 系统说明书 — 可执行优化

> 模块减肥 + 行为轨道 + 短文本折叠
> **执行文档：** `DECISIONS/执行方案-Phase14-可执行优化-模块减肥+行为轨道+短文本折叠.md`

---

## 一、模块定位

Phase14 是**结构优化 Phase**，不改动任何运行时语义，只改 index.ts 这个文件（~115 行重构）。它为 Phase15+ 提供了方法级扩展点。

## 二、关键改动

### 2.1 afterStep 分段命名化（重构核心）

把 `handleAfterStep()` 从 1 个巨块拆成 7 步命名方法：

```
Step 1: injectStepAfterVariants() + detectDeviationChain()
Step 2: 反事实检测 + runQualityDetection()
  → 🆕 Phase15 插入点: resetObservedBehaviorViolations()
Step 3: tryResolveDeviationChain() + turn-level 统计
Step 4: injectInterceptionSummary() + checkEventLogHealth()
Step 5: detectSceneMemoryIssue() + runGuardDetection() + injectBehaviorRulesAfterStep()
Step 6: injectPositiveFeedbackThisTurn() + detectCodeRefIssue()
Step 7: resetInjectorStepState()
```

每步只调一个或多个命名方法，每个 ≤ 45 行。

### 2.2 收敛条件数组化（可组合）

`convergenceConditions: ConvergenceCondition[]`，按 priority 排序（10=最高，4=最低），`shouldContinueAfterStop` 循环遍历。新增收敛条件只需 push 一条——不改 gate 主逻辑。

当前 7 个条件（priority 10-4）。

### 2.3 正反馈防重

`positiveFeedbackGivenThisTurn` — 每回合只给一次正反馈，不刷屏。

### 2.4 跨回合标记（Phase14 修复重点）

`crossTurnFlags` 存 `lastTurnHadGuardRule1` 和 `lastTurnHadDeviation`，在 `injectCrossTurnFlags()` 消费并立即复位。

**Bug 1（已修复）：** `runOneTurn` 提前清零了 `lastTurnHadGuardRule1/lastTurnHadDeviation`，导致跨回合标记永不起效。修复：不在 `runOneTurn` 复位，而是在 `injectCrossTurnFlags()` 消费后立即复位。

**Bug 2（已修复）：** `guardRule1FiredThisTurn` 曾与 `confabulationBlocked` 共用同一含义，导致语义分裂。修复：增加独立字段 `guardRule1FiredThisTurn`，隔离 Rule 1 拦截与反事实拦截。

## 三、文件依赖

| 调用方 | 依赖关系 |
|--------|---------|
| `index.ts:handleAfterStep()` | 调 7 个命名步骤方法 + `resetObservedBehaviorViolations()` (Phase15) |
| `index.ts:shouldContinueAfterStop()` | 读 `convergenceConditions` 数组 |
| `index.ts:injectCrossTurnFlags()` | 读/写 `crossTurnFlags` |
| `event-log.ts` | handleAfterStep Step 4 调用 getNewTurnSummary() + checkEventLogHealth() |

## 四、与 Phase15 的关系

Phase15 的 4 个方法直接嵌入 Phase14 的方法结构中：
- `trackBehaviorViolation()` — 在 `runQualityDetection()` 中 S→S 时调用
- `resetObservedBehaviorViolations()` — 在 Step 2 和 Step 3 之间调用
- `detectTriggerVariant()` / `buildBehaviorInterceptMsg()` — 在 `shouldContinueAfterStop` 偏差链 branch 中调用

没有 Phase14 的命名化结构，Phase15 的方法插点就不存在。

## 五、验收记录

- **pnpm typecheck** ✅ 通过
- **审计结果：** 发现 2 个 Bug（已修复）
- **代码变更：** 仅改 `turn/index.ts` 一个文件

## 六、边界情况

| 场景 | 行为 | 正确性 |
|------|------|:------:|
| 正反馈条件满足但已有预防性提醒 | `confabulationBlocked/deviateChainActive/verifyFailedThisStep` 任一为 true 则不注入 | ✅ |
| 收敛条件全不满足 | 数组遍历后 reasons 为空，gate_passed | ✅ |
| 跨回合标记被多次消费 | `injectCrossTurnFlags` 每回合只在 step=1 时调用一次，消费后立即复位 | ✅ |
