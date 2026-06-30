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
- [v0.7 升级与合并](#v07-升级与合并)
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

### 踩坑 #4：保护名单漏了 `ding` 标签（2026-06-27）

**症状**：带 `ding` 标签的记忆在热层容量裁剪时可能被降级（误删）

**根因**：`enforceHotTierCap()` / `demote()` / `autoDemoteIfNeeded()` 的保护名单只列了 `baohu/chundu/yongjiu`，漏了 `ding`。4 种"免死金牌"标签只保护了 3 种。

**修复**：补全 6 处的 `.includes('ding')`：
- `demote()` L1162
- `autoDemoteIfNeeded()` L1198 / L1218
- `enforceHotTierCap()` L1243 / L1264
- `listAll()` PROTECTED_TAGS L1630

**教训**：保护标签列表定义在一处（如 `tags.ts` 或常量数组），不要散落在各处手写条件。新增标签时用 `grep -rn` 搜索所有 `.includes('yongjiu')` 确认全覆盖。

### 踩坑 #5：业务验收报告误把缺项名写错（2026-06-27）

**症状**：验收报告说 `hermit` 标签漏了，实际漏的是 `ding`

**根因**：写报告时没去读实际代码也没读方案文档，凭记忆写了 `hermit`。方案文档写的是 4 个保护标签（`baohu/ding/yongjiu/chundu`），"隐修"不是方案里的内容。

**教训**：验收报告每条结论必须 from Read/Grep/LSP 的事实，不能从"我感觉"出发。

### 踩坑 #6：连续 Edit 未查 LSP References 触发偏差链（2026-06-27）

**症状**：连续 6 次 Edit 修改 .includes() 条件，被 Guard Rule 6 拦住要求查 references

**根因**：虽然每个 Edit 只是改字符串字面量（无方法签名变化），但批量 Edit 触发了"连续编辑未查 references"的偏差检测规则。

**教训**：
- 小改动（只改方法体内部字符串）改完后用一次 LSP.references 确认调用方不受影响
- 批量 Edit 后必须加验证步骤：Read 确认 + LSP.diagnostics + LSP.references

### 踩坑 #7：多个 Edit 到同一文件时锚点过期（2026-06-27）

**症状**：第 2 个及后续 Edit 因第一个 Edit 改了锚点而失败

**根因**：Edit 依赖 Read 返回的 Anchor 校验文件未变。第一个 Edit 成功后文件变了，后续 Edit 的 old_string 要找的内容已经被第一个编辑覆盖。

**教训**：
- 同一文件的多个 Edit 串行发，每改一处后 Read 确认新锚点再改下一处
- 或者一次 Edit 改全部（替换大块内容），减少锚点竞争
- 不要并行发同一个文件的多个 Edit——写锁虽然串行但锚点预测会失效

### 踩坑 #8：数据库备份找错了系统（2026-06-28）

**症状**：用户要求备份"记忆数据库"，用 `find` 找到 `HermesData/memory_store.db` 就备份了，被用户骂"瞎备份什么"。

**根因**：直觉上认为 `memory_store.db` 名字像"记忆数据库"就直接用了，没溯源代码确认真正的数据库路径。ScreamCode 的记忆数据库在 `~/.scream-code/memory/memos.sqlite`（由 `projectDir/memory/memos.sqlite` 解析而来，`projectDir` 默认是 `screamHomeDir`）。

**教训**：
1. 数据库/数据文件路径必须从源码追踪出来，不要靠文件名猜测
2. `find -name "*memory*"` 找到的多个结果需要确认哪个是目标系统的
3. 写 MemoryWrite 之前先查代码确认路径，再用 Read 确认文件存在

### 踩坑 #9：MemoryWrite 的 processTags 过滤掉了 baohu 标签（2026-06-28）

**症状**：用 MemoryWrite 写记忆数据库路径，明确传了 `tags: ["baohu", "ding"]`，但写入后看 tags 没有 baohu 和 ding。

**根因**：`MemoryWrite` 落地时走 `processTags()`，其中有黑名单过滤：`baohu/ding/chundu/yongjiu` 被列为保留标签（仅供内部自动标注之用），从用户写入的 tag 中移除。换句话说，用户不能直接通过 MemoryWrite 给自己打"免死金牌"。

**修复方式**：先用 MemoryWrite 写本体（不含保留标签），再用 MemoryEdit 补上 baohu/ding。MemoryEdit 不走 processTags 过滤，能补上。

**教训**：
1. MemoryWrite 不是所有标签都能写——保留标签会被 processTags 过滤
2. 补标签要走 MemoryEdit（绕过后处理）
3. MemoryEdit 的 id 参数必须带 `memo-` 前缀（如 `memo-abc123`）

### 踩坑 #10：search() scope:'all' 不是真新功能（2026-06-28）

**症状**：在解释 12 痛点修复时，把 P3-6（`search() scope:'all'`）说成"新增跨项目搜索功能"。用户查 git diff 后发现原始代码在 `projectDir` 未传时已经能跨项目查了。

**根因**：`search()` 的 SQL 条件 `projectDir IS ?` 在 `projectDir` 传 `undefined` 时匹配所有行（SQLite 的 `IS` 比较）。所以不传 projectDir 已隐式支持跨项目搜索。P3-6 的改动只是加了一个显式参数覆盖（`scope:'all'` 传 `undefined`），不是真正的功能新增。

**教训**：
1. 在解释代码改动之前，先查 git diff 确认新旧对比，不要凭记忆吹
2. "从隐式到显式"不等于"功能新增"——说清楚是参数化重构而非新功能
3. 用户 git diff 能看到的比"感觉"准确得多

### 踩坑 #11：promote() 双计数 Bug 的根因（2026-06-28）

**问题**：`promote()` 调用 `calculateRecallCount()` 后再调 `recordRecall()`，但 `recordRecall()` 内部也会调 `calculateRecallCount()`，导致 `recallCount` 被双倍计数。

**根本原因**：`recordRecall()` 的职责边界模糊——它既记录访问日志，又重算计数。而 `promote()` 调用它之前自己已经算了一次，没预料到 `recordRecall()` 还会再算一次。

**修复**：`promote()` 的 `upsert` 调用传 `recallCount: 0`，不走 `recordRecall()` 的内部计算，只靠 `calculateRecallCount()` 从日志重算。

**教训**：
1. 函数副作用的边界必须清晰：`recordRecall()` 不应该既记录又重算（违反单一职责）
2. 调用链的同一功能在不同层级重复调用时容易双倍计数
3. 修 Bug 前先画调用链：`promote() → calculateRecallCount() → recordRecall() → calculateRecallCount()` 才能发现冗余

### 踩坑 #12：claimsOverlap 大小写不敏感故障（2026-06-28）

**问题**：`consolidator.ts:327` 的 claims 重叠检测比较 token 时没转小写，`"Learn"` vs `"learn"` 误判为不重叠。

**根因**：`if (aWords[i] === bWords[j])`——严格比较，不统一大小写。

**教训**：
1. 文本比较（尤其是用户输入的比较）默认必须 `.toLowerCase()`
2. 测试用例应包含大小写混合的 case（`"Learn TypeScript" === "learn typescript"`）

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

### "Observation Masking 需要 polling 保护缓存"（KV-cache 深研纠错）

**问题**：旧 `三合一融合` 方案认为遮蔽旧工具输出会破坏 KV-cache，设计了 polling=15 每 15 步才刷新一次遮蔽范围的保护机制。

**事实**：KV-cache 深研（`分析-KV-cache深研-官方证据与方案修正.md`，基于 Anthropic/OpenAI 官方文档验证）发现：
- **缓存前缀在 `cache_control` 断点前**（system prompt + tools）
- **Observation Masking 操作在断点后的 messages 尾部**
- 两者完全不重叠 → polling 是在解决不存在的问题

学到的具体知识（`prefix-stabilizer.ts:20-24` 注释）：

```
Anthropic:  显式 cache_control 断点 → 遮蔽在尾部 → 无影响
OpenAI:     隐式前缀匹配 → 遮蔽改变消息列表字节 → 轻微影响
            但影响的是尾部，前缀稳定化才是主力
```

**TokenPilot 论文数据**：仅前缀稳定化就让缓存未命中从 5.94M 降到 1.59M（-73%）。Observation Masking 对命中率无贡献，它的价值在省 attention（每个旧工具结果省 ~3000 token）。

**教训**：对 prompt caching 的机制假设要先看官方文档，不要凭直觉设计保护机制。缓存问题分三段排查：① provider 是否有显式断点 ② 操作在断点前还是后 ③ 影响的是内容字节还是结构字节。

### 验证纯函数模块时 bundle 依赖导致 `ERR_MODULE_NOT_FOUND`

**问题**：新写的纯函数（`prefix-stabilizer.ts`、`mask-tool-observations.ts`）无法通过 `node -e "import ..."` 直接运行测试，因为 dist bundle 有外部依赖（`neverBundle: ['@scream-code/ltod']`），加载时找不到 ltod 的 src 路径。

**事实**：这些纯函数**零外部依赖**——只用了 TypeScript 基本类型和标准正则。不需要加载 bundle 来验证。

**解决方法**：用内联复制测试（`_verify.mjs`）：

```js
// 把纯函数代码直接复制到验证脚本
// 不 import 任何包，不加载 bundle
function stabilizePrefix(messages) { /* 源码逻辑 ... */ }
function maskToolObservations(messages, keepLastN = 3) { /* 源码逻辑 ... */ }

// 6 个测试场景，13 条断言
// 全部在 0 外部依赖下运行
node _verify.mjs  # → 13 passed, 0 failed
```

**适用场景**：新写的纯函数（零外部依赖）、正则替换逻辑、简单条件分支。不适用于有 import 依赖的模块。

**不适用场景**：调了 SDK 类型、用了 node built-in、有异步状态。这种情况走 vitest 测试。

**教训**：纯函数验证不需要加载 bundle。零依赖的函数直接内联复制 + 断言验证，比折腾 import 路径快 10 倍。

---

## 实施教训

### ContentArchive 加权淘汰实现 — API 变更必须同时更新所有调用方（2026-06-26）

**场景**：ContentArchive 的 `archive()` 签名从 `(key, content, source?)` 改为 `(key, content, options?)`。

**教训**：改 API 签名后不能只改定义。必须用 `Grep` 或 `LSP.references` 找出所有 `.archive(` 调用点并逐个更新。本轮涉及 2 个调用方：
- `agent/context/index.ts:276-285` — `contentArchive.archive(ctxKey, content, { priority, source })`
- `agent/compaction/micro.ts:156-171` — `contentArchive.archive(key, content, { priority })`

**额外注意**：`LSP.references` 对通过 `agentContext.contentArchive` 间接引用的类可能返回空。此时用 `Grep` 以 `contentArchive.archive` 或 `\.archive\(` 为模式搜索。

### FlushBuffer.flush() 前置重置 error 标记让退出路径可重试（2026-06-27）

**场景**：`FlushBuffer.flush()` 在 `ensureFlush()` 前调用 `throwIfError()`，如果 `ensureFlush()` 曾经失败过，`this.error` 保留着上次的异常，导致后续 `flush()` 直接抛出不重试。

**教训**：设计了熔断机制的类，其 `flush()` 公共方法应重置 `this.error = null` 在前，让调用方（尤其是退出兜底路径 `agent/index.ts:586`）有机会重试最后一次刷盘。不能因为之前失败就永远跳过。

### registry.ts 的 flag 默认值与效果（2026-06-27）

**场景**：`file-action-audit` flag 的 id 是 `'file-action-audit'`，default 是 `false`（关闭）。编译和测试中不体现默认值效果，需要运行时才可见。

**教训**：新功能在设计时就要确定 default true/false。需要 IO 或有副作用的 feature 默认 false。把 flag 的 env 变量名（`SCREAM_CODE_EXPERIMENTAL_FILE_ACTION_AUDIT`）也写进文档，方便用户排查。

### ArchiveRecover 从 MCP 改为内置工具 — MCP 不适合 Agent 内部工具（2026-06-27）

**场景**：Phase 3 原计划用 MCP `registerUserTool`（RPC 前端通道）暴露 archive_recover，但调研发现 `archive_recover` 是 Agent 内部工具（读取 ContentArchive 实例），不应走 MCP 路由。

**教训**：MCP 通道的本质是**前后端分离的 RPC**：前端注册 → 后端 via `agent.getTool()` 分发，路径长、有序列化开销。内置工具是**硬性注入**（构造函数传入 ContentArchive 实例），路径短、无序列化、代码可见性高。判断标准：工具需要读取 Agent 内部状态/实例 → 内置工具；工具是外部服务/数据库 → MCP。参考 `MemoryLookupTool` 的 constructor + `&&` 守卫模式。

### ContentArchive 加权淘汰 — NO_EVICTABLE_ENTRY 守卫防无限制膨胀（2026-06-27）

**场景**：ContentArchive 的 `evictOne()` 在所有条目 priority < 0.1 时可能无限循环，因为淘汰条件 `entry.priority < 0.1` 正好是硬约束淘汰类——如果全部条目都是 < 0.1，每次循环检查第一个条目→ condition 命中→ return，不会死循环。但为防未来评分公式变化引入的死循环风险，加了 `for (let attempt = 0; attempt < 3; attempt++)` + break 保护 + `throw ContentArchiveError('NO_EVICTABLE_ENTRY')` 兜底守卫。

**教训**：淘汰类算法一定要同时考虑：（1）找不到可淘汰项时的退化路径（throw Error 而非静默失败），（2）循环保护（for+break 而非 while(true)），（3）调用方对 NO_EVICTABLE_ENTRY 的预期处理。

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

### RESERVED_TAGS 防线：自动管道生成拼音标签（2026-06-26 修复）

**问题**：压缩（compaction）、知识提取（Exit Extraction）、Dream 整理、MemoryWrite 的 `processTags` 路径自动生成了 `baohu`/`chundu`/`ding`/`yongjiu` 等拼音标签。这 4 个是系统状态标签，必须只由人工手动写入。

**根因**：4 条自动管道全部汇入 `processTags()` 统一路由。旧代码中 `processTags()` 的 Pipeline 包括后备生成（`generateTags` 从 `fullText` 提取关键词），当 LLM 输出的 tags 包含状态关键词时的误判。

**修复**（3 处改动）：
```typescript
// ① tags.ts:186-188 — RESERVED_TAGS 常量
export const RESERVED_TAGS = new Set(['baohu', 'chundu', 'ding', 'yongjiu']);

// ② tags.ts:146-147 — processTags 末尾过滤（挡住所有自动管道）
return merged.filter((t) => !RESERVED_TAGS.has(t));

// ③ consolidator.ts:29 — unionWithPriority 末尾过滤（挡住 Dream 合并传播）
.filter((t) => !RESERVED_TAGS.has(t));
```

**排查路径**：
1. 确认 LLM 产生的原始 tags 不含拼音标签（Read 响应日志）
2. 查 `processTags()` 流程：后备生成 `generateTags()` 接受 `fullText` 从关键词提取 → 误判产生拼音标签
3. 查 `consolidator.ts` 的 `unionWithPriority()` — Dream 合并路径可传播现有拼音标签
4. 查 `PROTECTED_TAGS` 缺少 `ding`

**教训**：
1. 统一路由引入后，所有自动管道都汇入同一入口——在入口设过滤（RESERVED_TAGS）一刀切，比逐一排除管道可靠
2. 状态标签一旦被自动生成，Dream 合并路径会通过 `unionWithPriority` 传播到更多记忆
3. `PROTECTED_TAGS` 与 `RESERVED_TAGS` 功能不同：前者防 Dream 误删，后者防自动生成——两者都要维护

### smartTags 概念优先排序替代 normalizeTags 砍头法（2026-06-26）

**问题**：`normalizeTags` 是"砍头法"——按输入顺序截断前 max 个。当 LLM 输出的 tags 中短标签（如 `bug`/`fix`）排在前面、长标签（概念标签）排在后面时，概念标签被砍掉。

**解决**：`smartTags()` 按质量分层排序：
```typescript
function smartTags(tags, options):
  Phase 1: 分两层——概念标签（≥4 字符）→ concepts[]，短标签（≤3 字符）→ shorts[]
  Phase 2: 同义合并（deduplicateAgainstCorpus）— 只对概念标签做
  Phase 3: 装配——先 concepts（上限 maxConcepts=10），再 shorts（上限 maxTotal=20）
```

**教训**：标签排序的 bug 不能在"截断"阶段修，必须在"排序"阶段修。砍头法在标签数量少时不明显，一旦 LLM 批量输出就会出现概念标签被短标签挤出。

### tags 字段从 optional 改为 required（tags 必填）（2026-06-26）

**问题**：旧代码 `tags` 在 schema 中为 `z.array(z.string()).optional()`。当 LLM 不传 tags 时，`processTags(undefined, { fullText })` 触发后备生成——从 `fullText` 提取关键词作为标签，质量不可控。

**修复**：
```typescript
// memory-write.ts:33
tags: z.array(z.string()).min(1).describe('3-5 semantic tags...')
```
- Schema 改为 `.min(1)` — tags 必填
- `processTags` 调用不再传递 `undefined`，始终 `args.tags ?? []`
- processTags 内部当输入为空时不再触发后备生成，直接返回 `[]`

**测试适配**：6 个测试用例补了 tags 字段；1 个确认空 tags 返回 undefined 的测试改为 `toBeUndefined()`。

**教训**：后备生成从 `fullText` 提取关键词看似安全，实际产出的标签质量低（'问题' '修复' '解决' 等黑名单词反复出现）。让 LLM 直接写 tags 更好——LLM 知道什么是概念标签。tags 必填 = 强制 LLM 每写一条记忆就思考一次标签。
## v0.7 升级与合并

### v0.7 新功能总览（2026-06-26 合并完成）

上游 LIUTod 发布 v0.7.0，fork（Mo-chong/scream-code）于 2026-06-26 成功合并。以下为 7 大变化领域及合并后 fork 的表现。

#### 1. /loop 命令 + shell verifier gate

**变化**：新增 `/loop` 命令，配合 `--verify "command"` 在每轮后跑 shell 检查，exit 0 时自动终止循环。状态栏显示迭代进度。

**fork 适配**：纯新增，零冲突。合并即可用。

**踩坑**：无。

#### 2. npm 更新流（最高风险）

**变化**：`git pull + pnpm build` → `npm install -g scream-code@latest`。版本检测从 GitHub Releases API → `npm view scream-code version`。所有 spawn 调用加 `shell: true`。

**fork 适配**：方案 C——保留 git 更新流，合并兼容性改进（`shell: true` 等）。关键防御文件 `install-strategy.ts`（上游不存在，merge 零冲突）把 fork 所有更新逻辑集中于此。

**踩坑**：
- `installUpdate()` 签名不匹配：上游改用了 1 参，fork 的无参版本需做自解析 `resolveScreamHome()`
- `UpdateCache.source` 从 `'cdn'` 改为 `'npm'` — 测试必须同步改
- 上游 `promptForInstallConfirmation` 不再接受 `installSource` 参数 — 测试需移除相关断言
- 上游 `preflight.ts` 不再基于 `detectInstallSource` 做 manual mode 路由 — `unsupported` 测试整个失效，需删除

#### 3. WolfPack 无限并发

**变化**：WolfPack 不再限制子 Agent 并发数和 item 数，每个请求的 item 都并行 spawn。

**fork 适配**：上游放开限制，fork 无自定义并发控制。合并即可用。

**踩坑**：需注意资源耗尽风险——上游应有 AbortSignal 隐式保护。

#### 4. 文件工具强化

**变化**：
- Read：ENOENT 时通过后缀名模糊匹配恢复
- ReadGroup：容忍缺失路径，继续处理剩余文件
- Bash 拦截：失败后可恢复

**fork 适配**：纯改进，不改变接口。合并即可用。

**踩坑**：无。

#### 5. 微压缩默认开启

**变化**：micro-compaction 的 flag guard 默认打开。

**fork 适配**：fork 已有 micro-compaction 调用，合并后默认开启。检查 `MicroCompactionConfig` 默认值是否被 fork 覆盖。

**踩坑**：无。

#### 6. 记忆提取优化

**变化**：Memory idle extraction 和 footer context threshold handling 改进。

**fork 适配**：增量改进，不改变 API。合并即可用。

**踩坑**：注意 fork 在 memory 层的自定义改动（tags.ts、consolidator.ts）不会冲突。

#### 7. 稳定性修复

**变化**：
- stdin EIO dead-terminal 处理
- LSP multi-byte framing + 并发启动修复
- Convergence gate 不再在 Edit 恢复后对冗余验证循环
- fetch URL SSRF guard 增加 DNS rebinding 防护

**fork 适配**：纯 Bug 修复，优先合并。合并即可用。

**踩坑**：无。

#### v0.7 合并效果总结

| 指标 | 数值 |
|------|------|
| 上游 commit | v0.7.0 tag |
| 变更文件数 | 77 files |
| 新增代码 | +2504 lines |
| 删除代码 | -385 lines |
| 冲突文件 | 4 files（preflight.ts, preflight.test.ts, agent/index.ts, pnpm-lock.yaml）|
| install-strategy.ts | ✅ 零冲突验证成功 |
| tsc | ✅ 0 errors |
| vitest | ✅ 30/30 passed |
| 临时分支 | merge-v0.7 → 已清理 |

### 合并上游更新的标准操作流程 (SOP)

**适用场景**：上游 LIUTod 发布 v0.8 / v0.9 / ...，要把新功能合并到 fork。

**前置条件**：已经创建了 `install-strategy.ts`（策略层防御已就位）。

#### 步骤

```bash
# 1. 标记当前 fork 状态（万一翻车能回滚）
git tag fork-before-v0.8

# 2. 拉取上游最新代码
git fetch origin                  # origin 指向 LIUTod/scream-code

# 3. 开临时分支做合并测试
git checkout -b merge-v0.8 main
git merge origin/main             # 合并上游改动
```

#### 处理冲突

合并后检查冲突文件。大概率只有这些文件可能冲突：

| 文件 | 冲突概率 | 处理方式 |
|------|----------|----------|
| `install-strategy.ts` | 🔴 **永不冲突** | 上游没有这个文件，零冲突 |
| `preflight.ts` | 🟡 可能 | 保留 `install-strategy` 的 import，放弃上游的 npm 逻辑 |
| `cdn.ts` | 🟡 可能 | 上游可能改版本检测源，接受上游改动（不影响 fork） |
| `source.ts` | 🟡 可能 | 上游可能改安装源检测，接受上游改动（fork 用 install-strategy） |
| 其他文件 | 🟢 不易 | 普通功能冲突，正常解决 |

**关键原则**：
- `install-strategy.ts` **永远不动**——这是 fork 的核心策略层
- `preflight.ts` 的 import 行必须确保引用的是 `install-strategy` 不是 `source`
- 其他文件（`cdn.ts`、`source.ts`、`select.ts`、`cache.ts`、`refresh.ts`、`prompt.ts`）可以接受上游改动，因为 `install-strategy.ts` 才是实际生效的路径

#### 验证

```bash
# TypeScript 检查
./node_modules/.bin/tsc --noEmit -p apps/scream-code/tsconfig.json

# 运行更新系统测试
./node_modules/.bin/vitest run apps/scream-code/test/cli/update/preflight.test.ts

# 确认 install-strategy 没有被上游文件覆盖
grep -r "install-strategy" apps/scream-code/src/cli/update/preflight.ts
```

#### 合入主分支

```bash
git checkout main
git merge merge-v0.8
git branch -d merge-v0.8
```

#### 常见问题

**Q: 上游改了 preflight.ts 里 installUpdate 函数名怎么办？**
A: 没关系。`install-strategy.ts` 导出的 `installUpdate` 是你的版本，上游改的是上游自己的代码。你只需要确认 `preflight.ts` 的 import 来源没被冲掉。

**Q: 上游删了 cdn.ts 改用 npm view 怎么办？**
A: `install-strategy.ts` 里有自己的 `fetchLatestVersion()`，不受影响。`cdn.ts` 被删了也没关系——`preflight.ts` 用的 `refreshUpdateCache` 来自 `refresh.ts`，它调的是 npm 还是 GitHub API 不影响你的策略层。

**Q: 上游改了 detectInstallSource 的逻辑怎么办？**
A: `preflight.ts` 用的是 `install-strategy.ts` 的 `detectInstallSource`，上游的改动在 `source.ts` 里，不会影响你。你可以接受上游的 `source.ts` 改动或直接删除它。

### 合并上游 v0.7 的真实冲突复盘

**冲突文件**：
- `preflight.ts` — 5 处冲突（import 差异 + local installUpdate + renderManualUpdateMessage + installCommand）
- `preflight.test.ts` — 4 处冲突（import + mock 方式 + 断言差异 + unsupported 测试）
- `agent/index.ts` — 1 处冲突（await parseMemoryMemos 签名 + return 0 缺失）
- `pnpm-lock.yaml` — 1 处冲突（patch hash 差异）

**处理结果**：
| 文件 | 策略 | 实际做法 |
|------|------|----------|
| `install-strategy.ts` | 零冲突 | 上游没有此文件，不动 |
| `preflight.ts` | 保留 fork | 保留 install-strategy import，放弃 local installUpdate |
| `preflight.test.ts` | 保留 fork + 修断 | 保留 install-strategy mock，但需适配上游 API 变化 |
| `agent/index.ts` | 合并 | `await parseMemoryMemos(summary)` + `return 0` |
| `pnpm-lock.yaml` | 取上游 | `git checkout --theirs` |

**踩坑点总结**：
1. `installUpdate()` 的签名 — 合并后 tsconfig 会报 Expected 1 arguments but got 0。解决方案：函数内部 `resolveScreamHome()` 自解析，调用方无参
2. `UpdateCache.source` 从 `'cdn'` 改为 `'npm'` — 测试里 `source: 'cdn'` 报 TS2322。测试必须同步改
3. 上游 `promptForInstallConfirmation` 不再接受 `installSource` 参数 — 测试里 `expect.objectContaining({installSource: ...})` 需要移除
4. 上游 `preflight.ts` 不再基于 `detectInstallSource` 做 manual mode 路由 — `unsupported` 测试整个失效，需删除
5. `agent/index.ts` 的冲突：上游把 `parseMemoryMemos` 签名从 `await` 改成非 `await`，但此函数实际是 `async`，所以 fork 的 `await` 才是对的

### 「策略层」防御模式（install-strategy.ts）

**问题**：上游 LIUTod v0.7 把更新系统从 `git pull + pnpm build` 改成 `npm install -g scream-code@latest`。fork 不能直接合并——npm 装的是官方版，会覆盖 fork 的所有改动。每次 merge 时 preflight.ts/cdn.ts/source.ts 都会冲突。

**根因**：fork 的核心差异（git remote、构建方式、版本检测源）直接写在上游也在改的文件里，merge 必然冲突。

**解决**：创建 `install-strategy.ts`（上游不存在的文件），把 fork 所有更新逻辑集中到该文件。`preflight.ts` 只做 import 不写逻辑。

**关键文件**：`apps/scream-code/src/cli/update/install-strategy.ts`

```
export const INSTALL_GIT_REMOTE = 'mochong';  // fork 的远程仓库名
export const INSTALL_GIT_BRANCH = 'main';     // fork 的默认分支
export const INSTALL_COMMAND_STRING = 'cd ~/.scream-code && git pull mochong main && pnpm install && pnpm -r build';
export const MANUAL_UPDATE_MESSAGE = 'Scream Code 有新版本可用...';

export function detectInstallSource(): 'source' | 'unsupported';  // 检测是否源码安装
export async function fetchLatestVersion(fetchImpl?): Promise<string>;  // 从 GitHub Releases API 获取版本
export async function installUpdate(): Promise<void>;  // 无参，自解析 resolveScreamHome()
```

**教训**：当上游改动 fork 核心差异点时，建一个上游不存在的文件做「策略层」，把所有 fork 特有逻辑抽进去。以后 merge 时只有 import 行可能冲突，一次解决永久解决。这个文件永远只增不改，保持零冲突。`install-strategy.ts` 是 Scream Code 的专属文件，上游永远不会有。

### FullCompaction 缺少 Observation Masking（2026-06-27）

**问题**：FullCompaction 发消息给 LLM 做压缩时，跳过 `maskToolObservations`，把全部 tool 输出原文（数千行/条）发给 API。满员 ~100 条消息时，实际 token 达到 557k，远超 262k 限制，API 返回 400。

**根因**：`c170167` 引入 `maskToolObservations` 给正常对话路径遮 tool 输出（turn-step.ts），但压缩路径（full.ts:compactionWorker）直接从 `originalHistory.slice()` 拿原始消息，经过 `project()` 后未遮蔽就发给 LLM。

**正反馈循环**：压缩失败 → 历史不缩反增 → 下次压缩更大 → 更容易超限。

**修复**：`full.ts:compactionWorker` 在 `project()` 之后、发给 LLM 之前加 `maskToolObservations(projected, 1)`，与正常路径保持一致。keepLastN=1 因为压缩的是被裁老消息，不需要完整 tool 原文。

**教训**：给正常对话加过滤/遮蔽逻辑时，必须同步检查压缩路径是否也有同样的处理。两端走不同的代码路径，很容易漏一端。

**注意**：此坑与 MicroCompact 的 BATCH_SIZE 完全无关（BATCH_SIZE 只控制每 8 步检测一次的频率，不参与压缩 worker 的数据流）。

**关键文件**：`packages/agent-core/src/agent/compaction/full.ts` line 342-343

### v0.7.2 合并复盘（2026-06-27）

**上游改动**（v0.7.0 → v0.7.2，9 个提交）：
- `feat(wolfpack)` — 暴露 subagent profiles
- `feat(cc)` — scream cc 添加 uninstall 选项
- `fix(loop,skill,update)` — 交互 UX 打磨
- `fix(update)` — 消除 Windows 上 `spawn` 的 DEP0190 弃用警告：`spawn(npm, [...], { stdio })` 替代 `spawn(cmd.join(' '), [], { shell: true })`
- `fix(stream-json)` — 接受 `--append-system-prompt-file` 和 `--plugin-dir`

**冲突分析**：
- `apps/scream-code/src/tui/commands/update.ts`（update-tui）：上游去掉 `shell: true`，我们用字符串参数 + `shell: true` → **同一行冲突**，取上游数组参数方案
- `apps/scream-code/src/cli/update/preflight.ts`：上游新增 `npmExecutable()` + `installUpdate()` → 我们的 `install-strategy.ts` 已在，上游副本删掉（保留 `npmExecutable` 优化）
- `root package.json` 和 `apps/scream-code/package.json`（版本号变更）→ 自动合并无冲突
- README 类文件 → 自动合并无冲突

**解决思路**：上游新增的 `installUpdate()` 与我们的 `install-strategy.ts` 功能重复。合并后删掉上游副本，保留 `install-strategy.ts`。上游的 `npmExecutable()` 优化（防 DEP0190）通过 `update.ts` 的 `spawn` 参数改造接入。

**验证流程**：
1. `git merge v0.7.2 --log`
2. 解决 2 个文件冲突（preflight.ts + update.ts）
3. `git add` → `git merge --continue`
4. `tsc --noEmit` 通过（0 errors）
5. LSP.diagnostics 确认所有调用方文件（dispatch.ts、from-source.ts、测试文件）均 0 错误

**关键经验**：
1. **策略层模式验证成功**：`install-strategy.ts` 在 v0.7.2 merge 中零冲突，import 行自动合并。证明"上游不存在的专有文件做策略层"策略有效
2. **先合并再删重复**：上游新增的函数与我们的策略层功能重叠时，先接受 merge 冲突，再删除上游副本。不反向修改 merge 过程
3. **DEP0190 修复单独验证**：`spawn(cmd, args)` 数组参数模式在 Windows 消除弃用警告，但新版本 Node 才支持。确认 CI Node 版本后决定是否采用
4. **build guard hook**：merge 提交被 guard hook（`npm run build`）拦截，需先 rebuild bundle 再提交。流程：merge → build → commit

---

## 上下文管理

### 踩坑 #29：readonly 字段阻止子 agent 共享 ContentArchive 实例（2026-06-29）

**现象**：尝试在 `subagent-host.ts configureChild()` 中用 `child.contentArchive = parent.contentArchive` 实现父子共享，编译报错。

**根因**：Agent 类中 `contentArchive` 声明为 `readonly`（`agent/index.ts L130`），TypeScript 不允许赋值。

**解决方案**：改为「静态共享存储」方案——`ContentArchive.sharedStore`（`static Map`），所有 agent 实例共用一个全局 Map，不需要通过属性赋值共享。

**教训**：
1. 编辑前先确认属性的修饰符（`readonly`/`private`）——LSP.definition 可以看
2. readonly 字段不能靠赋值绕过，需要设计静态存储或构造参数注入
3. 静态共享方案比实例共享更简单，且不破坏封装

### 踩坑 #30：FAA entry 字段与 turn/index 注入字段不一致（2026-06-29）

**现象**：第一次在 `turn/index.ts` 注入 FAA 记录时，引用了 `e.filePath`、`e.beforeHash`、`e.afterHash`，但这些是 `FileActionAuditEntry` 类型不存在的字段（实际是 `action/resultPreview/success/durationMs`）。

**根因**：凭记忆写了 FAA 的字段名，没有先 Read 源文件确认实际接口。

**修复**：修正为实际的字段 `e.action/e.resultPreview/e.success/e.durationMs`。

**教训**：
1. 引用一个不在当前可见范围内的类型时，必须先 Read 确认接口定义
2. FAA 的 entry 字段是审计动作的摘要/时长/成功标志，不是文件内容 hash
3. 避免根据类名猜测字段——"FileActionAudit"不意味着它有 "beforeHash/afterHash"

### 踩坑 #31：文档优先搜索代码接口再写注释（2026-06-29）

**症状**：决策文档里有 4 处功能标注为"未实现"，实际源码中已经实现（ContentArchive gate、valueTier 逃逸、ArchiveRecover 注册条件、BATCH_SIZE 主瓶颈是 minContextUsageRatio）。

**根因**：写文档时只读了设计文档没对照源码核实。

**教训**：
1. 写功能状态表之前先 Read/Grep 实际源码和调用链
2. "功能状态"比"设计意图"更重要——源码永远比设计文档新
3. BATCH_SIZE 分析时不可忽略同层的其他条件（minContextUsageRatio=0.5 才是真门槛）

### 踩坑 #32：Bash 终端输出含 ANSI 转义序列（Phase20 — 2026-06-29）

**症状**：Bash 命令输出中含 `\u001B[32m`（绿色）、`\u001B[0m`（重置）等 ANSI 颜色码，以及 `\r 50%` 等进度条帧。这些对 AI 模型没有语义价值，却占总 token 的 5-15%，还导致模型有时误解彩色输出为多条独立消息。

**根因**：`readStreamIntoBuilder` 直接复制原始 stdout 字节到 `ToolResult`，未做后处理。ANSI 序列对终端有意义，对 LLM 是噪声。

**修复**：`result-builder.ts` 新增 `sanitizeOutput()`（`stripAnsi` + `collapseCarriageReturnLines`），`ToolResultBuilderOptions` 新增 `sanitize?: boolean` 选项，`write()` 方法内自动调用。bash.ts 通过 `new ToolResultBuilder({ sanitize: true })` 激活，builder 层自动剥离 ANSI + 跳过 `\r` 空行。同步新增 `collapseDuplicateLines()` 到 `context/index.ts` 的 `truncateToolOutput`，3 行以上连续重复行去重。

**教训**：
1. 所有原始终端输出在进入 AI 上下文前必须做 ANSI 剥离
2. `collapseCarriageReturnLines` 必须在 `stripAnsi` 之后做才能正确判断可见内容
3. 连续重复行去重应在 truncate 前做，避免浪费截断额度

