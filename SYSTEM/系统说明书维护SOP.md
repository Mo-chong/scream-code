---
tags: [type/reference, domain/knowledge, status/final]
keywords: [知识库, knowledge, chunk, 向量检索, FTS5, 蒸馏塔, SABCD, SYSTEM-INDEX, 索引同步]
updated: 2026-07-29
---

<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->

# 系统说明书维护SOP [P0]

> **参见：** [`attention-system.md`](attention-system.md)（AI 全流程起点） | [`MAP.md`](MAP.md)（目录结构 T0） | [`INDEX.md`](INDEX.md)（索引同步） | [`CHANGELOG.md`](CHANGELOG.md)（变更记录） | [`SYSTEM-INDEX.md`](../SYSTEM-INDEX.md)（根索引表）

> 用户说"更新文档" → Read 本文件 → 按流程执行。

## 0. 强制规则 [P0]

四条刚性要求，违反即禁止写入：

| # | 规则 | 说明 |
|---|------|------|
| 1 | **更新必须遵照规则** | 无规则条目的变更 → 不触发。必须命中 §1 决策树至少一条 |
| 2 | **文件独立规则优先** | 文件自身标头的维护规则 > 本文档 SOP。写入前必须 Read 目标文件头部直到第一个 `##` 或正文开始，确认 `maintain` / `更新规则` / 格式声明完整可见 |
| 3 | **写入前读标头** | 每写一个文件前 → Read 其头部至正文分界，确认维护规则和现存格式。禁止凭记忆盲写 |
| 4 | **无规则 → 遵循现有格式** | 文件标头和 SOP 均无规则 → 以文件已有内容和格式为准，模式对齐最近 5 行同类上下文，不发明新格式 |
| 5 | **改前先读 attention-system.md** | 任何涉及注意力/拦截/注入/回合的改动 → 先读 [`attention-system.md`](attention-system.md) 理解 AI 完整 5 步流程，确认改动不与其他模块冲突后才能动手 |

## 1. 决策树 [P0]

变更来了 → 逐条判断，只选符合的：

| # | 条件 | 动作 | 层级 |
|---|------|------|------|
| 1 | 全新模块 / 已有增量 | 新建 SYSTEM/xxx.md / 更新已有 | T0-T4 |
| 2 | 新接口/类型/配置 | API-REFERENCE.md + `<!-- ref: xxx -->` | T4 |
| 3 | 踩坑/教训 | pitfalls.md（三段：根因/修复/预防） | T4 |
| 4 | 值得记录（上游合并 / 二开功能 / 文档维护） | CHANGELOG.md（双轨：上游合并顶部倒序 / 二开发日志正向追加） | T4 |
| 5 | 修改/新增 SYSTEM 文件 | MAP.md（注册）+ INDEX.md（路径）+ SYSTEM-INDEX.md（验证/更新索引表+层级图） | T0 |
| 6 | 修改文件正文 | 检查并更新相关文件的 `参见：` 区块 + 检查 SYSTEM-INDEX.md 中该文件的描述是否过时 | 跨层 |
| 7 | 都不触发 | 不更新 | — |

（条件）变更无关任何规则 → 跳过，交付前告知。

## 2. 执行流程 [P0]

调研 → 分类（给用户确认）→ 按依赖顺序执行 → 验证 → 读回检查。

**调研**：先 Read 所有待更新文件头部，确认：
- YAML frontmatter（tags / keywords / updated）存在且准确
- `参见：` 区块中每个链接文件在正文有实际提及
- 缺失补之

**分类**：列影响文件清单（按 T0→T4 层级分组）给用户确认，确认后才动手。

**执行顺序**（不可乱。**SYSTEM-INDEX.md 是根索引，必须先于其他索引文件更新，后于专题文件进行验证**）：
```
┌─ 专题文件 SYSTEM/xxx.md（T1-T4 修改/新增）
├─ MAP.md（T0 目录注册）
├─ SYSTEM-INDEX.md（T0 根索引同步 ← 专题文件必须在此有正确摘要）
├─ API-REFERENCE.md（T4 接口/类型同步）
├─ pitfalls.md（T4 踩坑）
├─ CHANGELOG.md（T4 变更记录）
├─ INDEX.md（T0 DECISIONS 索引）
└─ 读回验证：全部文件头部完整性
```

**读回验证清单**：
```
□ YAML frontmatter √（tags/keywords/updated）
□ 参见： 每项链接在正文有实际文件名/概念出现
□ 无过期内容残留（原功能已迁移 → 改索引标记）
□ 无假关联（正文未提及却放在参见中）
□ 路径 Read 可访问 √
□ Grep 验证新增链接的文件名在正文中出现 √
□ **SYSTEM-INDEX.md 中对应条目的描述、层级树、日期是否同步 √**
□ 无多余改动 √
```

## 3. 写入规范

### 3.1 YAML frontmatter 格式 [P1]

每个 SYSTEM 文件顶部必须含：

```yaml
---
tags: [type/<类目>, domain/<域>, status/<状态>]
keywords: [关键词1, 关键词2, ...]
updated: YYYY-MM-DD
---
```

- `type/` 可选值：core / reference / process / config
- `domain/` 可选值：docs / knowledge / memory / injection / turn / guard / compaction
- `status/` 可选值：draft / active / final / deprecated
- `keywords` 5-10 个，覆盖文件核心术语 + 同义表达（支撑 FTS5 搜索）
- `updated` 每次内容变更同步更新

### 3.2 `参见：` 区块规范 [P1]

格式：`> **参见：** [\`文件.md\`](文件.md)（关联原因） | ...`

规则：
- 每项链接的文件名**必须在正文中实际出现**（Grep 验证）
- 描述括号内用 4-8 字说明关联原因，**只写 AI 导航能用的事实**，如"回合生命周期"而非"推荐先读"
- 优先级：T1 核心层优先 | 跨层只加最强关联（≤5 条）
- 小文件功能已迁移到大文件 → 小文件保留索引指向新位置，不可重复描述

### 3.3 专题文档 SYSTEM/xxx.md

```
# 标题 [P0]  > 一句话描述
## 设计原理  ## 核心流程  ## 接口/配置  ## 边界/约束
```

追加/修改：尾部追加 / 精确替换。废弃标 (deprecated)。

### 3.4 SYSTEM-INDEX.md

**根索引，必须维护。**

| 操作 | 规则 |
|------|------|
| 新增 SYSTEM 文件 | **必须**在 SYSTEM-INDEX.md 的层级图和索引表中各加一条。层级图找到对应分支追加，索引表字母序插入 |
| 修改 SYSTEM 文件 | **必须**检查索引表中该文件的行是否需要更新（描述/日期/Phase 号） |
| 删除 SYSTEM 文件 | **必须**从层级图和索引表中删除对应行 |
| 跳过 | 仅改 ZHU/DECISIONS/ 或源码不改 SYSTEM/ 时不需要碰 |

> SYTEM-INDEX.md 是 ScreamCode 对外暴露的知识入口。过时的索引比没有索引更危险——它会引导读者到不存在的文件或错误的方向。**改 SYSTEM 文件后不更新索引 = 违反 T0 规则。**

### 3.5 API-REFERENCE.md

```
### N.x 功能名
<!-- ref: FunctionName -->
- 用途 / 参数: {key: type} / 返回: type / 调用方: [path] / 备注
```

续编。改旧不改号。废弃加 (deprecated)。

### 3.6 MAP.md / pitfalls.md / INDEX.md

- MAP: `├─ 文件名.md — 一句话描述` 追加到模块层级
- pitfalls: `## 标题 → 症状 → **根因** / **修复** / **预防** / **相关**: [path]`
- INDEX: `→ [标题](./xxx.md)` 文件增删时同步

### 3.7 CHANGELOG.md [P0]

两条线独立记录，**禁止混写**。

| 线 | 触发条件 → 动作 | 格式 | 顺序 |
|---|---|---|---|
| 上游合并 | 从原始仓库合并版本 | `## v{大}.{小}.{补丁} — 合并上游 v...（YYYY-MM-DD）` | 顶部倒序 |
| 二开发日志 | 手动更新 / 二开新增功能 / 文档维护 | `### Phase{N} — 标题（YYYY-MM-DD）` 子节 `新功能 / 修复 / 变更 / 文档 / 框架源码引用 / 未实现` | `二开发日志` 节下正向追加 |

**通用规则：**
- 每个 `###` 必须含日期 | 每个条目必须含文件路径或行号
- 无路径 / 无日期 / 概括废话 / 新旧倒置 → 禁止
- 标头维护规则定义在 `CHANGELOG.md` 自身标头，以本地为准

## 4. 禁止 [P0]

- ❌ 不 Read 就写 | ❌ 乱序
- ❌ 改没要求的文件 | ❌ 发明新格式（按 §3 规范）
- ❌ 贴大段代码 | ❌ 模糊描述（必须有路径/函数名）
- ❌ 删旧内容（只追加或 deprecated）
- ❌ 添加参见不验证正文出现（假关联）
- ❌ 更新了文件内容而不改 YAML `updated` 日期

### 3.8 大版本变更速查（2026-07-14 cache-stable-v1）

| 事件 | 涉及文件 | 操作 |
|:----|:--------|:-----|
| **三层蒸馏塔**（保真/压缩/归档） | `context-management.md` | 全篇重写 |
| **MicroCompaction 废弃** | `compaction.md` | 标记 deprecated |
| **ArchiveRecover 注销** | `context-management.md` | 标记废弃 |
| **incremental LLM summary 移除** | `context-management.md` | 管线移除 |
| **ArchivalSummaryInjector 新增** | `injection-system.md` | 追加注册条目 |
| **edit-failure-loop 新增** | `interception-system.md` | 追加注册条目 |
| **SABCD 5→3（critical/normal/debug）** | `variant-registry.ts` + 12 文件 | 类型+函数+配额+测试同步 |
| **注入器位置优化**（5 个移尾部） | `manager.ts` + 5 个注入器 | AFTER_SYSTEM/MID → AFTER_TOOL_CALL |
| **tool-result-recovery 删除** | `manager.ts` | 注销注册 |
| **CRLF 修复** | `.gitattributes` + git config | 全仓库 LF 归一化 |
| **注：** 修改代码后必须更新对应 SYSTEM 文档的 `updated` 字段和版本表 |
| **Phase42d 说明书查缺补漏** | `context-management.md` / `turn-control.md` / `injection-system.md` / `architecture-overview.md` | 补 SnipHinter+Checkpoint 文档+edit_error_fix 变体 |
| **v0.11.2 合并（64 commits）** | `footer.ts` / `manager.ts` / `micro.ts` / `build-dev.sh` / `package.json` | 取 theirs 后逐一 grep 补 fork 增强 + pi-tui 版本手动覆盖导致脱节 + build-dev.sh 缺 web 构建 |

## 5. system.md 维护规则 [P0]

上游合并时 `packages/agent-core/src/profile/default/system.md` 的特殊保护规则。

### 5.1 基本原则

| 规则 | 说明 |
|------|------|
| **永不允许上游全量覆盖** | 本地 system.md 是定制精简版（~234 行），上游是通用版（~2000 行含模板）。全量覆盖 = 丢失 `[Pn]` 权重体系 + CONTRACT + 紧凑记号法 |
| **必须逐段对比吸收** | 不取 ours 也不取 theirs。每段独立判断：HEAD 保留 + 上游吸收 + 都不留 |
| **吸收标准：AI 消费价值** | 每段内容用四轴评分：注意力 / 防幻觉 / 防降智 / 能力提升。不达标的段落放弃 |

### 5.2 四轴评估框架

```
| 维度 | 评分说明 | 高分信号 |
|------|---------|---------|
| 注意力 | 能否让 AI 更快锁定关键决策点 | `[P0]` 标记、禁令式短句、"Never" 句式 |
| 防幻觉 | 能否阻止 AI 编造/猜测/跳过验证 | "Never fabricate"、完整验证流程、不可跳过步骤 |
| 防降智 | 能否阻止 AI 偷懒/走捷径/重复错误 | 完整决策树、"No substitute commands"、失败处理流程 |
| 能力提升 | 能否让 AI 做更多/更好的事 | Fusion Plan 指南、Memory vs Knowledge 对比、子代理详细指引 |
```

### 5.3 本地不可替换资产

以下内容为本地定制，上游必无，永不可丢弃：

- **`<format>` 紧凑记号法**（`key: value — definition | A → B → C — flow`）— 注意力引导核心
- **`[P0][P1][P2]` 优先级权重体系** — 上游全是散文，无权重标记
- **`# CONTRACT [P0]`** — 防幻第一盾牌，上游无此章节
- **`# Engineering judgment [P0]`** — 保守决策框架，上游无
- **`## Tool rules [P1]` + `## Tool mapping [P1]`** — 工具限制规则，格式更优
- **`## Tool reference [P2]`** — 上游无此参考表

### 5.4 上游值得吸收的内容类型

合并时发现以下类型值得吸收（按价值排序）：

| 优先级 | 内容类型 | 示例 |
|--------|---------|------|
| 高 | **完整验证协议** | Verification Protocol（何时验/怎么验/失败重试/去重） |
| 高 | **结构化交付格式** | Delivering Results（一结果二文件三验证四遗留） |
| 高 | **Memory vs Knowledge 对比** | "sticky notes vs reference library" |
| 中 | **子代理详细指南** | oracle/writer 的适用场景描述 |
| 中 | **WolfPack/Fusion Plan** | 完整使用条件与示例 |
| 低 | **AGENTS.md 哲学** | 解释性内容，对 AI 行为无直接影响 |

### 5.5 v0.10.5 成功经验

合并 v0.10.1→v0.10.5 时上游 system.md 重写了 ~388 行（原来 `# Role [P0]` 一行扩展到完整 DIY/Delegate 决策框架 + Prompt and Tool Use + Available Subagents + Verification Protocol + Memory Memos + 知识库 + 编码指南 + 环境等 15 个章节）。

**执行过程**：
1. 取出两版全文（HEAD 234 行 / 上游 388 行冲突区），逐段对比四轴评分
2. 列出"不可替换资产"（HEAD 独有）和"值得吸收"（上游高价值）两张表
3. 保留 HEAD 全部 234 行骨架，不丢失任何 `[Pn]` 标记和 CONTRACT
4. 插入上游高价值内容：Delivering Results（新增章节）、Verification 增强（决策树 + 不降级规则）、Fusion Plan、Memory vs Knowledge 对比、Subagents 补充
5. 最终 257 行零冲突

**关键教训**：
- 控制行数不是目的，AI 消费质量才是唯一标准
- "不取 ours/不取 theirs" 的逐段策略比二选一多花 30% 时间但产出质量高一个量级
- 四轴评分框架是可复用的，以后每次上游合并 system.md 都按这个流程来

### 5.6 v0.11.2 合并教训（全面审计）

合并 v0.10.5→0.11.2（64 commits），核心不在于 system.md 冲突（上游未改），而在于**取 theirs 后 fork 增强的隐性丢失**和**环境依赖的隐性退化**。

#### 机制问题：取 theirs 可能丢 fork 增强

`git checkout --theirs` 不仅替换冲突区域的代码，还可能删掉 fork 在该文件中新增的独立功能。本次合并 4 次隐性丢失：

| 文件 | 丢失内容 | 发现方式 | 补救 |
|------|---------|---------|------|
| `footer.ts` | `formatCacheStats()` 缓存率+🧊统计 | 用户报 UI 不对 | 从旧版本还原函数 |
| `micro.ts` | `contentArchive?.archive()` 存档 | grep 验证发现 `=0` | 手动补回 |
| `manager.ts` | `flushContextFacts()` 引用已死方法 | 运行时崩溃 | 删 orphan finally |
| `dispatch.ts` | /web 斜杠命令 | 用户报 unknown | 补 registry+dispatch |

**教训**：取 theirs 后两步走——① grep 检查 fork 增强关键字（`VEC0_`、`processTags`、`contentArchive`、`formatCache`）② `scream --version` + 核心功能测试。

#### 环境退化：pi-tui 版本脱节

**现象**：`package.json` 声明 `^0.80.31`，但物理安装的 `node_modules/@liutod-scream/pi-tui` 是旧 `0.80.10`。

**根因**：v0.10.0 合并后用了 `npm pack + tar 解压` 手动装旧版 0.80.10。pnpm install 不覆盖已有 node_modules，版本永久卡死。

**教训**：合并后检查关键依赖物理版本：`node -e "console.log(require('@liutod-scream/pi-tui/package.json').version)"`。版本不对 → `rm -rf node_modules/xxx apps/scream-code/node_modules/xxx` 清空重装。

#### 构建流程缺失：web 前端资产

**现象**：合并后 `scream web` 报错，`dist/public/` 不存在。

**根因**：`build-dev.sh` 只有两段 tsdown 构建，缺 vite build + copy-web-assets。

**教训**：大版本合并后重新审视 `build-dev.sh`——上游新增的平台/UI 可能依赖新的构建步骤。

#### 全面审计检查清单（合并后必做）

```bash
# 1. Fork 增强关键字存活
grep -c "VEC0_MIGRATION" packages/memory/src/store.ts
grep -c "processTags" packages/memory/src/consolidator.ts
grep -c "contentArchive?.archive" packages/agent-core/src/agent/compaction/micro.ts
grep -c "McpBrowserSkillInjector" packages/agent-core/src/agent/injection/manager.ts
grep -c "onnxruntime-node" apps/scream-code/tsdown.config.ts

# 2. 运行时
scream --version
scream web --port 8080   # 确认不是 MODULE_NOT_FOUND

# 3. 依赖物理版本
node -e "console.log(require('@liutod-scream/pi-tui/package.json').version)"

# 4. 构建完整性
ls apps/scream-code/dist/public/index.html
```