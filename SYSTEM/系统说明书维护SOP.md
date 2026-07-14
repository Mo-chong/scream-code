---
tags: [type/reference, domain/knowledge, status/final]
keywords: [知识库, knowledge, chunk, 向量检索, FTS5]
updated: 2026-07-14
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
| 5 | SYSTEM 文件增删 | MAP.md（注册）+ INDEX.md（路径）+ SYSTEM-INDEX（索引+层级图） | T0 |
| 6 | 修改文件正文 | 检查并更新相关文件的 `参见：` 区块 | 跨层 |
| 7 | 都不触发 | 不更新 | — |

（条件）变更无关任何规则 → 跳过，交付前告知。

## 2. 执行流程 [P0]

调研 → 分类（给用户确认）→ 按依赖顺序执行 → 验证 → 读回检查。

**调研**：先 Read 所有待更新文件头部，确认：
- YAML frontmatter（tags / keywords / updated）存在且准确
- `参见：` 区块中每个链接文件在正文有实际提及
- 缺失补之

**分类**：列影响文件清单（按 T0→T4 层级分组）给用户确认，确认后才动手。

**执行顺序**（不可乱）：
```
SYSTEM/xxx.md（专题 T1-T4）→ MAP.md（T0）→ SYSTEM-INDEX.md（根）
→ API-REFERENCE.md（T4）→ pitfalls.md（T4）→ CHANGELOG.md（T4）
→ INDEX.md（T0）
→ 读回验证：全部文件头部完整性
```

**读回验证清单**：
```
□ YAML frontmatter √（tags/keywords/updated）
□ 参见： 每项链接在正文有实际文件名/概念出现
□ 无过期内容残留（原功能已迁移 → 改索引标记）
□ 无假关联（正文未提及却放在参见中）
□ 路径 Read 可访问 √
□ Grep 验证新增链接的文件名在正文中出现 √
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

索引表：`| 路径 | 用途（≤15字） | 更新日 |` 字母序插入。层级图：找到模块分支追加。

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
| **注：** 修改代码后必须更新对应 SYSTEM 文档的 `updated` 字段和版本表