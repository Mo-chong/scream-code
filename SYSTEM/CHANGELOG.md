---
tags: [type/changelog, status/final, domain/system]
---
<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->

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
> 当前本地版本：v0.8.1（合并于 2026-07-03）

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
