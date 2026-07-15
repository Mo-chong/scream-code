---
tags: [type/reference, domain/turn, status/final]
keywords: [回合, turn, TurnController, afterStep, runOneTurn, 债务模型, 收敛门, 偏差链, 墨克尔]
updated: 2026-07-15
---

<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
# 回合控制系统 — TurnController

> **参见：** [`injection-system.md`](injection-system.md)（注入管线） | [`interception-system.md`](interception-system.md)（行为矫正） | [`interception.md`](interception.md)（拦截日志） | [`architecture-overview.md`](architecture-overview.md)（架构全景） | [`API-REFERENCE.md`](API-REFERENCE.md)（API 签名）
>
> 源码: `packages/agent-core/src/agent/turn/index.ts`

---

## 生命周期

> 别名：TurnController / 回合控制器
> 对应代码：TurnController (turn/index.ts)

```
runOneTurn()
  │
  ├── perTurnSetup()              ← 重置所有状态
  │   ├── debtd/carryover/keyword 重置
  │   ├── eventLog.clear()
  │   ├── appendUserMessage(input)
  │   └── Phase 4: 意图注入
  │
  ├── applyUserPromptHook()       ← 用户消息 hook
  │
  └── 主循环 (while shouldContinue)
       │
       ├── generate()             ← AI 生成回复
       │
       ├── afterStep()            ← 每一步结束后的处理
       │   ├── 偏差链检测（4 条件：Edit≥3未查LSP / 行为变体跨回合累计 / 代码质量违规）
       │   ├── 反事实检测（confidence >= 3 → confabulationBlocked = true）
       │   ├── 质量升级检测（C→B→A→S）
       │   ├── 工具后注入（C5: step_after_edit / step_after_verify_fail）
       │   ├── 探索债务计数（Read/Grep +1，同主题+0.5）
       │   └── 健康检查 + resetInjectorStepState
       │
       ├── prepareToolExecution() ← 工具执行前阻断
       │   ├── H1 dedup
       │   ├── H2 Bash error loop
       │   ├── H3 债务 ≥10 → 阻断
       │   ├── H4 偏差链+代码质量 → 阻断 Write/Edit
       │   └── H5 截断恢复
       │
       ├── shouldContinueAfterStop()  ← 收敛门（8 条件 + confabulation + pending-doc）
       │   ├── HIGH severity（先注入）：工具报错 / 验证失败 / 偏差链 / LSP ≥3Edit
       │   ├── LOW severity（后注入）：无内容生成 / 未更新TodoList / 假通过
       │   ├── 有拦截 → inject() → return { continue: true }
       │   └── MAX_CONVERGENCE_INJECTIONS = 3 → 上限后放行
       │
       └── finalizeToolResult()  ← 工具结果返回
           ├── isError → addDebt(工具名, 0.5)（Bash 超时除外）
           ├── inject codegraph/keyword 记录
           └── FAA 记录
```

---

## 关键状态字段

| 字段 | 类型 | 作用 |
|------|------|------|
| `confabulationBlocked` | boolean | Guard 和反事实检测设置，收敛门消费 |
| `deviationChainActive` | boolean | 偏差链激活标志 |
| `verifyFailStep` | number | 验证假通过检测 |
| `convergenceInjections` | number | 收敛注入计数器，上限 3 |
| `MAX_CONVERGENCE_INJECTIONS` | 3 | 收敛门最大注入次数 |
| `explorationDebt` | float | 探索债务（+1/+0.5，不归零） |
| `carryover` | number | 跨回合债务延续，min(2, floor(debt)) |
| `nonExploreStepsSinceLastExplore` | number | 非探索步计数器（每 3 步 -1） |
| `recentExplorationKeywords` | Set[] | 近 4 步关键词快照（语义重复检测） |

---

## 三个关键方法

### inject()

注入中枢。优先级从高到低：
1. `extraInterceptions` → 拦截系统预批准消息，优先占 budget 槽
2. 普通 `injection` → 经过 5 重过滤：重复衰减 → 残差注意力 → 步级去重 → 预算检查 → 注册 VariantRegistry

### afterStep()

每次 AI 生成完一步后执行。包含所有检测和注入逻辑：
- 偏差链 4 条件（C1: Edit≥3未查LSP / C3: 行为变体累计 / C4: 代码质量）
- 探索债务计数
- 语义重复检测 + 后置校验
- C5 工具后注入

### shouldContinueAfterStop()

收敛门。HIGH 条件先注入（工具报错 / 验证失败 / 偏差链 / LSP ≥3Edit），LOW 条件后注入（无内容 / TodoList / 假通过）。上限 3 次后放行。

### addDebt(reason, amount)

**Phase40 新增** — 统一债务累积接口。所有工具报错（Bash 超时除外）通过此接口加债 0.5，债务达 carryover+4/+7 时触发针对性提醒，尾部追加 `FIX_SUFFIX` 修复路径。

---

## 偏差链系统

### 激活条件（4 个 → 当前）

| # | 条件 | 激活 reason |
|---|------|------------|
| C1 | Edit ≥3 未查 LSP.references | "连续多次 Edit 未查 LSP.references" |
| C3 | 行为变体跨回合超标（3 种） | "行为变体 ${variant} 连续 ${count} 回合 S→S 升级" |
| C4 | 代码质量违规 | "代码质量违规：存在 N 个未修正的规范违反" |

### 已删除

| 原条件/变体 | 删除原因 |
|------------|---------|
| C2（验证失败→偏差链） | 冗余（工具结果+收敛门G2已覆盖） |
| T1 毒性拦截（收敛门前） | 冗余（与收敛门 G3 重复） |
| `scene_memory_recall` 变体 | 已有 scene-memory detector |
| `step_after_edit` / `step_after_verify_fail` 变体 | 与其他机制重复 |

### 3 个跨回合跟踪变体（INTERCEPT_VARIANTS）

| 变体 | 阈值 | 检测什么 |
|------|------|---------|
| `guard_feedback_rule_2` | 3 | 声称无证据 |
| `guard_feedback_rule_3` | 2 | 声称已修改无 Edit |
| `guard_feedback_rule_4` | 3 | 用记忆不查代码 |

### 3 个介入点

| 介入点 | 触发条件 | 效果 |
|--------|---------|------|
| G3 收敛门（HIGH） | AI 说"完成"时偏差链活跃未解决 | 注入 reason + 阻止回合结束 |
| H4 硬阻断 | 偏差链活跃 + reason 含代码质量 + 写/Edit | syntheticResult.isError 阻断 |

### 偏差链解析条件

`tryResolveDeviationChain()`：
- C1 偏差链 → 当前步调了 LSP.references → 已修复
- C4 代码质量偏差链 → codeQualityViolationsThisTurn = 0 → 已修复
- C3 行为变体偏差链 → 当前步有验证工具调用 → 已修复

---

## 收敛门 severity 分区（Phase40）

| 条件 | severity | 触发条件 |
|------|----------|---------|
| 工具报错 | HIGH | lastToolFailure 且未验证通过 |
| 验证失败 | HIGH | workingSet 验证未通过 |
| 偏差链 | HIGH | deviationChainActive 未解决 |
| Edit≥3 无 LSP | HIGH | totalCodeFileEditsThisTurn ≥ 3 且无 LSP |
| 无内容生成 | LOW | currentStepHadContent 为 false |
| 待办未更新 | LOW | goal active 但 todoSeenThisTurn 为 false |
| 假通过 | LOW | verifyFailStep ≥ 0 |

收敛门注入消息的顺序是 HIGH 全部在先，LOW 全部在后。

---

## 探索债务模型

| 机制 | 规格 | 说明 |
|------|------|------|
| 债务积累 | 探索 Read/Grep +1（同主题 +0.5）| 文档 Read 不计数 |
| 债务衰减 | 非探索每 3 步 -1 | 替代 codegraph 直接减债 |
| codegraph 减债 | **移除** | 防 dummy call 作弊，仅靠自然衰减 |
| 触发阈值 | debt ≥ carryover+4 / +7 / +10 | 提醒 / 警告 / 阻断 |
| 跨回合 | carryover = min(2, floor(debt)) | 防重启洗白 |
| 统一债务 addDebt | 工具报错加债 0.5 | Bash 超时除外（Win11 环境问题） |
| FIX_SUFFIX | 消息尾部追加修复路径 | Edit→/edit-fix, Read→node, Grep→explore |

---

## 墨克尔审计链（Phase40）

`turn/event-log.ts`：

- `computeEventHash(prevHash, event)` — 每次 `record()` 记录事件时计算 SHA256 hash
- `verifyMerkleChain(events)` — 验证整条链完整性，发现篡改时返回 `brokenAt` 下标
- 模块级 `lastMerkleHash` 跨回合串联，重置用 `resetMerkleChain()`

每一条拦截事件记录形如 `{ ...event, seq, prevHash }`。

---

## 工具优先级（system.md Phase40）

```
codegraph_explore: unknown structure / broad scope (maxFiles: 12 broad, 3 known)
codegraph_node: known symbol / precise lookup
codegraph: callees(function) / impact(symbol) / affected(path)
LSP.references/definition: precise targeting
Read / Grep / Glob: fallback
```

格式：无序列表（对齐 `<format>` 的 `No cross-segment ordering dependencies`），全英文。

---

## quality-degrade 消息改写（Phase40）

消息嵌入 `bestMessage`（具体质量偏差描述），替代"考虑改用结构化方法"等空话。加保护：`bestMessage` 长度 10-80 字时才嵌入，否则回退通用消息。

C 级: `${bestMessage} — 建议用工具验证代替手动推断。`
B 级: `${bestMessage}（已重复多步）— 请 Read 当前内容后再操作。`
A 级: `${bestMessage} — 必须修正后继续，否则回合终止。建议换方法或缩小范围。`
S 级: `${bestMessage} — 已触发上限，违反系统规则。`

---

## 关键常量变化（Phase40）

| 常量 | 旧值 | 新值 | 备注 |
|------|------|------|------|
| `MAX_CONVERGENCE_INJECTIONS` | 5 | 3 | 收敛门上限 |
| `carryover` 取值 | min(3, debt) | min(2, debt) | 降低跨回合敏感度 |
| codegraph 减债 | debt -2 | **移除** | 防作弊 |
| 自然衰减 | -0.1/步 | -1/3步 | 加速 |
