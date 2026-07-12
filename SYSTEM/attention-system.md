---
tags: [type/reference, domain/attention, status/draft]
keywords: [注意力, attention, 拦截, interception, 全流程, AI消费体验]
updated: 2026-07-12
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
| MicroCompaction + TruncationTracker | 我的记忆被裁剪 | `context-compaction.md` |

### ② 行动 — 我自己

AI 自主调用工具，无系统干预。

### ③ 被观察（检测）

所有检测器（detector）都是纯函数，只产生信号，不做决策。

| 检测器 | 检测什么 | 产出信号 |
|--------|---------|---------|
| ConfabulationDetector | 我在虚构内容 | confidence: 0-3 |
| GuardEngine | 我是否违反行为规则 | rule_1/2/3/4 |
| QualityDetector | 质量是否下降 | C→B→A→S 升级 |
| EditDisciplineDetector | 编辑前是否查 LSP | 连续次数 |
| VerifyDisciplineDetector | 声明完成前是否验证 | 连续次数 |
| BehaviorRepeatDetector | 同一违规是否重复 | 重复次数 |
| AttentionMonitor | 我回复中的 [DONE]/[NEED]/[CONFIRM] | 信号值 |
| DeviationChainDetector | 连续异常行为模式 | 偏差链计数 |
| TurnLimitsDetector | 是否超步数/超时 | 上限是否触及 |
| ToolPermissionDetector | 工具调用是否有权限 | 权限评估结果 |
| ContextPressureDetector | token 是否接近上限 | 使用率 |
| verifyPassDetector | 修复后验证通过 → 正向信号 | [恢复] 确认 |
| qualityDegradeDetector | 回复质量递进下降 | C→B→A→S |
| confabulationDetector | 虚构内容检测 + 证据纪律 | 0-3 置信度 |
| deviationChainDetector | 偏差链 + Guard R1 后遗症追踪 | 偏差链计数 |
| turnLimitsDetector | 步数≥45 预告 / ≥50 阻断 | warn/block |
| toolDedupDetector | 连续相同工具调用（含连续 Read） | 连续次数 |
| permissionEnforcerDetector | Guard R2/R3/R4 拦截 | 权限结果 |
| interceptionSummaryDetector | 拦截概况（step≥30 时） | 统计数据 |
| toolPatternDetector | 连续 Read 无 codegraph / 连续报错 | 模式匹配 |
| sceneMemoryDetector | "上次/以前"触发 → 查记忆 | 记忆匹配 |
| budgetNotifyDetector | 预算降级通知 | budget 使用率 |
| archiveInefficiencyDetector 🆕 | 低效取回：重复 Read / 未用 archive_recover | 连续次数 |
| editRetryDetector 🆕 | Edit 失败后重试 | 连续失败次数 |

### ④ 被反馈（回应）

拦截消息（来自检测器）+ 注入消息（来自注入器）合并输出。

```
① detectants → RawSignal[]
    ↓
② mergeByRootCause → 同根因合并（如 3 个"编辑违规"→1 条）
    ↓
③ calcEscalation → hint → nudge → warn → block
    ↓
④ sortByPriority + budgetCap(3) → 最多 3 条
    ↓
⑤ formatMessage → 统一格式 "[拦截/根因] 你... 建议: ..."
    ↓
⑥ InjectionRouter 接管 → 拼入 messages[] → 我收到
```

### ⑤ 回到①

本轮检测→反馈的摘要进入下轮的历史计数，用于递进升级。

---

## 5 层优先级（P0-P4）

| 优先级 | 含义 | 动作 | 递进 |
|--------|------|------|------|
| P0 | 必须立刻停止 | block_step | ❌ 直接阻断 |
| P1 | 你违规了，改正 | inject_feedback | ✅ hint→nudge→warn→P0 |
| P2 | 质量在下降，注意 | inject_feedback | ✅ log→hint→nudge→warn |
| P3 | 我注意到你说了 [DONE] | inject_feedback | ❌ 只做 1 次 |
| P4 | 纯信息 | log_only | ❌ 不注入 |

---

## 根因分类（统一术语）

| 根因 | 优先级 | 合并在哪 |
|------|--------|---------|
| `confabulation` | P0 | AntiConfabulation detector |
| `turn_limit` | P0 | TurnLimits detector |
| `tool_permission` | P0 | Permission detector |
| `stuck_loop` | P1 | Detectors merge → 1 条 |
| `edit_discipline` | P1 | EditDiscipline + Guard R2 |
| `verify_discipline` | P1 | VerifyDiscipline + Guard R3 |
| `behavior_repeat` | P1 | BehaviorRepeat + Guard R4 |
| `quality_degrade` | P2 | QualityDetector |
| `attention_signal` | P3 | AttentionMonitor |
| `context_pressure` | P4 | TruncationTracker |
| `archive_inefficient` 🆕 | P2/P3 | ArchiveInefficiencyDetector |
| `edit_retry` 🆕 | P1/P2 | EditRetryDetector |
| `log_info` | P4 | EventLog |

---

## 与其他系统的接口

| 对接系统 | 输入给谁 | 从谁获取 |
|---------|---------|---------|
| InjectionRouter | 拦截消息占 budget 槽 | 注入器列表、budget 配置 |
| ContextBuilder | — | history、事件日志 |
| InterceptionManager | detectors 注册 | 合并后的消息 |
| EventLog | 拦截事件 | 查阅记录 |

---

## 等价关系表

```yaml
# 旧术语 → 新统一术语
注意资源: 注意力优先级 P0-P4
注入融合: InjectionRouter
融合调度: InjectionRouter.dispatch()
拦截拦截: InterceptionManager.execute()
检测检测: detector（纯函数）
注入注入: DynamicInjector
限制限制: 根因优先级
```

---

## 决策表（AI 行为 → 系统响应）

```
我写代码:
  ├─ 写前读文件了 → 正常，无反馈
  ├─ 写前没读文件 → 质量 C→B→A（递进）
  └─ 写前没读 + 连续 3 次 → 编辑纪律 P1 warn

我声明完成:
  ├─ 验证通过了 → 无反馈（普通通过，旧代码仍用 this.inject()）
  ├─ 验证失败 → 验证纪律 P1 hint（旧代码处理）
  └─ 之前反复失败后本轮通过 → **P3 [恢复] 正向确认** ✅（verifyPassDetector）

我报告 [DONE]:
  ├─ 之前已验证过 → **无反馈** ✅（attentionMonitorDetector 智能跳过）
  └─ 之前没验证 → 注意力信号 P3 hint（attentionMonitorDetector）

我质量下降:
  └─ C→B→A→S 升级 → **P2→P1 递进** ✅（qualityDegradeDetector）

我在失败循环:
  ├─ stuck_loop 检测 → 一条合并消息，不是 5 条
  └─ 连续 3 次同一循环 → P1 warn

我编造了:
  └─ confabulation + 证据纪律记忆 → P0 block

用户说"上次/以前":
  ├─ 我调了 MemoryLookup → 无反馈
  └─ 我没调记忆 → **P3 hint** ✅（sceneMemoryDetector，不用 async memory recall）

我连续 Read/Grep 探索:
  ├─ 连续 3 次无 codegraph → **P3 建议用 codegraph** ✅（toolPatternDetector）
  └─ 同一工具连续报错 → **P3 建议换方法** ✅（toolPatternDetector）

注入预算降级:
  └─ budget 持续下降 → **P4 通知** ✅（budgetNotifyDetector，仅知会不干预）

我被遮蔽的内容已存档:
  ├─ 需要历史工具结果 → 检查上下文中是否有 `[已遮蔽·key:xxx·archive_recover可取回]`
  ├─ 有 → 调用 `archive_recover(key=xxx)` 取回全文 ✅
  ├─ 有但摘要够用 → 继续工作，不额外取回
  └─ 没有 → 正常 Read（新文件）

我连续 Read 同一文件:
  ├─ 已 Read 过且被遮蔽 → **P3 建议用 archive_recover** ✅（archiveInefficiencyDetector）
  └─ 新文件 → 正常 Read

我收到 [摘要] 注入:
  ├─ 摘要带 key → 需要时可 archive_recover(key) 取回全文
  └─ 摘要已足够 → 直接使用摘要内容继续工作

我 Edit 失败了:
  ├─ 第 1 次失败 → 无反馈（正常重试）
  ├─ 第 2 次同文件失败 → **P2 建议先 Read** ✅（editRetryDetector）
  └─ 第 3+ 次同文件失败 → **P1 必须先 Read** ✅（editRetryDetector 升级为 warn）
```
