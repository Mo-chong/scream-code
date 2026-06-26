# 踩坑与经验记录 — Pitfalls & Lessons

> 说明：记录从开发/使用 ScreamCode 过程中遇到和解决的问题。
> 每个条目包含：问题描述 → 根因 → 解决方案 → 教训。

---

## 目录

- [构建与部署](#构建与部署)
- [记忆系统](#记忆系统)
- [回合控制](#回合控制)
- [注入系统](#注入系统)
- [拦截系统](#拦截系统)
- [Git 与仓库管理](#git-与仓库管理)
- [设计误区](#设计误区)
- [调试教训](#调试教训)

---

## 构建与部署

### agent.yaml 修改必须重构建才能生效

**问题**：在 `agent.yaml` 加了 `- MemoryEdit`，git commit 后重启，新工具不可用。

**根因**：`agent.yaml` 是编译时静态导入（`default.ts:1 import agentYaml from './default/agent.yaml'`），必须在编译时打包进 bundle。只 commit 不 build 不会触发重新编译。

**解决**：
```
修改 agent.yaml → pnpm build (agent-core) → pnpm build (scream-code) → 重启
```

**教训**：YAML 配置的改动都视为代码改动，必须走完整构建链。

### 双构建链（alwaysBundle 陷阱）

**问题**：只 build `agent-core` 后重启，agent.yaml 改动仍不生效。

**根因**：`scream-code/tsdown.config.ts` 中 `deps.alwaysBundle: [/^@scream-./]` 把所有 `@scream-*` 包都打包进 scream-code 的 bundle。所以 agent-core 的 dist 只是中间产物，最终生效的是 scream-code 的 dist。

**解决**：
```
pnpm build (agent-core)  # 编译源码
pnpm build (scream-code)  # 打包进最终 bundle ← 这步必须做
```

**教训**：monorepo 中最终 bundle 是入口，依赖包的 dist 只是中间文件。

### 构建完成后必须重启 scream

**问题**：`pnpm build` 都通过了，但新功能不生效。

**根因**：scream 进程运行的是 `bin/scream.cmd` 加载的 `dist/main.mjs`。构建只写了磁盘文件，正在运行的进程不会自动重载。

**解决**：`Ctrl+C` 停止 scream，重新启动。

**教训**：编译型配置（YAML 编译导入） + 打包型部署（alwaysBundle）= 三步曲：改 → build → 重启。

---

## 记忆系统

### FTS5 不索引 tags 列

**问题**：想搜索 `chundu` 标签的记忆，直接 `search("chundu")` 没结果。

**根因**：FTS5 索引只覆盖了 `user_need`, `approach`, `what_failed`, `what_worked`, `source_session_title` 五列（store.ts:344-351），tags 存为 JSON 字符串不在索引中。

**解决**：先 `search("关键词")` 语义初筛，再 `.filter(m => m.tags?.includes('chundu'))` tag 精筛。

**教训**：不能假设 FTS5 能搜一切。看 `CREATE VIRTUAL TABLE` 定义确认索引覆盖的字段。

### MCP 连接失败：env 过滤器删了 PATHEXT（2026-06-25 排查）

**问题**：MCP 服务器 context7 和 codegraph 均报 "Connection closed"，但终端中独立启动正常。

**根因**：`client-stdio.ts:221` 的 `ALLOWED_ENV_PREFIXES` 列表中缺少 `PATHEXT` 和 `COMSPEC`。
Windows 上 cross-spawn 7.0.6 在 `shell: false` 模式下依赖 `PATHEXT` 来解析命令名的扩展名（`context7-mcp` → `context7-mcp.cmd`）。env 过滤器把这俩环境变量删了，cross-spawn 找不到可执行文件，MCP 连接全部失败。

**修复**：`ALLOWED_ENV_PREFIXES` 加入 `'PATHEXT', 'COMSPEC'`，四包重建。

**教训**：
1. Windows 上 spawn 依赖 `PATHEXT` 解析 .cmd 文件——env 过滤器不要砍它
2. MCP 服务器终端的独立启动正常 ≠ 在 scream 进程中能正常启动（env 不同）
3. Node 24 CVE-2024-27980 加固后 `.cmd` 文件必须经 `cmd.exe` 包装才能 spawn，cross-spawn 的 `parseNonShell()` 做这个包装需要 PATHEXT

### MCP 连接失败 #2：PATHEXT 被 Git Bash 注入双引号字符（2026-06-25）

**问题**：context7 和 codegraph MCP 服务器持续报 "Connection closed" + "不是内部或外部命令" 的错误。桌面快捷方式启动正常，终端（Git Bash）启动失败。

**根因**：Git Bash（MSYS2/MINGW）有一个已知行为——从 Windows 继承环境变量时，会在 `PATHEXT` 值周围包裹双引号。实际值形如：
```
"\";.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PY;.PYW;.SH\";.CPL"
```
首尾各有一个嵌入式 `"`（ASCII 0x22）。

当 cross-spawn 收到 `normalizeWinCommand()` 追加 `.cmd` 的命令（如 `context7-mcp.cmd`），其 `parseNonShell()` 检测到文件不是 `.com/.exe`（`isExecutableRegExp`），于是包装为：
```
cmd.exe /d /s /c "context7-mcp.cmd ..."
```
`.cmd` 文件内容执行 `"%_prog%"`（即 `"node"`）时，`cmd.exe` 用 `PATHEXT` 来解析 `"node"`。但畸形的 PATHEXT 包含了双引号，导致 `cmd.exe` 找不到 `node.exe`，立刻报错退出。MCP SDK 的 `StdioClientTransport.start()` 收到 process error（`error` 事件），标记连接关闭。

为什么桌面快捷方式正常？因为 `wt.exe` → `scream.cmd` → `cmd.exe` → `node main.mjs` 这个路径下，`process.env.PATHEXT` 来自原生 `cmd.exe`，值是干净的（无引号）。而 Git Bash 的 `sh` → `scream` shebang 脚本 → `node main.mjs` 路径下，MSYS2 转译时给 PATHEXT 加了双引号。

**完整 env 传递链**：
```
MCP SDK getDefaultEnvironment() → 只传 12 个 Win32 白名单变量（不含 PATHEXT）
  ↓ 合并
Scream mergeStdioEnv() → 从 process.env 复制 PATHEXT（含引号）
  ↓ 传给子进程 env
cross-spawn → parseNonShell() 包装 cmd.exe
  ↓
cmd.exe 运行 .cmd 文件 → %PATHEXT% 含引号 → 找不到 node → 报错
```

**修复**：`mergeStdioEnv()` 中对 `PATHEXT` 值执行 `value.replace(/"/g, '')` 清洗双引号。

**教训**：
1. Git Bash/MSYS2 下的 `process.env` 不干净——环境变量可能含转译 artifact
2. PATHEXT 这个变量在 Windows 的 `cmd.exe` 中尤其敏感，畸形值直接导致 `cmd.exe` 找不到任何命令
3. 快捷方式启动 vs 终端启动的差异，本质是 `cmd.exe` 原生环境 vs Git Bash 转译环境的差异
4. pnpm 本身也在 Git Bash 中被同样问题影响——修复前连 `pnpm build` 都跑不了

### yongjiu 标签不生效：代码正确但 app 没重建（2026-06-25 排查）

**问题**：源代码中 yongjiu 的 demote 免疫、ResNet D=1、PROTECTED_TAGS、♾️图标全部写好了，但运行时不生效。

**根因**：双构建链陷阱（`deps.alwaysBundle`）。scream-code 的 `tsdown.config.ts` 中 `deps.alwaysBundle: [/^@scream-./]` 把所有 `@scream-*` 包都打包进 scream-code 的 bundle。只 build memory/agent-core 不够，**必须 build scream-code** 才会生成包含新代码的最终 bundle。此外 symlink `/d/reasonix/node_modules/scream-code` → `ScreamCode/apps/scream-code` 指向正确，但 dist 是旧版本。

**排查过程**：
1. 查源代码 → yongjiu 代码全部正确 ✅
2. 查 memory/dist/agent-core/dist → yongjiu 存在 ✅
3. 查 scream-code/dist → 旧 bundle 没有 yongjiu ❌ → 原来是 screams-code 未重建
4. 查 symlink 确认指向最新版本 → 正确 ✅
5. 查 scream --version → 0.6.10 ✅ 但运行时载入的是旧 bundle

**修复**：四个包全部用 tsdown 入口逐个重建（config → memory → agent-core → scream-code）。

**教训**：
1. 验证链路必须是：源代码 → 每个依赖包的 dist → 最终入口的 bundle → 测试 → 重启
2. 中间产物（memory/agent-core 的 dist）不对 = 不用继续查源文件，直接重建
3. 写了正确代码 + build 通过 ≠ 最终 bundle 已更新。scream-code 的最后一步 build 必须跑
4. "代码正确"和"生效"之间差一个完整的构建链

### 双构建链陷阱的验证方法（2026-06-25 补充）

**问题**：如何确认最终 bundle 确实包含了新代码？

**解决**：三步验证法：

```bash
# Step 1: 查 dist 产物（最快判断方向）
grep "yongjiu" packages/memory/dist/index.mjs      # memory 包有吗？
grep "yongjiu" apps/scream-code/dist/app-*.mjs     # 最终 bundle 有吗？

# Step 2: 查 bundle hash 是否变了
ls -la apps/scream-code/dist/                      # 看 hash 和 timestamp
cat apps/scream-code/dist/main.mjs                 # main 指向哪个 bundle？

# Step 3: 运行测试
npx vitest run packages/memory/test/tier-yongjiu.test.ts  # 功能测试
```

**教训**：永远不要相信"代码改了 + build 没报错 = 已生效"。必须在最终 bundle 中 grep 确认。

### baohu 标签的副作用 — Dream 免疫导致无法通过工具编辑

**问题**：给旧版规则加了 `baohu+ding` 标签，Dream 跳过不处理。但新版本写入后，旧版因为 `baohu` 保护始终存在。

**根因**：`consolidator.ts` 中 `PROTECTED_TAGS = ['baohu']`，带 `baohu` 的记忆不被 merge/delete/stale。

**解决**：用 Node.js `DatabaseSync` 直连 SQLite 手动摘掉旧版的 ding 标签。

**教训**：保护标签是双刃剑——保护了不被 Dream 误删，也保护了不被工具编辑。需要绕过工具直接操作 SQLite。

### MemoryEdit 工具默认不在 agent.yaml 中

**问题**：MemoryEditTool 已经注册在 `tool/index.ts:634`，但调用时找不到。

**根因**：工具注册两步骤：① 代码中 `new MemoryEditTool()` 注册 ② `agent.yaml` 中列出工具名，`setActiveTools()` 过滤。步骤①做了，步骤②没做。

**解决**：`agent.yaml` 加一行 `- MemoryEdit`，然后完整构建链。

**教训**：新工具 = 注册 + 配置 + 构建 + 重启，缺一不可。

### 拼音标签体系不影响 AI 搜索

**问题**：最初的 `baohu` 标签用英文还是拼音有讨论。

**结论**：拼音标签不影响搜索，因为 AI 搜索时用自然语言关键词（"保护"），而 FTS5 搜索的是 `user_need`/`approach` 等字段的内容，不是标签名。标签纯粹是系统侧的分类标记。

**教训**：标签的语言对搜索无影响，选语义清晰、不易冲突的即可。

### 标签质量四层优化踩坑记录（2026-06-25）

#### 坑 1：`normalizeTags` 硬编码 `max=5` 吞了动态预算的上限

**问题**：动态预算公式算出来最高 8 个，但存储时只有 5 个。

**根因**：`tags.ts` 的 `normalizeTags()` 写死的 `max = 5`。调用方传 `MAX_TAGS_ABSOLUTE = 8` 也传不进去——因为参数默认值在调用方没传时才生效。

```typescript
// 旧
export function normalizeTags(tags: unknown, max = 5): string[] {

// 新
export function normalizeTags(tags: unknown, max = TAG_CONFIG.MAX_TAGS_DEFAULT): string[] {
```

**修复**：`normalizeTags` 默认值改为 `TAG_CONFIG.MAX_TAGS_DEFAULT`（5），调用方 `processTags()` 传 `TAG_CONFIG.MAX_TAGS_ABSOLUTE`（8）。

**教训**：常量和参数默认值必须来自同一个配置源。藏在函数签名里的魔数是所有预算系统的头号敌人。

#### 坑 2：Dream 合并路径跳过了 `processTags`

**问题**：`consolidator.ts:189-193` 的 Dream 合并直接 `normalizeTags(flatTags)`，不走黑名单和同义合并。

**根因**：旧代码在 `processTags()` 统一路由实现之前写的，直接调用低阶函数 `normalizeTags()`。

```typescript
// 旧（无黑名单+无同义合并）
const mergedTags = normalizeTags(group.memos.flatMap((m) => m.tags ?? []));

// 新（走 processTags 完整链路）
const mergedTags = await processTags(
  group.memos.flatMap((m) => m.tags ?? []),
  { existingTags: allRelatedTags },
);
```

**教训**：统一路由引入后，必须 grep 所有直接调用低阶函数的地方逐一改为高阶调用。只改路由不改调用方等于没有改。

#### 坑 3：`extractor.ts` 同步 `generateTags()` 无法调用 async 后备

**问题**：`generateTags()` 是同步函数，但 `processTags()` 内部的异步后备（`await generateTags(context.fullText)`）需要调用方也是 async。

**根因**：旧代码 `extractor.ts` 的 `extractMemoryMemos()` 是同步调用，无法 await。

**修复**：`extractMemoryMemos()` → `async`，调用方 `compact()` 也同步改为 async。

**教训**：同步→async 的传播链：`compact() → extractMemoryMemos() → processTags() → generateTags()`。改最底层的 `processTags()` 为 async 后，必须把调用栈一直改到顶层函数签名。漏一层就编译不通过——编译会帮你发现，但前提是你先 build。

#### 坑 4：apps/scream-code 是 bundle 模式，子包 dist/ 不算数

**问题**：编译子包 `packages/memory/dist/` 和 `packages/agent-core/dist/` 都通过了，但运行时标签处理仍然是旧代码。

**根因**：`scream-code/tsdown.config.ts` 中 `deps.alwaysBundle: [/^@scream-./]` 把所有 `@scream-*` 包都打包进 scream-code 的 bundle。memory 的 dist 是中间产物，最终用的是 scream-code bundle 里的源代码快照。

**修复**：只 build scream-code 即可（`node ../../node_modules/tsdown/dist/run.mjs`），不需要单独 build memory 和 agent-core。

**教训**：bundle 模式下，依赖包的 dist 只是编译检查凭证，不是运行时加载的文件。最终 bundle 一步到位。

---

## 回合控制

### LSP 在 root agent 连续超时 120s — 3 个独立 bug 的链式故障（2026-06-23 修复）

**现象**：`LSP.references` 和 `LSP.definition` 始终 120s 超时（`DEFAULT_REQUEST_TIMEOUT_MS`），但 `LSP.diagnostics` 能立刻返回。子 agent reviewer 的 LSP 可用。

**表面迷惑性**：diagnostics 能通让人误以为 LSP 服务器正常，实际上 diagnostics 是 server-push notification（无需 request-response），而 references/definition 需要完整的 request-response 通路。三个 bug 依次叠加：

**Bug 1 — 僵尸 client 缓存（registry.ts + client.ts）**

**症状**：第一次调用 `typescript-language-server` 时 spawn ENOENT（PATH 里找不到命令），但 `LspClient.start()` 在进程创建前就设了 `this.started = true`，且 `LspRegistry.getClient()` 在 `client.start()` 完成前就 `this.clients.set(key, client)`。失败后死进程被永久缓存。后续请求发过去静默丢弃（`send()` 里 `if (this.process === undefined) return`），Promise 永不 resolve，直到 120s 超时。

**修复**：① `client.ts`：`this.started = true` 放在进程创建成功 + stdout/stderr 绑定之后；② `registry.ts`：`await client.start()` 通过后才 `set()` 缓存。

**Bug 2 — workspace root 无 tsconfig.json（registry.ts）**

**症状**：TypeScript LSP 启动后对 `workspaceRoot` 全目录扫描寻找项目。`workspaceRoot = D:/AI/allgzmulu`（会话当前目录）没有 `tsconfig.json`，TS server 一直扫到超时。

**修复**：`getClient()` 改为从文件路径往上找最近有 `tsconfig.json`/`jsconfig.json` 的祖先目录做 project root。

**Bug 3 — Windows spawn 不能跑 `.cmd` 文件（registry.ts）**

**症状**：全局安装的 `typescript-language-server` 入口是 `.cmd` 文件（`%APPDATA%/npm/typescript-language-server.cmd`）。Node `child_process.spawn` 不能直接执行 `.cmd`，抛出 `spawn EINVAL`。

**修复**：`_resolveCmd()` 用 `npm root -g` 找到全局 node_modules，解析到 `lib/cli.mjs` 真实入口，用 `node <entry> --stdio` 启动。

**链式故障示意图**：
```
spawn typescript-language-server → ENOENT（PATH 无 cmd，Bug 1 僵尸）
→ 下次请求 → 僵尸 client 静默丢包 → 120s 超时（Bug 1 症状）
→ 全局安装后 → spawn 不跑 .cmd → EINVAL（Bug 3）
→ 绕路 npx → 捆绑环境 PATH 无 npx.cmd → 依然 EINVAL
→ resolveProjectRoot 无 tsconfig → scan 2min → 超时（Bug 2 叠加）
```

**教训**：
1. symptoms can be the same for different root causes — 别只看现象换方向
2. Windows 上 spawn 不能跑 `.cmd` 文件，必须用 `node <entry>` 或 `cmd /c`
3. LSP diagnostics 通 ≠ LSP 完全可用，references/definition 是独立的 request-response 通路
4. bundle 环境 PATH 与开发环境不同，所有外部命令依赖必须显式处理

### shouldContinueAfterStop 收敛门有注入次数上限

**问题**：收敛门最多注入 5 次（`MAX_CONVERGENCE_INJECTIONS = 5`），超过后就算拦截也会放行。

**根因**：防无限循环保护——如果 AI 一直被拦住但不修正，5 次后强放，避免死锁。

**教训**：不是被拦就一定安全，超过上限后仍可能放行有问题的行为。

---

## 注入系统

### system_trigger 穿透预算但数量仍消耗 token

**问题**：`system_trigger` 绕过 `injectBudget` 的预算检查，但注入的内容仍然占用上下文 token。

**根因**：`turn/index.ts:1356-1359` 直接调 `appendSystemReminder()` 返回，不走 budget、残差、去重。但注入的内容是 append 到上下文中的，占位置。

**教训**：`system_trigger` 不是"无限免 token"——只免了预算检查，token 空间照占。

### 中文 <system-reminder> 指令权重大于英文

**问题/发现**：同一条规则，英文写容易被 AI "I understand but..." 绕过，中文写更容易被遵守。

**分析**：
- 英文在训练数据中占 ~70%，被绕过的样本也多
- 中文占 ~10-15%，被绕过的样本少，约束更"干净"
- 中文祈使句（"不准"/"必须"）语义刚性比英文的 "should"/"must" 强

**教训**：在不可微调的约束下，中文 + `<system-reminder>` 标签 = 能给 AI 的最强信号。

---

## 拦截系统

### 事件日志路径指向父目录（2026-06-23 修复）

**问题**：`resolveBaseDir()` 用 `dirname(this.agent.homedir)`，日志写到了 `.scream-code` 的父目录。

**根因**：`event-snapshot.ts:235` 错误使用 `dirname()`。`agent.homedir` 已经是 `.scream-code` 的路径（如 `C:/Users/xxx/.scream-code/agents/xxx`），用 `dirname()` 反而向上取了一层。

**修复**：`const base = this.agent.homedir ?? '.'` → 日志写在 `.scream-code/interception-logs/` 内。

**教训**：`agent.homedir` 是 agents 目录，不是 session 目录。改之前先确认 homedir 的实际值。

### 攒批刷盘策略导致用户看不到日志（2026-06-23 修复）

**问题**：用户跑完一回合，日志文件没出现。

**根因**：`shouldFlush()` 默认攒 5 回合或 30 分钟才写盘。单回合有事件也不写。

**修复**：`MAX_PENDING_ROUNDS=1`，`MIN_FLUSH_INTERVAL_MS=0`，`shouldFlush()` 简化为单行。

**教训**：默认配置偏向"少写盘"，但拦截日志的消费场景要求"即时可见"。

### session.close() 没有调用 eventBuffer.flush()（2026-06-23 修复）

**问题**：虽然每回合刷盘，但会话关闭时可能在跑的 `drainBatch()` 没完成，会话就结束了。

**根因**：`session/index.ts:close()` 中有 `flushMetadata()`，但没有对应的 `eventBuffer.flush()`。

**修复**：在 `TurnFlow` 加 `flushEventLog()` 公开方法，`session.close()` 在 `flushMetadata()` 后调用。

**教训**：异步操作类的资源管理必须检查关闭路径的兜底 flush。reviewer 可以查到这个漏。

### 偏差链连续 Edit 拦截（2026-06-24 修复：只对代码文件触发）

**问题/发现**：连续 3 次 Edit（代码文件如 .ts/.py/.rs）没有 LSP.references → 偏差链触发 → 收敛门拦住。

**修复**：`editOnCodeFileThisStep` 区分代码文件（.ts/.tsx/.js/.jsx/.py/.rs/.go）和非代码文件（.md/.json/.yaml/.toml 等）。编辑 .md / .json / .yaml 不再触发 LSP.references 要求。

**机制**：`turn/index.ts` 的 `injectStepAfterVariants()` 中 `editOnCodeFileThisStep && !hasCalledLspReferencesThisStep`，每步结束时检查。`editWithoutLookupCount >= 3` → `deviationChainActive = true`。

**取消**：必须调一次 LSP.references（或 reviewer）才会释放。

**教训**：偏差链不是 bug，是设计——强制在批量代码编辑之间插入验证步骤。但文档编辑不在此列。

---

## Git 与仓库管理

### 作者 force-push 重写历史 → 合并变无共同祖先（2026-06-24）

**问题**：`git merge origin/main` 爆出上千个 add/add 冲突。

**根因**：作者的 v0.6.9 是从全新的 `Initial commit` 开始的（4f67f50），和我们 fork 的旧历史线（起点 32b5233）完全没有共同祖先。`git merge-base` 返回 exit: 1。GitHub 显示的"forked from"标签是网站元数据，不影响实际 commit 历史。

**解决**：不用 `git merge`，改用 cherry-pick：

```bash
# 从 v0.6.9 创建新分支
git checkout -b update-v069 v0.6.9

# 把我们的 commits cherry-pick 上去（从最旧到最新）
git cherry-pick <oldest-commit>^..<newest-commit>

# 遇到冲突时接受我们的版本
git checkout --theirs <conflict-file>
git add <conflict-file>
git cherry-pick --continue
```

**教训**：
1. `git merge-base` 是合并前必须跑的检查——确认两条分支有共同祖先再 merge
2. 没有共同祖先时 `git merge --allow-unrelated-histories` 是最差选择，会爆全量 add/add 冲突
3. Cherry-pick 是"历史不连通"场景下的替代方案

### 被抹掉的文件要主动从旧历史恢复（2026-06-24）

**问题**：Cherry-pick 完成后构建报错，`injector/*.ts`、`pnpm-workspace.yaml`、`node-sdk/tsconfig.dts.json` 在磁盘上找不到。

**根因**：作者 force-push 后的新初始提交不包含这些文件。我们的 cherry-pick 从 Phase 5 开始，但 Phase 1-4 创建的文件被代码 import 了但不在新历史里。

**检查**：
```bash
git ls-tree v0.6.9 packages/node-sdk/tsconfig.dts.json   # 在新历史中是否存在？
git ls-tree main packages/node-sdk/tsconfig.dts.json      # 在我们的 main 中是否存在？
```

**解决**：从旧历史或 v0.6.9 恢复：
```bash
git show v0.6.9:pnpm-workspace.yaml > pnpm-workspace.yaml
git show 32b5233:packages/node-sdk/tsconfig.dts.json > packages/node-sdk/tsconfig.dts.json
```

**教训**：
1. Force-push 新初始提交 = 代码还在但部分配置文件会丢失
2. 构建失败先看错误是不是"文件不存在"再改代码
3. `git ls-tree <ref> <path>` 确认文件在哪个版本中存在

### 包名变更导致 import 找不到（2026-06-24）

**问题**：构建报 `Cannot find module '@scream-code/ltod'`——cherry-pick 过来的代码用的是旧包名 `@scream-cli/ltod`。

**根因**：v0.6.9 把 `@scream-cli/*` 全部改成 `@scream-code/*`。cherry-pick 搬代码但不改包名。

**检查**：
```bash
grep -rn "@scream-cli/" packages/ apps/
```

**解决**：全局搜索替换为 `@scream-code/`。

**教训**：大版本改名后 cherry-pick，包名引用是最容易被忽略的遗漏项。

### `pnpm install` 是 cherry-pick 后的必修课（2026-06-24）

**问题**：一切构建通过后，`scream` 命令报错找不到入口。

**根因**：Cherry-pick 改了配置文件，`node_modules` 的 workspace 符号链接没更新。

**解决**：
```bash
pnpm install                     # 重建 workspace symlinks
npm install -g ./apps/scream-code # 重装全局 CLI
scream --version                 # 确认工作
```

**教训**：
1. Force-push + cherry-pick 后 `node_modules` 是脏的——必须 `pnpm install`
2. 全局安装入口指向旧包名也需要重装
3. 验证顺序：git 状态 → pnpm install → pnpm build → scream --version

### Edit 工具漏传 path 参数（2026-06-24）

**问题**：调用 Edit 时报 `Invalid args for tool "Edit": must have required property 'path'`。

**根因**：Edit API schema 中 `path` 是 required 参数，但调用时只传了 `old_string` 和 `new_string`，漏了 `path`。

**教训**：
1. Edit 的 3 个必填参数是 `path` + `old_string` + `new_string`，缺一不可
2. 在工具调用模板中，`path` 应该永远放在第一个写，不容易忘

### pnpm lifecycle 在 Windows Git Bash 下无法执行（2026-06-26 确认）

**问题**：`pnpm install` 报 "enospc" 或子进程找不到 `node`，`package.json` 的 `prepare` 脚本（`"prepare": "node scripts/prepare.mjs"`）以及 `apps/scream-code` 的 `preinstall`/`postinstall` 全部失败。

**根因**：pnpm lifecycle 在 Windows 上使用 `cmd.exe` 运行子进程脚本。但 `cmd.exe` 继承的 PATH 中缺少 Node.js 路径（`node` 不在 PATH 中），导致 `.cmd` 文件执行时找不到 `node`。

**解决**：绕过 pnpm lifecycle，直接调用 tsdown：
```bash
node node_modules/.pnpm/tsdown@*/node_modules/tsdown/dist/run.mjs \
  --config apps/scream-code/tsdown.config.ts
```

**教训**：
1. pnpm lifecycle 在 Windows Git Bash 下不可靠——不要依赖 `prepare`/`preinstall`/`postinstall` 做关键构建步骤
2. 绕过方式：直接调 tsdown 的 run.mjs，跳过了 pnpm 的 lifecycle 流程
3. `scripts/prepare.mjs` 中用 `process.execPath` + `shell: true` 可以缓解但不会根治——`cmd.exe` 子进程的问题仍存在

### VEC0_DIMS 常量与模型实际维度不同步（2026-06-26 修复）

**问题**：`VEC0_DIMS = 384`，但嵌入模型 BGESmallZH 实际输出 512 维。一旦写入 `float[384]` 的 vec0 表会 SQLite 报错。

**根因**（Git 时间线）：
```
Jun 16 10:44 → VEC0_DIMS 诞生（英文模型 BGESmallENV15，384 维 ✅）
Jun 16 11:09 → 模型切换为中文 BGESmallZH（512 维 🔴 此时还没 VEC0_DIMS）
Jun 25       → sqlite-vec 引入 VEC0_DIMS = 384（继承了错误值 🔴）
```
从引入恒量 `VEC0_DIMS` 的第一天起就是错的——写代码的人假设模型是 384 维，没去核实 9 天前模型已被换成 512 维的 BGESmallZH。

**修复**：`VEC0_DIMS = 512` + `rebuildVec0IfNeeded()` 在启动时检查 vec_memos 是否空，空则 DROP+CREATE。

**教训**：
1. 模型切换时必须同步更新所有模型相关的常量（特别是维度）
2. Git 历史能帮你找出错误的真正起点——追到 `4377862`（Jun 16 11:09 切模型）和 `0e8fb88`（Jun 25 引入 VEC0_DIMS）
3. `VEC0_DIMS` 的注释应该写 `// 512 = BGESmallZH`，这样下次换模型时一眼就知道要改哪里
4. 全项目搜 `Float32Array(384)` 是测试文件维度硬编码残留的可靠检查方法

### 容量控制被 embedding 管道锁死（2026-06-26 修复）

**问题**：143 条记忆全部在热层（`memos` 表），冷层（`memos_archive`）0 条。`autoDemoteIfNeeded()` 从未被调用。

**根因**：`scheduleEmbedding()` 开头有一个 early-return：
```typescript
// store.ts:1305-1306
if (this.embeddingEngine === undefined || !this.embeddingEngine.available) return;
```
embedding 引擎不可用 → `scheduleEmbedding` 直接 return → `flushEmbeddings()` 不被触发 → `autoDemoteIfNeeded()` 不被调用。但 `autoDemoteIfNeeded()` 后半段（热层 > 100 条就 evict）完全不依赖 embedding——被无辜连坐。

**修复**：新增独立容量守卫 `enforceHotTierCap()`（`store.ts:1147-1169`），在 `appendInternal` 尾部（line 685）每次写记忆都自动触发，不依赖 embedding。

**教训**：
1. 异步管道的触发链耦合会导致连带故障——embedding 挂了降级也一起死了
2. 容量控制这种基础功能永远不应该依赖一个"可能不可用"的外部子系统
3. `enforceHotTierCap` 的防御性设计：先 COUNT 轻查询，超限才全表扫描——兼顾性能和防呆

### loadEmbedder() 的 import('fastembed') 运行时永远找不到模块（2026-06-26 修复）

**问题**：`memory_embeddings = 0`，所有记忆从未生成过 embedding。

**根因**：`import('fastembed')` 是 ESM 动态导入，Node.js 从 `process.cwd()` 开始遍历目录树找 `node_modules/fastembed`。但 `sc` CLI 构建后（tsdown bundle），运行时 CWD 是用户目录（如 `C:/Users/Administrator/`），不是项目根目录，所以模块解析链找不到 `fastembed`。

**修复**：三级 fallback 机制：
```
Primary:   createRequire(import.meta.url).resolve('fastembed/package.json')
           → 从 bundle 位置向上找 node_modules → 找到绝对路径 → import(feDir)
Fallback 1: 裸 import('fastembed') → 开发模式（CWD = 项目根）时正常工作
Fallback 2: SCREAMCODE_NODE_PATH 环境变量 → 手动指定路径的逃生舱
```

**教训**：
1. bundle 后 CWD = 用户目录，不是项目根——不要假设 `import('xxx')` 能找到任何包
2. `createRequire(import.meta.url)` 可以在 bundle 中创建一个从 bundle 位置出发的 require 解析器——这是 ESM bundle 中找 node_modules 的通用解法
3. fastembed 内含 ONNX Runtime 原生 `.node` 扩展，不能被 bundle（`alwaysBundle` 排除），所以运行时必须能解析到 `node_modules/fastembed` 的真实路径
4. 当前 embedding 引擎仍不可用——虽然修复了加载路径，但 ONNX Runtime 原生模块在 bundle 环境中的加载可能还有后续问题

### tsdown.config.ts 的 Date.now() 类型错误（2026-06-26 修复）

**问题**：`tsdown build` 报类型错误，构建中断。

**根因**：`tsdown.config.ts` 中 `define: { __BUILD_TIMESTAMP__: Date.now() }`。rolldown 的 `define` 选项要求值是 `string` 类型，`Date.now()` 返回 `number`，导致构建报错。

**修复**：`String(Date.now())`。

**教训**：`tsdown.config.ts` 的构建错误在本轮修复之前就被掩盖了——因为 `pnpm build` 走 pnpm lifecycle，先死在 lifecycle，根本到不了 tsdown。`Date.now()` 的类型错误是绕过了 pnpm 直接跑 tsdown 后才暴露出来的。

### 测试文件硬编码 Float32Array(384) 残留（2026-06-26 修复）

**问题**：`tier-vec0.test.ts` 和 `vec0-repro.test.ts` 中共 14 处 `Float32Array(384)`。

**根因**：`VEC0_DIMS` 常量的初始化发生在方案的 Step 1（store.ts），但这些测试文件写于方案实施之前或时，使用了硬编码 384 而非引用常量。

**修复**：14 处全部改为 `Float32Array(512)`。

**教训**：
1. 修改常量后必须全项目 grep 该常量的旧值（例如 `Float32Array(384)`）——测试文件最容易被遗漏
2. 硬编码维度在测试中尤其危险——测试可能"通过"但实际插入的是错误维度的数据
3. 以后应该用 `new Float32Array(VEC0_DIMS)` 替代 `new Float32Array(512)`——但 VEC0_DIMS 是模块级常量，测试文件中 import 不了（因为是 internal const）

---

## 设计误区

### "系统没有压缩"（假分析）

**问题**：在方向文件中写了"系统没有上下文压缩"。

**事实**：系统自带了 `FullCompaction` + `MicroCompaction` 两层压缩，全自动运行。

**教训**：写分析前必须确认系统已经有什么。这是写 SYSTEM 说明书的原因——下次不用靠记忆。

### "注入需要回收"（伪需求）

**问题**：认为注入的规则越来越多需要回收。

**事实**：行为规则一共就 5 条（~500 tokens），在 32k 上下文中占 2%，完全不需要回收。而且 step 级去重已经在做了。

**教训**：量级决定方案。5 条规则用 5000 条规则的方案是过度设计。

### "注入压缩能省钱"（过度优化）

**问题**：认为需要把规则从 120 token 压缩到 30 token。

**事实**：5 条规则最多省 450 token，换来语义可能损失。

**教训**：优化前先算 ROI。省 1% 的 token 花 100% 的时间不值得。

### 开源方案能直接拿来用（场景不匹配）

**问题**：认为 ContextFusion/MEM1 可以集成。

**事实**：ContextFusion 是做 RAG 上下文的压缩路由，MEM1 是做 RL 训练让模型自己学会压缩。我们的场景是"少量规则注入 + 系统行为拦截"——路径不同。

**教训**：开源工具解决的是通用问题。先确认自己的问题是不是通用问题。

---

## 调试教训

### MCP 连接失败全复盘 — 同一个现象背后是 2 个独立 bug 的链式叠加（2026-06-25）

> 三次修复，三次重启，同一个现象 "Connection closed"，背后是 env 过滤 + normalizeCommand + PATHEXT 污染三个 bug 依次浮现。

#### 经过

```
2026-06-24 晚上：
  用户反馈：MCP context7/codegraph 全部报 "Connection closed"
  尝试：自己开终端独立启动 context7-mcp → 正常
  判断：不是服务端问题，是 scream 的 spawn 环境有问题

Round 1 → 修 ALLOWED_ENV_PREFIXES（约 30 分钟）
  猜测：env 过滤太严格，砍了 PATHEXT/COMSPEC
  操作：client-stdio.ts 的 ALLOWED_ENV_PREFIXES 加入 PATHEXT/COMSPEC
  构建：四包重建，重启
  结果：还是一样 ❌

Round 2 → 修 normalizeWinCommand + findCmdInPath（约 45 分钟）
  猜测：bare name "context7-mcp" 没有 .cmd 后缀，cross-spawn 找到 shebang 脚本后死锁
  操作：增加 normalizeWinCommand() 对 Win32 追加 .cmd，增加 findCmdInPath() 搜索 PATH
  构建：四包重建，重启
  结果：桌面快捷方式正常了 ✅，但终端启动仍然失败 ❌
        → 发现"桌面快捷方式正常"这个关键线索

Round 3 → 修 PATHEXT 双引号污染（约 60 分钟）
  猜测：终端 vs 快捷方式的差异来自启动环境不同
  验证 PATH：findCmdInPath 在 node 环境本身就能找到 .cmd → 没问题
  验证 env 传递链：发现 MCP SDK 的 getDefaultEnvironment() 有自己的一套白名单！
  验证 cross-spawn 解析：parseNonShell() 对 .cmd 文件包装 cmd.exe /d /s /c
  关键测试：cmd /c context7-mcp.cmd --version 在过滤后的 env 中运行 → 报错
  PATHEXT 检查：发现 process.env.PATHEXT 的值包含嵌入式双引号！
  "\";.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PY;.PYW;.SH\";.CPL"
  修复：mergeStdioEnv() 中对 PATHEXT 值做 value.replace(/"/g, '')
  构建：四包重建，重启
  结果：桌面和终端都正常了 ✅
```

#### bug 叠加关系

```
Bug 1: ALLOWED_ENV_PREFIXES 缺 PATHEXT
  ↓ 修了
Bug 2: cross-spawn 对 bare name 走 shebang 死锁（normalizeWinCommand）
  ↓ 修了
Bug 3: Git Bash 给 PATHEXT 注入双引号，.cmd 文件里 cmd.exe 找不到 node
  ↓ 这个才是终端启动失败的最终根因
```

没有 Round 1 的修复，Round 3 的 PATHEXT 值就算清洗了也传不进去。
没有 Round 2 的修复，bare name 会走 shebang 路径先报错。
三个 bug 叠加 → 同一个 "Connection closed" 现象。

#### 关键排查方法

1. **AB 对比（桌面 vs 终端）**：同一个代码，不同的启动环境。这种对比比胡乱改代码高效百倍——环境差异才是突破口。
2. **写最小复现测试**：`cmd /c context7-mcp.cmd --version` 在过滤后的 env 中跑——结果报的不是"Connection closed"而是"不是内部或外部命令"。中文 Windows 把真正的根因暴露出来了。
3. **逐层检查 env 传递链**：`process.env.PATHEXT` → `mergeStdioEnv()` 输出 → `getDefaultEnvironment()` 合并 → cross-spawn 接收的 env → cmd.exe 看到的 PATHEXT。每一层都做一个 console.log 确认值。
4. **拆分成功/失败的 env 差异**：对比桌面快捷方式的 env（干净 PATHEXT）和终端启动的 env（含引号 PATHEXT）→ 直接定位到污染源。

#### 教训总结

**教训 1：同一个现象，背后可能是多个独立 bug 叠加**
"Connection closed"可以是：
- 命令找不到（PATHEXT 被过滤）
- shebang 死锁（bare name 没加 .cmd）
- cmd.exe 解析失败（PATHEXT 被污染）

每次都修一个，每次都以为修完了——但只有三个全修了才走通。

**教训 2：终端启动 ≠ 桌面快捷方式启动**
这是 Windows 特有的坑。快捷方式走 `wt.exe → cmd.exe → node`，终端走 `sh → shebang → node`。两个路径下 `process.env` 的内容不同：
- 快捷方式：环境变量直接来自 Windows 注册表 → 干净
- Git Bash：MSYS2 转译 → 可能给环境变量加引号、改格式

**教训 3：MCP SDK 有自己的 env 白名单**
`@modelcontextprotocol/sdk` 的 `StdioClientTransport.start()` 调用 `getDefaultEnvironment()`，只继承了 12 个 Windows 白名单变量（不含 PATHEXT/COMSPEC）。所以只修 scream 的 `mergeStdioEnv()` 加白名单还不够——还要确保 SDK 自带的 env 继承不会筛掉它们。

看代码：`getDefaultEnvironment()` 不会覆盖 scream 传入的 env，因为 SDK 先 `...getDefaultEnvironment()` 再 `...env`。所以 mergeStdioEnv 额外传一份就能覆盖——但前提是 mergeStdioEnv 本身传了正确的值。

**教训 4：最小复现测试比猜代码更有效**
与其反复读 `client-stdio.ts` 猜"这里会不会有问题"，不如直接写一个 20 行的 CJS 文件模拟 spawn：
```
cp.spawnSync('cmd.exe', ['/d','/s','/c', 'context7-mcp.cmd --version'], { env })
```
结果马上告诉你问题在 env 不在代码逻辑。

**教训 5：process.env 在 Git Bash 下不可信任**
```
Raw PATHEXT: "\";.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PY;.PYW;.SH\";.CPL"
```
Git Bash 的环境变量可能包含引号包裹等 MSYS2 转译 artifact——任何传递给子进程的 env 变量都应该做基本清洗。

**教训 6：交叉验证链路**
```
源代码改了 → dist 编译了 → bundle 确认包含新代码 → 最小复现测试通过 → 重启
```
每一步都能通过 grep/file 验证，不要跳过任意一环。本轮排查踩的坑——"修了 build 了重启了还是一样"——就是因为 patch 1 和 patch 2 没有在 bundle 中 grep 确认存在。

#### MCP 调试 checklist（更新版）

```
症状：MCP 服务器报 "Connection closed" 或 "不是内部或外部命令"

Step 1：区分启动路径（30s）
  桌面快捷方式 vs 终端（Git Bash）启动 → 结果是否相同？
  不同 → 环境差异问题；相同 → 代码逻辑问题

Step 2：独立启动验证（30s）
  终端直接跑命令看能否正常运行
  能 → spawn 环境问题；不能 → 服务端/安装问题

Step 3：写最小复现（5min）
  cp.spawnSync('cmd.exe', ['/d','/s','/c', '<command> --version'], { env })
  看 stderr 的具体错误（不是 Connection closed，而是"不是内部或外部命令"）

Step 4：检查 env 传递链（5min）
  process.env.PATHEXT 是否干净？
  mergeStdioEnv() 的输出是否包含 PATHEXT/COMSPEC？
  getDefaultEnvironment() 的 12 个白名单是否足够？

Step 5：检查 bundle（2min）
  grep "PATHEXT" dist/app-*.mjs → 确认新代码已打包
  dist/main.mjs 是否指向最新的 hash bundle


**经过**：修复 LSP.references 超时用了 10+ 轮对话，尝试了 5 种不同方向（agent.yaml 工具注册、僵尸进程、workspace root、npx fallback、全局安装、Windows .cmd）才全部解决。

**为什么绕了这么久**：

1. **只看错误消息改方向**：`ENOENT` → 装全局 → `EINVAL` → 改 npx → `npx ENOENT` → 改 bundle → 每次发现一个问题就以为"哦原来就是这个"，修了立刻试，试了还不行再换下一个。实际上 3 个 bug 叠加，修 1 个 2 个都不够。

2. **没做"症状排除矩阵"**：如果一开始就把三个 LSP 功能（references/definition/diagnostics）都试一遍，就会发现 diagnostics 可用 → 不是 agent.yaml 工具注册问题。这才是关键阻断信息——单靠这一个排除就能省掉第一轮绕路。

3. **过早怀疑非代码原因**：第一轮 LSP 调用失败就抛出"tool not found"，但误以为是"网络问题"、"路径问题"、"权限问题""换网络"——其实看错误码 `ENOENT` 就是命令不在 PATH，非常直接。

4. **修复后没确认 bundle 确实更新**：改了代码、build 通过、重启，但 `spawn EINVAL` 仍然是旧代码报的——说明 bundle 没清缓存或 build 没正确 link。应该用 `strings bundle | grep "npx.cmd"` 确认新代码真的进去了。

**总结 — LSP debugging checklist**：

```
症状：references/definition 均 120s 超时，但 diagnostics 正常

Step 1：排除法（30s）
  diagnostics 可用 → LSP 进程可启动 → 排除 agent.yaml/工具注册问题
  → 问题在 request-response 路径

Step 2：看错误类型（2min）
  ENOENT → 命令不在 PATH
  EINVAL → Windows spawn 不支持 .cmd
  EFATAL/TIMEOUT → 进程可启动但卡死在项目扫描

Step 3：验证修复（30s）
  strings dist/app-*.mjs | grep "npx.cmd"  确认新旧代码
  重启后 LSP.references 直接试，不要猜
```

**教训**：
1. 多个 bug 叠加导致同一症状时，修了还不行不代表方向错——可能只修了冰山一角
2. diagnostics vs references 功能差异是 LSP 调试的关键排除点
3. 每次修复完先确认 bundle 有没有新代码再试，避免"修了 = 等于没修"的无效循环
4. 错误码是线索不是判决——ENOENT 后面接 EINVAL 说明路径方向对但 spawn 方式错

### MemoryEdit ID 前缀

使用 `MemoryEdit` 工具时，`id` 参数必须带 `memo-` 前缀。
`MemoryLookup` 返回的 ID 是短格式（如 `mqqhr7ek-pq7iel`），但数据库实际存的 ID 是 `memo-mqqhr7ek-pq7iel`。
传给 `MemoryEdit` 时要用完整 ID，否则报 "not found"。

## LSP 故障 #2：bundle 环境中 npm root -g 和 npx.cmd 双重 fallback 失败（2026-06-25）

**问题**：scream（bundle 运行）中 LSP.references 报 `"not found in PATH and npx fallback failed: spawn EINVAL"`。

**连锁故障链路**：

```
LSPTool → registry.getClient() → _resolveCmd()
  → execSync('npm root -g')     ← ❌ npm 在 bundle 环境中不在 PATH
  → fallthrough 返回原始命令     ← [typescript-language-server, --stdio]
  → client.ts jian.exec()       ← spawn ENOENT（不在 PATH）
  → npx fallback: spawn('npx.cmd', ...)  ← spawn EINVAL（.cmd 不能直接 spawn）
```

**根因**：两次 fallback 都卡在同一个 Windows 限定上——bundle 打包后 `PATH` 环境变量只有 Windows 系统目录和 scream 所在目录，`npm` 和 `typescript-language-server` 都不在 PATH 中。

**修复两处**：

| 文件 | 旧 | 新 |
|------|----|----|
| `registry.ts` | 只试 `execSync('npm root -g')` | 3 重 fallback：`npm` → `npm.cmd` → `nodeBin/npm.cmd` |
| `client.ts` | 直接 `spawn(npxPath, '-y', ...)` | Windows 上包装为 `cmd.exe /d /s /c npx.cmd -y ...` |

**bundle env 的 PATH 构成**：
```
bundle 运行时的 process.env.PATH 通常只包含:
  C:\Windows\system32
  C:\Windows
  D:\reasonix\  (scream 所在目录)
  
不含:
  C:\Program Files\nodejs\           ← npm/node
  %APPDATA%\npm\                     ← 全局 node_modules .bin
  C:\Users\Administrator\.cargo\bin  ← rust-analyzer
```

这意味着 bundle 中 spawn 外部命令（typescript-language-server、npx、npm）全部依赖 registry.ts 的 `_resolveCmd()` 解析到 `node <entry>`，或者 client.ts 的 npx fallback——两者之前都有 Windows .cmd 缺陷。

**教训**：
1. bundle 环境的 PATH 极简——不要假设任何外部命令在 PATH 中
2. `_resolveCmd()` 的 `npm root -g` 本身依赖 `npm` 在 PATH 中——bundle 中这也不成立，必须用 `nodeBin/npm.cmd` 绕过
3. npx fallback 的 `.cmd` 不能直接 spawn——这是 Windows 上所有 `.cmd` 文件的通用限制，不限于 npx
4. LSP.references 报 `spawn EINVAL` 基本就是 spawn 了 `.cmd` 文件——排查方向固定

**新增 checklist 条目**：

```
症状：LSP 报 "spawn EINVAL" + "npx fallback failed"

Step 1：看错误类型（30s）
  "not found in PATH" → registry.ts 的 resolve 失败
  "spawn EINVAL"     → .cmd 文件被直接 spawn
  两者都有            → resolve 和 npx fallback 都废了

Step 2：检查 bundle 中的 resolve 代码（2min）
  grep "npm root -g" dist/app-*.mjs       → 旧代码只有一种尝试？
  grep "npm.cmd.*root" dist/app-*.mjs     → 新代码有多种 fallback？
  grep "cmd.exe.*npx" dist/app-*.mjs      → npx fallback 用了 cmd.exe 包装？

Step 3：直接手动运行 resolve 路径（3min）
  node -e "console.log(require('child_process').execSync('npm root -g').toString())"
  → 在 bundle 环境（/d/reasonix/）跑一遍看是否成功
```

### 降级容量守卫形同虚设（.catch 吞错 + 缺写锁）
**现象**：热层 152 条 > HOT_MAX_SIZE=100，冷层永远 0 条。`enforceHotTierCap()` 从未成功执行。
**发现**：2026-06-26 全链路追查，手工 SQL 模拟降级成功（INSERT archive + DELETE memos + DELETE vec_memos 均正常），但线上从不触发。
**根因**：
- `store.ts:685` `void this.enforceHotTierCap().catch(() => {})` — 所有抛错被静默吞掉
- `store.ts:1066` `demote()` 没有 `withWriteLock` 包裹，与主 append 路径并发时 SQLITE_BUSY 超时抛错 → 被吞
- `store.ts:1400` `void this.autoDemoteIfNeeded().catch(() => {})` — 同款吞错
**修复**（2026-06-26）：
- `demote` 用 `return this.withWriteLock(async () => {...})` 包裹
- `.catch(() => {})` 改为 `.catch((err) => { this.log.error?.('...', { error: err }) })`（两处）
**排查方法**：查冷层 `node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(require('os').homedir()+'/.scream-code/memory/memos.sqlite');console.log('archive:',d.prepare('SELECT COUNT(*) FROM memos_archive').get().c)"` → 0 说明从未降级
