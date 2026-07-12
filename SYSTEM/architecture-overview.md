---
tags: [type/reference, domain/architecture, status/final]
keywords: [架构, architecture, 全景, 子系统, 数据流]
updated: 2026-07-08
---

<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
# Scream Code 系统全景 [P0]

> **AI 上手入口** — 首次接入本文档是整个 SYSTEM/ 的第一份阅读材料。读完即可理解全局架构、核心创新、子系统关系和数据流。

---

## §1 系统定义 [P0]

**Scream Code** 是一个 AI Agent 运行时框架，提供：

- **通用 Agent 运行时** — 回合控制、工具执行、上下文管理、注入调度
- **记忆系统** — SQLite + FTS5 + vec0 向量搜索、热冷升降、Dream 合并
- **知识库** — 文档摄取、向量化、multiSearch
- **LLM 适配层** — 统一 Anthropic/Ollama/OpenAI 接口
- **CLI/TUI 入口** — `scream` 命令

### 1.1 定位

| 维度 | 说明 |
|------|------|
| 不是 | 聊天机器人框架、IDE 插件、工作流引擎 |
| 是 | Agent 运行时框架、AI 交互协议实现、Prompt 工程平台 |
| 目标用户 | AI Agent 开发者、Prompt 工程师 |
| 核心创新 | 残差注意力门控注入系统、AGENTS.md 规则三层加载、收敛性回合控制 |

### 1.2 入口点

| 路径 | 说明 |
|------|------|
| `apps/scream-code/` | CLI 入口 `scream.cmd`，命令分发 + Agent 实例化 |
| `packages/agent-core/` | 核心运行时（回合控制、注入、工具、上下文） |
| `packages/memory/` | 记忆存储 |
| `packages/knowledge/` | 知识库 |
| `packages/ltod/` | LLM 提供商适配 |

---

## §1.5 架构分层总览

SYSTEM/ 的 23 个文件按职责分为 5 层：

```
L0 入口层
  SYSTEM-INDEX · MAP · 系统说明书维护SOP
  └─ 导航入口

L1 核心执行层 —— 同一执行引擎的 4 个视图
  turn-control.md
  └─ 回合调度：runOneTurn → afterStep → convergenceGate
     ├── attention-system.md — 注意力决策（残差→预算→位置→检测）
     ├── injection-system.md — 内容执行（17 injector + router + manager）
     └── context-management.md — 数据管理（存档·审计·截断恢复）

L2 支撑层 —— 被 L1 调用的功能模块
  guard-engine · prompt-assembly · compaction · cli-tui · interception(事件日志)
  └─ 不直接驱动回合

L3 存储层 —— 被 L1/L2 读写
  memory-store · dream · knowledge

L4 独立层 —— 不参与执行，独立参考
  API-REFERENCE · agents-hierarchy · mcp-server · pitfalls · CHANGELOG
  知识库维护 · 合并上游仓库SOP
```

文档 ↔ 代码映射（部分）：

| SYSTEM 文档 | 代码目录 |
|:-----------|---------|
| turn-control.md | `turn/` (+`detectors/` +`injection/`) |
| attention-system.md | `turn/variant-registry.ts` + `facts.ts` + `budget.ts` + `detectors/` |
| injection-system.md | `injection/` (17 injector + router + manager) |
| context-management.md | `context/` + `audit/` + `turn/index.ts` (FAA) |
| interception-system.md | `turn/guard-engine.ts` + `turn/index.ts` (L1551-1555) |

阅读顺序（AI 首次接入按此顺序）：

```
① 本文（architecture-overview.md）—— 全景理解
② SYSTEM/injection-system.md —— 核心创新：注入系统
③ SYSTEM/turn-control.md —— 回合调度
④ SYSTEM/context-management.md —— 上下文管理
⑤ SYSTEM/interception-system.md —— AI 行为 Guard
⑥ SYSTEM/attention-system.md —— 注意力决策
⑦ SYSTEM/prompt-assembly.md —— Prompt 组装
⑧ SYSTEM/agents-hierarchy.md —— Agent 层级
```

---

## §2 五大核心创新 [P1]

### 2.1 注入系统 (Injection System) — 核心创新

**文件**: `packages/agent-core/src/agent/injection/*.ts` | **系统说明书**: `SYSTEM/injection-system.md`

AI Agent 本质上是一个「注入运行时」：每步对话必须向 prompt 追加 system-reminder（注入），以控制 AI 行为。Scream Code 的注入系统提供了：

- **Plugin 化 DynamicInjector** — 11 个注入器，每个文件负责一种行为控制
- **残差注意力门控** — 公式 `R = W × D^Δs`，避免同一变体重注入、控制注入频率
- **三层调度** — InjectionRouter → VariantScheduler（频率） → PositionStrategy（位置）
- **三路径架构**（A/B/C，A 已受控，B/C 待迁移）

详见 SYSTEM/injection-system.md。

### 2.2 回合控制 (Turn Control)

**文件**: `packages/agent-core/src/agent/turn/index.ts` (1737 行) | **系统说明书**: `SYSTEM/turn-control.md`

Agent 每步执行的核心循环：

```
runOneTurn()
  → perTurnSetup()
  → applyUserPromptHook()
  → 主循环 (while shouldContinue)
      → generate()        ← AI 生成
      → afterStep()       ← 检测 + 注入 + Guard
      → shouldContinueAfterStop()  ← 收敛门
```

**收敛门** (convergence gate) 是核心设计：每次 AI 生成后检查是否需要继续/停止，而非固定轮数。

### 2.3 上下文管理 (Context Management)

**文件**: `packages/agent-core/src/agent/context/` | **系统说明书**: `SYSTEM/context-management.md`

三层上下文管理：
1. **ContentArchive** — LRU 2000 条 / 4h+24h 双窗口 TTL，存完整的 tool result + 文件缓存一致性校验（statSync）
2. **MicroCompaction** — 轻量压缩，移除旧 tool result + 遮蔽 tool observations
3. **FullCompaction** — LLM 总结压缩，75% headroom 触发，含 `_maxTries` 安全门控

### 2.4 Guard 引擎 (Guard Engine)

**文件**: `packages/agent-core/src/agent/turn/guard-engine.ts` | **系统说明书**: `SYSTEM/interception-system.md`

4 条 AI 行为 Guard 规则 + 反事实检测：

| 规则 | 检测 | 修复提示 |
|------|------|---------|
| RecursionLock | 同工具循环调用 ≥3 次无其他工具 | 尝试不同方法 |
| DetourCheck | 提示 error → bash → 报错 → 再 bash 的绕路模式 | 阅读文档/搜索代码 |
| RunAwayStep | 连续 3+ 次工具失败且信任级高 | 停止 → 重新思考 |
| ToolChain | 同一工具连续调用 ≥3 次且结果均失败 | 切换方法 |

Guard 已包装为 `GuardInjector(DynamicInjector)`（路径 A 迁移完成）。

### 2.5 注意力管理 (Attention Management)

**文件**: `packages/agent-core/src/agent/turn/variant-registry.ts` | **系统说明书**: `SYSTEM/attention-system.md`

- **34 个变体**，分级 S/A/B/C/D（S 最高优先级）
- **残差公式**：`R = W × D^Δs` — `W` 基础权重、`D` 衰减因子、`Δs` 距上次注入步数差
- **步级竞争保护**：同一步多个变体竞争注入机会，每步注入上限 5 个
- **阈值衰减**：每次成功注入后 `T *= thresholdDecay`

---

## §3 五层架构 [P0]

```
第 4 层: 外部系统
  LLM (Anthropic/Ollama/OpenAI) | MCP 服务器 | SQLite | Python fastembed

第 3 层: 内置工具
  code/ (Read/Write/Edit/Glob/Grep/Bash/LSP) | memory/ | context/ | knowledge/

第 2 层: Agent 类 (所有子系统的容器)
  turn/index.ts | injection/ | detectors/ | guard-engine | compaction

第 1 层: agent-core 包
  agent/ | tools/ | permission/ | context/

第 0 层: Monorepo 包
  agent-core | memory | scream-code | knowledge | ltod
```

### 3.1 第 0 层 — Monorepo 包

| 包 | 路径 | 职责 |
|----|------|------|
| `agent-core` | `packages/agent-core/` | 回合控制、注入、检测器、Guard、工具执行、上下文管理、拦截日志、压缩 |
| `memory` | `packages/memory/` | 记忆存储（SQLite + FTS5 + vec0）、热冷升降、Dream 合并、评分 |
| `scream-code` (入口) | `apps/scream-code/` | CLI + TUI、命令分发、Agent 实例化、MCP 客户端 |
| `knowledge` | `packages/knowledge/` | 知识库（SQLite + fastembed + LLM 事件抽取）、multiSearch、ingest |
| `ltod` | `packages/ltod/` | LLM 提供商（Anthropic/Ollama/OpenAI）、max_tokens 天花板、请求构建 |

**构建链**: `tsdown.config.ts` 中 `deps.alwaysBundle: [/^@scream-./]` → 修改任意 `@scream-*` 包必须两段构建：
```
pnpm build (agent-core / knowledge / memory) → pnpm build (scream-code)
```

### 3.2 第 1 层 — agent-core 包结构

```
packages/agent-core/src/
├── agent/
│   ├── index.ts               ← Agent 类（所有子系统容器）
│   ├── turn/
│   │   ├── index.ts           ← 回合控制核心（runOneTurn → beforeStep → afterStep → shouldContinueAfterStop）
│   │   ├── variation-tracker.ts← 变体状态机
│   │   ├── guard-engine.ts    ← 4 条 AI 行为 Guard + 反事实检测
│   │   ├── variant-registry.ts← VariantScheduler（残差公式 R=W×D^Δs）
│   │   ├── truncation-tracker.ts ← 截断自动恢复 + 步级竞争保护
│   │   └── injectors/         ← 传统注入器（stuck.ts 等）
│   ├── context/
│   │   ├── index.ts           ← appendUserMessage / appendSystemReminder / protectHighLevelReminders
│   │   ├── content-archive.ts ← ContentArchive（LRU 2000 条 / 4h+24h 双窗口 TTL）
│   │   ├── masking.ts         ← maskToolObservations（遮蔽旧 tool result，keepLastN 可配，短输出保护）
│   │   ├── stabilize.ts       ← stabilizePrefix（KV-cache 命中率提升）
│   │   └── compaction/
│   │       ├── micro.ts       ← MicroCompaction
│   │       ├── summary.ts     ← 增量 LLM 摘要（上轮 ≥ 8 步时触发）
│   │       └── full.ts        ← FullCompaction（含 _maxTries 安全门控）
│   ├── injection/
│   │   ├── manager.ts         ← InjectionManager（DynamicInjector 注册表）
│   │   ├── injector.ts        ← DynamicInjector 抽象基类
│   │   ├── router.ts          ← InjectionRouter + InjectContext 类型
│   │   ├── position-strategy.ts ← system-reminder 位置策略
│   │   ├── guard-injector.ts  ← GuardInjector（✅ 注册，统一管线完成）
│   │   └── 11 个注入器文件（goal/user-prefs/plan-mode/memory-rules/...）
│   ├── detection/
│   │   ├── scene-memory.ts    ← SceneMemoryDetector
│   │   ├── code-ref.ts        ← CodeRefDetector
│   │   ├── code-quality.ts    ← CodeQualityDetector
│   │   ├── confabulation.ts   ← ConfabulationDetector
│   │   └── quality.ts         ← QualityDetector（5 种信号）
│   ├── interception/
│   │   └── event-log.ts       ← 环形缓冲区 + 磁盘持久化
│   └── audit/
│       └── file-action-audit.ts ← FAA（刷盘/熔断/查错注入）
├── tools/builtin/
│   ├── code/                  ← Edit/Read/Write/Glob/Grep/Bash/LSP
│   ├── memory/                ← MemoryLookup/MemoryWrite/MemoryEdit
│   ├── context/               ← ArchiveRecoverTool
│   └── knowledge/             ← KnowledgeLookupTool
├── permission/                ← 权限管理
└── context/                   ← 上下文类型定义
```

### 3.3 第 2 层 — Agent 类组合

**文件**: `packages/agent-core/src/agent/index.ts`

Agent 是「容器」——不处理业务逻辑，业务在 `turn/index.ts` 中。

| 属性 | 类型 | 可选 | 说明 |
|------|------|:----:|------|
| `modelProvider` | `LlmCaller` | | LLM 调用接口 |
| `tools` | `ToolCollection` | | 注册的工具集合 |
| `history` | `ContextMessage[]` | | 完整对话历史 |
| `convergenceGate` | object | | 收敛检查 + 注入 + 停止 |
| `injectionManager` | `InjectionManager` | | 注入管线 |
| `turnController` | 内置 | | 回合控制器 |
| `permission` | `PermissionManager` | | 权限管理 |
| `memoStore` | `MemoryMemoStore` | ✅ | 记忆存储（sub agent 没有） |
| `knowledgeStore` | `KnowledgeStore` | ✅ | 知识库（sub agent 没有） |
| `sceneMemoryDetector` | `SceneMemoryDetector` | | 场景记忆检测 |
| `codeRefDetector` | `CodeRefDetector` | | 代码引用检测 |
| `codeQualityDetector` | `CodeQualityDetector` | | 代码质量检测 |
| `confabulationDetector` | `ConfabulationDetector` | | 反事实检测 |
| `qualityDetector` | `QualityDetector` | | 质量检测 |
| `fileActionAudit` | `FileActionAudit` | ✅ | FAA（sub agent 没有） |
| `eventLog` | `InterceptionEventLog` | ✅ | 拦截日志（sub agent 没有） |

### 3.4 第 3 层 — 内置工具

```
tools/builtin/
├── code/        ← Edit / Read / Write / Glob / Grep / Bash / LSP
├── memory/      ← MemoryLookup / MemoryWrite / MemoryEdit
├── context/     ← ArchiveRecoverTool
└── knowledge/   ← KnowledgeLookupTool
```

**工具注册两步骤**：① 代码中 `new ToolName()` 注册 ② `agent.yaml` 列出工具名。缺一不可。
工具执行 3 阶段：`prepareToolExecution → execute → finalizeToolResult`。

### 3.5 第 4 层 — 外部系统

| 外部系统 | 连接方式 | 说明 |
|---------|---------|------|
| LLM | `modelProvider` 接口 | Anthropic / Ollama / OpenAI，通过 `ltod` 包 |
| MCP 服务器 | `mcp.json` 三层配置 | codegraph / anysearch / context7 |
| SQLite 存储 | `better-sqlite3` / `node:sqlite` | 记忆库（FTS5+vec0）/ 知识库（FTS5） |
| 文件系统 | `jian` 抽象层 | 文件读写 |
| Python 运行时 | `child_process` | fastembed（知识库 embedding） |

---

## §4 端到端数据流 [P1]

### 4.1 用户消息 → AI 回复

```
用户输入
  → scream CLI 解析命令
  → Agent 实例化（加载 agent.yaml + AGENTS.md）
  → turn/index.ts runOneTurn()
      → perTurnSetup()         重置状态 + 清空注入预算
      → appendUserMessage()    追加用户消息到 context
      → 增量 LLM 摘要注入（上轮 ≥ 8 步时 → appendSystemReminder → 尾部）
      → 意图注入 (Phase 4)

      → applyUserPromptHook()  用户消息 hook
      → 主循环:
          → generate()         LLM 生成回复（含 tool_calls）
          → executeTool()      执行工具调用
          → afterStep()        检测 + 注入 + Guard
              → injectors 运行（按顺序）
              → Guard 检测（4 条规则）
              → convergence gate（shouldContinueAfterStop）
          → 收敛 → 下一轮 / 停止
  → 返回最终回复
```

### 4.2 注入生命周期

```
turn/index.ts 注册 context
  → InjectionManager.inject(ctx)
    → InjectionRouter.dispatch(ctx)
      → 各 DynamicInjector 检查 canInject()
        → VariantScheduler 残差门控: R = W × D^Δs < T?
          → 允许 → getContent() → record()
            → PositionStrategy.format() → appendSystemReminder()
          → 拒绝 → 跳过
```

### 4.3 内存管理

```
context 消息积累（appendUserMessage / tool_calls / tool_results / system-reminders）
  → headroom < 40%? → MicroCompaction（轻量：移除旧 tool result + 遮蔽）
    → 仍不足且 headroom < 25%? → FullCompaction（LLM 总结压缩，最多 _maxTries 次）
      → injectionManager.onContextCompacted() 通知注入器适配
```

### 4.4 收敛门（每步末决定继续/停止）

```
afterStep()
  → shouldContinueAfterStop()
    → 6 种拦住理由:
      1. 无内容生成
      2. 有 Goal 但没更新 TodoList
      3. 工具失败未修复
      4. 验证失败未修复
      5. 反事实阻断（confabulationBlocked）
      6. 偏差链未修复
      7. 验证假通过
      8. 无 LSP 但改 3+ 文件（仅代码文件）
    → 有拦截 → inject() → return { continue: true }
    → 无拦截 → return { continue: false } → 回合结束
```

---

## §5 AGENTS.md 三层架构 [P1]

**系统说明书**: `SYSTEM/prompt-assembly.md`

### 5.1 加载链

```
L0 全局:  ~/.scream-code/AGENTS.md        (1.9KB)  跨项目通用规则
L1 项目集: ScreamCode/AGENTS.md            (4.5KB)  目录地图 + 决策门槛
L2 项目:  ZHU/AGENTS.md                    (6.3KB)  决策规范 + 格式契约
```

### 5.2 加载规则

1. 基于 `.git` 寻找 `projectRoot`
2. 从 `projectRoot` 到 `cwd` 的目录链收集 AGENTS.md
3. **32KB budget** 反向分配（靠近 cwd 的优先保留）
4. L0 + L2 简单拼接不覆盖，冲突 AI 自行判断

### 5.3 system.md + AGENTS.md 分工

| 文档 | 角色 | 谁写 |
|------|------|------|
| `system.md` | 框架规则（工具协议、格式契约） | 框架作者 |
| `AGENTS.md` | 项目规则（架构、偏好、决策标准） | 项目团队 |
| 不覆盖叠加 | 同级别规则无覆盖语义 | — |

---

## §6 注入系统（已统一） [P1]

**详细文档**: `SYSTEM/injection-system.md` | **源码**: `packages/agent-core/src/agent/injection/` (14 注册)

### 6.1 架构总览

```
Layer 4: 14 个具体注入器 (injection/*.ts)        ← 注入内容生成
Layer 3: TurnFlow 集成 (turn/index.ts inject())   ← 注入前预处理
Layer 2: 编排层 (router.ts + manager.ts)          ← 路由/调度/预算
Layer 1: 抽象基类 DynamicInjector (injector.ts)   ← 接口契约
Layer 0: 位置策略 InsertPosition (position-strategy.ts) ← 注入锚点
Cross:   VariantScheduler (variant-registry.ts)   ← 34 变体残差调度
```

### 6.2 17 个注册注入器（Phase37）

| 文件 | 变体 | 等级 | 触发 |
|------|------|------|------|
| `user-prefs.ts` | `user_prefs` | S | 每轮 |
| `decision-trace.ts` 🆕 | `decision_trace` | B | ILR>0.6 + step=1 |
| `intent-injector.ts` | `intent_guidance` | A/B | 意图检测命中 |
| `plan-mode.ts` | `plan_mode` | B | 计划模式 step |
| `permission-mode.ts` | `permission_mode` | A/B | 权限模式切换 |
| `working-set.ts` | `working_set` | B/C | working set 变化 |
| `error-audit-injector.ts` | `error-audit` | B | FAA 趋势检测（超时/耗时膨胀）**分析瘫痪已砍** |
| `session-summary.ts` 🆕 | `session_summary` | B | step=1 / compaction 后 |
| `tool-result-recovery.ts` 🆕 | `tool_result_recovery` | B | ILR>0.3 + hasHighValue |
| `goal.ts` | `goal` | C | 计划模式 step |
| `todo-list.ts` | `todo_list` | C | todo 列表变化 |
| `wolfpack.ts` | `wolfpack` | C | WolfPack 调用 |
| `plugin-session-start.ts` | `plugin_session_start` | C | 插件会话启动 |
| `quality.ts` | `quality_escalate` | C | QualityDetector 信号（Phase38c bypass消除改为标准残差） |
| `stuck.ts` | `system_ref_stuck` | D | 同文件编辑≥3 / 同工具报错≥2（weight 30→0.6） |
| `guard-injector.ts` | `guard-feedback` | C | checkGuard Rule 2/3/4 观察（minStepGap 0→3） |

### 6.3 残差注意力公式

```
R = W × D^Δs < T? → 允许注入

W = 基础权重（变体重要性 0.15-1.20）
D = 衰减因子（0.50-0.95）
Δs = 距上次注入的步数差
T = 动态阈值（每次注入后 T *= thresholdDecay）
```

每步注入上限：5 个（步级竞争保护）
等级制：S(最高) / A / B / C / D(最低)
位置映射：S/A → AFTER_SYSTEM (head)，B → MID_CONTEXT，C/D → AFTER_TOOL_CALL (tail)

---

## §7 架构原则 [P2]

| 原则 | 说明 |
|------|------|
| **Agent 是容器** | Agent 类组合子系统，业务逻辑在 turn/index.ts |
| **插件化 injector** | `injection/` 每个文件一个检测器，增减不影响其他 |
| **残差注意力门控** | 所有注入通过 VariantMeta 控制频率 |
| **可选子系统** | memoStore / knowledgeStore / FAA / eventLog 只有主 agent 有 |
| **每层可独立替换** | tools/、injectors/、compaction/ 可单独增删 |
| **收敛门而非固定轮数** | 每步末根据上下文质量决定继续/停止 |
| **资源敏感的压缩** | headroom < 40% Micro、< 25% Full，动态触发 |

---

## §8 快速参考 [P2]

### 8.1 关键文件

| 目的 | 文件 | 位置 |
|------|------|------|
| 系统说明书索引 | INDEX.md | `SYSTEM/` |
| 模块地图 | MAP.md | `SYSTEM/` |
| 踩坑记录 | pitfalls.md | `SYSTEM/` |
| 维护 SOP | 系统说明书维护SOP.md | `SYSTEM/` |
| 术语表 | GLOSSARY.md | 各项目根 |
| 项目规则入口 | AGENTS.md | 各项目根 |

### 8.2 关键路径

| 路径 | 用途 |
|------|------|
| `packages/agent-core/src/agent/turn/index.ts` | 回合控制核心 |
| `packages/agent-core/src/agent/turn/guard-engine.ts` | Guard 引擎 |
| `packages/agent-core/src/agent/turn/variant-registry.ts` | 注意力调度 |
| `packages/agent-core/src/agent/injection/` | 注入系统 |
| `packages/agent-core/src/agent/context/` | 上下文管理 |
| `packages/agent-core/src/agent/context/compaction/` | 压缩 |
| `packages/agent-core/src/agent/detection/` | 检测器 |
| `packages/memory/` | 记忆系统 |
| `packages/knowledge/` | 知识库 |

### 8.3 关键命令

```bash
pnpm build                                          # 构建 monorepo
pnpm build (agent-core/knowledge/memory) → pnpm build (scream-code)  # 两段构建
scream                                              # CLI 入口
scream resume <session-id>                          # 恢复会话
```

---

> 本文维护于 `SYSTEM/architecture-overview.md`。如有大范围架构变更，同步更新本文 §2-§4。
