<format>
本文件使用 compact notation | A → B — 流程 | A / B — 任一 | [P0][P1] — 优先级
每段独立解读，不依赖上下文顺序
</format>

# System Prompt 装配管线 [P0]

Template → Render → Cache → Inject → API call 全链路。
读此文件即可理解 system prompt 从源代码到 API payload 的完整过程。

---

## 1. 概念分层 [P0]

| 层 | 定义 | 生命周期 |
|---|---|---|
| Template | Jinja2 模板文件，含 `{{ }}` 变量 / `{% if %}` 条件 | build 时编译一次 |
| Raw | 模板经 webpack raw-loader 编译为 JS 字符串 (`default.ts:8`) | build 时编译一次 |
| Context | 运行时变量键值对，由 `prepareSystemPromptContext()` + `buildTemplateVars()` 构建 | session 启动时构建一次 |
| Rendered | Template + Context → nunjucks.renderString() → 纯文本 | session 启动时渲染一次 |
| API payload | Rendered string 作为 `messages[0].content` | 每次 API 调用复用同个字符串 |

**关键事实：system prompt 在整个 session 中只渲染一次。** 渲染后的纯文本字符串存入 `LtodLlm.systemPrompt` 字段，每次 API 调用时直接取缓存字符串，不重新渲染。

---

## 2. 源文件清单 [P0]

| 源文件 | 内容 | Build 时编译 | 改后需重启 session |
|---|---|---|---|
| `profile/default/system.md` | 主模板，含 9 变量 + 3 条件 | raw-loader | **是** |
| `profile/default/[type].yaml` (x8) | subagent 配置（agent/coder/explore/...） | raw-loader | **是** |
| `.scream-code/AGENTS.md` (多级) | 用户+项目+逐级 AGENTS 规则 | 否—session 启动时读盘 | **是**（仅在 session 启动时读取） |
| `.scream-code/user-prefs.md` | /like 偏好 | 否—session 启动时读盘（路径 A） / 每轮读盘（路径 B） | 路径 A **是** / 路径 B **否** |

**重启 session**指结束当前会话并启动新会话。只改 `user-prefs.md` 时路径 B（system-reminder 注入）立即生效，路径 A（模板变量注入）需要重启 session。

---

## 3. 模板变量表 [P0]

来源：`profile/resolve.ts:163` → `buildTemplateVars()`

```typescript
buildTemplateVars(context: SystemPromptContext): Record<string, string> {
  return {
    ROLE_ADDITIONAL:         context.roleAdditional,      // user-prefs.md 全文
    SCREAM_AGENTS_MD:        context.agentsMd,            // 合并后的 AGENTS.md
    SCREAM_SKILLS:           context.skills,              // 技能内容
    SCREAM_NOW:              formatDate(new Date()),      // ISO 时间戳
    SCREAM_OS:               process.platform,            // win32 / darwin / linux
    SCREAM_SHELL:            env.SHELL || COMSPEC,        // shell 路径
    SCREAM_WORK_DIR:         context.workDir,             // 当前工作目录 (process.cwd())
    SCREAM_WORK_DIR_LS:      context.workDirLs,           // `ls -la {cwd}` 输出
    SCREAM_ADDITIONAL_DIRS_INFO: context.additionalDirs,  // 额外目录信息
    HAS_SUBAGENT:            type?.trim() ? 'true' : '',
    HAS_SKILL_CONTENT:       skills.trim().length > 0 ? 'true' : '',
  }
}
```

### 变量明细

| 变量 | 源 | 注入时机 | 值示例 | 改后需重启 session |
|---|---|---|---|---|
| `ROLE_ADDITIONAL` | `.scream-code/user-prefs.md` | **session 启动时渲染一次** | `Respond PROFESSIONAL...` | 路径 A **是** / 路径 B **否** |
| `SCREAM_AGENTS_MD` | 多级 AGENTS.md 合并+截断 | **session 启动时搜索+合并+截断一次** | AGENTS.md 合并内容（≤32KB） | **是** |
| `SCREAM_NOW` | `Date.now()` | **session 启动时** | `2026-07-03T23:48:20.621Z` | **是**（值在 session 中不变） |
| `SCREAM_OS` | `process.platform` | **session 启动时** | `win32` | **是**（值恒定） |
| `SCREAM_SHELL` | `env.SHELL / COMSPEC` | **session 启动时** | `D:\Git\Git\bin\bash.exe` | **是**（值恒定） |
| `SCREAM_SKILLS` | Skill 目录内容 | **session 启动时** | Skill 类型+路径列表 | **是** |
| `SCREAM_WORK_DIR` | `process.cwd()`（CLI 启动目录） | **session 启动时** | `D:\AI\ScreamCode` | **是**（值恒定） |
| `SCREAM_WORK_DIR_LS` | `ls -la {cwd}` 实时输出 | **session 启动时** | `total 123\ndrwxr-xr-x...` | **是**（值恒定） |
| `SCREAM_ADDITIONAL_DIRS_INFO` | 额外目录信息 | **session 启动时** | 目录结构文本 | **是** |
| `HAS_SUBAGENT` | `SCREAM_SUBAGENT_TYPE` | **session 启动时** | `true` / `false` | **是** |
| `HAS_SKILL_CONTENT` | `SCREAM_SKILLS` 非空判断 | **session 启动时** | `true` / `false` | **是** |

**以上所有变量在 session 启动时渲染一次后被固化到字符串中，后续 API 调用不更新。**

**重要**：`SCREAM_WORK_DIR` 就是 CLI 启动时的 `process.cwd()`——即终端中执行 `scream` 命令时的所在目录，不是项目的根目录。它决定了 AGENTS.md 的加载路径（见 §6）和 CWD 目录列表。

### 条件块（在模板中使用 `{% if %}`）

```
{% if HAS_SUBAGENT %}...# Subagents [P2]...{% endif %}        → 子 agent 专属指令
{% if HAS_SKILL_CONTENT %}...# Skills [P2]...{% endif %}      → 技能指令
{% if SCREAM_OS == 'win32' %}Windows 路径转换规则{% endif %}   → OS 适配
```

---

## 4. 模板渲染引擎 [P1]

文件：`utils/render-prompt.ts` (19 行)

```typescript
nunjucks.Environment(null, {
  autoescape: false,      // 不转义 HTML，prompt 中的 < > & 原样传递
  throwOnUndefined: true  // 变量缺失时抛错，不会静默泄漏 {{placeholder}}
})
```

渲染语法：
- `{{ var }}` — 插入变量值
- `{% if condition %}...{% endif %}` — 条件块
- `{% for item in list %}...{% endfor %}` — 循环（当前模板未使用）

---

## 5. 装配管线（完整数据流）[P0]

```
                                    Build time (一次)
                                    ─────────────────
 profile/default/system.md ──raw-loader──→ default.ts:8 (systemMd: string)


                                    Session 启动（一次）
                                    ──────────────────────

 agent/index.ts:365
 ┌─────────────────────────────────────────────────────────────┐
 │ agent.useProfile(profile)                                    │
 │                                                             │
 │ context = prepareSystemPromptContext(options)                │
 │  ├─ roleAdditional: readFile('.scream-code/user-prefs.md')  │
 │  ├─ agentsMd: mergeAgentsMd(cwd + home)                     │
 │  └─ ... (cwd/os/shell/skills/now)                           │
 │                                                             │
 │ vars = buildTemplateVars(context)        ← resolve.ts:163   │
 │ rendered = renderPrompt(systemMd, vars)  ← render-prompt.ts │
 │                                                             │
 │ this.config.update({ systemPrompt: rendered })               │
 └──────────────────────────┬──────────────────────────────────┘
                            │
                            ▼
                    ltod-llm.ts:87
          ┌──────────────────────────────────┐
          │ this.systemPrompt = config.systemPrompt  ← 缓存     │
          └──────────────────────────────────┘


                                    每轮 API 调用
                                    ─────────────────

 ltod-llm.ts:130
 ┌─────────────────────────────────────────────────────────────┐
 │ generate(tools, history, options)                            │
 │                                                             │
 │ // 直接使用已缓存的字符串，不重渲染                           │
 │ return this.generate(this.systemPrompt, tools, history,      │
 │                       options)                               │
 └──────────────────────────┬──────────────────────────────────┘
                            │
                            ▼
                    generate.ts:112
          ┌──────────────────────────────────┐
          │ provider.generate(               │
          │   systemPrompt,  // 同个字符串     │
          │   tools,                         │
          │   history,                       │
          │   options)                       │
          └──────────────────┬───────────────┘
                             │
                             ▼
                    Provider 层 (ltod)
          ┌──────────────────────────────────────┐
          │ openai-legacy.ts:453-454              │
          │ createParams.tools =                  │
          │   tools.map(toolToOpenAI)             │
          │                                      │
          │ messages = [                         │
          │   { role: "system",                  │
          │     content: <缓存字符串> },           │
          │   ...history                         │
          │ ]                                    │
          └──────────────────────────────────────┘
```

**关键行号**（全部经过代码验证）：
- `default.ts:8` — raw-loader 编译 system.md 为 JS 字符串
- `context.ts:139-189` — `prepareSystemPromptContext()` 构建上下文
- `resolve.ts:163-179` — `buildTemplateVars()` 变量构建（session 启动时一次）
- `agent/index.ts:365-382` — `useProfile()` 渲染 system prompt 并缓存
- `ltod-llm.ts:87` — `this.systemPrompt = config.systemPrompt`（缓存字段）
- `ltod-llm.ts:130` — 每次 API 调用使用缓存字符串
- `generate.ts:112` — `provider.generate()` 发送
- `openai-legacy.ts:453-454` — `toolToOpenAI()` schema 转换

---

## 6. AGENTS.md 合并+截断逻辑 [P1]

来源：`profile/context.ts` → `collectAgentsFiles()` (L56-77) + `renderAgentFiles()` (L129-177)

### 搜索路径（收集顺序）

```
Step 1: ~/.scream-code/AGENTS.md                        ← 全局（始终加载）
Step 2: ~/.agents/AGENTS.md                             ← 全局备选（仅当 Step 1 失败）

Step 3: for each dir in dirsRootToLeaf(projectRoot, cwd):
          {dir}/.scream-code/AGENTS.md                  ← 优先
          {dir}/AGENTS.md | {dir}/agents.md             ← 依次 fallback，命中 break
```

**关键路径规则**：`dirsRootToLeaf` 只遍历从**项目根（有 .git 的目录）到 cwd** 之间的目录。cwd 的父目录及项目根之上的目录不会被搜索。

### 收集 vs 分配的分离

**收集顺序**：全局 → 项目根 → ... → 最深子目录（递增 push）
**预算分配方向**：最深子目录 → ... → 项目根 → 全局（反向循环）

```
discovered = [全局, 项目根, 子目录1, 子目录2]
                    ↑ 先收集                ↑ 后收集

for (let i = files.length - 1; i >= 0; i--)
       ↑ 预算从最深目录（数组末尾）开始分配
```

### 32KB 总预算限制

`AGENTS_MD_MAX_BYTES = 32768`（context.ts L33）是整个 `SCREAM_AGENTS_MD` 变量的**总字节上限**，包括所有收集到的文件内容 + 每个文件的 `<!-- From: {path} -->` 注释标记。

**预算分配流程**：

```
budget = 32768
for (i = files.length - 1; i >= 0; i--):
  overhead = annotationFor(file) + separator
  if budget - overhead <= 0:
    content = ''         ← 文件完全被截断
  elif content.length <= budget - overhead:
    content = 全量        ← 文件全部保留
  else:
    content = truncateUtf8(content, budget - overhead)  ← 文件尾部被截断
  budget -= (overhead + content.length)
```

### 实际影响（实测验证）

| 场景 | 项目 AGENTS.md | 全局 AGENTS.md | 截断结果 |
|------|---------------|---------------|---------|
| ScreamCode 根 | 55KB（根目录） | 7.6KB | 根文件截断前 ~32KB，全局 **0 字节** |
| ZHU/（allgzmulu 下） | 2.3KB + 800B | 7.6KB | 全部保留，预算充裕 |
| 无 AGENTS.md 目录 | 无 | 7.6KB | 全部保留 |

**关键事实**：当项目 AGENTS.md > 32KB 时，全局 AGENTS.md **100% 丢失**。项目 AGENTS.md 尾部也被截断。

### 渲染顺序（输出）

```
渲染后按收集顺序排列：全局 → 项目根 → 子目录
每个文件前加注释标记：<!-- From: {path} -->
```

**叠加规则**：后加载的**不能覆盖**先加载的规则——所有文件内容简单拼接，不是 merge。冲突规则不会自动解决，由 AI 自行判断。

### 文件内容 ≠ 模板变量

AGENTS.md 文件本身是 Markdown，不是 Jinja2 模板。它通过 `SCREAM_AGENTS_MD` 变量整体插入 system prompt，**不经过 nunjucks 渲染**（变量注入一次完成，其内部的 `{{ }}` 不会被二次解析）。

---

## 7. user-prefs 双路注入 [P0]

`/like` 设置的偏好通过两条独立路径注入：

### 路径 A：模板变量注入（system prompt 内）

```
/like "Respond PROFESSIONAL..."
    ↓
写入 .scream-code/user-prefs.md
    ↓
context.ts: context.roleAdditional = readFile('.scream-code/user-prefs.md')
    ↓
resolve.ts: buildTemplateVars() 时 → { ROLE_ADDITIONAL: context.roleAdditional }
    ↓
nunjucks 渲染 → system prompt 第 12 行 {{ ROLE_ADDITIONAL }} → 固化为纯文本
```

**特点**：仅在 session 启动时渲染一次。改 user-prefs.md 后**需要重启 session** 才更新此路径。

### 路径 B：system-reminder 注入（对话层）

```
每轮对话后 → DynamicInjector
    ↓
user-prefs.ts → 读 .scream-code/user-prefs.md（每轮读盘）
    ↓
每轮用户消息后插入 system-reminder:
<system-reminder>
USER PREFERENCES REMINDER: ...
</system-reminder>
```

**特点**：每轮对话后独立读文件，不依赖 system prompt 渲染。**改后立即生效**。

### 两条路径的差异

| | 路径 A（模板变量） | 路径 B（system-reminder） |
|---|---|---|
| 注入位置 | system prompt 文本第 12 行 | 对话消息中，每轮 |
| 渲染时机 | session 启动一次 | 每轮对话后 |
| 改后生效 | **需重启 session** | **立即** |
| 可见性 | system prompt 开头，被后续对话稀释 | 每轮都出现在用户消息前 |

---

## 8. 与 injection-system.md 的边界 [P1]

| | prompt-assembly.md（本文） | injection-system.md |
|---|---|---|
| 关注点 | **编译时**模板装配 + **session 启动时**渲染 | **运行时**系统提醒注入 |
| 核心机制 | Jinja2 渲染 → 一次缓存 | DynamicInjector + 残差公式（每轮） |
| 变量 | 9 个模板变量 + 3 个条件 | 变体向量 + 残差 R=W×D^Δs |
| 数据流 | source → rendered string → 缓存 | 缓存的字符串 → 每轮注入 segments |
| 修改频率 | 低（改模板/变量需要构建 + 重启 session） | 中（调权重/配运行时参数） |

**不重叠**。injection-system.md 的重写在渲染完成后、对话开始前——它操作的是**已经渲染完并缓存的文本流**，不涉及模板变量。

---

## 9. 变更指南 [P2]

| 你想改什么 | 改哪个文件 | 需重启 session |
|---|---|---|
| system prompt 的指令内容 | `profile/default/system.md` | **是**（tsdown + 新 session） |
| 模板变量名称/逻辑 | `profile/resolve.ts:163` | **是**（tsdown + 新 session） |
| AGENTS.md 规则 | `.scream-code/AGENTS.md`（相应层级） | **是**（新 session） |
| /like 偏好（路径 B） | `.scream-code/user-prefs.md` | **否**（system-reminder 每轮读取） |
| /like 偏好（路径 A） | `.scream-code/user-prefs.md` | **是**（模板变量在 session 启动时固化为字符串） |
| 渲染引擎参数 | `utils/render-prompt.ts` | **是**（tsdown + 新 session） |

---

## 10. 风险点 [P2]

- **throwOnUndefined: true** — template 内引用未注册的 `{{ UNDEFINED_VAR }}` 会导致渲染失败，API 调用被阻断。新增变量时必须同步更新 buildTemplateVars()。
- **AGENTS.md 收集 vs 预算分配方向相反** — 收集先全局后项目，预算先项目后全局。当项目 AGENTS.md > 32KB 时全局文件被完全截断（0 字节注入），项目文件尾部也丢失。见 §6 实测数据。
- **32KB 是总预算不是每个文件预算** — 所有 AGENTS.md 内容 + 注释标记总和。system.md 模板 10.7KB 不在此预算内。
- **session 缓存行为** — system prompt 仅在 session 启动时渲染一次。改模板、AGENTS.md、user-prefs（路径 A）后，必须重启 session 才会生效。**不要以为改文件后立即生效**——路径 B（system-reminder）是例外。
- **存档副本陷阱** — `profile/default/system.md` 是模板（含 `{{ }}` 和 `{% if %}`），`SYSTEM/system.md` 是存档参考副本（不含模板语法，已渲染）。修改模板后需手动同步存档副本。
- **SCREAM_WORK_DIR ≠ projectRoot** — `SCREAM_WORK_DIR` = `process.cwd()`（CLI 启动目录），`projectRoot` = 从 cwd 向上找到的最近 .git 目录。AGENTS.md 搜索路径基于 projectRoot，CWD 目录列表基于 SCREAM_WORK_DIR。两者可能不同，在分析 AGENTS 加载行为时务必区分。