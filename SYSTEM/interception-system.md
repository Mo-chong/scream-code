---
tags: [type/reference, domain/interception, status/final]
keywords: [拦截, interception, 决策, 优先级, 根因合并, InterceptionManager]
updated: 2026-07-12
---
<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
# 拦截管理系统 — InterceptionManager

> **定位：实现参考** — [`attention-system.md`](attention-system.md)（统一大脑）定义 AI 的完整 5 步流程。本文件只负责执行层：detectors 怎么注册、消息怎么合并、递进怎么计算。
>
> **参见：** [`attention-system.md`](attention-system.md)（AI 读这个） | [`interception.md`](interception.md)（日志存储） | [`injection-system.md`](injection-system.md)（budget 共享）
>
> 源码: `packages/agent-core/src/agent/interception/`（Phase38a 基础设施）

---

## 解决什么问题

44 个拦截/阻断/收敛点散落在 8 个管道中，AI 同一时间最多收到 5 条同根因消息。拦截管理系统负责：**统一决策 + 根因合并 + 递进控制 + AI 体验统一**。

### 分界原则

| 系统 | 职责 |
|------|------|
| InterceptionManager（本系统） | 决定"要不要做"（block / inject / log） |
| InjectionRouter（融合注入） | 决定"怎么做"（注入内容组装 + 频率控制） |
| TurnEventLog（logging） | 记录"做了什么"（持久化 + 可查阅） |

---

## 核心架构

```
InterceptionManager（中央调度器）
  │
  ├── detectors[]（纯检测函数）
  │     └─ 只做一件事: 检测到模式 → RawSignal
  │     └─ 注册式: registerDetector(fn)
  │
  ├── mergeByRootCause（根因合并）
  │     └─ 同根因的信号 → 1 条统一消息
  │
  ├── calcEscalation（递进策略）
  │     └─ 基于历史触发计数 → hint / nudge / warn / block
  │
  ├── sortByPriority + budgetCap(3)
  │     └─ P0 > P1 > P2 > P3 > P4
  │     └─ 最多 3 条/步
  │
  └── formatMessage（统一输出格式）
        └─ "[拦截/P1] 失败循环 | 连续 3 次验证失败..."
```

---

## 5 层注意力优先级

| 优先级 | 含义 | 动作 | 递进 |
|--------|------|------|------|
| critical | 阻断/纪律 | block_step / inject_feedback | ❌ critical 直接阻断不递进。normal 递进 |
| normal | 质量偏差/信号 | inject_feedback / inject_feedback | ✅ hint→nudge→warn→block |
| debug | 纯信息 | log_only | ❌ 不注入 |
| **合计** | **3 级（对齐 WeightLevel）** | | |

---

## 根因分类

| 根因 | 说明 | 优先级 |
|------|------|--------|
| `confabulation` | 虚构内容 | critical |
| `turn_limit` | 回合上限 | critical |
| `tool_permission` | 工具权限 | critical |
| `stuck_loop` | 失败循环 | critical |
| `edit_discipline` | 编辑未查 LSP | critical |
| `verify_discipline` | 跳过验证 | critical |
| `behavior_repeat` | 重复违规 | critical |
| `quality_degrade` | 质量下降 | normal |
| `attention_signal` | [DONE]/[NEED] 等 | normal |
| `context_pressure` | token 压力 | debug |
| `log_info` | 纯日志 | debug |

---

## 数据流

```
Step 开始
  │
  ├─ agent.interception.execute(ctx)
  │   │
  │   ├─ 1. 运行所有 detectors → RawSignal[]
  │   ├─ 2. mergeByRootCause() → 同根因合并
  │   ├─ 3. calcEscalation() → 历史递进
  │   ├─ 4. sortByPriority + budgetCap(3)
  │   └─ 5. 输出: blocked? + messages[]（AI 直接收到）
  │
  ├─ (Step 正常执行)
  │     AI 收到 ≤3 条格式化消息
  │
  └─ triggerHistory 更新（用于下轮递进）
```

## 配置

拦截系统的所有阈值/开关/递进参数集中在 `interception/config.ts`：

```typescript
// 默认配置
const config = {
  maxMessagesPerStep: 3,
  priorities: { /* P0-P4 各层配置 */ },
  escalation: {
    hintToNudge: 2,     // 第 2 次触发 → nudge
    nudgeToWarn: 4,     // 第 4 次触发 → warn
    warnToBlock: 6,     // 第 6 次触发 → block
    autoResetAfterSteps: 15,
  },
};
```

> **完整策略说明见** [`attention-system.md`](attention-system.md)（决策表、AI 行为→系统响应映射、等价关系）。本文件仅记录 `interception/` 目录源码的实现细节。

### edit_failure_loop —— Edit循环检测器（v3 新增）
- rootCause: stuck_loop
- priority: critical
- confidence: 0.75
- phase: post_step
- 触发条件：同一文件在同一轮中连续 Edit 2次以上
- 文件：interception/detectors/edit-failure-loop.ts
- 注册：agent/index.ts
