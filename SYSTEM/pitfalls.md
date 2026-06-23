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
- [设计误区](#设计误区)

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

### LSP 在 root agent 不可用，在 reviewer 可用

**问题**：root agent 没有 LSP tool，偏差链要求调 LSP.references 但调不了。

**根因**：`Agent` 类的 `tools` 加载按类型筛选。LSP 服务端是独立进程，root agent 每步都要做 LLM 调用，负担重，所以 LSP 只部署在 reviewer 子 Agent 上。

**解决**：要么派 reviewer 做 LSP 验证，要么用 Grep 等效替代。

**教训**：验证调用者不一定需要 LSP。Grep 可以用作 fallback，但需要人工判断是否覆盖全量。

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
