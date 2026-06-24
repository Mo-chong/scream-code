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

**问题**：想搜索 `behavior-rule` 标签的记忆，直接 `search("behavior-rule")` 没结果。

**根因**：FTS5 索引只覆盖了 `user_need`, `approach`, `what_failed`, `what_worked`, `source_session_title` 五列（store.ts:344-351），tags 存为 JSON 字符串不在索引中。

**解决**：先 `search("关键词")` 语义初筛，再 `.filter(m => m.tags?.includes('behavior-rule'))` tag 精筛。

**教训**：不能假设 FTS5 能搜一切。看 `CREATE VIRTUAL TABLE` 定义确认索引覆盖的字段。

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

### 偏差链连续 Edit 拦截（已知行为）

**问题/发现**：连续 3 次 Edit 没有 LSP.references → 偏差链触发 → 收敛门拦住。

**机制**：`turn/index.ts` 的 `afterStep` 中 `editWithoutLookupCount++`，每步结束时检查。>= 3 → `deviationChainActive = true`。

**取消**：必须调一次 LSP.references（或 reviewer）才会释放。

**教训**：偏差链不是 bug，是设计——强制在批量编辑之间插入验证步骤。

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

### 症状相同 ≠ 根因相同 — LSP 超时调试的链式故障反思（2026-06-23）

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
