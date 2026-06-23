# 拦截日志系统 — Interception

> 源码: `packages/agent-core/src/agent/turn/event-log.ts` (181 行)
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
  · 第5步: [anti_confabulation] Injected anti_confabulation (lv=S)
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
    "byVariant": { "post_edit": 12, "session_memory": 5, "anti_confabulation": 8 },
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
