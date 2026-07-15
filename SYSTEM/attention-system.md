---
tags: [type/reference, domain/attention, status/draft]
keywords: [注意力, attention, 拦截, interception, 全流程, AI消费体验]
updated: 2026-07-14
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

### ⑥ 统一债务累积（addDebt，Phase40）

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

## 探索债务模型（codegraph 触发）

旧机制（Phase 17，已废弃）：
- 连续 Read/Grep ≥3 次提醒，≥5 次阻断
- 调一次 codegraph 永久放行（可作弊）

新机制（2026-07-14）：
- `explorationDebt`：探索 Read/Grep +1（同主题 +0.5）。**codegraph 不直接减债**（防作弊），非探索每 3 步 -1
- 阈值：debt ≥ carryover+4 提醒 / +7 警告 / +10 阻断
- 语义重复检测：`extractExplorationKeywords()` 提取 Grep/Read 路径关键词，近 4 步快照比对
- 跨回合 carryover = min(2, floor(debt))，防重启洗白
- 文档/配置（.md/.json/.yaml/.toml/.txt）Read 不计数
- 详见 `turn-control.md`

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
  ├─ debt ≥ carryover+4 → 建议用 codegraph + maxFiles 三档引导
  ├─ debt ≥ carryover+7 → 警告接近阻断
  └─ debt ≥ carryover+10 → 阻断（探索债务模型）
```
