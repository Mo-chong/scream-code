---
tags: [type/reference, domain/interception, status/final]
keywords: [拦截, interception, 日志, event-log, audit]
updated: 2026-07-12
---

<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
# 拦截日志系统 — Interception

> **定位：日志层** — [`attention-system.md`](attention-system.md)（统一大脑）定义 AI 完整流程。本文件只负责拦截事件的**记录 + 持久化 + 可查阅**。
>
> **参见：** [`attention-system.md`](attention-system.md)（统一大脑） | [`interception-system.md`](interception-system.md)（执行层） | [`turn-control.md`](turn-control.md)（回合层）
>
> 源码: `packages/agent-core/src/agent/interception/event-log.ts`（核心）+ `turn/event-log.ts`（委托层）
> 持久化: `packages/agent-core/src/agent/turn/event-snapshot.ts` (283 行)

---

## 解决什么问题

Guard 引擎 + 收敛门 + 偏差链 + 反事实检测 —— 这些拦截系统执行了拦截，但是事后怎么看、分析什么、怎么知道方案有效？

拦截日志系统负责：**记录 + 持久化 + 可查阅**。

---

## 架构

```
                    TurnEventLog（内存环形缓冲区）
                           │
                    pushTurn() / flush() 
                           │
              EventSnapshotBuffer（磁盘写入）
                           │
              interception-logs/<YYYY-MM-DD>.md
              interception-logs/INDEX.json
```

### 3.1 拦截系统整体架构

```
detectors/（9 个纯函数检测器）
  ├── attention-monitor      — [DONE]/[NEED]/[CONFIRM] 信号检测
  ├── quality-degrade        — C→B→A→S 质量衰退检测
  ├── confabulation          — 虚构内容检测（防幻核心）
  ├── deviation-chain        — 偏差链状态检测
  ├── turn-limits            — 回合步数上限检测（step≥45 预告）
  ├── permission-enforcer    — Guard 规则 1-4 检测
  ├── edit-failure-loop      — 同一文件连续 Edit 循环检测
  ├── tool-pattern           — 连续 Read 无 codegraph + 连续报错 + maxFiles 引导
  └── scene-memory           — 用户说"上次/以前"提醒查记忆
           │
           │ RawSignal
           ▼
InterceptionManager（决策层）
  ├── mergeByRootCause       — 同根因合并为 1 条
  ├── calcEscalation         — hint→nudge→warn→block
  ├── sortByPriority         — critical > normal > debug（3 级，对齐全系统 WeightLevel）
  ├── budgetCap(3)           — 最多 3 条/步
  └── formatMessage          — 统一 "[拦截/CRIT]" 格式
           │
           ▼
InjectionRouter（注入层）
  ├── Step 0: extraInterceptions 预批准（占 budget 槽）
  ├── Step 1-7: 正常注入器
           │
           ▼
appendSystemReminder → AI 收到 ≤3 条消息
           │
           ▼
TurnEventLog（日志层—3层结构化记录）
  │
  ▼
拦截事件池（3 层分层结构）
  L1: DetectorResult        — 原始检测信号（谁触发了什么）
  L2: InterceptionDecision  — 合并/递进/排序后的决策
  L3: DeliveryResult        — 最终注入/阻断的实际情况
  │
  ▼
聚合查询 API（AI 可自助调用）
  ├── getRootCauseTrend()     — 特定根因的触发趋势
  ├── getAllDetectorStats()   — 各 detector 效果分析
  └── getInterceptionSummary()— 整体运行概况（一行读懂）
```

> **3 层分离原则：**
> - DetectorResult：每轮有哪些检测器被触发
> - InterceptionDecision：合并后的决策（为什么发这条消息）
> - DeliveryResult：实际投递结果（发了/被预算卡了/阻断步了）
> - AI 可通过 `eventLog.getInterceptionSummary()` 快速了解拦截系统运行状况

> **Phase38i 目录重构：** 拦截日志实现代码已从 `turn/event-log.ts` 迁移到 [`interception/event-log.ts`](interception/event-log.ts)。`turn/event-log.ts` 保留为委托层（向后兼容）。新增代码直接在 `interception/` 下，不再散落在 `turn/` 中。

---

## TurnEventLog — 内存日志（event-log.ts）

### 事件类型

| kind | 含义 | action 示例 |
|------|------|-------------|
| `injection_skipped` | 注入被跳过 | `skipped_budget`, `skipped_residual`, `skipped_dedup` |
| `injection_delivered` | 注入已送达 | `injected` |
| `convergence_gate` | 收敛门动作 | `gate_held`, `gate_passed` |
| `deviation_chain` | 偏差链拦截 | `detected` |
| `confabulation` | 反事实阻断 | `blocked` |
| `verify_fail` | 验证失败拦截 | `detected` |
| `guard_observe` | Guard 观测事件 | `observed` |

### W 驱动采样（event-log.ts:113-126）

高频 variant 按权重降采样，避免日志爆炸：

```
采样率 = clamp(W × 0.5 + 0.1, 0.1, 1.0)
W=1.0 → 60%,  W=0.8 → 50%,  W=0.5 → 35%,  未配置 → 100%
```

同一 variant 在同一回合中采样决策一致（回合开始缓存）。

### 增量摘要（event-log.ts:80-92）

`getNewTurnSummary()` 只返回上次调用后新增的事件，用于 afterStep 增量注入。跨回合自动重置，**自动过滤 `interception_log` 变体自身的事件**，防止日志注入自引用循环。

---

## EventSnapshotBuffer — 磁盘持久化（event-snapshot.ts）

### 刷盘策略

| 版本 | 策略 | 见代码 |
|------|------|--------|
| **旧版（已修复）** | 攒 5 回合 或 30 分钟闲置才写 | 已删除 |
| **新版（当前）** | MAX_PENDING_ROUNDS=1，每回合有事件就立即写 | line 43-44 |

### 磁盘路径

```
<screamHome>/interception-logs/          ← screamHome = resolveScreamHome()
  ├── 2026-06-23.md          ← Markdown，按天分文件，带 [sessionId] 前缀
  ├── 2026-06-24.md
  └── INDEX.json             ← 汇总统计（atomicWrite）
```

- `<screamHome>` = `~/.scream-code/`（`resolveScreamHome()`）
- 集中管理：不跟 session 绑定，跨会话日志归一到同一组文件
- 每行日志带 `[sessionId]` 前缀，可区分来自不同会话

### 日志格式（Markdown）

```markdown
# 拦截日志 — 2026-06-23

## [session_xxx] Turn #12 — 14:32 | 8 steps
- injection_skipped/skipped_budget: 2 次
  · 第3步: [session_memory] Budget denies session_memory (t≈179, lv=D)
  · 第7步: [post_edit] Budget denies post_edit (t≈12, lv=C)
- injection_delivered/injected: 1 次
  · 第5步: [confabulation_detector] Injected confabulation_detector (lv=S)
---
```

### 会话关闭兜底

`session/index.ts:close()` 在 `flushMetadata()` 后调用 `agent.turn.flushEventLog()`：

```
session.close()
  → agent.turn.flushEventLog()
    → EventSnapshotBuffer.flush()
      → drainBatch()
        → appendToDateFile()    ← 写 Markdown
        → updateIndex()         ← 写 INDEX.json
```

所有 agent（main + 子 agent）都遍历执行 `Promise.allSettled`。

---

## INDEX.json 结构

```json
{
  "version": 1,
  "globalStats": {
    "totalEvents": 42,
    "byKind": { "injection_skipped": 30, "injection_delivered": 8, "convergence_gate": 4 },
    "byVariant": { "post_edit": 12, "session_memory": 5, "confabulation_detector": 8 },
    "lastUpdated": "2026-06-23T11:48:16.515Z"
  }
}
```

---

## 关键限制

| 限制 | 说明 |
|------|------|
| W 驱动采样可能漏记 | 低 W variant 有概率被降采样跳过，不是 100% 完整 |
| 日志文件无人查看 | 写了但没 CLI 命令查阅，需要手动去目录翻 |
| INDEX.json 只有总览无趋势 | 没有按天的统计，看不出变化趋势 |
