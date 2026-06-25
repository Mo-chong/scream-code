# 回合控制系统 — TurnController

> 源码: `packages/agent-core/src/agent/turn/index.ts` (1737 行)

---

## 生命周期

```
runOneTurn()
  │
  ├── perTurnSetup()              ← 重置所有状态
  │   ├── confabulationBlocked = false    (line 442)
  │   ├── eventLog.clear()                (line 451)
  │   ├── appendUserMessage(input)        (line 454)
  │   └── Phase 4: 意图注入               (line 456-464)
  │
  ├── applyUserPromptHook()       ← 用户消息 hook
  │
  └── 主循环 (while shouldContinue)
       │
       ├── generate()             ← AI 生成回复
       │
       ├── afterStep()            ← 每一步结束后的处理
       │   ├── 偏差链检测
       │   ├── 反事实检测 (line 704-722)
       │   │   └── confidence >= 3 → confabulationBlocked = true
       │   ├── 质量升级检测
       │   ├── 工具后注入 (line 990+)
       │   ├── 健康检查 (line 772-778)
       │   └── resetInjectorStepState (line 780)
       │
       ├── shouldContinueAfterStop()  ← 收敛门 (line 783-891)
       │   ├── 检查 confabulationBlocked
       │   ├── 检查偏差链
       │   ├── 检查验证假通过
       │   └── 有拦截 → inject() → return { continue: true }
       │
       └── finalizeToolResult()  ← 工具结果返回（注入点 B 组）
```

---

## 关键状态字段

| 字段 | 类型 | 位置 | 作用 |
|------|------|:----:|------|
| `confabulationBlocked` | boolean | line 442 | Guard 和反事实检测设置，收敛门消费 |
| `deviationChainActive` | boolean | line 438 | 偏差链激活标志 |
| `verifyFailStep` | number | line 443 | 验证假通过检测 |
| `convergenceInjections` | number | line 814 | 收敛注入计数器，上限 5 |
| `MAX_CONVERGENCE_INJECTIONS` | 5 | line 91 | 收敛门最大注入次数 |
| `stepInjectedVariants` | Set | line 99 | 步级注入去重 |
| `injectBudget` | object | — | token 预算管理 |
| `variantRegistry` | object | — | 变体注册 + 残差注意力 |

---

## 三个关键方法

### inject() (line 1351-1435)

注入中枢。优先级从高到低：

1. `system_trigger` → 直接 `appendSystemReminder()`，穿透一切（line 1356-1359）
2. `quality_escalate_` → 穿透预算（line 1362-1365）
3. 普通 `injection` → 经过 5 重过滤：
   - 重复衰减（line 1369-1372）
   - 残差注意力（line 1375-1392）
   - 步级去重（line 1395-1403）
   - 预算检查（line 1412-1419）
   - 注册 VariantRegistry（line 1425-1428）

### afterStep() (line 633-781)

每次 AI 生成完一步后执行。包含所有检测和注入逻辑。

### shouldContinueAfterStop() (line 783-891)

收敛门。决定是否让 AI 继续。6 种拦住理由（line 817-874）：
- 无内容生成
- 有 Goal 但没更新 TodoList
- 工具失败未修复
- 验证失败未修复
- **反事实阻断**（confabulationBlocked）
- 偏差链未修复
- 验证假通过
- 无 LSP 但改了 3+ 文件（仅限代码文件，文档不触发）

---

## 注入预算 (injectBudget)

- 每个回合有 token 预算上限
- system_trigger 和 quality_escalate_ 穿透预算
- 偏差链激活时 bypassBudget()
- 预算不足 → eventLog.record('skipped_budget')

---

## 工具优先级（Phase16：代码探索三阶路由）

```
代码探索和修改前，按此顺序：

1. mcp__codegraph__codegraph_explore  — 新文件/未知符号/调用链（PRIMARY）
2. LSP.references / LSP.definition     — 已知符号精确定位
3. Read / Grep / Glob                  — 以上不够时 fallback
```

**代码级提醒**（turn/index.ts:983-991）：
- 当前回合连续 Read/Grep ≥3 次且从未调 codegraph → 注入 `step_code_explore` 提醒
- 调过一次 codegraph `mcp__codegraph__codegraph_*` → 计数清零
- codegraph MCP 不可用时（断开等），从不触发提醒
- 提醒只是建议，不阻断执行

**收敛门条件更新**（line 1787）：
- `totalCodeFileEditsThisTurn >= 3` 才触发（原 `totalStepsWithEditsThisTurn` 含文档）
- 文档 .md 编辑不再触发"无 LSP"收敛门

**LSP 双层 fallback 修复**（registry.ts + client.ts）：
- `_resolveCmd()` 3 重 fallback：npm → npm.cmd → nodeBin/npm.cmd
- `npx fallback` Windows 上改为 cmd.exe 包装 spawn
- 解决 bundle 环境 PATH 极简下 LSP 不可用的问题
