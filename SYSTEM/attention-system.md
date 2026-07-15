---
tags: [type/reference, domain/attention, status/draft]
keywords: [注意力, attention, 拦截, interception, 全流程, AI消费体验]
updated: 2026-07-15
---
<!-- maintain: 以 AI 消费体验为中心。改相关代码前先读这个。 -->
# 注意力系统 — AttentionSystem [P0]

> AI 读这一份就够了。策略+执行+术语统一。实现细节看同级文档。

---

## AI 在一轮中的 5 步流程

```
① 醒来（记忆重建）
② 行动（思考+工具）
③ 被观察（检测）    ← 我在这里被"审视"
④ 被反馈（回应）    ← 我在这里被"告知"
⑤ 回到①
```

---

## 我在每步被什么影响

### ① 醒来

| 来源 | 影响 | 出处 |
|------|------|------|
| ContextBuilder | 我的记忆宽度 | `context-management.md` |
| PrefixStabilizer | 我的规则顺序稳定 | `context-management.md` |
| 蒸馏塔（maskToolObservations） | 我的旧工具结果被压缩/遮蔽 | `mask-tool-observations.ts` |
| 归档层（ArchivalSummaryInjector） | 过长上下文被尾部 append 归档摘要 | `archival-summary.ts` |

> MicroCompaction 已废弃（Token 节省 <1% 但缓存破坏 44%）。
> 详见 `compaction.md`。

### ② 行动 — 我自己

AI 自主调用工具，无系统干预。

### ③ 被观察（检测）

所有检测器（detector）都是纯函数，只产生信号，不做决策。当前 **9 个**。

| 检测器 | 检测什么 | 优先级 |
|--------|---------|--------|
| ConfabulationDetector | 我在虚构内容 | critical |
| PermissionEnforcer (Guard) | 我是否违反行为规则 (R1-R4) | critical |
| TurnLimitsDetector | 是否超步数/超时 | critical |
| AttentionMonitor | 我回复中的 [DONE]/[NEED]/[CONFIRM] | normal |
| QualityDegradeDetector | 质量是否下降（C→B→A→S） | normal |
| DeviationChainDetector | 上回合被拦截原因的复发判断 | normal |
| ToolPatternDetector | 连续低效探索/连续报错 | normal |
| SceneMemoryDetector | 用户说"上次/以前"我没查记忆 | normal |
| EditFailureLoopDetector | 同一文件连续 Edit 失败 | critical |

> 已删除（2026-07-14）：verifyPass / toolDedup / interceptionSummary / budgetNotify

### ④ 被反馈（回应）

拦截消息（来自检测器）+ 注入消息（来自注入器）合并输出。

```
① detectors → RawSignal[]
    ↓
② sortByPriority → critical > normal > debug（3 级，对齐全系统 WeightLevel）
    ↓
③ budgetCap(3) → 最多 3 条/步
    ↓
④ formatMessage → 统一格式 "[拦截/CRIT] 你... 建议: ..."
    ↓
⑤ InjectionRouter 接管 → 拼入 messages[] → 我收到
```

> mergeByRootCause 保留不动（同根因合并，极少发生但无害）。
> calcEscalation 在 normal 级启用。

### ⑤ 回到①

本轮检测→反馈的摘要进入下轮的历史计数，用于递进升级。

### ⑥ 债务分类账 — DebtLedger（Phase41）[P1]

替代单一 `explorationDebt`，采用 4 类分类债务：

| 分类 | 触发器 | 加债 | 还款方式 |
|------|--------|------|---------|
| `exploration` | Read/Grep（文档/配置除外） | +1/次，同主题 +0.5 | `repayAll`：每正确调用 |
| `tool_error` | 工具报错（Edit/Bash/Read/Grep/Write） | +0.5/次 | `repayAll`：每正确调用 |
| `reasoning` | 推理链过长/重复思考 | +0.3/次 | `repayAll`：每正确调用 |
| `gate` | 领域不匹配的注入器命中 | +2.0/次 | `repayGate()`：收敛解决 |

#### 还款机制 [P1]

| 机制 | 规则 | 金额 |
|------|------|------|
| `repayAll` | 每次正确工具调用，4 类各自减债 | -0.05/类 |
| 连胜奖励 | 连续 3 次正确调用（某分类连胜归零） | 额外 -0.3（该分类） |
| `repayGate` | 收敛门解决（流程完成） | -0.5（gate 分类） |

- 连胜计数器每类独立：连续正确 +1，该类加债事件重置为 0
- `repayGate` 由收敛门调用，**与 domain-analyzer 无关**

#### 定向阻断 [P1]

阻断阈值统一为 12.0（gate 为 8），在 B 组 `prepareToolExecution` 中由 `shouldBlockTool()` 直接拦截：

| 条件 | 阻断范围 |
|------|---------|
| `exploration` ≥ 12 | 封 Read / Grep / Glob / WebSearch |
| `tool_error` ≥ 12 | 封 Edit / Write |
| `reasoning` ≥ 12 | 无工具阻断（仅警告注入） |
| gate ≥ 8 | 全工具阻断 |
| **安全网** total ≥ 25 | 全阻断 |

- 阻断不走 `InjectionRouter`，不经过 `ToolPatternDetector`（DebtLedger 直接阻断，不经过检测器管线）
- 阻断消息由 `DebtLedger.getGuidance()` 生成，**只有一个分类的工具被阻断**，其他工具正常使用

#### 领域门控（domain-analyzer.ts）[P1]

| 组件 | 职责 |
|------|------|
| `activeDomains` | 从推理关键词 + 工具名实时计算活跃领域 |
| `INJECTOR_DOMAIN_MAP` | 注入器名 → 所属领域映射（undefined=核心始终激发） |
| `shouldSkipByDomain()` | 领域不在活跃列表时跳过注入 |
| domain 匹配 | router.ts 中 `level` 提升一级（debug→normal, normal→critical） |

- 活跃域每步在 `inject()` 前计算，缓存到 `cachedAtStep` 变化才重算
- 领域不匹配的注入器**直接跳过注入**（不触发、不累计、不花费 budget）
- domain-analyzer **不累计 gate 债务**（gate 债务由收敛门触发累计）

#### 知识菜单 [P1]

| 步骤 | 动作 |
|------|------|
| step 1 注入 | `KnowledgeMenuInjector` 注入 8 领域菜单 |
| AI 输出 `"REQUEST: <topic>"` | `resolveKnowledgeRequest()` 解析 |
| `handleAfterStep` 处理 | 匹配 → `this.inject(knowledgeSnippet)` + 记录 event-log |

8 领域（实际域标签）：`deviation_chain` / `convergence_gate` / `distillation_tower` / `debt_model` / `audit_chain` / `codegraph` / `injection_system` / `interception`

- 知识注入走正常 `inject()` 路径，**消耗 token**
- 不匹配的 `REQUEST:` 静默忽略（返回 null）
- 知识内容在 `KNOWLEDGE_SNIPPETS` 中预定义，无外部通道检索

#### 忠实度检查 — FaithfulnessCheck [P1]

| 属性 | 值 |
|------|-----|
| 执行时机 | `handleAfterStep`（被动离线分析） |
| Token 消耗 | 0（不参与推理路径，不注入 prompt） |
| 输出 | event-log 事件（`kind: faithfulness`） |
| 检测内容 | **AI 推理文本中的动词 vs 实际工具调用的一致性**（如说"edit"但实际调了 Read→mismatch） |

- 高精度、低召回策略——只检明确不一致（6 组动词→工具映射），不猜测
- 一致/不一致都记录 event-log（修复 Phase41 beta 中只记不一致导致分无区分度的 bug）
- 结果在 session-end 聚合进 QualityScore faithfulness 维度（权重 0.20）

#### 质量指数反馈 — qualityIndex [P1]

```
session-end → recordQualityBaseline() → computeQualityScore() → writeBaseline()
session-start → readBaseline() → getFeedbackInjection() → inject()
```

5 维加权评分：

| 维度 | 公式 | 权重 |
|------|------|:----:|
| deviation | (1 - 偏差触发步数/总步数) × 100 | 0.25 |
| convergence | (1 - 收敛门触发步数/总步数) × 100 | 0.20 |
| toolAccuracy | (1 - 工具报错数/总调用数) × 100 | 0.25 |
| faithfulness | 一致数/总检查数 × 100 | 0.20 |
| debtHealth | (1 - finalDebt/debtCap) × 100 | 0.10 |

- qualityIndex = 加权平均四舍五入，0-100
- 持久化为 `~/.scream-code/quality-baseline.json` 单文件（非 50 条滚动存储）
- session-start 按分注入反馈：<55 加 4 条硬约束，<70 给建议，≥85 且不降表扬

### ⑦ [DEPRECATED] 统一债务累积（addDebt，Phase40，已被 DebtLedger 取代 2026-07-15）

> ⚠️ 已废弃。2026-07-15 起被 **DebtLedger**（§⑥）取代。`explorationDebt` 字段已从代码中完全清除（9 处引用全部迁至 `debtLedger`）。以下保留仅供参考，不再生效。

工具报错时通过 `addDebt(reason, amount)` 统一加债 0.5，债务达阈值时触发提醒并附带修复路径：

| 工具报错 | 修复路径 |
|---------|---------|
| Edit | `/edit-fix` |
| Bash | 换内置工具或 `codegraph_explore` |
| Read | 换 `Glob` 或已知符号用 `codegraph_node` |
| Grep | 换 `codegraph_explore`（省 80% token） |
| Write | `Glob` 确认目录 |

> Bash 超时通常由 Win11 环境问题引起，不扣 AI 债务。

---

## 3 级优先级（对齐全系统 WeightLevel）

| 优先级 | 含义 | 动作 | 递进 |
|--------|------|------|------|
| critical | 必须立刻处理（含原 P0+P1） | block_step / inject_feedback | ❌ 直接阻断或注入反馈 |
| normal | 需要改进（含原 P2+P3） | inject_feedback | ✅ hint→nudge→warn→block |
| debug | 纯信息（原 P4） | log_only | ❌ 不注入 |

Header 标签：`[拦截/CRIT]` / `[拦截/NORM]` / `[拦截/DBG]`

---

## 根因分类（统一术语）

| 根因 | 优先级 | 来源 detector |
|------|--------|-------------|
| `confabulation` | critical | confabulation |
| `turn_limit` | critical | turn-limits |
| `tool_permission` | critical | permission-enforcer |
| `stuck_loop` | critical | edit-failure-loop |
| `edit_discipline` | critical | permission-enforcer (R2,R3) |
| `verify_discipline` | critical | permission-enforcer (R3) |
| `behavior_repeat` | critical | deviation-chain (T1,T2) |
| `quality_degrade` | normal | quality-degrade |
| `attention_signal` | normal | attention-monitor |
| `context_pressure` | debug | turn-limits |
| `log_info` | debug | — |

---

## [DEPRECATED] 探索债务模型（codegraph 触发，已被 DebtLedger 取代）

> ⚠️ 已废弃。以下描述的 `explorationDebt` / `carryover` 字段已从代码中完全清除。替代为 `DeptLedger.exploration` 分类（见 §⑥）。

旧机制（Phase 17，2026-07-15 废弃）：
- 连续 Read/Grep ≥3 次提醒，≥5 次阻断
- 调一次 codegraph 永久放行（可作弊）

Phase42 新机制：
- `DebtLedger.exploration`：探索低效 +0.5。**codegraph 不直接减债**（防作弊），`repayAll()` 每次正确调用 -0.05/类
- 阈值：单类 ≥ 12 阻断；安全网 total ≥ 25 全阻断
- 域门控不累计 gate 债务（gate 债务由收敛门触发）
- 详见 `turn-control.md`

### ⑧ 工具智能集成（Phase42b）

#### 工具别名映射 — TOOL_ALIAS [P0]

**问题：** system.md 写 `codegraph_explore`，MCP 注册名是 `mcp__codegraph__codegraph_explore`。AI 按 system.md 调 → "Tool not found"。

**方案：** turn/index.ts A组 prepareToolExecution 前加短名→MCP 全名映射：

```typescript
const alias: Record<string, string> = {
  'codegraph_explore': 'mcp__codegraph__codegraph_explore',
  'codegraph_node': 'mcp__codegraph__node',
};
const mapped = alias[ctx.toolCall.name];
if (mapped) ctx.toolCall.name = mapped;
```

AI 说短名，系统自动转 MCP 全名。零认知负担。

#### knownPaths 路径豁免 [P1]

**背景：** AI 经 codegraph/LSP 查到文件路径后，Read 确认这些文件是"验证性读取"而非"探索性读取"，不应扣探索债。

**机制：**
- `knownPaths: Set<string>`（每 session newTurn 清空）
- codegraph（MCP 两工具 + 内建 `codegraph`）返回结果中所有 `.ts/.js/.tsx/.jsx/.py/.go/.rs` 路径自动提取→`knownPaths`
- LSP 返回结果中 `file.ts:行号` 格式路径自动提取→`knownPaths`
- `isExploratoryReadGrep()` 中检查：Read 路径匹配 knownPaths → 返回 false（不算探索），不扣债

#### [BulkRead] 批量标记 [P1]

**背景：** AI 做计划性批量审计时需读大量文件，这些不是"没头绪的探索"，不应被债务系统打断。

**机制：**
- AI 在推理文本中声明 `[BulkRead: src/auth/*.ts]` → `checkFaithfulness()` 检测→加入 `bulkReadPatterns[]`
- `isExploratoryReadGrep()` 中检查：Read 路径以 pattern 的 `*` 前为前缀 → 返回 false（不算探索）
- 每 session 清空，不过期积累

**防滥用：** 前缀匹配比 includes 严格（`src/auth/` 匹配 `src/auth/` 下文件，不匹配 `src/auth-helper/`）。

---

## 与缓存的关系

| 特性 | 关系 |
|------|------|
| 拦截消息（role=system） | 绕过蒸馏塔，不压缩不遮蔽。删减 = 唯一优化手段 |
| codegraph 结果（role=tool） | 蒸馏塔 `isStructuredOutput()` 保护源码块。旧结果被 `getCodegraphSummary` 压缩为 L1+L2（-93%） |
| 蒸馏塔 | 作用于 tool 消息，3 条保真层 + 结构化保护 + 压缩层 |
| 归档层 | context > 50K 时尾部 append 归档摘要 |

---

## 等价关系表

```yaml
# 旧术语 → 新统一术语
注意资源: 注意力优先级 3 级（critical/normal/debug）
P0-P4: 废弃，已对齐 WeightLevel
注入融合: InjectionRouter
拦截拦截: InterceptionManager.execute()
检测检测: detector（纯函数）
注入注入: DynamicInjector
限制限制: 根因优先级
verifyPassDetector: 已删除（2026-07-14）
budgetNotifyDetector: 已删除（2026-07-14）
MicroCompaction: 已废弃
```

---

## 决策表（AI 行为 → 系统响应）

```
我写代码:
  ├─ 写前读文件了 → 正常，无反馈
  ├─ 写前没读文件 → quality-degrade C→B→A（递进）
  └─ 写前没读 + 连续 3 次 → permission-enforcer R3 critical warn

我声明完成:
  ├─ 验证通过了 → 无反馈（正常结果，不额外注入）
  └─ 验证失败 → permission-enforcer R2 critical hint

我报告 [DONE]:
  ├─ 之前已验证过 → 无反馈 ✅（attentionMonitor 智能跳过）
  └─ 之前没验证 → attention-monitor normal hint

我质量下降:
  └─ C→B→A→S 升级 → normal 递进 ✅（qualityDegrade）

我在失败循环:
  ├─ edit-failure-loop 检测 → 一条消息，不是 5 条
  └─ 连续 3 次同一循环 → critical warn

我编造了:
  └─ confabulation + deviation-chain 记忆 → critical block

用户说"上次/以前":
  ├─ 我调了 MemoryLookup → 无反馈
  └─ 我没调记忆 → scene-memory normal hint

我连续 Read/Grep 探索:
  ├─ exploration 债务 ≥ 4 → 建议用 codegraph + maxFiles 三档引导（DebtLedger）
  ├─ exploration 债务 ≥ 8 → 警告接近阻断
  └─ exploration 债务 ≥ 12 → 阻断 Read/Grep（主动还债可解封）
```
