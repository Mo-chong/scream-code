# Scream Code 系统架构索引

> 说明书索引文件 — 只放链接和一句话定位
> 详细描述在 `SYSTEM/*.md`，按子系统拆分

---

## 如何用这个索引

```
你问系统问题 → 查这个索引找到对应文件
→ 读 SYSTEM/xxx.md 获取完整描述
→ 不需要每次从零查源码
```

---

## 索引表

| 子系统 | 索引文件 | 一句话定位 |
|--------|----------|-----------|
| **记忆系统** | `SYSTEM/memory-store.md` | SQLite + FTS5 + 向量三重检索，tags 存 JSON 不在 FTS5 索引中 |
| **MCP 服务器集成** 🆕 | `SYSTEM/mcp-server.md` | MCP 三层配置（用户级→父目录→项目级），codegraph/context7/anysearch，内置与 MCP 工具无权重差别 |
| **Dream 整理系统** | `SYSTEM/dream.md` | 自动去重合并/清理过期/保护标签（baohu）免疫 |
| **回合控制** | `SYSTEM/turn-control.md` | turn/index.ts 1737 行，runOneTurn → afterStep → shouldContinueAfterStop 闭环 |
| **注入系统** | `SYSTEM/injection-system.md` | inject() 三种优先级 + InjectionManager + VariantRegistry |
| **Guard 规则引擎** | `SYSTEM/guard-engine.md` | afterStep 后处理检查，confabulationBlocked → 收敛门拦截 |
| **上下文压缩** | `SYSTEM/compaction.md` | FullCompaction（LLM 摘要）+ MicroCompaction（删覆盖 Read），自动缓解窗口溢出 |
| **拦截日志** | `SYSTEM/interception.md` | 环形缓冲区 + W 驱动采样 + 磁盘持久化（每回合刷盘） |
| **CLI/TUI 层** | `SYSTEM/cli-tui.md` | apps/scream-code，dispatch → screm-tui → dialog，/memory 命令链路 + 新版标签图标 |
| **整体架构** | `SYSTEM/architecture.md` | Agent 类（agent/index.ts）组合所有子系统 |
| **踩坑与经验** | `SYSTEM/pitfalls.md` | 构建链陷阱、FTS5 限制、中文权重、路径修复等实踩记录 |
| **行为矫正方案** | `../DECISIONS/行为矫正系统-完整实战方案.md` | 融合 Guard + 记忆注入 + 收敛门的完整计划 |

---

## 快速查找

### 常见问题 → 查哪个文件

| 问题 | 先查这个文件 |
|------|-------------|
| 记忆存在哪里/怎么搜 | `SYSTEM/memory-store.md` |
| FTS5 索引了什么字段 | `SYSTEM/memory-store.md` §FTS5 |
| 能不能按 tag 过滤 | `SYSTEM/memory-store.md` §Tags |
| 注入有几种优先级 | `SYSTEM/injection-system.md` §优先级 |
| system_trigger 是什么 | `SYSTEM/injection-system.md` §system_trigger |
| 收敛门怎么拦住 AI | `SYSTEM/turn-control.md` §收敛门 |
| Guard 什么时候触发 | `SYSTEM/guard-engine.md` §触发时机 |
| /memory + i 键的完整链路 | `SYSTEM/cli-tui.md` §memory-命令 |
| 回合生命周期 | `SYSTEM/turn-control.md` §生命周期 |
| AI 编造怎么检测 | `SYSTEM/guard-engine.md` §反事实检测 |
| memory 选择器图标 | `SYSTEM/cli-tui.md` §新版图标 |
| Dream 运行流程 | `SYSTEM/dream.md` §生命周期 |
| 保护标签 baohu | `SYSTEM/dream.md` §保护标签 |
| 置顶标签 ding | `SYSTEM/memory-store.md` §标签体系 |
| 拼音标签体系 | `SYSTEM/memory-store.md` §标签体系 |
| behavior-rule 怎么过滤 | `SYSTEM/memory-store.md` §纯度控制 |
| 搜索评分 ding 权重 | `SYSTEM/memory-store.md` §dingBoost |
| MemoryEdit 怎么启用 | `SYSTEM/memory-store.md` §MemoryEdit-工具 |
| 改 agent.yaml 不生效 | `SYSTEM/memory-store.md` §构建链 |
| 数据库直接在哪里 | `SYSTEM/memory-store.md` §直接数据库操作 |
| 上下文压缩触发条件 | `SYSTEM/compaction.md` §两层压缩 |
| MicroCompaction 做什么 | `SYSTEM/compaction.md` §MicroCompaction |
| FullCompaction 什么时候调 | `SYSTEM/compaction.md` §FullCompaction |
| 拦截日志写在磁盘哪里 | `SYSTEM/interception.md` §刷盘策略 |
| 拦截日志有没有 CLI 命令 | 暂无，参考 `SYSTEM/interception.md` §关键限制 |
| 踩坑记录在哪里 | `SYSTEM/pitfalls.md` |
| MCP 工具有几种/怎么配 | `SYSTEM/mcp-server.md` |
| codegraph 索引了什么 | `SYSTEM/mcp-server.md` §codegraph |
| 内置工具和 MCP 工具有权重差吗 | `SYSTEM/mcp-server.md` §工具类型与权重 |
| 安装新 MCP server 怎么配置 | `SYSTEM/mcp-server.md` §配置格式 |
| 作者 force-push 后怎么合并 | `SYSTEM/pitfalls.md` §Git 与仓库管理 |
| Cherry-pick 后文件缺失 | `SYSTEM/pitfalls.md` §被抹掉的文件要主动从旧历史恢复 |
| 包名变更导致 import 找不到 | `SYSTEM/pitfalls.md` §包名变更 |
| Cherry-pick 后构建/bundle 不工作 | `SYSTEM/pitfalls.md` §pnpm install 是 cherry-pick 后的必修课 |

### 决策文档 / ADR（ZHU/DECISIONS/）

先看 `DECISIONS/INDEX.md` 分类索引（ADR/方案/分析/执行记录全分类）。

| 文档 | 内容 |
|------|------|
| `DECISIONS/INDEX.md` | DECISIONS/ 目录的全量分类索引 |
| `DECISIONS/行为矫正系统-完整实战方案.md` | 融合方案总设计 |
| `DECISIONS/Guard规则引擎-实战执行方案.md` | Guard 执行细节 |
| `DECISIONS/扩展方向-架构进化路线-行为学习与闭环.md` | 未来方向：P0反馈/P1学习/P2沙盒 |

---

## 文件位置速查

```
源码位置:
  packages/agent-core/src/
    agent/index.ts                → Agent 类（所有子系统的容器）
    agent/turn/index.ts           → 回合控制核心（1737 行）
    agent/context/index.ts        → appendUserMessage / appendSystemReminder
    agent/injection/manager.ts    → InjectionManager（6 个 injector）
    agent/injection/goal.ts       → GoalInjector
    agent/injection/todo-list.ts  → TodoListReminderInjector
    tools/builtin/memory/
      memory-lookup.ts            → MemoryLookup 工具
      memory-write.ts             → MemoryWrite 工具
      memory-edit.ts              → MemoryEdit 工具
  packages/memory/src/
    store.ts                      → MemoryMemoStore（SQLite + FTS5 + 向量）
    models.ts                     → MemoryMemo 数据模型
  
CLI/TUI 源码:
  apps/scream-code/src/
    tui/commands/memory.ts        → /memory 命令处理
    tui/commands/dispatch.ts      → 命令调度
    tui/components/dialogs/memory-picker.ts  → TUI 选择器
    tui/managers/dialog-manager.ts           → 弹窗管理
    tui/scream-tui.ts             → TUI 主入口
```

---

## 关键发现（速查）

> 这些是从代码审计中发现的、文档里没有的关键限制

| 发现 | 证据位置 | 影响 |
|------|----------|------|
| FTS5 不索引 tags 列 | store.ts:339 vs 344-351 | 不能 `search("tags:xxx")`，必须二次过滤 |
| memoStore 可能为 undefined | agent/index.ts:126 | sub agent 没有，必须加 guard |
| system_trigger 穿透预算 | turn/index.ts:1356-1359 | 收敛门注入不受 budget 限制 |
| sendNormalUserInput ≠ inject | context/index.ts:75-80 vs 83-91 | 前者是普通用户消息，后者是 <system-reminder> |
| inject('injection') 受 5 重限制 | turn/index.ts:1368-1419 | 重复衰减→残差→去重→预算→注册 |
---
