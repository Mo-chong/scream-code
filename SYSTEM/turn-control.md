---
tags: [type/reference, domain/turn, status/final]
keywords: [回合, turn, TurnController, afterStep, runOneTurn, 债务模型, 收敛门, 偏差链, 墨克尔]
updated: 2026-07-17
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
  │   ├── DebtLedger/carryover 重置
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
       │   ├── DebtLedger分类债务账本（exploration/tool_error/reasoning/gate）+ 偿还机制
       │   ├── 忠实性检测（faithfulness：被动，无 token 开销）
       │   ├── REQUEST 知识请求（protocol + step 1 inject）
       │   └── 健康检查 + resetInjectorStepState
       │
       ├── prepareToolExecution() ← 工具执行前阻断
       │   ├── H1 dedup
       │   ├── H2 Bash error loop
       │   ├── H3 DebtLedger分类阻断（exploration超限→封Read/Grep, tool_error超限→封Edit/Write, total≥25→全阻断）
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
| `debtLedger` | DebtLedger | 分类债务账本（exploration/tool_error/reasoning/gate） |
| `maxConvergenceInjections` | 3 | 收敛门最大注入次数 |
| `deviationChainActive` | boolean | 偏差链激活标志 |

---

## 三个关键方法

### inject()

注入中枢。优先级从高到低：
1. `extraInterceptions` → 拦截系统预批准消息，优先占 budget 槽
2. 普通 `injection` → 经过 5 重过滤：重复衰减 → 残差注意力 → 步级去重 → 预算检查 → 注册 VariantRegistry

### afterStep()

每次 AI 生成完一步后执行。包含所有检测和注入逻辑：
- 偏差链 4 条件（C1: Edit≥3未查LSP / C3: 行为变体累计 / C4: 代码质量）
- DebtLedger分类债务账本 + 偿还机制
- 忠实性检测（faithfulness：被动无感，不占 token budget）
- REQUEST 知识请求（协议：LLM → system 发 REQUEST，step 1 注入回答）
- 语义重复检测 + 后置校验
- C5 工具后注入

### shouldContinueAfterStop()

收敛门。HIGH 条件先注入（工具报错 / 验证失败 / 偏差链 / LSP ≥3Edit），LOW 条件后注入（无内容 / TodoList / 假通过）。上限 3 次后放行。

### addDebt(reason, amount)

**Phase40 新增，Phase42 起重构为 DebtLedger 分类账本（`audit/debt-ledger.ts`）**。
`addDebt(reason, amount)` 通过 `toolToCategory(toolName)` 自动映射到 4 个分类（exploration/tool_error/reasoning/gate），不再使用 `carryover`。
见 §DebtLedger 分类债务账本。

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

## DebtLedger 分类债务账本（Phase42，替代 explorationDebt）

从 Phase42 起，`explorationDebt` 单一债务升级为 **DebtLedger** 分类账本（`audit/debt-ledger.ts`）：
4 类单独记债、单独引导、分类阻断。**有偿还债**（每步正确调用自动减债）。

### 债务分类

| 分类 | 加债场景 | 金额 | 加债入口 |
|------|---------|:----:|---------|
| `exploration` | 低效 Read/Grep/Glob/WebSearch | +0.5 | `addDebt('Read 报错')` → `toolToCategory('Read')` → exploration |
| `tool_error` | Edit/Write/Bash 报错 | +0.5 | `addDebt('Edit 报错')` → `toolToCategory('Edit')` → tool_error |
| `reasoning` | faithfulness mismatch（推理动词≠工具调用） | +0.3 | `checkFaithfulness()` → mismatch → `debtLedger.addDebt('reasoning')` |
| `gate` | 收敛门 G3 拦截 | +1.0 | 收敛门触发时 `debtLedger.addDebt('gate', '收敛门拦截', 1.0)` |

### 偿还机制

| 机制 | 触发 | 金额 |
|------|------|:----:|
| `repayAll()` | 每次正确工具调用（在 handleAfterStep 中） | -0.05/类，总计 -0.2/步 |
| streak bonus | 连续 3 次正确调用（某分类无加债） | 额外 -0.3（该分类），连胜计数器归零 |
| `repayGate()` | 收敛门解决（流程完成） | -0.5（gate 分类）|

### 定向阻断

统一阈值 12.0（gate 8.0），安全网 total ≥ 25。在 B 组 prepareToolExecution 中由 `shouldBlockTool()` 直接阻断：

| 条件 | 阻断范围 | 消息模板 |
|------|---------|---------|
| exploration ≥ 12 | 封 Read / Grep / Glob / WebSearch | "探索债务已达 N 点。用 codegraph_explore。" |
| tool_error ≥ 12 | 封 Edit / Write | "工具错误债务 N 点。检查格式约束。" |
| reasoning ≥ 12 | 无工具阻断（仅警告注入） | "推理不一致债务 N 点。" |
| gate ≥ 8 | 全工具阻断 | "拦截债务高，需全面修正策略。" |
| total ≥ 25 | 全阻断（安全网） | "总债务达上限，报告用户请求介入。" |

> 与旧机制的差异：阻断不通过 InjectionRouter，不走 ToolPatternDetector（DebtLedger 直接阻断，不经过检测器管线）。阻断消息由 `DebtLedger.getGuidance()` 生成，**仅阻断超限分类的工具**，其他工具可正常还债。

### ② Phase42b：工具别名 + 路径豁免 + 批量标记

#### 工具别名映射（turn/index.ts A组）

| AI 说的短名 | 系统转为 | 解决 |
|-------------|---------|------|
| `codegraph_explore` | `mcp__codegraph__codegraph_explore` | system.md 写短名，MCP 注册长名，AI 不混淆 |
| `codegraph_node` | `mcp__codegraph__node` | 同上 |

A组 prepareToolExecution 前：`TOOL_ALIAS[ctx.toolCall.name] ?? ctx.toolCall.name`，匹配到的直接改写 `ctx.toolCall.name`。

#### knownPaths 路径豁免

**机制：** codegraph/LSP 调用成功 → 提取输出中的源码路径（`.ts/.js/.tsx/.jsx/.py/.go/.rs`）→ 写入 `knownPaths: Set<string>` → `isExploratoryReadGrep()` 检查 Read 路径是否匹配 → 匹配则不算探索债。每 session newTurn 清空。

#### [BulkRead] 批量标记

**机制：** AI 在推理文本中声明 `[BulkRead: src/auth/*.ts]` → `checkFaithfulness()` 检测 → `bulkReadPatterns[]` 记录 → `isExploratoryReadGrep()` 前缀匹配（`src/auth/`）→ 豁免。

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

### 质量基线（Phase41）

| 机制 | 时机 | 说明 |
|------|------|------|
| recordQualityBaseline | session-end | 记录当前回合的质量指标（偏差链触发次数、债务峰值、收敛注入次数、反事实次数）|
| getFeedbackInjection | session-start | 读取上一 session 的质量基线，若存在未解决的偏差模式则在首回合注入反馈 |

---

## [DEPRECATED] 探索债务模型（旧，被 DebtLedger 取代 2026-07-15）

> ⚠️ 已废弃。替代为 `DebtLedger.exploration` 分类（见 §DebtLedger 分类债务账本）。以下保留仅供历史参考。

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

## Checkpoint 双向文件回退（Phase42d）

> 代码：`packages/agent-core/src/utils/checkpoint.ts`（110 行）
> 集成：`turn/index.ts` afterStep → snapshot/recordAfter
> 命令：`/rewind N`（别名 /rw）和 `/forward`（别名 /fw）注册于 `apps/scream-code/src/tui/commands/`

CheckpointManager 为每个 Edit/Write 操作保存**双向快照**：
- `snapshot(path)` ← 改前（before）
- `recordAfter(path)` ← 改后（after）

### 回退机制

```
/rewind 3   → 恢复 3 轮前的文件内容（对所有快照文件执行 before → 当前）
   ↓            snapshot 反向应用
/forward    → 撤销 /rewind，恢复到 AI 最新修改状态
   ↓            recordAfter 正向应用
```

- turn-step 集成：每个工具调用前后自动调用 checkpoint
- 与 git 无关：纯内存快照，不创建 git commit
- 安全：多次 /rewind → /forward → /rewind 反复切换

---

## [DEPRECATED] 关键常量变化（旧探索债务模型，Phase40 → 已废弃）

> ⚠️ 已废弃。以下常量来自旧 `explorationDebt` 模型，已被 **DebtLedger** 替换。保留仅供参考。

| 常量 | 旧值 | 新值 | 备注 |
|------|------|------|------|
| `MAX_CONVERGENCE_INJECTIONS` | 5 | 3 | 收敛门上限（仍有效）|
| `carryover` 取值 | min(3, debt) | min(2, debt) | 旧探索债务模型，已失效 |
| codegraph 减债 | debt -2 | **移除** | 旧探索债务模型，已失效 |
| 自然衰减 | -0.1/步 | -1/3步 | 旧探索债务模型，已失效 |
