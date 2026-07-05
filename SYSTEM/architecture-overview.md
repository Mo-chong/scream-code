# 整体架构

> 0→4 层分层图。每 `##` 独立 knowledge chunk。Agent 类结构在本文件第 2 层。踩坑/版本历史在 `SYSTEM/pitfalls.md`。

---

## 第 0 层：Monorepo 包结构

| 包 | 位置 | 职责 |
|----|------|------|
| `agent-core` | `packages/agent-core/` | 回合控制、注入、检测器、Guard、工具执行、上下文管理、拦截日志、压缩 |
| `memory` | `packages/memory/` | 记忆存储（SQLite + FTS5 + vec0）、热冷升降、Dream 合并、评分 |
| `scream-code`（入口） | `apps/scream-code/` | CLI + TUI、命令分发、Agent 实例化、MCP 客户端 |
| `knowledge` | `packages/knowledge/` | 知识库（SQLite + fastembed + LLM 事件抽取）、multiSearch、ingest |
| `ltod` | `packages/ltod/` | LLM 提供商（Anthropic/Ollama/OpenAI）、max_tokens 天花板、请求构建 |

**构建链：** `tsdown.config.ts` 中 `deps.alwaysBundle: [/^@scream-./]` → 修改任意 `@scream-*` 包必须两段构建 `pnpm build（agent-core/knowledge/memory）→ pnpm build（scream-code）`

---

## 第 1 层：agent-core 包结构

```
packages/agent-core/src/
├── agent/
│   ├── index.ts           ← Agent 类（所有子系统的容器，见第 2 层）
│   ├── turn/
│   │   ├── index.ts       ← 回合控制核心（runOneTurn → afterStep → shouldContinueAfterStop）
│   │   ├── guard-engine.ts← 4 条 AI 行为 Guard 规则
│   │   ├── truncation-tracker.ts ← 截断自动恢复 + 步级竞争保护
│   │   └── variant-registry.ts   ← VariantScheduler + QUOTA_TABLE 配额
│   ├── context/
│   │   ├── index.ts       ← appendUserMessage / appendSystemReminder / protectHighLevelReminders
│   │   ├── content-archive.ts ← ContentArchive（LRU 2000 条/30min TTL）
│   │   ├── masking.ts     ← maskToolObservations（遮蔽旧 tool result）
│   │   └── stabilize.ts   ← stabilizePrefix（KV-cache 命中率提升）
│   ├── injection/
│   │   ├── manager.ts     ← InjectionManager（5 个注入器容器）
│   │   └── goal.ts        ← GoalInjector（计划模式）
│   ├── detection/
│   │   ├── scene-memory.ts     ← SceneMemoryDetector
│   │   ├── code-ref.ts         ← CodeRefDetector
│   │   ├── code-quality.ts     ← CodeQualityDetector
│   │   ├── confabulation.ts    ← ConfabulationDetector
│   │   └── quality.ts          ← QualityDetector（5 种信号）
│   ├── interception/
│   │   └── event-log.ts        ← 环形缓冲区 + 磁盘持久化
│   └── audit/
│       └── file-action-audit.ts ← FAA（刷盘 / 熔断 / 查错注入）
├── tools/
│   └── builtin/
│       ├── code/    ← Edit/Read/Write/Glob/Grep/Bash/LSP
│       ├── memory/  ← MemoryLookup/MemoryWrite/MemoryEdit
│       ├── context/ ← ArchiveRecoverTool
│       └── knowledge/ ← KnowledgeLookupTool
├── permission/        ← 权限管理
└── context/
    ├── types.ts       ← ContextMessage.protected
    └── compaction/
        ├── micro.ts   ← MicroCompaction
        ├── full.ts    ← FullCompaction（含 _maxTries 安全门控）
        └── ...
```

---

## 第 2 层：Agent 类组合

**文件**: `packages/agent-core/src/agent/index.ts`

### 组合属性

| 属性 | 类型 | 可选 | 说明 |
|------|------|------|------|
| `modelProvider` | `LlmCaller` | 否 | LLM 调用接口 |
| `tools` | `ToolCollection` | 否 | 注册的工具集合 |
| `history` | `ContextMessage[]` | 否 | 完整对话历史 |
| `convergenceGate` | object | 否 | 收敛检查 + 注入 + 停止 |
| `injectionManager` | `InjectionManager` | 否 | 注入管线 |
| `turnController` | 内置 | 否 | 回合控制器 |
| `permission` | `PermissionManager` | 否 | 权限管理 |
| `memoStore` | `MemoryMemoStore` | **是** | 记忆存储（sub agent 没有） |
| `knowledgeStore` | `KnowledgeStore` | **是** | 知识库（sub agent 没有） |
| `knowledgeAvailable` | boolean | **是** | 知识库可用性 |
| `sceneMemoryDetector` | `SceneMemoryDetector` | 否 | 场景记忆检测 |
| `codeRefDetector` | `CodeRefDetector` | 否 | 代码引用检测 |
| `codeQualityDetector` | `CodeQualityDetector` | 否 | 代码质量检测 |
| `confabulationDetector` | `ConfabulationDetector` | 否 | 反事实检测 |
| `qualityDetector` | `QualityDetector` | 否 | 质量检测 |
| `fileActionAudit` | `FileActionAudit` | **是** | FAA（sub agent 没有） |
| `eventLog` | `InterceptionEventLog` | **是** | 拦截日志（sub agent 没有） |

### 回合控制流

```
turnController.step(stepTool) →
  convergenceGate.beforeStep() → injectors → LLM → executeTool →
  afterStep() → [detectors run] → shouldContinueAfterStop() →
    [stopped → return | continued → loop]
```

### afterStep 流程

1. `afterStep(lastToolResult, stepToolSummary)`
2. 更新 injector 步号
3. 运行 injectors（按顺序：anti_confabulation → budget → quality → stuck）
4. `injectStuckInjector()` — 检测 3 种 stuck 模式（同文件连续编辑≥3步/同工具连续报错≥2步）
5. Guard 规则检测（guard-engine.ts）
6. `resetInjectorStepState()`
7. `shouldContinueAfterStop()` — 检查是否应该停止

### FAA 收敛门

```
步末 → convergence_gate 检查器队列
  └─ FAA checker: lastToolFailure?.isExploratory === false && !hasPassed
       ├─ BLOCKER: verifyFailedThisStep === true  → "验证失败" + FAA audit
       ├─ CRITICAL: lastBashExitCode ∈ {137, 124} → "OOM/超时" + FAA audit
       └─ WARNING: 其他错误                       → "检查输出修复" + FAA audit
```

FAA 是步末收敛检查的一部分，不属于注入管线。在步内错误信息记录后执行三级分类，针对错误类型选注入模板。

### 数据流（每步）

```
Edit/Write → filed 记 editFileThisStep
Bash 报错 → 记 toolErrorThisStep
步末 → injectors → Guard → detectors → shouldContinueAfterStop
     → 未停止 → 下一回合
```

---

## 第 3 层：内置工具

```
tools/builtin/
├── collaboration/    ← SkillTool（skill 调用）
├── memory/          ← MemoryLookup/MemoryWrite/MemoryEdit
├── code/            ← Edit/Read/Write/Glob/Grep/Bash/LSP
├── context/         ← ArchiveRecoverTool
└── knowledge/       ← KnowledgeLookupTool
```

**工具注册两步骤：** ① 代码中 `new ToolName()` 注册 ② `agent.yaml` 列出工具名。缺一不可。工具执行统一 3 阶段：`prepareToolExecution → execute → finalizeToolResult`。详见 `SYSTEM/API-REFERENCE.md §2`。

---

## 第 4 层：外部系统

| 外部系统 | 连接方式 | 说明 |
|---------|---------|------|
| LLM | `modelProvider` 接口 | Anthropic/Ollama/OpenAI，通过 `ltod` 包 |
| MCP 服务器 | `mcp.json` 三层配置 | codegraph / anysearch / context7 |
| SQLite 存储 | `better-sqlite3` / `node:sqlite` | 记忆库（FTS5+vec0）/ 知识库（FTS5） |
| 文件系统 | `jian` 抽象层 | 文件读写 |
| Python 运行时 | `child_process` | fastembed（知识库 embedding） |

---

## 架构原则

| 原则 | 说明 |
|------|------|
| **Agent 是容器** | Agent 类本身不处理业务，业务在 turn/index.ts |
| **插件化 injector** | injectors/ 每个文件一个检测器，增减不影响其他 |
| **残差注意力门控** | 所有注入通过 VariantMeta（W, D, threshold, minStepGap）控制频率 |
| **可选子系统** | memoStore / knowledgeStore / FAA / eventLog 只有主 agent 有 |
| **每层可独立替换** | tools/、injectors/、compaction/ 可单独增删不影响其他层 |