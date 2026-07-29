<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
---
tags: [type/changelog, status/final, domain/system]
keywords: [changelog, 开发日志, Phase, CHANGELOG, 更新日志]
updated: 2026-07-23
---

> 更新规则 [P0]: 上游合并日志 / 二开发日志 两条线独立记录

| 规则 | 条件 → 动作 | 格式 |
|------|-------------|------|
| 上游合并 [P0] | 从原始仓库合并版本 → 顶部倒序插入 | `## v{大版本}.{小版本}.{补丁} — 合并上游 v...` |
| 二开发日志 [P0] | 手动更新 / 二开新增功能 → `二开发日志` 节追加 | `### Phase{N} — 标题（YYYY-MM-DD）`，正向 |
| Section 分类 [P1] | 按变更性质选子节 | `新功能` / `修复` / `变更` / `文档` / `框架源码引用` / `未实现` |
| 路径标注 [P1] | 每个条目必须含文件路径或行号 | AI 可导航至具体文件 |
| 时间戳 [P0] | 每个 `###` 必须有日期 | 禁止无日期条目 |
| 禁止 [P0] | 混写两线 / 无路径 / 无日期 / 概括废话 / 新旧倒置 | 上游倒序、二开正向 |

---

## v0.11.2 — 合并上游 v0.10.5→0.11.2（2026-07-23）

### 重大变更
- **Web UI 完整引入**：Vue3 SPA + WebSocket 实时通信。包括 `/web` 命令、独立 web CLI、三栏工作台、多会话持久化、Goal/Todo 面板、Markdown/CodeBlock/DiffLines 渲染、权限审批面板等 30+ 组件。新增 `apps/scream-code/src/web/`（~80 文件）
- **Web MVP**：支持远程连接（port 配置）、Goal/Todo/Approval 面板、连接状态显示、自动重连

### 新功能
- **Goal 系统增强**：`/goal update` 命令、GoalGrader 改进、3-strike blocked 审计、WriteGoalNote 提示
- **Shell 输出完整保留**：`ToolResultBuilder.artifactSink` — Bash 工具截断后完整输出写入临时文件，可通过 Read 工具恢复
- **所有 TUI 组件 freeze 保护**：`packages/agent-core/src/tui/` 添加 freeze 检测，防止死渲染

### 优化
- pi-tui 0.80.14→0.80.31（4 次升级：tight-mode 窄屏、footer 定时器、resize 优化）
- memoize token 估算、tail-bias tool output、scan cache、rg-pattern-sanitize
- Goal 完成提醒（WriteGoalNote → UpdateGoal `complete` 流程）

### 修复
- Web port 冲突友好提示
- Markdown 渲染完整（代码块、图片、表格）
- RPC 协议扩展（updateGoalObjective、getTodos、TodoUpdatedEvent）
- 多个 TUI 视觉 & 稳定性 bug

### 二开影响
中高。11 文件冲突。

| 文件 | 策略 |
|------|------|
| `footer.ts`, `pulse-wave-loader.ts`, `full.ts`, `context/index.ts`, `turn/index.ts`, `result-builder.ts` | 取 theirs（上游重构，无 fork 依赖） |
| `bash.ts` | 互补合并（`sanitize: true` + `artifactSink` 合并） |
| `memory/index.ts` | 取 ours（fork 增强导 9 个 tags 函数，上游只导 2 个） |
| `memory-write.ts` | 取 ours + 互补（保留 `processTags`，吸收上游 `stripMemoryTags`） |
| `micro.ts` | 取 theirs + 补回 ContentArchive archive() |
| `package.json` | 取 theirs + 补回 `pnpm.onlyBuiltDependencies` + `patchedDependencies` |

`system.md`: 零改动。上游无 system.md 变更。fork 增强全部存活。

---

## v0.10.5 — 合并上游 v0.10.5（2026-07-23）

### 新功能
- **markit 文档引擎**：FetchURL 支持 PDF/Office→markdown（mammoth/fast-xml-parser/turndown）
- **MCP 浏览器技能注入**：Chrome DevTools MCP 连接时注入 browser skill guide
- **steer 中断机制**：用户中断 / steer 事件时挂起而非丢弃
- **权限模式徽章**：editor top border 显示当前权限模式
- **max thinking effort 选择器**：model selector 新字段

### 修复
- live-scrolling Write streaming preview 修复
- Web search 超时加固（hard timeouts + visible failure + domestic fallback）
- CI 修复（drop stale ScreamCliServiceConfig + eqeqeq）
- pi-tui 0.80.14→0.80.19 连续升级（ConPTY 写分块、全转录回放、对齐修复、committed prefix 对齐）
- 9 个运行时 bug 修复

### 变更
- `apps/scream-code/src/tui/components/` 重写：组件作用域动画 tick，自持有 footer 状态定时器

### 二开影响
中等。4 文件冲突。

| 文件 | 策略 |
|------|------|
| `tsdown.config.ts` | neverBundle 合并 `['fastembed', 'mupdf', 'onnxruntime-node']` |
| `agent/index.ts` | 双 import 保留（ContentArchive + USER_PROMPT_ORIGIN） |
| `injection/manager.ts` | router 模式 + McpBrowserSkillInjector 加入 |
| `system.md` | **增强合并**：保留 HEAD 234 行骨架 + [Pn] 权重体系 + CONTRACT → 吸收 Delivering Results / Verification 增强 / Fusion Plan / Memory vs Knowledge 对比 / Subagents 增强。257 行零冲突。 |

`system.md`: 半吸收（保留 HEAD+Pn+CONTRACT，插入上游高价值内容）。

## v0.10.0 — 合并上游 v0.10.0（2026-07-19）

### 重大变更
- **移除 `/loop` 命令**
- **`@earendil-works/pi-tui` → `@liutod-scream/pi-tui`**（删 patch 系统，清空 `patchedDependencies`）
- **品牌色改酸黄绿 `#ccfb23`**，修复 9 个 TUI 渲染 bug

### 新功能
- `/goal config wizard`：交互式 goal 配置助手
- `/title` 改为交互式标题编辑
- 响应式欢迎区、思考徽章、帮助面板改进
- WolfPack 加固：结果聚合 + 权限范围 + 超时 + 状态同步

### 修复
- TUI 渲染生命周期修复（spinner 泄漏、面板持久化、对话框追踪）
- 5 个类型错误
- i18n 精简（中英文各 -65 行）

### 二开影响
高（对比 v0.9.x）。主要变动：
- `pnpm-workspace.yaml`：保留本地 `scriptShell` 配置，删除旧 `patchedDependencies`
- 测试文件 8 个取上游
- `/loop` 相关测试跟上游删除
- `system.md`：零改动

## v0.9.7 — 合并上游 v0.9.7（2026-07-08）

### 重大变更
- **删除 `migration-legacy` 包**（完整移除 package + workspace 引用 + 代码）
- **删除 `migration` 模块**（`badge.ts` → `session-label.ts`，相关命令行和测试全部移除）
- **`session-store.ts` 大幅精简**（-155 行）

### 新功能
- cc-connect：改进 stream-json 协议对等性 + 单通道单 session 约束
- knowledge-web：添加 dirty flag + SSE heartbeat，移除飘浮动效
- TUI：升级 pi-tui 0.80.2→0.80.6，修复视口跳顶问题
- skill-center：添加 LLM 成本提示

### 修复
- 会话切换时清除 viewport + scrollback，防止内容混叠
- 编辑器 autocomplete 调用 `requestRender()` 修复
- 移除 alternate screen buffer，保留 scrollback
- 清除废弃的 audio-skill、修改图标

### 二开影响
低。3 文件冲突，`migration-legacy` 删干净跟上游走。
`system.md`: 零改动。

## v0.9.2 — 合并上游 v0.9.2（2026-07-08）

### 新功能
- /knowledge：手动下载 vector 模型，移除自动下载
- /init：显示 project root 并在执行前确认
- init.md 使用 `<TARGET_DIR>` 占位符通过 prompt-placeholders 测试

### 修复
- postinstall 语法错误，fastembed 从 node-sdk bundle 中排除
- embeddings.ts return-await lint error

### 二开影响
低。4 文件冲突：
- `tsdown.config.ts` `store.ts`: 取 HEAD（保留 fork 增强）
- `index.ts`: 互补合并
- `embeddings.ts`: 取 HEAD + 加 `clearEmbeddingModelCache` 别名桥接（兼容上游 `knowledge-store.ts` 调用方）
- `system.md`: 零改动（上游无变化）

## v0.8.11 — 注入系统三路径统一（2026-07-08）

### 新功能
- **路径 B 清零**：`turn/injectors/{stuck,anti_confabulation,quality,intent}.ts` 4 个硬编码注入函数全部迁入 DynamicInjector 管线
- **4 个新注入器**：`StuckInjector` / `AntiConfabulationInjector` / `QualityInjector` / `IntentInjector`（注册于 `injection/`）
- **QualityInjector budget 绕过**：`getResidualConfig()→undefined` 跳过残差检查 + token 预算（等价于旧版 `escalateQuality` 直接 `appendSystemReminder`）
- **管线扩展**：`InjectContext` 加 `stuckContext` / `confabulationResult` / `qualitySignals` / `intentPhase` 字段，供消费型注入器通过 `_lastInjectContext` 读取
- **方案文档**：`ZHU/DECISIONS/方案-注入系统三路径统一设计.md`

### 修复
- `router.ts` token 预算检查忽略 `residualCfg === undefined` 的注入器（L253）
- `turn/index.ts` 移除 `stuckInjectedAtStep` 属性，`runQualityDetection()` 返回 `QDetectionResult | null`

### 架构迁移
```
路径 A (DynamicInjector) ← 17 个注入器（原 14 + SessionSummaryInjector + PersistentSummaryInjector + GuardInjector 迁移）
路径 B (硬编码) ← 已清零（4 文件删除）
路径 C (GuardInjector) ← ✅ 已注册并走统一注入管线（Phase33，2026-07-10）
```

### 二开影响
低。4 个旧文件已删除，未暴露公共 API 变更。外部配置无影响。构建命令参照 SOP 使用 `bash scripts/build-dev.sh`。

### 文件变动
```
4 新建（injection/stuck, anti_confabulation, quality, intent-injector）
4 修改（injector.ts, router.ts, manager.ts, turn/index.ts）
4 删除（turn/injectors/stuck, anti_confabulation, quality, intent）
```

---

## v0.8.12 — 路径 B 残留清理 + 偏差链修复（2026-07-08）

### 修复
- **路径 B 残留引用清理**：`turn/index.ts` 中 4 行 import + 4 处旧函数调用（`injectAntiConfabulation`/`injectStuckInjector`/`escalateQuality`/`injectIntentGuidance`）+ `stuckInjectedAtStep` 属性全部删除
- **行为变体偏差链无法解除**：`tryResolveDeviationChain()` 缺失第 3 个条件分支（`'行为变体'`），导致 `guard_feedback_rule_2/3` 触发后永远无法 `deviationChainResolved = true`
- **时序接线**：`turn/index.ts` 新增 `_intentPhase/_confabResult/_qualitySignals/_stuckContext` 4 个 class field，`injection.inject(context)` 在 `handleBeforeStep` 中携带全部检测结果

### 二开影响
低。旧函数名已全部删除，新管线是 v0.8.11 已注册的注入器子类。外部调用无直接影响。

### 文件变动
```
4 修改（turn/index.ts, injection-system.md, pitfalls.md, CHANGELOG.md）
```

---

## v0.8.10 — 合并上游 v0.8.10（2026-07-07）

### 新功能
- 知识图谱网页重写：白色简约风、平滑镜头过渡、自动旋转、实体面板、语言切换
- FusionPlanTool 从 TUI 移至 agent-core（子代理可递归 spawn explore）
- TUI 全面国际化：运行时中英文切换 + 首次安装自动检测系统语言
- /knowledge 菜单显示 embedding 模型状态

### 修复
- 知识图谱：初始相机距离、双击折叠、web 视觉改进
- i18n：删除重复 key、修复 module 级 t() 过期
- 中文标题 h1→h2（防止 GitHub 仓库描述被覆盖）
- 环境变量方括号写法（兼容 TS 严格模式）
- 测试/lint 修复

### 二开影响
低。FusionPlanTool 冲突已通过 keep-local 解决。其余为 TUI 层改动。

## v0.8.5 — 合并上游 v0.8.5（2026-07-06）

### 新功能
- **memory/embeddings**: Engine cache 防并发重复下载，`cacheDir` 参数可配置模型缓存路径，HF sidecar 自动补全（缺失 tokenizer/config 文件自动从 mirror 下载），5min 超时保护，重试 3 次
- **memory/classifiers**: `value-classifier.ts` 记忆价值自动分类（critical/valuable/normal/low），`category-tagger.ts` 自动推断类别标签
- **memory/store**: 嵌入模型加载失败后 5 分钟自动重试循环（`startEmbeddingLoadLoop`）
- **agent/index**: 暴露 `memorySearch()`/`memoryAppend()` EmbeddingSearch API，`/knowledge` 命令集成
- **tui**: `/knowledge filter` 命令，按标签/时间段过滤知识图谱
- **新建文件**: `knowledge-filter.ts`, `value-classifier.ts`, `category-tagger.ts`

### 文档维护（2026-07-06）
- **SYSTEM/knowledge.md**: 新增（213 行），覆盖知识库全景：架构/Ingestion 管线/6 表+FTS5+vec0 存储/Extractor 实体事件抽取/7 步多跳图谱检索管线（FTS5+向量+LLM实体抽取+BFS 1跳+re-rank+兜底）/KnowledgeLookup 工具/增量更新状态/记忆对比/源码索引
- **SYSTEM/API-REFERENCE.md §9**: 修正表结构（4 表→6 表+3 FTS5）、去重描述（自动跳过→报错需先删再入）、工具注册条件（对等 Memory）、适用场景（SYSTEM docs + project source docs）
- **system.md**: KnowledgeLookup 描述从 1 行扩至 2 行，补充搜索范围（SYSTEM docs + project source docs）和返回值（event entities + search trace）
- **CHANGELOG.md**: 本条目

### 合并
- 上游 v0.8.5 合入本地二开分支
- `embeddings.ts` 手动合并：上游 engineCache 架构为基底 + 本地绝对路径 cache/超时/重试/清缓存/fallback
- `agent/index.ts` 双保留：上游 EmbeddingEngine 类型 + 本地 PlanMode/pre-warm
- `store.ts` 双保留：上游 embeddingLoadLoop + 本地 sqlite-vec/hot-cold/value-tier
- 版本号: packages/*/package.json 0.8.4→0.8.5

## v0.8.4 — 合并上游 v0.8.4（2026-07-06）

### 新增模块
- **render-messages.ts** — `packages/agent-core/src/agent/compaction/render-messages.ts` 新增
  - `renderMessagesToText(messages, opts?)` — 消息列表 → 纯文本渲染
  - `countMessageTokens(text, model?)` — token 计数
- **knowledge-web / knowledge-store** — TUI 命令新增（上游 2 个新文件）
- **CompactionReport** — `strategy.ts` 新增类型，携带压缩前后 token 统计信息

### 重构（upstream）
- **FullCompaction 主循环** — `full.ts:475-570` 扁平 while(true) → `summarizeOnce` 封装
  - `project` + `maskToolObservations` 移入 summarizeOnce 内部
  - 新增 `summarizeWithFallback()` 递归降级 + overflow 自动减量重试
  - 新增 `COMPACTION_INSTRUCTION`/`COMPACTION_UPDATE_INSTRUCTION` 模板驱动 prompt
- **MicroCompaction 两阶段过滤** — `micro.ts` 从单 `isUseless` 拆分为：
  - `isUseless` — `msg.useless === true` → uselessMarker
  - `isOversizedTruncatable` — token 数 > minContentTokens → 截断 + 可选 archive
- **context/index.ts** — `addToolResult` 自动标记 `useless` 字段

### 新字段
- `ExecutableToolSuccessResult.useless?: boolean` — context/types.ts + loop/types.ts
- `FullStrategy.lowWaterMark` — 防反复触发
- `FullStrategy.reactiveAttempted` — 防 overflow 循环
- `MicroConfig.keepRecentTokens: 40_000` + `pruneMinReclaimTokens: 20_000`

### 合并信息
- 分支：本地 main + `origin/main`（v0.8.1→v0.8.4，3 个版本）
- 冲突 6 个：context/types.ts（互补）, loop/types.ts（互补）, embeddings.ts（互补）, models.ts（互补）, full.ts（逐行合并）, micro.ts（逐行合并）
- 构建：agent-core + scream-code 两段编译链零错误

## v0.8.3 — AGENTS.md 加载验证与 prompt-assembly 修复（2026-07-05）

### 发现问题
- **AGENTS.md 32KB 预算分配方向相反** — 收集顺序（全局→项目）与预算分配顺序（项目→全局）方向相反，导致 ScreamCode 根 55KB AGENTS.md 独占总预算，全局 AGENTS.md 0 字节注入
- **prompt-assembly.md §3 漏 3 个模板变量** — `SCREAM_WORK_DIR` / `SCREAM_WORK_DIR_LS` / `SCREAM_ADDITIONAL_DIRS_INFO` 未在变量表中列出
- **prompt-assembly.md §6 加载逻辑有误** — 错写为 `resolve.ts → loadAgentsMd()`，实际来源为 `context.ts → collectAgentsFiles() + renderAgentFiles()`；缺预算分配、截断逻辑和实测数据

### 验证手段
- 三组新对话实地测试：ScreamCode根(41.4KB)、allgzmulu根(12.4KB)、D:/(14.4KB) 对比 systemPromptChars
- 日志 `scream-code.log` 的 `systemPromptChars` 字段交叉验证
- 每个对话 AI 报告 AGENTS From: 来源确认加载差异

### 文档修复
- `SYSTEM/prompt-assembly.md` — §3 模板变量表补全 3 个缺失变量；§6 重写为合并+截断逻辑，含实测数据表；§10 风险点补预算分配方向、32KB 总预算说明、SCREAM_WORK_DIR 与 projectRoot 区分
- `ZHU/DECISIONS/AGENTS-MD加载验证报告与结论.md` — 完整验证报告

### 关键数据
| 场景 | systemPromptChars | AGENTS 可见来源 |
|------|------------------|----------------|
| ScreamCode根 | 41,431 | 根 55KB（截断前 ~32KB），全局 0 |
| allgzmulu根 | 12,369 | 全局 7.6KB（全部） |
| D:/根 | 14,419 | 全局 7.6KB（全部） |

---

# Scream Code 版本更新记录

> 记录上游 LIUTod/scream-code 各版本的新功能、修复和 API 变更，以及二开 fork (Mo-chong/scream-code) 的本地定制改动。
> 当前本地版本：v0.8.4（合并于 2026-07-06）

## v0.8.2 — 本地 Phase26: 缓存感知架构与统一压缩方案（2026-07-04）

### 新增模块
- **content-cache** — `src/agent/turn/content-cache.ts` 跨步内容去重
  - `isDuplicate(variant, content)` — 前缀 60 字符 hash 对比，同 variant 同内容跳过
  - compaction 后 `reset()` 失效全部缓存
- **event-log.agentType** — `src/agent/turn/event-log.ts` 注入事件增加 `agentType` 字段
  - 所有 `eventLog.record()` 调用注入 `this.agent.type`（'main' | 'sub' | 'independent'）
  - 主子 agent 注入行为可区分分析

### 优化改动
- **position-strategy** — A 级从 'near_head' 升级为 'head'，feedback/post 从 'near_head' 降级为 'tail'
- **GrowthPredictor** — 简单平均 → EMA（α=0.4），时间间隔归一化
- **AttentionPositionStrategy** — 新增未知 variant 告警（console.warn，每个 variant 仅一次）
- **AuditLogWriter** — Phase26 新增审计日志系统

### 文档
- `SYSTEM/phase26-cache-aware.md` — 缓存感知架构与审查日志系统说明
- `ZHU/DECISIONS/系统模块协调诊断与缓存优先级的统一架构方案.md` — 架构方案（v3.3）
- `API-REFERENCE.md` — 补 GrowthPredictor(EMA) / ContentHashCache / InterceptionEvent.agentType

---

### 本地新功能
- **guard-engine** — 4 条 AI 行为 Guard 规则全量，14 测试覆盖
  - 路径：`packages/agent-core/src/agent/turn/guard-engine.ts`
  - 规则：exit code 矛盾阻断 / 无证据声称标记 / 无编辑声错误修改 / 记忆仅代码断言门控
- **TUI 美化** — DOM diff 安全渲染、双层调试防护、CJK 字符滚动修复、spinner 层级优化
- **MoE 配置** — 上下文记忆注入标签配置：`should-consult-memory` 和 `memory-consulted` 作为 MoE 门控

### 上游 v0.7.7-v0.8.0 合并
- **Knowledge Store**（上游 v0.8.0 新增子包 `packages/knowledge/`）：
  - SQLite (node:sqlite) 知识库：chunks/events/entities/relations 四表 + FTS5 全文索引
  - ingestFile()：md/txt → chunk → embedding (fastembed bge-small-zh-v1.5) → LLM 事件抽取
  - multiSearch()：7 步检索链路（embedding → Entity Recall → BFS 100 → Coarse Rank 50 → LLM Rerank 5 → Dedup）
  - KnowledgeLookupTool：AI Agent built-in 工具，知识库查询能力
  - **依赖**：Python + fastembed 包，首次加载自动下载 ~30MB 模型
  - **限制**：只支持 .md/.txt；无增量更新（改文件需删掉重录）；每 chunk 1 次 LLM 调用
- **响应格式修正** — like.ts 文本简化、测试断言同步
- **能力清单修正** — agent 能力声明格式调整
- **凑整优化** — 响应精简

### 合并信息
- 分支：`mochong/liuyiyi` + `origin/main`（v0.7.2→v0.8.1，5 个版本跨版本合并）
- 冲突 5 个：like.ts(取上游+重应用文本)、like.test.ts(取上游改断言)、system.md(--ours)、agent/index.ts(互补合并)、agent/tool/index.ts(互补合并)
- 验证：guard-engine 14/14 + like.test 8/8 通过，alwaysBundle 完好

---

## v0.7.6 — 子 Agent 模型绑定（2026-06-30 合并）

### 新功能
- `/model diy subagent bindings` — 运行时为不同子 agent 指定不同模型（如 `/model agent=diy planner=gpt-4`）
  - 路径：`packages/agent-core/src/session/subagent-host.ts`
  - API：新增 `setSubagentModelBindings` hook，将 /model diy 配置路由到子 agent 创建路径
- `per-subagent usage display` — TUI 中实时显示每个子 agent 的 token 用量
- `delegation prompt tuning` — 子 agent 委派 prompt 优化，上下文传递更精准

### 修复
- fix(tui): wire /model diy bindings to subagent spawn path
- fix(tui): /tasks 卡死修复
- fix(tui): plan mode 提示重设计
- fix(tui): 呼吸时序同步
- README 多处更新（章节标题调整 + 功能补充）

### 二开兼容
- 合并冲突 12 个，其中 10 个已自动/手动解决
- `alwaysBundle` 配置完好，本地注入系统/配额调度不受影响
- 踩坑 #39-#41 记录在 `SYSTEM/pitfalls.md`

---

## v0.7.5 — 持久化与交互增强

### 新功能
- `fusion-plan 持久化` — Plan 策略跨会话保留
  - 路径：`apps/scream-code/src/tui/utils/fusion-plan.ts`
  - API：`SCREAM_FUSIONPLAN_TIMEOUT_SECONDS` 环境变量（30..3600s）
- `/like 命令` — 快速记录用户偏好/人设偏好
  - 路径：`apps/scream-code/src/tui/commands/like.ts`
- `FusionPlanStatus` 实时组件 — TUI 中计划状态实时显示

### 修复
- fix(fusion-plan): timeout 可配置
- fix(fusion-plan): 进程树清理（`taskkill /T` on Windows / `kill(-pgid)` on POSIX）
- fix(profile): 保留子 agent role instructions 同时注入用户偏好
- fix(update): 优先用 fresh npm 版本检查而非缓存
- fix(startup): 在 loading splash 内预取更新检查
- fix(fusion-plan): 移除 --yolo 冲突

---

## v0.7.4 — TUI 大版本优化

### 新功能
- **状态机优化与风暴守护者** — TUI 状态流转更稳定，异常风暴自动防护
- **model thinking level 同步** — think level 在 TUI 中实时显示 effort 标签
- **gradient sheen + ping-pong breathing** — 加载动画升级：渐变色呼吸光效
- **gradient subtitle/prompt + logo-prompt 间距** — UI 美化
- **render batching + container caching** — TUI 渲染批处理减少重绘

### 依赖
- bump `pi-tui` to 0.80.2 + migrate patches

---

## v0.7.3 — 安全与防死循环

### 新功能
- **noop-loop-guard** — 防止无操作死循环
  - 路径：`packages/agent-core/src/tools/builtin/file/noop-loop-guard.ts`
  - 机制：检测到连续 noop 步骤时自动终止循环，防止无限占用量化窗口
- **secret obfuscation** — 日志/输出中对敏感信息自动掩码
  - 路径：`packages/agent-core/src/agent/secrets.ts`
  - 机制：通过正则匹配 API Key、Token 等敏感模式，替换为 `***`

### 依赖
- bump 各类依赖版本

---

## v0.7.2 — 二开 fork 基点

上次成功合并上游的版本，也是本二开 fork (Mo-chong/scream-code) 的主要分叉点。

---

## 二开发日志（Mo-chong fork）

### Phase38-39 — 拦截系统正收益审计 + codegraph 智能触发 + 探索债务模型（2026-07-14）

**拦截系统优化：**
- 删除 4 个 detector (verifyPass / toolDedup / interceptionSummary / budgetNotify)，13→9，-31%，0 安全损失
- Priority 5→3 对齐：P0_block/P1_discipline → critical, P2_quality/P3_signal → normal, P4_info → debug。10 文件旧字面量全清零
- SYSTEM 说明书同步：attention-system.md 全量重写, interception.md/ interception-system.md/ turn-control.md/ API-REFERENCE.md 更新
- maxFiles 引导：tool-pattern.ts 文案含三档引导（12/3/1）

**codegraph 智能压缩：**
- mask-tool-observations.ts: isCodegraphResult() + getCodegraphSummary()，旧结果 ~4,000→~300 tokens（-93%）
- 先于 isStructuredOutput() 拦截 codegraph 源码块，避免被结构化保护整段保留

**探索债务模型（替换 Phase 17 二进制门控）：**
- explorationDebt：探索 +1（同主题 +0.5），codegraph -2，非探索衰减 -0.1
- debt ≥ carryover+4(suggest) / +7(warn) / +10(block)
- 语义重复检测：extractExplorationKeywords() 提取 Grep/Read 路径关键词，近 4 步快照比对
- 跨回合 carryover = min(3, floor(debt))，防重启洗白
- 消除 dummy call bypass 漏洞（旧：调一次永久放行）

**决策文档（2 份）：**
- DECISIONS/分析-拦截系统正收益审计.md — 13 detectors 逐项 + 外部 7 论文 8 开源验证 + AI 消费角色四维评分
- DECISIONS/方案-3-codegraph智能触发机制重设计.md — 完整方案，749 行（含附录 A 智能压缩 + B 工具对比）

### Phase40 — 偏差链优化 + addDebt + system.md 精简（2026-07-15）

**偏差链 P0-P2（U1-U6）：**
- U1 删 C2（验证失败→偏差链，与收敛门 G2 冗余）
- U2 精简 C3 6→3（删 scene_memory_recall / step_after_edit / step_after_verify_fail）
- U3 crossTurnFlags 精简
- U4 删 T1 毒性拦截（统一走收敛门 G3）
- U5 收敛门 severity 分区（HIGH/LOW）
- U6 墨克尔审计链（SHA256，event-log.ts）

**addDebt 统一债务累积：**
- 所有工具报错统一加债 0.5（Bash 超时除外）
- FIX_SUFFIX：高频工具修复路径映射（Edit→/edit-fix / Read→node / Grep→explore）
- quality-degrade 消息改写（嵌入 bestMessage + 长度保护）
- 收敛门 MAX_CONVERGENCE_INJECTIONS = 5→3

**system.md 工具优先级格式化：**
- 去掉编号列表（对齐 format 的 No cross-segment ordering）
- callees/impact/affected 中文改英文 + 提到 codegraph 块内
- codegraph 三条前置：explore / node / callees+impact+affected

**P3 推敲结论：** U7 fail-closed 不推荐 / U8 语义死锁不推荐 / U9/U10 收益有限。

**拦截系统优化：**
- **删除 4 个 detector** (verifyPass / toolDedup / interceptionSummary / budgetNotify)，13→9，-31%，0 安全损失
- **Priority 5→3 对齐**：P0_block/P1_discipline → critical, P2_quality/P3_signal → normal, P4_info → debug。10 文件旧字面量全清零
- **SYSTEM 说明书同步**：attention-system.md 全量重写, interception.md/ interception-system.md/ turn-control.md/ API-REFERENCE.md 更新
- **maxFiles 引导**：tool-pattern.ts 文案含三档引导（12/3/1）

**codegraph 智能压缩：**
- mask-tool-observations.ts: isCodegraphResult() + getCodegraphSummary()，旧结果 ~4,000→~300 tokens（-93%）
- 先于 isStructuredOutput() 拦截 codegraph 源码块，避免被结构化保护整段保留

**探索债务模型（替换 Phase 17 二进制门控）：**
- explorationDebt：探索 +1（同主题 +0.5），codegraph -2，非探索衰减 -0.1
- debt ≥ carryover+4(suggest) / +7(warn) / +10(block)
- 语义重复检测：extractExplorationKeywords() 提取 Grep/Read 路径关键词，近 4 步快照比对
- 跨回合 carryover = min(3, floor(debt))，防重启洗白
- 消除 dummy call bypass 漏洞（旧：调一次永久放行）

**决策文档（2 份）：**
- `DECISIONS/分析-拦截系统正收益审计.md` — 13 detectors 逐项 + 外部 7 论文 8 开源验证 + AI 消费角色四维评分
- `DECISIONS/方案-3-codegraph智能触发机制重设计.md` — 完整方案，749 行（含附录 A 智能压缩 + B 工具对比）


### Phase42 — 智能上下文注入：域门控 + 分类债务账本 DebtLedger（2026-07-15）

**新文件（4）：**
- `audit/debt-ledger.ts` — 分类债务账本，替代 explorationDebt 一锅烩
- `injection/domain-analyzer.ts` — 域分析引擎 + INJECTOR_DOMAIN_MAP + shouldSkipByDomain
- `injection/knowledge-menu.ts` — KnowledgeMenuInjector + REQUEST: 协议
- `interception/output-constraint.ts` — 输出格式约束注册表

**分类债务账本 DebtLedger：**
- 4 分类：exploration / tool_error / reasoning / gate，各自记债
- 分类阻断：exploration 超限→封 Read/Grep，tool_error 超限→封 Edit/Write，total≥25→全阻断
- 3 种偿还：每次正确调用 repayAll()、连续3次正确奖励、收敛门解决 repayGate()
- toolToCategory() 工具名自动映射，FIX_SUFFIX 分类引导（不再一刀切"用 codegraph"）

**域门控 + 优先级提升：**
- analyzeActiveDomains() 从推理文本关键词+工具调用推断活跃域
- 域门控跳过不相关注入器（shouldSkipByDomain），噪音减少
- 域匹配注入器自动提升优先级（debug→normal, normal→critical）
- user-prefs 位置 8→2（紧跟 plugin-session-start，利用 Attention Sink）

**qualityIndex 反馈回路：**
- audit/quality-baseline.ts：session-end 写 ~/.scream-code/quality-baseline.json
- session-start 读取并注入反馈
- 修复 2 bug：convergenceHits 过滤条件错 + faithfulness 只记不一致

**关联改动：** turn/index.ts（DebtLedger 替换 9 处 explorationDebt/carryover）、manager.ts（user-prefs 第 8→2）、router.ts（域门控 + level boost）、variant-registry.ts（CRITICAL 识别）。已清：`explorationDebt` 字段。

**Phase42b — 工具智能 + 路径豁免 + 批量标记（2026-07-15）：**
- **工具别名映射（TOOL_ALIAS）**：turn/index.ts A组，`codegraph_explore`→`mcp__codegraph__codegraph_explore`，`codegraph_node`→`mcp__codegraph__node`。AI 调短名自动转 MCP 全名，不再报"Tool not found"。
- **knownPaths 路径豁免**：codegraph/LSP 返回的文件路径自动记录到 `knownPaths: Set<string>`，Read 匹配这些路径不算探索债。验证性读取不再扣币。
- **\[BulkRead\] 批量标记**：AI 声明 `[BulkRead: src/auth/*.ts]` 后，前缀匹配的 Read 全部豁免探索债。计划性批量审计不被打断。
- **isExploratoryReadGrep 增强**：增加 knownPaths + bulkReadPatterns 两项豁免检查。

**Phase42c — `/like` workStyle 字段 + 格式修正（2026-07-15）：**
- **背景**：Phase41 Work Style 是直接编辑 `user-prefs.md` 加的，`/like` schema 只有 nickname/tone/other 三字段。跑 `/like` 会覆盖丢失。
- **修复（5 文件）：** `config.ts` — `TuiLikePreferencesSchema` 加 `workStyle: z.string().optional()` | `like.ts` — `handleLikeCommand()` 加第 4 输入框 + `buildRoleAdditionalText()` 加 Work Style 段落输出 | `zh.ts` / `en.ts` — 3 条 i18n 翻译（标题/提示/示例）。
- **格式修正：** `user-prefs.md` 手动整理为 41 行：Work Style 6 条逐行排列、5 条规则分条、4 示例独立代码块。无中文尾部多余文字。
- **构建验证：** `agent-core 7.7s + scream-code 5.7s = EXIT 0`

**Phase42d — 回合内实时反馈闭环 + quality_feedback 删除（2026-07-15）：**
- **回合内 3 缺口分析：** faithfulness 只记录不注入 / 域门控只过滤不推荐 / 收敛门不拦工具选择（all 代码行号验证）
- **已执行（2/3）：**
  - `[Faithfulness Alert]` 实时注入 — `checkFaithfulness()` mismatch 时 `this.inject('[Faithfulness Alert] 推理说X但实际调了Y')` + `variant: 'faithfulness_alert'`
  - G4 收敛门 — 收敛门复用 event-log 最近 faithfulness 记录，`action==='mismatch'` 追加 lowReasons
- **已否决（1/3）：** 域门控主动推荐 — 已有探索债务覆盖，额外注入破坏缓存
- **P0 quality_feedback 删除：** `step 1 readBaseline()+getFeedbackInjection()` 全量删除。原因：跨 session 质量分跟本轮任务无关系（噪音），且每次文字不同导致 step 1 前缀缓存断裂。
- **quality-baseline.ts 重构：** `QualityBaselineData` 加 `scores?` 可选字段 | `writeBaseline()` 加第二参数存 5 维分数 | `getFeedbackInjection()` 改为优先输出具体分（降级兼容旧数据）→ 后因 cross-session 噪音问题删除调用
- **5 维具体反馈（P0 已执行）：** `getFeedbackInjection()` 输出从 3 档模糊分改为 5 维具体分（`✅好:工具准确=94` / `❌注意:推理一致=38`）。后因跨 session 噪音问题删除 step 1 注入，数据继续存 `quality-baseline.json` 供后分析。
- **跨 session 方向修正：** 判定跨 session 质量分无 / 本轮任务相关（噪音），改为 event-log 后分析检测真实退化模式时才尾部追加注入。
- **清理：** `turn/index.ts` 删 8 行 step 1 `quality_feedback` 块 + import 清理 `readBaseline/getFeedbackInjection`（只剩 `writeBaseline`）
- **构建：** `agent-core 5948ms + scream-code 5476ms = EXIT 0`

**Phase42c-ext — 缓存审计增强（2026-07-17）：**
- **AuditLogEntry** 新增 `prevHitRatio` + `hitRatioDelta` 字段：每轮日志自动带命中率变化对照（负=退化，正=恢复），无需人肉对比。
- **构建验证**：通过。

**Phase42d-ext — Checkpoint + SnipHinter + edit_error_fix 即时注入（2026-07-17）：**
- **CheckpointManager**（`utils/checkpoint.ts`）双向快照。`/rewind N`（/rw）`/forward`（/fw）TUI 命令。
- **SnipHint** 接口 + 5 工具裁剪声明（Bash/Read/LSP/Grep/Glob）。
- **edit_error_fix** variant：Edit 错误即时注入 fix 指令，不依赖债务累积。
- **25 文件 ToolAccesses 补齐** + **6 SYSTEM 说明书同步**。
- **构建验证**：通过。

**Phase42e — MaskingStats 遮蔽可观测性（2026-07-17）：**
- **MaskingStats** 接口 + `maskToolObservations()` 返回 `{ messages, stats }`：8 类遮蔽统计，零额外遍历。
- **maskingStats** 每轮累计：`turn-step.ts` 导出，`turn/index.ts` 重置+传入审计日志。
- **`AuditLogEntry.masking`**：ndjson 新增 `masking.total/compressed/fullyMasked/bytesSaved`。
- **TUI footer**：显示 `🧊 -X.XK mask:N cmp:N`（有遮蔽时），一眼判断遮蔽是否生效。
- **barrel 重命名**：`checkpoint-barrel.ts` → `turn-step-barrel.ts`，同时导出 `checkpoint` + `maskingStats`。
- **8 文件修改**，构建通过。

### Phase41 — 注意力与偏好系统升级：P0→P2 全量落地（2026-07-15）

**P0 — 信息结构优化：**
- user-prefs.md：新增 Work Style 6 条 + [InsufficientContext] MUST 指令
- mask-tool-observations.ts：三层感知蒸馏（L1+L2 完整保，L3 源码块砍）
- AGENTS.md 冲突清理（全局→个人风格迁入 /like，双写零冲突）

**P1 — 注意力增强 + 定量 baseline：**
- 角色前缀 + severity 标签（[Debt Monitor] [CRITICAL/WARNING/INFO]）
- output-constraint.ts（Edit/Write/Bash 格式约束）
- audit/quality-score.ts（5 维评分）
- QualityScore session-end hook → quality-baseline.ts 持久化 + session-start 反馈注入
- CRITICAL 规则进开头 10%（detectWeightLevel + KNOWN_PREFIXES）

**新文件（5）：** faithfullness.ts | quality-score.ts | quality-baseline.ts | knowledge-menu.ts | output-constraint.ts


### Phase40 — 拦截审计+CodeGraphTool内建+债务模型bugfix（2026-07-14）

**拦截系统正收益审计+执行：**
- 删除4 detector（verifyPass/toolDedup/interceptionSummary/budgetNotify），13→9，-31%
- Priority 5→3：P0/P1→critical, P2/P3→normal, P4→debug，10文件全清零
- 新增 CodeGraphTool 内建工具：callees(内部调用链)/impact(重构影响)/affected(关联测试)，66行
- Bash redirect 新增 find/fd→Glob 规则
- deviation-chain T1 尾部加 codegraph_node 引导

**codegraph 智能压缩：**
- mask-tool-observations.ts: isCodegraphResult+getCodegraphSummary，旧结果~4,000→~300 tokens（-93%）

**探索债务模型（替换二进制门控）：**
- debt+1(同主题+0.5)/codegraph-2/非探索衰减-0.1
- debt≥carryover+4(suggest)/+7(warn)/+10(block)
- extractExplorationKeywords语义重复检测，跨回合carryover

**Bugfix：**
- turn/index.ts:1381,1397 裸currentStep→this.currentStep
- 此bug导致所有finalizeToolResult hook抛ReferenceError，Read/Grep等工具全部失效

**SYSTEM说明书同步（第2轮）：**
- SYSTEM-INDEX: guard-engine→interception-system/注入器17→15
- MAP/injection-system/architecture-overview: 注入器计数统一15
- pitfalls: 新增currentStep踩坑

### Phase33 — Context Facts 尾部聚合 + 内容哈希埋点 + toolCalls TypeError 修（2026-07-10）

#### 新功能
- **Context Facts 尾部聚合 (Phase B')**: 7 个注入器（error-audit/working-set/goal/todo-list/wolfpack/plugin-session-start/guard-injector）接入 `recordFact()` 接口，在 `manager.inject()` 尾部统一格式化为 `[Context Facts]` 结构化块注入。AI 在尾巴 U 形第二高点一眼扫完所有注入器关键状态，无需扫描 3-8 块碎片 | git diff 11文件 107行 | vitest 24/24 | 缓存影响零
- **内容哈希测量埋点 (Phase M)**: `DynamicInjector` 基类新增 `_lastContentHash` + `getLastContentHash()` 访问器，`InjectResult` 新增 `contentHash?: string` 字段

#### 接口变更
- `ContextMemory` 新增 `recordFact(key, value, level)` + `flushContextFacts(): string | null`
- `InjectionManager.inject()` 尾部集成 try/finally flush 流程
- `DynamicInjector` 新增 `getLastContentHash(): string | null`
- `InjectResult` 新增 `contentHash?: string`

#### Bug 修复
- **`_lastContentHash` 脏数据**: 不注入轮次 `_lastContentHash` 残留旧值 → 加 `else { null }` 清空
- **`flushContextFacts` 异常安全**: dispatch 抛异常时 `_contextFacts` Map 泄漏 → `try { dispatch } finally { flush }`
- **`recordFact` mock 兼容**: 7 个注入器使用 `?.()` 可选链，test mock 环境不崩溃
- **toolCalls 缺失 TypeError**: 增量摘要构造 Message 时缺 `toolCalls` 字段（隐式 undefined）→ 下游 `for...of undefined` 崩。两层修复：上游 `summary.ts` 加 `toolCalls: []`，下游 `tool-call-id.ts` 三处加 `?? []` 防御 | 详见 `SYSTEM/pitfalls.md`
- **`_summaryTriggered` 从未赋值 true**: 审计日志 `summaryTriggered` 字段声明了、日志写了，但成功生成摘要后没设 `true`，2718 条记录全是 false。修复：`turn/index.ts:2075` 加 `this._summaryTriggered = true` | 详见 `SYSTEM/pitfalls.md`

#### 文档
- `SYSTEM/injection-system.md`: 新增 §Context Facts 尾部聚合节，融合计划 + Phase B'/M 行
- `SYSTEM/API-REFERENCE.md`: 新增 `recordFact/flushContextFacts/getLastContentHash` 签名 + InjectionEvent.contentHash
- `SYSTEM/pitfalls.md`: 新增 "toolCalls 缺失导致 TypeError" 设计误区条目
- `ZHU/DECISIONS/ADR-7-注入位置优化与尾部聚合策略.md`: 废弃原 Phase 1，修正为 Phase B' + Phase M
- `ZHU/workspace/研-ADR7验证与重设计分析.md`: 补全 2718 条日志实证

#### 经验教训
- Phase 1 原计划是假前提：源码证明 B 级注入器实际已在尾部（`appendSystemReminder`），先查源码再写计划
- ADR 必须带源码验证，否则方向可能全错
- 审计日志 2718 条确认缓存已 98.13%，"优化缓存"方向错的
- `as SomeType[]` 是红牌：类型断言跳过类型检查，后续所有安全失效。禁止 `as` 强转，改显式补字段或用 `satisfies`
- 对可选数组字段（如 `message.toolCalls`），`for...of` 或 `.length` 前必须加 `?? []` 防御——TypeScript 通用防御模式
- 异常触发时机不直观的 bug（"停一段时间后首次消息崩"），查日志确认触发条件比瞎猜更快

---

### Phase34 — reasonix shim 清理 + guard-bundle-stale Windows mtime 修复 + 合并 v0.9.7 善后（2026-07-08）

#### 基础设施
- **D:\reasonix 路径混淆 — 彻底修复**: 旧全局安装的 scream shim 文件（`scream`/`scream.cmd`/`scream.ps1`）指向过时的 `npm global` 路径，导致构建错误混淆到 `D:\reasonix`。修复：新建 `D:\AI\ScreamCode\bin\`，写入 3 个正确 shim（bash/cmd/ps1），指向 `packages/agent-core/dist/index.mjs`；回收站删除旧 shim；`npm uninstall -g scream-code` 清理全局包。`which scream` → `/d/AI/ScreamCode/bin/scream` ✅ | 零源码/文档引用 reasonix
- **`guard-bundle-stale.sh` Windows mtime 假阳性修复**: `find -newer` 比较文件 mtime，但 Git on Windows 的 `checkout/merge/stash` 会覆写所有已跟踪文件的时间戳，导致 100% 假阳性拦截 commit。修复：改用 `git diff HEAD --name-only` 只检查**实际内容变更**，不受 mtime 影响

#### 文档
- `SYSTEM/合并上游仓库SOP.md`: line 290 旧 reasonix 描述更新为新 bin/ shim 路径
- `SYSTEM/知识库维护.md`: 修复缺失的 maintain 标签
- `system.md.baseline-v0.9.7`: 创建上传后基线

#### 影响评估
- 零：shim 清理和 guard 修复都是基础设施层面，不影响 Scream Code 功能逻辑或 API 签名

---

### Phase31 — L4 结构化注入：KnowledgeSearchResult 追加 sourcePath（2026-07-08）

#### 新功能
- `KnowledgeSearchResult` 接口追加 `sourcePath` 字段（值来自 `knowledge_sources.file_path`），AI 直接获得来源文件路径 | 2 行代码，构建通过 ✅

---

### Phase30 — SYSTEM 参见互联核查 + SOP 升级（2026-07-08）

#### 文档维护
- **SYSTEM/ 23 文件参见互联核查** — 按 T0→T4 层级逐文件正查（自身参见准确性）+ 反查（其他文件是否缺本文件引用）+ 功能迁移状态。6 处修改
- **6 处参见修改：**
  - `architecture-overview.md`：删除参见（架构枢纽不需外指）
  - `API-REFERENCE.md`：删除参见（接口签名表独立维护）
  - `context-management.md`：+turn-control
  - `attention-management.md`：+context-management +guard-engine
  - `prompt-assembly.md`：+turn-control（重排列序）
  - `compaction.md`：旧"体系集成"→标准参见制式 +turn-control
  - `memory-store.md`：+pitfalls
- **系统说明书维护SOP** — 新增 YAML frontmatter 规范（type/domain/status 三类可选值）、参见验证流程（Grep 正文文件名确认，≤5 条，不写人类语）、读回检查清单 7 项、决策树增加参见维护规则、禁止假关联和 updated 日期遗漏
- **文档**：`ZHU/DECISIONS/记录-SYSTEM参见互联核查与SOP优化.md` / `ZHU/DECISIONS/INDEX.md` 计数 112→118

#### 框架源码引用
- 无（纯文档维护）

---

### Phase26 — 缓存感知架构与审查日志系统（2026-07-04）

#### 新功能
- **注入位置修正**（P0）— `position-strategy.ts:29` A 级 `near_head→head`，`:38` feedback_/post_ `near_head→tail`。缓存破坏范围缩小 55%。对所有有前缀缓存的模型有效
- **DeepSeek KV 缓存字段解析**（P0）— `openai-common.ts:242-254` 解析 `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens` → `ltod/usage.ts` TokenUsage 的 `cacheHitTokens?`/`cacheMissTokens?`
- **缓存审计日志**（P1）— 新建 `audit-log.ts`（163 行），每轮写入 `workspace/cache-audit.ndjson`。含 CacheMetrics 计算 + 告警规则（hitRatio<0.2 告警，>0.8 静默）
- **动态自适应压缩阈值**（P1）— 新建 `predictor.ts` GrowthPredictor（38 行），记录最近 5 轮 token 增长，预测下次压缩时机（均值×1.2）。`strategy.ts` 集成：shouldCompact 优先用 predictor，fallback triggerRatio
- **FullCompaction token 量跟踪**（P1）— `full.ts:70,432` 新增 `lastCompactedTokens`，审计日志记录每次压缩释放量
- **keepRecentMessages 扩到 30**（P1）— `micro.ts:20` 20→30

#### 修复
- **recordRound 集成缺口**（2026-07-04 修复）— `strategy.ts:58-60` 定义了 `recordRound` 但 `turn/index.ts` 未调用。Grep 全项目仅定义本身 1 个匹配。修复：`turn/index.ts:1733-1738` 加 `this.strategy.recordRound(totalInput)`

#### 测试
- 新增 3 个测试文件 15 个测试全通过：`cache-audit.test.ts(5)` / `predictor.test.ts(6)` / `strategy-threshold.test.ts(4)`
- `CompactionStrategy` 接口新增 `recordRound` 方法签名

#### 文档
- 新建 `SYSTEM/phase26-cache-aware.md`（compact notation，AI 可读）
- `SYSTEM-INDEX.md` 索引表挂载 Phase26 条目
- `SYSTEM/CHANGELOG.md` 本日志追加二开发记录

#### 未实现
- P2 TUI usage-panel 缓存命中率展示（格式：`⚡ usage: 12.4K in / 1.2K out | 缓存命中率: 66%`）

### Phase27 — ScreamCode 全盘目录清理与 .git 重建（2026-07-05）

#### 背景
`D:\AI\allgzmulu` 集合目录下 .git 是大杂烩，意外跟踪了 8 个不相干项目（ScreamCode/ZHU/、Reasonix/、WorkBuddy/等）。ScreamCode 项目目录内杂项堆积：Obsidian vault 混在根目录、workspace 分散 3 处、system.md 外的 AGENTS.md 冗余。

#### 目录清理（ScreamCode 边界内）
- **Obsidian 搬迁** — `.obsidian/` + `docs/*` → 统一迁入 `ScreamCode/obsidian/`（移除根下 Obsidian 配置污染）
- **隔离删除** — `.scream-code/AGENTS.md`（含 Obsidian wiki 规则，干扰 AGENTS.md 层级设计）、根下杂文件 `L0-decisions.md` `reasonix-backup.map.md`
- **SYSTEM 链接撤销** — `obsidian/SYSTEM` 符号链接从 ScreamCode 根搬到 obsidian/ 后因 Git Bash `rm -rf` 跟随链接误删源目录，从 ScreamCode 独立仓库 `git checkout HEAD -- SYSTEM/` 恢复
- **回收站安全规则** — AGENTS.md（home + ZHU）写入硬性规则：禁止 `rm`，统一走 PowerShell 回收站
- **workspace 统一** — `ScreamCode/workspace/` 为唯一工作区；`ZHU/workspace/` 和 `docs/workspace/` 清理；`allgzmulu/workspace/` 的 ScreamCode 产物拉回（15 文件），其余 22 个记忆系统一次性文件整目录清回收站
- **ZHU 残留清理** — `ZHU/.workbuddy/`（WorkBuddy 缓存）清回收站

#### .git 重建
- **大杂烩解除** — `allgzmulu/.git` 跟踪 8 个项目。ScreamCode/ZHU/ 从大仓库 `git rm --cached` 解除跟踪，`.gitignore` 防反弹
- **ZHU 独立仓库** — `ScreamCode/ZHU/` 新建 `git init`，提交 109 个文件（`0df9535`）
- **清大杂烩** — `allgzmulu/.git` 全回收站。Reasonix 系列因自有独立 .git 完全不受影响
- **`.mempalace-shared/` 迁回** — 从 allgzmulu 根搬到 `Reasonix/.mempalace-shared/`

#### 决策记录
- `ZHU/DECISIONS/ScreamCode目录清理与工作计划.md` — 目录整理全流程执行记录（Phase1→验收）
- `ZHU/DECISIONS/全盘目录修复方案.md` — 五大痛点诊断 + .git 重建方案

### Phase28: AGENTS.md 分层架构设计与实现 [2026-07-05]

#### 新增
- **`SYSTEM/agents-hierarchy.md`** — 全新专题文档，完整定义三层AGENTS加载链（.git→findProjectRoot→dirsRootToLeaf→collectAgentsFiles→budget） + 四维评估框架 + 语言设计规范 + 55KB提取方法论
- **`ScreamCode/AGENTS.md`** — L1 项目集合级 AGENTS.md（4.5KB/149行），含 §1 目录地图/§2 决策门槛/§3 框架认知/§4 注意力地图/§5 通用规则/§6 回退锚点
- **`ZHU/AGENTS.md`** — L2 增强版（6.3KB/208行，原80行），新增 §2 格式契约/§4 L1-L2 协同/§5 ZHU 命令速查/§6 防降智检查

#### 变更
- `SYSTEM/MAP.md` / `SYSTEM-INDEX.md` / `SYSTEM/INDEX.md` — 追加 agents-hierarchy.md 索引

#### 框架源码引用
- `packages/agent-core/src/profile/context.ts` L42-170 — 加载链源码验证（findProjectRoot/dirsRootToLeaf/collectAgentsFiles/renderAgentFiles 精确行号）

#### 设计文档
- `DECISIONS/AGENTS-MD分层方案-当前真实状态.md` — 完整迭代（3版本：去重导向→能力增强→语言规范整合）

### Phase29: 缓存审计 UI + 日志轮转 + sessionId [2026-07-08]

#### 新功能
- UI footer 第二行显示缓存命中率：`ScreamCode\ZHU    ⚡ 单：96.9% ┃ 总：96.8%`
  - 百分比颜色：≥90% 绿 / 80-89.9% 黄 / <80% 红
  - 左端显示启动目录（末两层），灰色对齐上下文行
  - 单步缓存率来自 `currentTurn`，总缓存率来自 `total`（对话累计）
- 缓存审计日志按日期轮转：`cache-audit-YYYY-MM-DD.ndjson`，每日一个文件
- 审计日志每行新增 `sessionId` 字段，支持按对话查询
- **缓存诊断**：`AuditLogEntry.injected` 记录每轮注入的变体名，定位缓存破坏源头

#### 修复
- UI 缓存率翻倍 bug：`event.usage.total` 已是累计值，旧代码再次累加导致指数增长
- 审计日志注入诊断链路：dispatch() → `getLastInjectResults()` → `buildAuditEntry(injectedNames)` → ndjson

#### 框架源码引用
- `packages/ltod/src/providers/openai-common.ts` L228-258 — `extractUsage()` 提取 `prompt_cache_hit_tokens`/`prompt_cache_miss_tokens`
- `packages/agent-core/src/agent/usage/index.ts` L43-50 — `UsageRecorder.data()` 中 `total`/`currentTurn` 来源
- `packages/agent-core/src/agent/usage/audit-log.ts` L69-145 — `AuditLogWriter` 按日轮转 + sessionId + injected
- `packages/agent-core/src/agent/injection/router.ts` — `getLastInjectResults()` 暴露注入诊断
- `apps/scream-code/src/tui/components/chrome/footer.ts` L155-175 — `pickCacheColor` + 第二行渲染
- `apps/scream-code/src/tui/controllers/session-event-handler.ts` L636-651 — 缓存字段提取到 AppState
- `SYSTEM/phase26-cache-aware.md` — 缓存诊断字段表 + 注入破坏等级表

#### 文档
- `SYSTEM/CHANGELOG.md` — Phase29 条目

### Phase30: SYSTEM 参见互联核查 + 维护SOP升级 [2026-07-08]

#### 修复
- SYSTEM 全目录 23 文件参见互联核查：逐文件 Read 头部参见 → Grep 验证正文提及 → 反查全目录引用，6处假关联/缺失关联修复
- `SYSTEM/architecture-overview.md` — 删除假参见
- `SYSTEM/API-REFERENCE.md` — 删除假参见
- `SYSTEM/attention-management.md` — 补 context-management + guard-engine 互参见
- `SYSTEM/context-management.md` — 补 attention-management + guard-engine 互参见
- `SYSTEM/compaction.md` — 补 turn-control 参见
- `SYSTEM/memory-store.md` — 删假参见，补 turn-control + knowledge 互参见

#### 变更
- `SYSTEM/系统说明书维护SOP.md` — YAML frontmatter 规范 + 参见验证流程 + 强制规则 4 条
- `SYSTEM/CHANGELOG.md` — 标头规则双轨制（上游倒序/二开正向/路径标注/时间戳强制）

#### 新功能
- `SYSTEM-INDEX.md` — 顶部加 3 行阅读顺序
- `SYSTEM/architecture-overview.md` — §1.5 架构分层总览 + 旧§8合并入§1.5 + §9→§8重编号
- `SYSTEM/MAP.md` — "AI导航指南"→"阅读顺序"引用同步

#### 文档
- `DECISIONS/记录-SYSTEM参见互联核查与SOP优化.md`
- `DECISIONS/方案-SYSTEM目录架构重构-三层互联计划.md`（v1→v2→v3→终版）

### Phase31: 知识搜索 L4 结构化注入 + 注入系统审计 [2026-07-08]

#### 新功能
- `packages/knowledge/src/types.ts` + `store.ts` — KnowledgeSearchResult 追加 `sourcePath`（2行代码，值来源 `knowledge_sources.file_path`）
- `SYSTEM/knowledge.md` — §6.3 追加 `sourcePath` 行

#### 文档
- `DECISIONS/分析-注入系统全面审计-变体评估与优化方向.md` — 全量源码审计（初版→勘误版：文件数29→18、行数~2500→~1670、DynamicInjector 15→14）

### Phase32: 注入系统 FAA 修复 + 全量记录升级 [2026-07-09]

#### 修复
- **FAA 双路径并行**（🔴 P0）：`turn/index.ts` L2075 inline path 删除 + `manager.ts` 注册 ErrorAuditInjector + `variant-registry.ts` 加 `error-audit` VARIANT_META → 构建 EXIT 0
- **guard-injector 孤儿类**：Phase22 空壳 DEPRECATED → Phase33 已完成迁移（注册 `'guard-feedback'`，setGuardData/getInjection，统一管线）

#### 变更
- **FAA 全量工具记录**：旧 Edit/Write 独占 → `finalizeToolResult` hook 内全工具覆盖（Bash/Read/Grep/LSP）
- **resultPreview 真实内容**：从 `"D:\\path"`（文件名）→ 截取工具输出前 500 字
- **durationMs 真实计时**：`_toolStartTimers` Map → `authorizeToolExecution` 记起始时间 → `finalizeToolResult` 计算差值

#### 文档
- `workspace/验收-FAA双路径清理分析报告.md`
- `workspace/验收-注入系统全面审计执行总结.md`（8 方向全链路）
- `DECISIONS/分析-注入系统全面审计-变体评估与优化方向.md` 勘误版落地

#### 框架源码引用
- `packages/agent-core/src/agent/turn/index.ts` L103 — `_toolStartTimers` 私有字段
- `packages/agent-core/src/agent/turn/index.ts` L1123 — `authorizeToolExecution` 加 timer set
- `packages/agent-core/src/agent/turn/index.ts` L1136-1151 — `finalizeToolResult` FAA push
- `packages/agent-core/src/agent/turn/index.ts` L2080-2090 — FAA inline 删除
- `packages/agent-core/src/agent/injection/manager.ts` L39 — ErrorAuditInjector 注册
- `packages/agent-core/src/agent/turn/variant-registry.ts` L344 — `error-audit` VARIANT_META
- `packages/agent-core/src/agent/injection/guard-injector.ts` — Phase22 空壳（DEPRECATED）→ **Phase33 迁移完成**（注册 `'guard-feedback'`，setGuardData/getInjection，统一管线）
- `packages/knowledge/src/types.ts` L82-83 + `store.ts` L660 — `sourcePath`

### Phase33: ContentArchive TTL + 文件变更缓存一致性 + sharedStore 泄漏修复 [2026-07-09]

#### 新功能
- **TTL 判据 `timestamp`→`lastAccessedAt`**（`content-archive.ts:170,207,279,307`）：模型频繁 recover 的条目永不过期，不复用的正常过期。改 1 行判据 + 3 处淘汰逻辑同步
- **文件变更缓存一致性**：Point A（`context/index.ts:384-396`）存档时 `statSync` 记 `filePath`/`fileMtime`/`fileSize`；Edit/Write 后 `invalidateByPath(path)` 自动清除关联缓存条目（`turn/index.ts:1484`）；`recover()` 内 `statSync` 对比 mtime，不一致直接删（`content-archive.ts:182-196,211-220`）——覆盖 AI 自身修改 + 外部编辑器修改
- **`invalidateByPath()`** 新增方法（`content-archive.ts:340-350`）：文件被改后清除所有关联该路径的缓存条目，同步清理 sharedStore
- **`getStats()` / `pruneAll()`** 新增方法（`content-archive.ts:358-375`）：调试监控 + 强制清理

#### 修复
- **sharedStore 内存泄漏**（`content-archive.ts:267,279,307,372`）：`clear()` / `pruneInternal()` / `evictOne()` 原只清理 `this.store`，static `ContentArchive.sharedStore` 同步清理；进程运行 7 天约 350MB+ 泄漏
- **evictOne 淘汰分数用 `timestamp` 而非 `lastAccessedAt`**（`content-archive.ts:307`）：与 TTL 判据不一致

#### 文档
- `SYSTEM/context-management.md` — §1 状态表补 Predictor/缓存审计；§2 补 Point A 存档 + tool result 预处理流水线；§4 补完整参数表；§7 补缓存审计事件；§8 完整数据流重写；§9 补 predictor/audit-log；§10 依赖关系图补充
- `DECISIONS/分析-ContentArchive-Micro-Masking三系统协同分析.md` — 1037 行 12 章节全链路分析（协同/综合评判/硬伤/优化排序/缓存一致性/泄漏审计/持久化管理）
- `.gitignore` — 追加 `workspace/` + `*.ndjson`

#### 未实现
- evictOne 加权淘汰的 `lastAccessedAt` 同步虽然 TTL 判据已改，但 sharedStore 不直接参与加权淘汰（由 local store 负责，sharedStore 是超集）

### Phase33 续章：mask 增强 + 增量摘要 + BATCH_SIZE 纠正 + GuardInjector 迁移 + 审计升级 + ContextBuilder API [2026-07-10→07-11]

#### 新功能
- **maskToolObservations 增强**（`mask-tool-observations.ts`）：
  - **占位符带工具名**：`[已遮蔽·readFile·已存档·ArchiveRecover可恢复]`，AI 扫一眼知道什么工具、已存档、怎么恢复
  - **keepLastN 可配置**（`flags/registry.ts`）：通过 `SCREAM_CODE_MASK_KEEP_LAST_N` 环境变量覆盖默认 3
  - **短输出保护**：< 100 字符的工具结果跳过遮蔽，小确认不浪费
  - `turn-step.ts:79-86` 每步从 assistant 消息提取 `toolCallId→toolName` 映射传给 masking
- **增量 LLM 摘要**（`compaction/summary.ts` 新文件 + `turn/index.ts`）：
  - 最初：每 30 步调 LLM 生成结构化摘要，通过 `kind: 'system_trigger'` 注入尾部
  - Phase33 修正：改为每轮结束、上轮 ≥8 步时 → beforeStep 注入（不干扰工具调用）
  - `lastTurnStepCount` 字段替代 `totalSteps` 固定步数硬切
  - 每次注入前 `removeSystemRemindersByPrefix('[summary]')` 清理旧摘要防尾部沉积
  - `_summaryTriggered` 标记写入审计日志，可追溯触发次数
  - 增量合并——新摘要与旧摘要合并，保留最近 6 条事件，同步写入 ContentArchive key=`summary`
  - 日成本：实际 ~$0.0004/次 × 48 次/天 = ~$0.02/天（3756 步/天真实数据）
- **审计日志升级**（`audit-log.ts` + `turn/index.ts`）：
  - `AuditLogEntry` 接口新增 `turnStepCount` / `pendingRecoverKeys` / `summaryTriggered` 三个字段
  - 每次步级写入都带上这些参数
- **缓存命中率上报**（`content-archive.ts` + `audit-log.ts`）：
  - ContentArchive 新增 `hits`/`misses` 计数器
  - `getStats()` 返回 `{ hits, misses }`
  - `buildAuditEntry()` 新增 `archiveHit`/`archiveMiss` 字段
- **GuardInjector 迁移**（`guard-injector.ts`）：
  - 废弃空壳（38 行）→ **第 14 个注册注入器**（setGuardData/clearGuardData/lastFeedback）
  - 注册 `'guard-feedback'` 到 manager.ts，走统一残差/配额/去重管线
  - 位置：AFTER_TOOL_CALL（尾部），等级 C
- **ContextManager 新增 API**（`context/index.ts`）：
  - `removeSystemRemindersByPrefix(prefix)`：删除含 prefix 的 system-reminder 消息（protected 跳过）
  - 被 `updatePersistentSummary` 在注入新摘要前调用，防尾部死消息沉积
- **ltod-llm.ts `toolCalls` undefined 修复**（`agent/turn/ltod-llm.ts`）：
  - `summarizeWithLLM` 传 `tools: []`，LLM 从不返回工具调用，`toolCalls` 为 `undefined`
  - `[...result.message.toolCalls]` → `[...result.message.toolCalls ?? []]`（加 `?? []` 保底）
  - 同步修复 `deobfuscateToolCalls` 同路径
- **审计日志文件头升级**（`agent/usage/audit-log.ts`）：
  - 新建日志文件时写入 AI 可读层级架构（7 层分层）、全部 18 个字段速查、7 条 jq/grep 查询示例
  - 旧版文件头仅含简短用途说明和 2 条查询示例

#### 修复
- **BATCH_SIZE 回归常量 8**（`micro.ts`）：删 `computeBatchSize()` 动态函数，恢复 `const BATCH_SIZE`。审计日志确认 Micro Compaction 在你场景 < 1% 影响（上下文占用达不到 50% 触发条件），动态步数是方向错误。（**经验教训**：未查数据就设计优化，白干）
- **增量摘要触发机制修正**：
  - 废弃：`totalSteps` 字段 + `totalSteps % 12` 固定步数硬切 + afterStep 中间触发
  - 改为：`lastTurnStepCount` 字段记录上轮步数，beforeStep 判断 ≥8 步才触发（自然断点）
  - 新增 `removeSystemRemindersByPrefix('[summary]')` 防止尾部死消息沉积
  - 成本：~$0.0004/次，~$0.02/天（3756 步/天真实数据）
  - 缓存无影响（走 appendSystemReminder 尾部）

#### 文档
- `DECISIONS/分析-基于审计日志的上下文管理痛点与优化方向.md` — 486 行全链路分析：源码执行顺序验证 maskToolObservations 是省 token 主力（~90%）、审计日志确认 Micro Compaction 仅 0.2%、10 篇论文 + 10 个开源项目交叉验证、缓存命中率 97.41% 真实数据
- `DECISIONS/记录-BATCH_SIZE从动态回归常量8.md` — 决策纠正记录：BATCH_SIZE 不触发的原因和你场景的上下文占用率分析
- `workspace/验收-上下文管理优化执行.md` — 验收报告

#### 经验教训
- BATCH_SIZE 优化是错误方向：审计日志证实影响 < 1%，白花几天
- 所有性能优化必须先查审计日志数据，否则是拍脑袋
- maskToolObservations 不是缓存破坏者，是缓存保护者——标准化旧工具结果为固定占位符让前缀更稳定，97.41% 命中率

### Phase34: FAA Regeneration — ErrorAuditInjector 2-Pillar 趋势检测 [2026-07-10]

#### 新功能
- **ErrorAuditInjector 废弃→再生**（`error-audit-injector.ts` 165 行完整替换）：
  - 废弃旧功能：马后炮罗列最近失败记录（与 guard/偏差链完全重叠）
  - 支柱一（P0）：**超时死循环** — Bash 连续 ≥2 次失败且 `durationMs > 30_000ms` → `FATAL|TIMEOUT`
  - 支柱一（P0）：**耗时膨胀** — 同工具类型最新耗时 > 均值 ×1.5（仅超时未命中时检查） → `WARN|INFLATE`
  - 支柱二（P0）：**分析瘫痪** — Read+Grep ≥5 且 Edit+Write === 0 → `WARN|ANALYSIS`
  - 注入格式：AI 原生 3 行定长 `PREFIX|CAT|key=val\nROOT|cause\nACT|opt1|opt2|opt3`（50ms 解析）
  - `recordFact('error-audit', ...)` 记录事实供 Context Facts 聚合
- **冷却调优**：`minStepGap: 3→2`，超时死循环需要更快响应

#### 修复
- **耗时膨胀跨工具误报**：原实现对比全部工具 → 改为同工具类型内比较（`e.action === latest.action`）
- **超时 vs 快速失败区分**：原 `durationMs > 0` → 加 `> 30_000ms` 门限，快速错误（196ms/487ms）不触发
- **连续计数器重置**：中间有非超时条目即重置，保证真正连续
- **分析瘫痪工具名精确匹配**：正则 → 精确 `=== 'Read'/'Grep'/'Edit'/'Write'`

#### 数据验证
- 基准：2026-07-10 FAA 日志 3630 条真实操作记录
- 快速错误（196ms/487ms）< 30_000 → 门限排除 ✅
- 真实超时（135s/306s/307s）> 30_000 → 正确捕获 ✅
- 同工具数据不足（<3 条）→ 膨胀检测跳过 ✅
- 当前 getRecentEntries(10)：reads=6 greps=0 → 分析瘫痪触发 ✅

#### 文档
- `DECISIONS/分析-FAA再生-趋势检测与覆盖盲区发散风险.md`（状态 → implemented）
- `workspace/验收-FAA再生2Pillar落地全链路报告.md`（全链路验收）
- `SYSTEM/injection-system.md` — ErrorAuditInjector 章节同步更新

#### 框架源码引用
- `packages/agent-core/src/agent/injection/error-audit-injector.ts` — 165 行完整替换
- `packages/agent-core/src/agent/turn/variant-registry.ts` L345 — `minStepGap: 3→2`

### Phase36: 注入管线统一 — 摘要走 DynamicInjector [2026-07-11]

#### 架构变更
- **注入管线统一**：`SessionSummaryInjector` + `PersistentSummaryInjector` 新建为 DynamicInjector，
  注册到 `InjectionManager` 的统一 `injectors[]` 数组（`manager.ts:30-49`），
  与 15 个既有注入器共享 `maxInjectionsPerStep` 预算 + 6 道门（disabled/quota/cache/residual/budget/scheduler）
- **废止** `turn/index.ts:833-840` 中直接 `this.inject(sessionSummary, ...)` 的调用（绕过管线入口）
- **废止** `turn/index.ts:843-846` 中直接 `updatePersistentSummary()` 的调用

#### 新增文件
- `packages/agent-core/src/agent/injection/session-summary.ts` — SessionSummaryInjector
- `packages/agent-core/src/agent/injection/persistent-summary.ts` — PersistentSummaryInjector（基于 ILR）

#### Bug 修复
- **P0-1a**: `appendSystemReminder` 合并连续 user role system-reminder（`context/index.ts:117-136`）
  — 防止多条 `role:'user'` 注入违反 LLM API roles must alternate 约束
- **P0-1b**: `applyCompaction` 压缩后清理孤儿 tool 消息（`context/index.ts:311-326`）
  — 防止 compaction 后 `role:'tool'` 消息前面没有带 `tool_calls` 的 assistant 导致 API 400
- **P1-1**: ILR 触发取代步数阈值（`turn/index.ts:93-118`）
  — `shouldTriggerPersistentSummary(lastTurnStepCount >= 8)` → `computeILR(history, 3) > 0`

#### 数据验证
- 审计日志 7008 条 tool 记录：67.6% > 100 字符被 maskToolObservations 遮蔽
- 9 会话 656 轮次 step 分布验证 ILR 触发覆盖率合理

#### 文档
- `SYSTEM/injection-system.md` — 增量摘要接入管线章节重写
- `DECISIONS/分析-增量摘要设计与实现偏差复盘.md` — 全篇重写 §§10-12

### Phase37 — 全部完成：工具恢复 + 决策链 + 注意力信号 + stuck/ILR/error-audit 优化 [2026-07-11]

#### 新功能
- **ToolResultRecoveryInjector**（`tool-result-recovery.ts`）— 替代 PersistentSummaryInjector。ILR>0.3 时恢复被 mask 的关键 tool 结果，按优先级 ERROR>FILE>API>SEARCH>STATUS 提取，含 hasHighValue 过滤
- **DecisionTraceInjector**（`decision-trace.ts`）— ILR>0.6 时注入决策链快照 + 循环检测告警（连续 4 次相同操作类型）
- **注意力信号闭环** — `turn/index.ts:2020-2033` `parseAttentionSignals()`，从 AI 回复提取 [DONE]/[NEED]/[CONFIRM] 存入 crossTurnFlags.attentionSignals

#### 修复
- **stuck** `injection/stuck.ts:47,61` — weight 30→0.6（不霸屏）；从 `context.history` 直接读取替代 `stuckContext`（1773 次失败归零）
- **error-audit** `error-audit-injector.ts:63-95` — 删除分析瘫痪支柱（不再因 Read/Grep ≥5 警告）
- **guard-injector** `guard-injector.ts:55` — minStepGap: 0→3, threshold: 0.35→0.25

#### 优化
- **ILR 数据驱动优化** `tool-result-recovery.ts:106-109` — 基于 7 天实盘数据（17760 轮，93.2% ILR≤0.3）：加 hasHighValue 过滤，纯 STATUS 内容不触发
- **pushHistory 过滤** `context/index.ts:488-491` — injection/system_trigger 跳过 replayBuilder.push（不触发 TUI 重渲染）

#### 注册变更
| 变体 | 文件 | 状态 |
|------|------|------|
| `tool-result-recovery` | `tool-result-recovery.ts` | ✅ 新增 |
| `decision-trace` | `decision-trace.ts` | ✅ 新增 |
| `session-summary` | `session-summary.ts` | ✅ 已转入统一管线 |
| `error-audit` | `error-audit-injector.ts` | ✅ 仍注册（分析瘫痪已砍） |
| 14 个既有注入器 | — | ✅ 不变 |
| **总数** | **17 个** | ✅ 全部注册 |

#### 文档
- `SYSTEM/injection-system.md` — 全篇：17 注入器表格 + 注册码 + 版本号
- `SYSTEM/architecture-overview.md` — §6.2 更新为 17 注入器表
- `DECISIONS/分析-增量摘要设计与实现偏差复盘.md` — 更新所有计划为已完成

### Phase38 — 拦截管理系统统一架构 [2026-07-12]

#### Phase38a: 基础设施
- **`interception/types.ts`** — 接口定义（AttentionPriority/RootCause/RawSignal/InterceptionMessage/DetectorFn）
- **`interception/config.ts`** — 统一配置（5层优先级 P0-P4，递进阈值，单步上限3条）
- **`interception/manager.ts`** — InterceptionManager 中央调度器（mergeByRootCause / calcEscalation / sortByPriority / budgetCap / formatMessage）
- **`agent/index.ts`** — Agent 类注册 `agent.interception` 实例

#### Phase38b: 互联通道
- **`injection/router.ts`** — `InjectContext` 新增 `extraInterceptions: readonly InterceptionMessage[]`
- **`injection/manager.ts`** — `inject()` Step 0：拦截消息预批准优先占 budget 槽，走后门直入 `appendSystemReminder()`
- **`turn/index.ts`** — 管线串联：`interception.execute(ctx)` → `messages[]` → `inject({extraInterceptions})`

#### Phase38c: bypass 消除 + 清理
- **`variant-registry.ts`** — 删除 `system_trigger` 死代码
- **`anti_confabulation.ts`** — 删除（合并入 InterceptionManager confabulation detector）
- **`quality.ts`** — QualityInjector bypass 消除（`getResidualConfig` → 标准残差参数 0.6/0.85/3/0.20）

#### Phase38e/f: AI 体验提升
- **`detectors/attention-monitor.ts`** — [DONE]+已验证→智能跳过，[NEED]/[CONFIRM] 走 P3 统一管道
- **`detectors/quality-degrade.ts`** — C→B→A→S 质量衰退走递进（不再 bypass budget）
- **`detectors/verify-pass.ts`** — 修复后 `[恢复]` 正向确认
- **`detectors/confabulation.ts`** — 防幻核心：confidence≥3→P0_block 阻断，≥2→P1_discipline 证据提醒
- **`detectors/deviation-chain.ts`** — 偏差链消息走 extraInterceptions 通道（替代旧 `this.inject()` bypass）
- **`manager.ts`** — 正向信号算法：修复恢复检测 + triggerHistory 衰减（未触发根因每轮-1)

#### Phase38g: 代码整洁
- **`detectors/turn-limits.ts`** — 回合步数上限检测
- **`detectors/tool-dedup.ts`** — 连续相同工具调用检测
- **`detectors/permission-enforcer.ts`** — Guard 规则 1-4 检测

#### 文档
- **`SYSTEM/attention-system.md`** — 新建：统一大脑（AI 读这个就够了）
- **`SYSTEM/interception-system.md`** — 新建：执行层参考
- **`SYSTEM/interception.md`** — 扩展：全链路架构图（8 detectors→InterceptionManager→InjectionRouter→event-log）
- **`SYSTEM/architecture-overview.md`** — 引用更新（`attention-system` 替换 `attention-management`）
- **`SYSTEM/injection-system.md`** — 引用更新
- **`SYSTEM/MAP.md`** — 描述更新（`attention-system`+`interception-system` Phase38 标记）
- **`SYSTEM/API-REFERENCE.md`** — §3.1 新增拦截预批准通道，变体表清理 `system_trigger`
- **`SYSTEM/系统说明书维护SOP.md`** — §T5 规则：改前先读 `attention-system.md`
- **`SYSTEM/turn-control.md`** — 引用更新
- **删除** `attention-management.md`（回收站），`guard-engine.md`（回收站）

#### 数据
- bypass: 5→1（保留 TruncationTracker 合理例外）
- AI 每步消息上限: 6→3条
- SYSTEM 文档: 6碎片→1统一大脑（`attention-system.md`）
- 8 detectors 全部注册运行

#### Phase38i: 拦截日志系统 3 层结构升级 [2026-07-12]
- **`interception/event-types.ts`** — 新建：3 层事件类型体系（DetectorResult / InterceptionDecision / DeliveryResult）+ 聚合查询类型（RootCauseTrend / DetectorStats / TurnInterceptionReport）
- **`interception/manager.ts`** — `recordStep()` 自动记录本轮拦截事件全链路（检测→决策→投递）
- **`turn/event-log.ts`** — `recordReport()` 结构化记录 + 3 个聚合查询 API（`getRootCauseTrend` / `getAllDetectorStats` / `getInterceptionSummary`）
- **`SYSTEM/API-REFERENCE.md`** — §3.4 新增拦截事件类型体系 + 聚合查询 API 表；§3.2 AntiConfabulationInjector 标记已删除
- **`SYSTEM/interception.md`** — 架构图增加 3 层日志层 + 聚合查询 API

#### Phase38l: sceneMemory + budgetNotify + toolPattern + interceptionSummary detectors [2026-07-12]
- **`detectors/scene-memory.ts`** — 新建：用户说"上次/以前"时提醒查 MemoryLookup（替代旧 `detectSceneMemoryIssue()`）
- **`detectors/budget-notify.ts`** — 新建：预算降级时通知 AI
- **`detectors/tool-pattern.ts`** — 新建：连续 Read/Grep 无 codegraph + 连续报错检测
- **`detectors/interception-summary.ts`** — 新建：拦截运行概况（step≥30 时注入）
- **`detectors/turn-limits.ts`** — 改进：step≥45 收尾警告
- **`detectors/deviation-chain.ts`** — 改进：接管 Guard R1 阻断后遗症
- **`interception/types.ts`** — `InterceptionContext` 新增 `userInputText` + `calledMemoryLookup`
- **`turn/index.ts`** — 删除 3 个 `this.inject()` bypass（detectSceneMemory / injectInterceptionSummary / injectCrossTurnFlags）
- **`SYSTEM/interception.md`** — detector 列表 8→12
- **`SYSTEM/attention-system.md`** — 决策表 3 条新规则

---

### cache-stable-v1 — 三层蒸馏塔 + 缓存正常初级版（2026-07-14）

**基线**：`e2fbdec`（Phase38 完整构建产物）

#### 废弃（3 个功能）

| 功能 | 原因 | 操作 |
|:----|:----|:----|
| **ArchiveRecover Tool** | 5 天零调用，训练分布不支持 AI 主动取回 | 注销注册（`agent/tool/index.ts` 注释） |
| **Incremental LLM Summary** | `removeSystemRemindersByPrefix` splice 断缓存 | 从 `turn/index.ts` 管线移除 |
| **Micro Compaction** | 0.01% token 换 6.5-44% 缓存断裂 | `flags/registry.ts` `default: false` + deprecated |

#### 新功能：三层蒸馏塔

| 层 | 模块 | 机制 |
|:--|:----|:----|
| **保真层** | `mask-tool-observations.ts` | 错误按类型预算保留（编译300/Edit不限/测试500/权限300），已解决→自动降级 |
| **结构化保护** | `mask-tool-observations.ts` | JSON/代码 fence/Markdown 表格 → 保留完整，不压缩 |
| **压缩层** | `mask-tool-observations.ts` | 成功→一行（"Build: 0 errors"），无 emoji |
| **归档层** | `injection/archival-summary.ts` | 上下文 >50K 触发，尾部 append，按文件/错误/搜索分组 |
| **任务级聚合** | `archival-summary.ts` | 三信号加权（路径 50%+搜索 30%+reasoning 20%），置信度 >0.6 显示标题 |
| **Edit 循环检测** | `detectors/edit-failure-loop.ts` | 同文件连续 Edit 2 次 → appendSystemReminder 警告 |

#### 接口变更

- `maskToolObservations(messages, keepLastN?, toolNameMap?)` — 签名不变，行为改为分级保留（向后兼容）
- `DynamicInjector` 新增 `ArchivalSummaryInjector` 子类（注册于 `manager.ts`）

#### 新文件

| 文件 | 路径 |
|:----|:----|
| 归档层注入器 | `packages/agent-core/src/agent/injection/archival-summary.ts` |
| Edit 循环检测 | `packages/agent-core/src/agent/interception/detectors/edit-failure-loop.ts` |

#### 文档

- `SYSTEM/context-management.md` — 重写为 v3 蒸馏塔架构（旧 micro/ArchiveRecover/incremental summary → 已废弃）
- `SYSTEM/compaction.md` — 标记 Micro 为已废弃
- `ZHU/DECISIONS/分析-从AI消费者视角看缓存保护与注意力优化方向.md` — 最终版(v3)
- `ZHU/DECISIONS/INDEX.md` — 同步文件列表

#### 外部调研

- 10 篇学术论文（LLMLingua/MemGPT/ACON/SnapKV 等）
- 10 个开源/工业方案（Letta/ContextCompressionEngine/Claude Code/Anthropic Context Engineering 等）
- 核心确认：三层蒸馏塔方向与工业界最佳实践一致，Anthropic/Claude Code 使用相同策略
- 完整报告：`ZHU/workspace/研-上下文蒸馏塔外部调研对比分析.md`

#### 经验教训

- **缓存断裂根因**：micro compaction 推进 cutoff 改变消息前缀 → 6.5% 断裂率；注入器（ActiveSummaryInjector+DecisionTraceInjector）将可变尾部放大到 44%
- **ArchiveRecover 不成立**：训练分布不支持 AI 主动取回被遮内容（5 天零调用），根因不是"信息问题"是"激励问题"
- **缓存安全边界**：不是"改什么文件"，而是"改 `_history` 还是 projected 消息" / "插入头部还是尾部"
- **系统驱动 vs AI 驱动**：上下文管理不应依赖 AI 主动行为，应系统自动整理好送到 AI 面前
- **尾部 append 安全**：尾部内容本就是每轮可变的，追加 system-reminder 在任何情况下不伤缓存前缀
- **确定性优先**：全管线确定性规则，不依赖 LLM（ContextCompressionEngine 验证了 651ms/4257 条）
- **任务聚合确保高精度**：置信度 >0.6 才显示，宁可少显示也不能误导 AI