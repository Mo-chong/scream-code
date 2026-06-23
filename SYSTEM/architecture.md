# 整体架构 — Agent 类

> 源码: `packages/agent-core/src/agent/index.ts` (746 行)

---

## Agent 组合了哪些子系统

```
Agent
├── context                    ← 对话上下文（context/index.ts）
├── config                     ← 配置
├── usage                      ← token 用量
├── tools / ToolManager        ← 工具注册和执行
├── skills / SkillManager      ← skill 管理
├── background / BackgroundManager  ← 后台任务
├── cron / CronManager         ← 定时任务
├── goal / GoalMode            ← Goal 系统
├── memoStore / MemoryMemoStore ← 记忆系统（可选!）
├── sessionMemory / SessionMemory ← 会话记忆
├── workingSet / WorkingSet    ← 工作集文件追踪
├── dreamTracker / DreamTracker  ← 压缩记忆提取
├── turn / TurnController      ← 回合控制（1737 行核心）
├── injection / InjectionManager ← 注入管理器
├── permission / PermissionManager ← 权限
├── plan / PlanMode            ← 计划模式
├── wolfpack / WolfPackMode    ← Wolfpack 模式
├── records / Records          ← 持久化记录
└── logs / Logger              ← 日志
```

---

## 关键字段

| 字段 | 类型 | 位置 |
|------|------|:----:|
| `agent.memoStore` | `MemoryMemoStore \| undefined` | index.ts:126 |
| `agent.context` | `AgentContext` | index.ts |
| `agent.sessionMemory` | `SessionMemory` | index.ts:127 |
| `agent.workingSet` | `WorkingSet` | index.ts:128 |
| `agent.emitEvent()` | 事件发布 | index.ts |
| `agent.log` | Logger | index.ts |

---

## 架构特点

- **Agent 是容器**，不直接处理业务逻辑，业务在 turn/index.ts
- **memoStore 可选**：只有主 agent 有（设了 screamHomeDir），sub agent 没有
- **events 发布** 驱动 TUI 更新
- **records 持久化** 驱动断点续传
