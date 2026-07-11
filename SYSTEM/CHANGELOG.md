<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
---
tags: [type/changelog, status/final, domain/system]
updated: 2026-07-11
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

### Phase33 续章：mask 增强 + 增量摘要 + BATCH_SIZE 纠正 + GuardInjector 迁移 + 审计升级 + ContextManager API [2026-07-10→07-11]

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
