<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
# 踩坑与经验记录 — Pitfalls & Lessons

> 每条：现象→根因→解决→教训。`###` 为独立 knowledge chunk，按域分组。**维护规范：每条四要素齐全，`###` 标题用本文现象首句浓缩；新增踩坑必须归入已有 `##` 域，不建新域；每条不超过 15 行。**

---

## 构建与部署

### agent.yaml 修改必须走完整构建链

**现象**：`agent.yaml` 加了 `- MemoryEdit`，commit 后重启，新工具不可用。

**根因**：`agent.yaml` 是编译时静态导入（`default.ts:1 import agentYaml from './default/agent.yaml'`），编译打包进 bundle。只 commit 不 build 不会触发重新编译。

**解决**：`agent.yaml` → `pnpm build`（agent-core）→ `pnpm build`（scream-code）→ 重启。

**教训**：YAML 配置改动视为代码改动，必须走完整构建链。

### 双构建链陷阱（alwaysBundle）

**现象**：只 build `agent-core` 后重启，agent.yaml 改动仍不生效。

**根因**：`scream-code/tsdown.config.ts` 中 `deps.alwaysBundle: [/^@scream-./]` 把所有 `@scream-*` 包打包进 scream-code 的 bundle。agent-core 的 dist 是中间产物，最终生效的是 scream-code 的 dist。

**解决**：两段构建：`pnpm build`（agent-core）→ `pnpm build`（scream-code）。

**教训**：monorepo 中最终 bundle 是入口，依赖包的 dist 只是中间文件。验证链路：源代码 → 每个依赖包 dist → 最终入口 bundle → 测试 → 重启。

### 构建完成后必须重启进程

**现象**：`pnpm build` 都通过了，但新功能不生效。

**根因**：scream 进程运行的是 `bin/scream.cmd` 加载的 `dist/main.mjs`。构建只写了磁盘文件，不会自动重载。

**解决**：`Ctrl+C` 停止 → 重启。

**教训**：编译型配置 + 打包型部署 = 改 → build → 重启，三步曲。

### 双构建链陷阱的验证方法

**现象**：无法确认最终 bundle 是否包含新代码。

**解决**：三步验证法：

```bash
# Step 1: 查 dist 产物
grep "yongjiu" packages/memory/dist/index.mjs
grep "yongjiu" apps/scream-code/dist/app-*.mjs

# Step 2: 查 bundle hash
ls -la apps/scream-code/dist/
cat apps/scream-code/dist/main.mjs

# Step 3: 运行测试
npx vitest run packages/memory/test/tier-yongjiu.test.ts
```

**教训**：永远不要相信"代码改了 + build 没报错 = 已生效"。必须在最终 bundle 中 grep 确认。

### 构建卡在 prepare 脚本

**现象**：`pnpm install` 时 `prepare` 脚本失败，报错找不到 node。

**根因**：Git Bash 的 `node` 命令在 `pnpm` 的 `prepare` 脚本中不生效，因为子进程环境 PATH 被裁剪。

**解决**：`bash scripts/build-dev.sh` 替代 `pnpm build`，该脚本硬编码了 node 路径。

**教训**：`scripts/build-dev.sh` 是绕过 pnpm lifecycle 路径问题的专用入口，任何构建问题优先用它。

### `.mjs` 在 Windows 上无默认关联

**现象**：`node node_modules/vitest/vitest.mjs` 弹出"打开方式"对话框卡死。

**根因**：Windows 注册表中 `.mjs` 扩展名无关联（`assoc .mjs` 返回空）。

**解决**：
```cmd.exe
cmd.exe /c "assoc .mjs=NodeJSFile"
cmd.exe /c "ftype NodeJSFile=\"C:\Program Files\nodejs\node.exe\" \"%1\" %*"
```

**教训**：Git Bash 不处理 Windows 文件关联。长期方案走 npm scripts（`pnpm test`）或 `npx` 避直接调用 `.mjs`。

---

## 记忆系统

### FTS5 不索引 tags 列

**现象**：`search("chundu")` 无结果。

**根因**：FTS5 索引只覆盖 `user_need`, `approach`, `what_failed`, `what_worked`, `source_session_title`（store.ts:344-351），tags 存 JSON 不在索引中。

**解决**：`search("关键词")` 语义初筛 → `.filter(m => m.tags?.includes('chundu'))` 精筛。

**教训**：查 `CREATE VIRTUAL TABLE` 定义确认索引覆盖字段。

### MCP 连接失败：env 过滤器删了 PATHEXT（2026-06-25）

**现象**：MCP 服务器 context7 和 codegraph 均报 "Connection closed"，终端独立启动正常。

**根因**：`client-stdio.ts:221` 的 `ALLOWED_ENV_PREFIXES` 缺 `PATHEXT` 和 `COMSPEC`。Windows 上 cross-spawn 7.0.6 在 `shell: false` 下依赖 `PATHEXT` 解析命令扩展名。env 过滤器砍了这俩环境变量，cross-spawn 找不到可执行文件。

**解决**：`ALLOWED_ENV_PREFIXES` 加入 `'PATHEXT', 'COMSPEC'`。

**教训**：Windows spawn 依赖 `PATHEXT` 解析 `.cmd` 文件。MCP 终端独立启动正常 ≠ 在 scream 进程中能正常启动（env 不同）。

### MCP 连接失败 #2：PATHEXT 被 Git Bash 注入双引号（2026-06-25）

**现象**：context7 和 codegraph MCP 持续报 "Connection closed" + "不是内部或外部命令"。桌面快捷方式正常，Git Bash 启动失败。

**根因**：Git Bash（MSYS2）在 `PATHEXT` 值周围包裹双引号，形如 `"\";.COM;.EXE;.CMD;...\"`。cross-spawn 包装 `cmd.exe /d /s /c "context7-mcp.cmd"` 后，畸形的 PATHEXT 导致 `cmd.exe` 找不到 `node.exe`。

**解决**：`mergeStdioEnv()` 中对 `PATHEXT` 执行 `value.replace(/"/g, '')` 清洗双引号。

**教训**：Git Bash 下的 `process.env` 不干净——环境变量可能含 MSYS2 转译 artifact。快捷方式启动 vs 终端启动的差异本质是 `cmd.exe` 原生环境 vs Git Bash 转译环境的差异。

### yongjiu 标签不生效：代码正确但 app 没重建（2026-06-25）

**现象**：源代码中 yongjiu 的 demote 免疫、ResNet D=1、PROTECTED_TAGS、♾️图标全部写好了，运行时不生效。

**根因**：双构建链陷阱。scream-code 的 `deps.alwaysBundle` 把所有 `@scream-*` 包打包进最终 bundle。只 build memory/agent-core 不够，必须 build scream-code 才会生成包含新代码的最终 bundle。

**验证链路**：
1. 源代码 → yongjiu 代码正确 ✅
2. memory/dist/agent-core/dist → yongjiu 存在 ✅
3. scream-code/dist → 旧 bundle 没有 yongjiu ❌
4. symlink 指向正确 ✅
5. scream --version → 0.6.10 ✅ 但运行时载入的是旧 bundle

**解决**：四包全部用 tsdown 入口逐个重建（config → memory → agent-core → scream-code）。

**教训**：验证链路必须是：源代码 → 每个依赖包 dist → 最终入口 bundle → 测试 → 重启。中间产物对 = 不用继续查源文件，直接重建最终 bundle。

### baohu 标签 → Dream 免疫导致无法编辑

**现象**：给旧版规则加了 `baohu+ding` 标签，Dream 跳过不处理。新版本写入后旧版因 `baohu` 保护始终存在。

**根因**：`consolidator.ts` 中 `PROTECTED_TAGS = ['baohu']`，带 `baohu` 的记忆不被 merge/delete/stale。

**解决**：Node.js `DatabaseSync` 直连 SQLite 手动摘掉 ding。

**教训**：保护标签是双刃剑——保护了不被 Dream 误删，也保护了不被工具编辑。需要绕过工具直接操作 SQLite。

### MemoryEdit 工具默认不在 agent.yaml 中

**现象**：MemoryEditTool 已注册在 `tool/index.ts:634`，但调用时找不到。

**根因**：工具注册两步骤：① 代码中 `new MemoryEditTool()` 注册 ② `agent.yaml` 中列出工具名，`setActiveTools()` 过滤。步骤①做了，步骤②没做。

**解决**：`agent.yaml` 加一行 `- MemoryEdit`，然后完整构建链。

**教训**：新工具 = 注册 + 配置 + 构建 + 重启，缺一不可。

### 拼音标签体系不影响 AI 搜索

**现象**：`baohu` 标签用英文还是拼音有讨论。

**结论**：拼音标签不影响搜索，因为 AI 搜索时用自然语言关键词（"保护"），FTS5 搜索的是 `user_need`/`approach` 等字段的内容，不是标签名。标签纯粹是系统侧的分类标记。

**教训**：标签语言对搜索无影响，选语义清晰、不易冲突的即可。

### 标签质量四层优化 — 坑 1：normalizeTags 硬编码 max=5

**现象**：动态预算公式算出来最高 8 个，存储时只有 5 个。

**根因**：`tags.ts` 的 `normalizeTags()` 写死 `max = 5`。调用方传 `MAX_TAGS_ABSOLUTE = 8` 也传不进去。

**解决**：`normalizeTags` 默认值改为 `TAG_CONFIG.MAX_TAGS_DEFAULT`（5），调用方 `processTags()` 传 `TAG_CONFIG.MAX_TAGS_ABSOLUTE`（8）。

**教训**：常量和参数默认值必须来自同一个配置源。藏在函数签名里的魔数是所有预算系统的头号敌人。

### 标签质量四层优化 — 坑 2：Dream 合并跳过了 processTags

**现象**：Dream 合并直接 `normalizeTags(flatTags)`，不走黑名单和同义合并。

**根因**：旧代码在 `processTags()` 统一路由实现之前写的，直接调用低阶函数 `normalizeTags()`。

**解决**：`consolidator.ts` 改为 `await processTags(group.memos.flatMap((m) => m.tags ?? []), { existingTags: allRelatedTags })`。

**教训**：统一路由引入后，必须 grep 所有直接调用低阶函数的地方逐一改为高阶调用。

### 标签质量四层优化 — 坑 3：extractor.ts 同步→async 传播链

**现象**：`generateTags()` 是同步函数，但 `processTags()` 内部的异步后备需要调用方也是 async。

**根因**：`extractMemoryMemos()` 是同步调用，无法 await。

**解决**：`extractMemoryMemos()` → async，调用方 `compact()` 也同步改为 async。

**教训**：同步→async 的传播链：`compact() → extractMemoryMemos() → processTags() → generateTags()`。改最底层的为 async 后，必须把调用栈一直改到顶层函数签名。

### 保护名单漏了 ding 标签（2026-06-27）

**现象**：带 `ding` 标签的记忆在热层容量裁剪时可能被降级。

**根因**：`enforceHotTierCap()` / `demote()` / `autoDemoteIfNeeded()` 的保护名单只列了 `baohu/chundu/yongjiu`，漏了 `ding`。

**解决**：补全 6 处 `.includes('ding')`：`demote()` L1162 / `autoDemoteIfNeeded()` L1198/L1218 / `enforceHotTierCap()` L1243/L1264 / `listAll()` PROTECTED_TAGS L1630。

**教训**：保护标签列表定义在一处（tags.ts 常量数组），不要散落在各处手写条件。

### promote() 双计数 Bug（2026-06-28）

**现象**：`promote()` 调用 `calculateRecallCount()` 后再调 `recordRecall()`，`recordRecall()` 内部也会调 `calculateRecallCount()`，导致 `recallCount` 被双倍计数。

**根因**：`recordRecall()` 既记录访问日志，又重算计数，违反单一职责。

**解决**：`promote()` 的 `upsert` 调用传 `recallCount: 0`，不走 `recordRecall()` 的内部计算。

**教训**：修 Bug 前先画调用链：`promote() → calculateRecallCount() → recordRecall() → calculateRecallCount()` 才能发现冗余。

### claimsOverlap 大小写不敏感（2026-06-28）

**现象**：`consolidator.ts:327` 的 claims 重叠检测 `"Learn"` vs `"learn"` 误判为不重叠。

**根因**：`if (aWords[i] === bWords[j])` 严格比较，不统一大小写。

**教训**：文本比较默认必须 `.toLowerCase()`。测试用例应包含大小写混合 case。

### search() scope:'all' 不是真新功能（2026-06-28）

**现象**：P3-6（`search() scope:'all'`）被说成"新增跨项目搜索功能"，git diff 显示原始代码在 `projectDir` 未传时已能跨项目查。

**根因**：`search()` 的 SQL 条件 `projectDir IS ?` 在 `projectDir` 传 `undefined` 时匹配所有行（SQLite `IS` 比较）。P3-6 只是加了一个显式参数覆盖，不是功能新增。

**教训**：解释代码改动前先查 git diff 确认新旧对比，不要凭记忆吹。"从隐式到显式"不等于"功能新增"。

### 数据库备份找错了系统（2026-06-28）

**现象**：用 `find` 找到 `HermesData/memory_store.db` 就备份了，实际 ScreamCode 记忆数据库在 `~/.scream-code/memory/memos.sqlite`。

**根因**：直觉上认为 `memory_store.db` 名字像"记忆数据库"就直接用了，没溯源代码确认。

**教训**：数据库路径必须从源码追踪出来，不要靠文件名猜测。`find -name "*memory*"` 找到多个结果需要确认哪个是目标系统。

### MemoryWrite 的 processTags 过滤掉了 baohu 标签（2026-06-28）

**现象**：`MemoryWrite` 传 `tags: ["baohu", "ding"]`，写入后 tags 没有它们。

**根因**：`processTags()` 黑名单过滤：`baohu/ding/chundu/yongjiu` 列为保留标签，从用户写入的 tag 中移除。

**解决**：先用 MemoryWrite 写本体（不含保留标签），再用 MemoryEdit 补上 baohu/ding。MemoryEdit 不走 processTags 过滤。

**教训**：MemoryWrite 不是所有标签都能写。补标签走 MemoryEdit（绕过后处理）。MemoryEdit 的 id 参数必须带 `memo-` 前缀。

### 记忆系统 12 痛点修复集（2026-06-28），已修

以下为旧 memory-store.md §十五 记录的一次性代码修复，症状轻微，未单独成条：

| 痛点 | 根因 | 修复 |
|------|------|------|
| CJK Bigram 中文召回 | FTS5 unicode61 不切分 CJK 双字词 | `tokenize='unicode61 remove_diacritics 2 tokenchars'` + 自定义 Bigram tokenizer |
| usageBoost NaN 防御 | search() 中 usageBoost 未检查分母是否为 0 | 加 `isNaN` guard |
| TIER_RANK 模块常量 | 排序条件散落在 3 处 | 抽取为 `TIER_RANK: Record<string, number>` 模块常量 |
| splitClaims 12 分割符 | 中文逗号/顿号/空格/换行等未切分 | 统一正则 `split(/[,，、\s\n]+/)` |
| critical 豁免淘汰 | critical 标签的记忆在热层满时仍被裁剪 | `enforceHotTierCap()` 加 critical 跳过 |
| 向量漂移告警 | vec0 embedding 模型更新后旧向量语义偏差 | 每次 search() 比较新旧 embedding 余弦距离，超阈值告警 |
| TAG_CONFIG 扩容 | 黑名单/同义词 Map 固定容量 | 改为 `new Map()` 无上限 |
| toLowerCase 大小写不敏感 | claims 比较 `"Learn"` vs `"learn"` 判为不重叠 | 比较前统一 `.toLowerCase()` |
| tier+recalledAt 排序防御 | 同 score 的记录返回顺序不稳定 | `ORDER BY tier DESC, recalledAt DESC` 二级排序 |

### 向量模型下载反复失败 — 超时+清错目录+sidecar 缺 onnx（2026-07-06）

**现象**：新对话触发向量模型下载，300s 超时→zlib 损坏文件→清缓存→tokenizer 找不到→sidecar 补 4 文本→init 仍缺 onnx→下轮对话再下载循环。

**根因**：`cleanFastembedCache()` 只清理 `local_cache/` 不清理 `SCREAM_HOME/cache/fastembed/`（实际 cacheDir），导致脏文件残留；`EMBED_INIT_TIMEOUT_MS=300_000` 不够（33% 已花 602s）；`ensureFastembedModelSidecars()` 只补 4 文本配置不补 `model.onnx`（30MB），清缓存重试后 onnx 仍缺席。

**解决**：`cleanFastembedCache(specificDir?)` 参数化，优先清理实际 `effectiveCacheDir` + `SCREAM_HOME/cache/fastembed/` + HF Hub + `~/.cache/fastembed/`；超时增至 `600_000`（10min）。

**教训**：多目录缓存清理类函数必须参数化传入当前在用目录，不能硬编码假设。网络波动下模型下载超时阈值取日志峰值 ×1.5。

---

## 回合控制

### LSP 在 root agent 连续超时 120s — 3 个独立 bug 的链式故障（2026-06-23）

**现象**：`LSP.references` 和 `LSP.definition` 始终 120s 超时，`LSP.diagnostics` 能立刻返回。子 agent reviewer 的 LSP 可用。

**迷惑性**：diagnostics 能通让人误以为 LSP 服务器正常，实际上 diagnostics 是 server-push notification（无需 request-response），而 references/definition 需要完整的 request-response 通路。

**Bug 1 — 僵尸 client 缓存**
- 根因：`LspClient.start()` 在进程创建前就设了 `this.started = true`，`LspRegistry.getClient()` 在 `client.start()` 完成前就 `set()` 缓存。失败后死进程被永久缓存，后续请求静默丢弃，Promise 永不 resolve。
- 解决：`this.started = true` 放在进程创建成功 + stdout/stderr 绑定之后；`await client.start()` 通过后才 `set()` 缓存。

**Bug 2 — workspace root 无 tsconfig.json**
- 根因：`workspaceRoot = D:/AI/allgzmulu` 没有 `tsconfig.json`，TS server 一直扫到超时。
- 解决：`getClient()` 从文件路径往上找最近有 `tsconfig.json`/`jsconfig.json` 的祖先目录做 project root。

**Bug 3 — Windows spawn 不能跑 `.cmd` 文件**
- 根因：全局安装的 `typescript-language-server` 入口是 `.cmd` 文件。`child_process.spawn` 不能直接执行 `.cmd`，抛出 `spawn EINVAL`。
- 解决：`_resolveCmd()` 用 `npm root -g` 找到全局 node_modules，解析到 `lib/cli.mjs` 真实入口，用 `node <entry> --stdio` 启动。

**链式故障**：
```
spawn → ENOENT（PATH 无 cmd，Bug 1 僵尸）
→ 下次请求 → 僵尸静默丢包 → 120s 超时（Bug 1 症状）
→ 全局安装后 → spawn 不跑 .cmd → EINVAL（Bug 3）
→ 绕路 npx → 捆绑环境 PATH 无 npx.cmd → 依然 EINVAL
→ resolveProjectRoot 无 tsconfig → scan 2min → 超时（Bug 2 叠加）
```

**教训**：
- symptoms can be the same for different root causes
- Windows spawn 不能跑 `.cmd` 文件，必须用 `node <entry>` 或 `cmd /c`
- LSP diagnostics 通 ≠ LSP 完全可用，references/definition 是独立的 request-response 通路
- bundle 环境 PATH 与开发环境不同，所有外部命令依赖必须显式处理

### shouldContinueAfterStop 收敛门有注入次数上限

**现象**：收敛门最多注入 3 次，之后 AI 可以继续但收敛门不再介入。

**根因**：`turn/index.ts` 的 `convergenceGate` 计数器 `injectionCount` 上限为 3。超过后跳过注入。

**教训**：收敛门不是无限纠正的，AI 需要在前 3 次内修正行为，否则收敛门放弃。

### 连续 Edit 未查 LSP References 触发偏差链（2026-06-27）

**现象**：连续 6 次 Edit 修改 `.includes()` 条件，被 Guard Rule 6 拦住。

**根因**：批量 Edit 触发了"连续编辑未查 references"的偏差检测。

**教训**：小改动（只改方法体内部字符串）改完后用一次 LSP.references 确认调用方不受影响。批量 Edit 后必须加验证步骤：Read 确认 + LSP.diagnostics + LSP.references。

### 多个 Edit 到同一文件时锚点过期（2026-06-27）

**现象**：第 2 个及后续 Edit 因第一个 Edit 改了锚点而失败。

**根因**：Edit 依赖 Read 返回的 Anchor 校验文件未变。第一个 Edit 成功后文件变了，后续 Edit 的 old_string 已被覆盖。

**教训**：同一文件的多个 Edit 串行发，每改一处后 Read 确认新锚点再改下一处。不要并行发同一个文件的多个 Edit。

---

## 注入系统

### 上游 ROLE_ADDITIONAL 功能重复

**现象**：上游 v0.8.0 实现了 `loadRoleAdditional()` + `mergeRoleAdditional()`，和本地 fork 的注入实现完全重复。

**教训**：合并前逐个文件检查上游是否已做了 fork 里改动的事。context.ts/resolve.ts 取 --theirs 即可。

### system_trigger 穿透预算

**现象**：`system_trigger` 注入不受 budget 限制。

**根因**：`turn/index.ts:1356-1359` 的收敛门注入不经过 `InjectionManager` 的预算检查。

**教训**：system_trigger 优先级最高，可用于必须注入的场景，但不可滥用。

### sendNormalUserInput ≠ inject

**现象**：`sendNormalUserInput` 和 `inject` 行为不一致。

**根因**：`context/index.ts:75-80` 的 `sendNormalUserInput` 是普通用户消息，`inject`（83-91）是 `<system-reminder>`。

**教训**：前者是用户消息无特殊权限，后者是系统指令受权重体系控制。

### inject('injection') 受 5 重限制

**现象**：注入最终被限制。

**根因**：`turn/index.ts:1368-1419` 的注入链路：重复衰减 → 残差 → 去重 → 预算 → 注册，5 重门控。

**教训**：修改注入行为需要确认在哪一层被拦，不是均匀"注入不生效"。

### system-ref 废弃 → stuck 注入器（Phase21）

**现象**：旧 `system-ref.ts` DynamicInjector 绕过所有 guard 被删除。

**替代**：`stuck` 注入器走残差系统。检测 3 种 stuck 模式（同文件连续编辑≥3步/同工具连续报错≥2步），受 budget/dedup/残差三重门控。

### 两套 ResNet 关系

**记忆 ResNet**：天级幂衰减（store.ts:1281-1287 + scoring.ts:162-163）
**注入调度 ResNet**：步级幂衰减（variant-registry.ts L319-345）
公式均为 `R = W×D^Δs`，但衰减维度和时间尺度不同。

---

## Git 与上游合并

> **📖 完整流程 SOP 见 [`合并上游仓库SOP.md`](./合并上游仓库SOP.md)** — 含双 remote 初始化、前置检查列表、冲突策略、guard 验证、force-push 恢复。
> **本页只记录零散踩坑，不替代 SOP。**

### 版本标签不一致

**现象**：本地 tag v0.7.2 是上次 merge 点，但 package.json 版本为 0.7.8（本地推进了 100+ commit）。

**教训**：合并前 `git log --oneline v0.7.2..HEAD | wc -l` 确认本地 commit 数。

### 互补冲突的合并策略

**现象**：`agent/index.ts` 和 `agent/tool/index.ts` 双方都改了相同区域但功能不同（上游加 KnowledgeStore，本地加 searchPendingDoc/ArchiveRecoverTool）。

**解决**：互补冲突不取舍，双方保留。手动去掉冲突标记，保留双方代码行。不是 --ours 或 --theirs。

### Merge commit 被 guard hook 拦截

**现象**：`git commit` 时 guard-bundle-stale.sh 检查源码 vs 产物时间戳，源码更新则阻止 commit。

**解决**：merge 后先 `bash scripts/build-dev.sh` 全量构建，再 `git add -A && git commit`。

### 上游新增 @scream-code/knowledge 子包

**现象**：上游新增 `packages/knowledge/`，pnpm install 多下依赖。但 alwaysBundle 的 `/^@scream-./` 正则自动 cover 了新子包，无需额外配置。

**教训**：alwaysBundle 正则匹配所有新子包名，新增子包无需修改 tsdown.config.ts。

### 作者 force-push 后合并

**现象**：作者 force-push 覆盖了历史，cherry-pick 后文件缺失。

**教训**：被抹掉的文件要主动从旧历史恢复。合并前先 `git fetch` 看看上游是否 rebase 了。

### 包名变更导致 import 找不到

**现象**：cherry-pick 后 `import` 语句指向旧包名，编译失败。

**教训**：pnpm install 是 cherry-pick 后的必修课。import 路径变化需要全局 grep 替换。

### 合并上游的标准 SOP

**现象**：合并上游 v0.8/v0.9 的标准流程不清晰。

**SOP**：
1. `git fetch origin` 拉上游最新
2. `git log --oneline current-tag..origin/main` 分析变更范围
3. `git merge origin/main` 合并
4. 解决冲突（互补冲突双方保留）
5. `bash scripts/build-dev.sh` 全量构建
6. `git add -A && git commit`（绕 guard hook 拦截）
7. 运行测试验证

### 策略层防御模式

**现象**：`install-strategy.ts` 中有策略层防御模式，用于阻止不安全的上游变更。

**教训**：合并前检查 `install-strategy.ts` 是否有新规则增加了。

---

## 设计误区

### 业务验收报告误把缺项名写错（2026-06-27）

**现象**：验收报告说 `hermit` 标签漏了，实际漏的是 `ding`。

**根因**：写报告时没读实际代码，凭记忆写了 `hermit`。

**教训**：验收报告每条结论必须来自 Read/Grep/LSP 的事实，不能从"我感觉"出发。

### 上游功能重复未提前发现

**现象**：合并 v0.8.0 时才发现上游也实现了 ROLE_ADDITIONAL 注入。

**教训**：合并前逐个文件 diff 检查是否有功能重叠。

### 代码写在类上≠代码在运行—recordRound 集成缺口（2026-07-04）

**现象**：Phase26 `strategy.ts:58-60` 定义了 `recordRound()` 委托给 predictor，全项目搜索 `.recordRound(` 仅 1 个匹配（定义本身）。turn/index.ts handleAfterStep 没调用它。GrowthPredictor 永远收不到 token 数据，等效于没写。

**根因**：验收时只做了代码审查（定义对不对、构建通不通、接口签不对），没做**行为级验证**（"谁调了这个方法"）。Build 通过只证明定义合法，不证明调用链完整。

**解决**：`handleAfterStep` 审计日志块后加 `this.agent.fullCompaction.strategy.recordRound(totalInput)`。

**教训**：接口方法新加后，必须 grep 全项目 `.方法名(` 确认调用链通不通。仅 Read 定义 + Build 通过 = 不够。新数据管道必须追踪到消费端。

### CompactionStrategy 接口少 recordRound 方法签名（2026-07-04）

**现象**：`recordRound()` 只写在 `DefaultCompactionStrategy` 类上，没加入 `CompactionStrategy` 接口。turn/index.ts 通过 `this.agent.fullCompaction.strategy.recordRound()` 调用时报 TypeScript 编译错误。

**根因**：`full.ts:77` 存的是 `strategy: CompactionStrategy` 接口类型。类方法不在接口上 → TypeError。

**解决**：`CompactionStrategy` 接口加 `recordRound(tokensUsed: number): void` 方法签名。

**教训**：新方法如果背后是接口引用，必须先加接口签名再加类实现，顺序反过来编译过不去。

### handleAfterStep 的模型条件判断陷阱（2026-07-04）

**现象**：Phase26 审计日志写在 `if (cacheHitTokens !== undefined)` 条件内（仅 DeepSeek），最初把 `strategy.recordRound()` 也放在这个 if 内，导致非 DeepSeek 模型永远不喂数据给预测器。

**根因**：贪方便把两行代码放同一个 if 块里。审计日志是 DeepSeek 独有，token 投喂是全模型通用，两个语义不同不该共用一个条件。

**解决**：`recordRound` 移到 `if (cacheHitTokens)` 块外面，只依赖 `if (this._lastUsage)`，不限模型。

**教训**：两个功能共用一个 if 条件，除非两者语义完全等价，否则必须分开。审计日志（仅 DeepSeek）≠ 预测器投喂（全模型）。

---

## 调试教训

### bundle 环境 PATH 极简，外部命令找不到

**现象**：bundle 中调用 `npx`、`node` 等外部命令失败。

**根因**：bundle 环境（`tsdown` 打包后）的 PATH 被裁剪，只包含 bundle 自带的路径。

**教训**：所有外部命令依赖必须显式处理，不能假设开发环境的 PATH 在 bundle 中可用。

### 全量验证结果的最佳调试路径

**现象**：测试失败或功能异常，不知从何查起。

**调试路径**：源代码 → 修改文件 → 构建 dist → 最终 bundle → 运行测试 → 反复。

**教训**：永远从最终 bundle 开始查，不要从源代码开始查。bundle 没有的，源代码再对也没用。

### fastembed embedding 引擎初始化失败 — tokenizer.json not found

**现象**：`[loadEmbedder] attempt 1/2 failed: Tokenizer file not found at local_cache\fast-bge-small-zh-v1.5\tokenizer.json`。文件在本地实际存在，仍报 not found。

**根因（4 层嵌套错误）**：

1. **没传 `cacheDir` 参数**: `FlagEmbedding.init({ model })` 不传 `cacheDir` → fastembed v1.x 用默认相对路径 `"local_cache"`，基于 `process.cwd()` 解析 → CWD 不符时路径错位。这是根本原因。
2. **环境变量无人读**: 设 `FASTEMBED_CACHE` 尝试修复 → fastembed v1.x **不读这变量**，死代码。
3. **清错缓存目录**: `cleanFastembedCache()` 只删 `~/.cache/huggingface/hub/` 和 `~/.cache/fastembed/` → 模型实际在 `local_cache/fast-bge-small-zh-v1.5/` → retry 永远清不掉真正的问题。
4. **验证错位**: 全程验证 `packages/memory/dist/` 而非实际运行的 app bundle → tsdown config 把 `@scream-code/memory` alias 到源码 → app 跑的是 `apps/scream-code/dist/app-*.mjs` 内联版，不重建 bundle 就没用。

**修复（5 处改动）**：

| 改动 | 文件 |
|------|------|
| `FlagEmbedding.init({ model, cacheDir: absolutePath })` | `embeddings.ts` |
| `fileURLToPath(import.meta.url)` 替代 `.pathname` 修 Windows 双盘符 | `embeddings.ts` |
| `cleanFastembedCache()` 加清 `local_cache/fast-bge-small-zh-v1.5/` | `embeddings.ts` |
| 删除死代码 `ensureAbsoluteCachePath()` + `FASTEMBED_CACHE` | `embeddings.ts` |
| 重建 `apps/scream-code` 的 app bundle | `tsdown` |

**预防**：
- 调第三方库 API 时，**必须追库源码确认参数和环境变量是否真有效**，不假设名字对的就有效。
- monorepo 打包场景下，**验证必须跑最终 bundle**（`apps/*/dist/`），不走中间包（`packages/*/dist/`）。
- Bundle alias 配置（`tsdown.config.ts` 的 `resolve` 别名）决定实际运行代码源 — 改代码后要先追 alias 链。
- 错误信息提示的路径如果是相对路径（无盘符），说明调用方没传绝对路径参数。
- 嵌套错误的特征：每次修复后出现**不同表现的新错误**，说明根因没动，只是暴露了下一层。