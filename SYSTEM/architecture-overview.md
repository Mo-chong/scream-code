# ScreamCode 整体架构总览

> 架构层级图：从 monorepo 到每一行代码的分层结构。
> 核心原则：大架构套小架构，每层职责清晰，可独立维护、可独立替换。

---

## 第0层：Monorepo 顶层

```
ScreamCode/                      ← pnpm workspace root
├── package.json                 ← workspace 定义（*）
├── vitest.workspace.ts          ← 跨包测试
├── SYSTEM/                      ← 系统说明书（三件套之一）
├── ZHU/DECISIONS/               ← 决策历史（三件套之二）
├── apps/                        ← 可执行应用
│   └── scream-code/             ← CLI 入口（含 TUI）
├── packages/                    ← 功能包
│   ├── agent-core/              ← 核心引擎（主要）
│   ├── memory/                  ← 记忆系统
│   ├── skill-compiler/          ← Skill 编译器
│   ├── jian/                    ← 文件系统抽象层
│   └── ...其他                  ← plugin、rpc 等
└── .scream-code/                ← 本地配置 + skills
```

**职责**：定义包间依赖、统一测试、统一构建。

---

## 第0.1层：packages/memory — 记忆系统

```
packages/memory/
├── src/
│   ├── store.ts               ← MemoStore（SQLite + FTS5 + vec0）
│   ├── scoring.ts             ← 残差评分 R = W × D^Δs
│   ├── archive.ts             ← 记忆归档/恢复
│   └── migrations/            ← 数据库迁移
├── test/
└── package.json
```

**作用**：全局记忆持久化，通过 `memoStore`（可选）挂载到 Agent。写操作 tools 在 `agent-core/tools/builtin/memory/`。

---

## 第0.2层：packages/skill-compiler — Skill 编译器

```
packages/skill-compiler/
├── src/
│   └── compiler.ts            ← 从 SKILL.md → SkillPackage（类型检查、路径解析）
├── test/
└── package.json
```

**作用**：把可读的 SKILL.md 编译成系统可注册的 `SkillPackage`。调用关系：`MakeSkillApplyTool` → `SkillPackageWriter` → `skill-compiler`。

---

## 第1层：packages/agent-core — 核心引擎

```
packages/agent-core/
├── src/
│   ├── agent/                   ← Agent 主体（第2层）
│   ├── tools/                   ← 内置工具（第3层）
│   ├── loop/                    ← 运行时循环
│   ├── skill/                   ← Skill 系统
│   ├── tui/                     ← 终端 UI
│   └── rpc/                     ← RPC API
├── test/                        ← 测试
└── package.json
```

**核心入口**：`apps/scream-code/` 启动 → `agent-core` 创建 Agent → 进入 `turn/index.ts` 回合循环。

---

## 第2层：Agent 主体内部（第1层的 agent/ 目录）

```
agent/
├── index.ts                     ← Agent 类（容器，746行）
│   ├── 组合: turnController     ← 回合控制（核心）
│   ├── 组合: injectionManager   ← 注入管理器
│   ├── 组合: context            ← 对话上下文
│   ├── 组合: toolManager        ← 工具管理
│   ├── 组合: skillManager       ← Skill 管理
│   ├── 组合: mcpManager         ← MCP 连接
│   ├── 组合: memoStore          ← 记忆系统（可选）
│   ├── 组合: backgroundManager  ← 后台任务
│   ├── 组合: cronManager        ← 定时任务
│   ├── 组合: workingSet         ← 文件追踪
│   ├── 组合: permissionManager  ← 权限
│   ├── 组合: records            ← 持久化
│   └── 组合: logger             ← 日志
├── turn/                        ← 回合控制器（第2.1层）
│   ├── index.ts                 ← TurnController（2150行核心）
│   ├── injectors/               ← 注入器集合
│   │   ├── anti_confabulation.ts ← 防编造注入
│   │   ├── budget.ts            ← 预算注入
│   │   ├── quality.ts           ← 简洁指令注入
│   │   ├── stuck.ts             ← ☑ Phase21: 痛点感知注入
│   │   └── base.ts              ← 注入器基类
│   ├── signature.ts             ← 签名
│   └── variant-registry.ts      ← 残差注意力注册表
├── injection/                   ← 注入系统
│   ├── manager.ts               ← InjectionManager（5个injector）
│   └── injector.ts              ← DynamicInjector（基类）
├── compaction/                  ← 上下文压缩
│   ├── micro.ts                 ← MicroCompaction
│   └── full.ts                  ← FullCompaction
├── goal/                        ← Goal 系统
├── plan/                        ← 计划模式
├── wolfpack/                    ← Wolfpack 批量模式
└── permission/                  ← 权限管理
```

---

## 第2.1层：回合控制 — 每步执行流程

```
TurnController.handleAfterStep()  ← 每步的"下班"处理
│
├── 1. 更新 injector 步号
├── 2. 运行 injectors (按顺序):
│   ├── anti_confabulation     ← 防编造
│   ├── budget                  ← 预算控制
│   ├── quality                 ← 简洁指令
│   └── stuck                   ← ☑ 痛点检测（Phase21 新增）
├── 3. injectStuckInjector()   ← 检测3种stuck模式
├── 4. GuardEngine 规则检测    ← 偏差链拦截
├── 5. resetInjectorStepState()
└── 6. shouldContinueAfterStop()
```

**数据流每步**: 
```
Edit/Write → 记 editFileThisStep
Bash 报错 → 记 toolErrorThisStep = ctx.toolCall.name
步末 → handleAfterStep → injectStuckInjector(editFileThisStep, toolErrorThisStep, ...)
     → 检测连续模式 → dedup/残差/间隔门控 → inject(stuckMsg)
     → resetInjectorStepState → 清空单步标记
```

---

### FAA 收敛门（Phase22 后新增）

```
步末 → convergence_gate 检查器队列
  └─ FAA checker: lastToolFailure?.isExploratory === false && !hasPassed
       ├─ BLOCKER: verifyFailedThisStep === true → "验证失败，不要跳过" + FAA audit
       ├─ CRITICAL: lastBashExitCode ∈ {137, 124} → "OOM/超时" + FAA audit
       └─ WARNING: 其他错误 → "检查输出修复" + FAA audit
```

FAA（File Action Audit）是**步末收敛检查**的一部分，不属于注入管线。它在步内错误信息（`lastBashExitCode`、`verifyFailedThisStep`）记录后执行三级分类，针对错误类型选择注入模板。

---

## 第3层：内置工具（第1层的 tools/ 目录）

```
tools/
├── builtin/
│   ├── collaboration/         ← SkillTool（skill 调用工具）
│   ├── memory/                ← MemoryRead/MemoryWrite/MemoryEdit
│   ├── skill/                 ← Skill 创建安装
│   ├── code/                  ← 代码类工具
│   └── ...
└── support/                   ← 工具支持库
```

---

## 第4层：外部系统

```
ScreamCode Agent
├──→ MCP 服务器（codegraph / anysearch / context7 / ...）
│   └── 通过 mcp.json 三层配置（用户级→父目录→项目级）
├──→ LLM（通过 modelProvider 接口）
├──→ 记忆存储（SQLite + FTS5 + vec0）
└──→ 文件系统（通过 jian 抽象层）
```

---

## 架构原则

| 原则 | 说明 |
|------|------|
| **Agent 是容器** | Agent 类本身不处理业务，业务在 turn/index.ts |
| **插件化 injector** | injectors/ 每个文件一个检测器，增减不影响其他 |
| **残差注意力门控** | 所有注入通过 VariantMeta（W, D, threshold, minStepGap）控制频率，不刷屏 |
| **可选子系统** | memoStore 只有主 agent 有，sub agent 没有 |
| **每层可独立替换** | tools/、injectors/、compaction/ 可单独增删不影响其他层 |

### Phase22 变更（2026-06-29）

Phase22 对架构做了以下补充：

| 组件 | 所属层级 | 职责 |
|------|----------|------|
| `ContextMessage.protected` | context/types.ts（上下文层） | compaction 保护标记 |
| `protectHighLevelReminders` | context/index.ts（上下文层） | 自动标记 S/A 级消息为 protected |
| `_maxTries` 安全门控 | compaction/full.ts（上下文层） | 防止全 protected 死循环 |
| `VariantScheduler` | turn/variant-registry.ts（回合层） | 注入配额 + 冷却 + 窗口调度 |
| `QUOTA_TABLE` | turn/variant-registry.ts（回合层） | default/low 两档配额 |
| `canInject/afterInject/onTurnReset` | injection/manager.ts（注入层） | 注入管线阀门占位 |
| `collectInjectorFacts` | turn/injectors/facts.ts（注入层） | 注入调度事实收集（待门控接入） |
| `injection-system.md` | SYSTEM/（文档） | 指令权重 S/A/B/C/D 全局说明书 |

**数据流新增**：turn 步末 → `VariantScheduler.shouldInject` 检查配额/冷却/窗口 → 通过后注入 → `afterInject` 记录 → compaction 时 `protected` 消息跳过。

相关文档：`SYSTEM/injection-system.md`

---

## 相关文档

- `SYSTEM-INDEX.md` — 系统索引表（入口）
- `SYSTEM/architecture.md` — Agent 类结构细节
- `SYSTEM/API-REFERENCE.md` — 接口签名参考
- `SYSTEM/pitfalls.md` — 踩坑记录
- `ZHU/DECISIONS/INDEX.md` — 决策历史
