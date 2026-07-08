---
tags: [type/reference, domain/guard, status/final]
keywords: [行为矫正, guard, 偏差链, deviationChain, 规则引擎]
updated: 2026-07-08
---

<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
# Guard 规则引擎 — 行为矫正后处理

> **参见：** [`turn-control.md`](turn-control.md)（回合控制权威） | [`interception.md`](interception.md)（拦截日志） | [`pitfalls.md`](pitfalls.md)（踩坑记录）
>
> 计划文件: `DECISIONS/行为矫正系统-完整实战方案.md`
> 已实现（Phase 11），源码见 `turn/guard-engine.ts`（139 行，4 条规则全量编码）
> 测试覆盖：`test/agent/turn/guard-engine.test.ts`（14 用例，全部通过）

---

## 工作原理

> 别名：偏差链守卫 / 偏差链引擎 / DeviationChainGuard

```
afterStep (line 704-722)
  │
  ├── 反事实检测 (已有 Phase 8)
  │   └── confidence >= 3 → confabulationBlocked = true
  │
  └── Guard 规则检查 (Phase 11 计划)
      ├── 规则 1: exit code 矛盾 → confabulationBlocked = true
      ├── 规则 2: 无证据声称 → eventLog.record() 仅记录
      └── 规则 3: 无编辑声称改 → eventLog.record() 仅记录
           │
           ▼
      confabulationBlocked = true
           │
           ▼
      shouldContinueAfterStop (line 843-852)
        → 检测到 confabulationBlocked
        → inject("Provide tool evidence before ending")
        → return { continue: true }
        → AI 被拦住，必须修正
```

---

## 3 条规则

| # | 模式 | 触发条件 | 动作 |
|:-:|:----:|----------|:----:|
| 1 | 拦截 | 回复含"测试通过" + exit code ≠ 0 | confabulationBlocked = true |
| 2 | 观察 | 回复含"检查发现/可以看到" + 近 2 步无 Read/Grep/LSP | eventLog.record() |
| 3 | 观察 | 回复含"已修改/已修复" + 近 3 步无 Edit/Write | eventLog.record() |

---

## 现有反事实检测（Phase 8）

位置: `turn/index.ts:704-722`

```
detectConfabulation(sig, snap) → { confidence, reason }
  confidence >= 3 → confabulationBlocked = true
```

现有检测基于工具调用特征压缩 + 质量检测，Guard 在此基础上加内容匹配层。
