# 上下文管理（Context Management）

> 演化图：`ZHU/DECISIONS/INDEX.md` → **上下文管理子演化线①+②**（06-27~06-28 合并）
> 最后更新：2026-06-29

---

## 功能实现状态总览

| # | 功能 | 模块 | 状态 |
|---|------|------|------|
| 1 | **ContentArchive** 纯内存 LRU 保留缓冲区 | `context/content-archive.ts` | ✅ **已实现** |
| 2 | **MicroCompaction** 自动轻量压缩 | `compaction/micro.ts` | ✅ **已实现** |
| 3 | **FullCompaction** LLM 全局总结压缩 | `compaction/full.ts` + `strategy.ts` | ✅ **已实现** |
| 4 | **PrefixStabilizer** 系统提示前缀稳定化 | `context/prefix-stabilizer.ts` | ✅ **已实现** |
| 5 | **ArchiveRecover** MCP 恢复工具 | `tools/builtin/context/archive-recover.ts` | ✅ **已实现** |
| 6 | **FileActionAudit** 文件操作审计日志（独立模块，不融合） | `audit/file-action-audit.ts` | ✅ **已实现，独立运行** |
| 7 | **FlushBuffer** 事件缓冲抽象基类 | `audit/file-action-audit.ts` | ✅ **已实现（FAA 基类）** |
| 8 | **ObservationMasking** tool result 遮蔽（每轮/FullCompaction前） | `utils/mask-tool-observations.ts` | ✅ **已实现** |
| 9 | **Headroom-lite** 保留 40% 上下文窗口 | — | ⏸️ **搁置**（非必要） |
| 10 | **CacheStats** 管线计数器 | — | ⏸️ **搁置** |
| 11 | **FileActionAudit↔ContentArchive 融合** | — | 🗑️ **已废弃**（TURN buffering 替代） |

---

## 一、架构总览

上下文管理分三层，从轻到重：

```
运行阶段                         压缩触发                  日志事件
─────────────────────────────────────────────────────────────────
ContentArchive (纯内存 LRU) ──→ key 前缀 + toolCallId     无日志
     │                          容量门卫 → 加权淘汰
     │                          TTL 过期 → prune()
     │
     ▼
maskToolObservations (每轮)  ──→ 每轮对话前自动执行        无日志
     │                          保留最近 keepLastN(3) 条
     │                          旧 tool result → 占位符
     │
     ▼
MicroCompaction (自动/无感)  ──→ 3 道关卡触发               micro_compaction.apply
     │                          (1) BATCH_SIZE(8) 检查频率
     │                          (2) minContextUsageRatio(0.5) 容量门槛
     │                          (3) keepRecentMessages(20) 保护圈
     │                          截断 cutoff 前 tool.result
     │                          Supersede 旧 Read
     │                          Point B → ContentArchive 存档
     │
     ▼
FullCompaction (自动检测)   ──→ triggerRatio(0.75)         full_compaction.begin/complete/cancel
                                project() 选代表消息
                                maskToolObservations(projected, 1)
                                LLM 总结
                                extractAndStoreMemos → 记忆库
                                applyCompaction → 清上下文
                                micro.reset()
```

---

## 二、ContentArchive（纯内存保留缓冲区）

**文件**：`packages/agent-core/src/agent/context/content-archive.ts`

### 2.1 配置常量

| 常量 | 值 | 含义 |
|------|----|------|
| `DEFAULT_TTL_MS` (L50) | `1_800_000` | 30 分钟 TTL，protected 条目同样过期即删 |
| `DEFAULT_MAX_ENTRIES` (L51) | `2000` | 全局条目上限 |
| `PRIORITY_BOOST` (L54) | `0.1` | `recover()` 每次升权步长 |
| `PRIORITY_MAX` (L55) | `1.0` | 权重上限 |
| `PRIORITY_NEW` (L56) | `1.0` | 新条目初始权重 |
| `FORCED_THRESHOLD` (L57) | `0.1` | priority < 0.1 强制优先淘汰 |
| `ACCESS_BOOST_FACTOR` (L58) | `0.5` | 访问新鲜度因子 |

### 2.2 核心方法

**`archive(key, content, options?)`** (L94-128) — 写入
- key 建议格式：`"{source}:{toolCallId}"`
- 容量门卫：条目数 ≥ maxEntries → `pruneInternal()` 清过期 → `evictOne()` 加权淘汰直到有空间
- 全部不可淘汰时返回 `error: 'NO_EVICTABLE_ENTRY'`
- `options.source` 来源标识
- `options.priority` 初始权重（默认 1.0）
- `options.protected` 禁止加权淘汰（真保护靠它，但不防 TTL）

**`recover(key)`** (L135-152) — 读取
- 先查本地 `this.store` → 未过期直接返回（升权 + 刷新时间）
- 本地未命中 → 回退到 `ContentArchive.sharedStore`（全局静态 Map，跨 agent 实例共享）
- sharedStore 命中 → copy-on-access 写回本地 store
- 两处都过期或不存在 → `undefined`
- 上限 `PRIORITY_MAX (1.0)`

**`getRecentEntries(n)`** (file-action-audit.ts L88-97) — FAA 最近 N 条审计记录
- 环状缓冲区，保留最近 50 条
- 用于 tool 错误时自动注入（详见 §十一）

**`list()`** (L157-159) — 列出所有存活 key
**`prune()`** (L172-175) — 清理所有 TTL 过期条目
**`clear()`** (L179-182) — 清空

### 2.3 加权淘汰策略

`evictOne()` (L213-244) 评分公式：

```
decay = exp(-ageMs / TTL_MS)
accessBoost = 1 - ageFactor × ACCESS_BOOST_FACTOR
score = priority × decay × accessBoost
```

执行顺序：
1. `priority < 0.1` 的条目归入**强制淘汰组**，选最低分
2. 其余条目归入**正常组**，选最低分
3. `forcedTarget ?? normalTarget` 淘汰

### 2.4 Flag 控制

**文件**：`packages/agent-core/src/flags/registry.ts` L27-29：
```
{ id: 'content-archive', env: 'SCREAM_CODE_EXPERIMENTAL_CONTENT_ARCHIVE', default: true }
```

注入点 gate（`micro.ts` L158-159）：
```typescript
if (flags.enabled('content-archive')) {
```

---

## 三、PrefixStabilizer（提示前缀稳定化）

**文件**：`packages/agent-core/src/agent/context/prefix-stabilizer.ts`
**引用**：`packages/agent-core/src/agent/context/index.ts` L8

### 3.1 作用

在每轮消息追加前，将系统提示（system prompt）固化到消息数组中，确保前缀 token 对 KV-cache 友好——相同前缀连续命中缓存，减少重新计算的 token 量。

### 3.2 调用点

```
context/index.ts L241-245:
  // Compare serialized form — stabilizePrefix never changes array length
  msgs = stabilizePrefix(msgs);
```

调用发生在每轮 turn 循环的消息组装阶段，在 MicroCompaction 压缩之前。

### 3.3 实现方式

逐消息遍历，仅当第一条消息角色为 `system` 且内容与当前系统提示不一致时更新。稳定化仅影响第一条 system 消息，不改变数组长度，不新增消息。

### 3.4 设计来源

设计来源于 KV-cache 前缀稳定化方案。演化路径见 `ZHU/DECISIONS/INDEX.md` → **上下文管理子演化线①**（`分析-上下文管理第三期深研-KVcache真相+TokenPilot+方案修正.md` → `分析-KV-cache深研-官方证据与方案修正.md` → `分析-KV-cache前缀稳定化方案深度审计-真实性与优化方向.md`）。

---

## 四、MicroCompaction（自动轻量压缩）

**文件**：`packages/agent-core/src/agent/compaction/micro.ts`

### 4.1 触发条件（3 道关卡）

```typescript
// micro.ts L120-123
this.stepsSinceLastDetect++;
if (!force && this.stepsSinceLastDetect < BATCH_SIZE) return;
```

| 关卡 | 参数 | 当前值 | 作用 |
|------|------|--------|------|
| ① 检查频率 | BATCH_SIZE | 8（每8轮检查一次） | 防止 cutoff 线频繁变化破坏 KV-cache |
| ② 容量门槛 | minContextUsageRatio | 0.5（上下文用到50%才触发） | 容量不够时不做无谓截断 |
| ③ 保护圈 | keepRecentMessages | 20（保留最近20条消息） | 保护最近对话内容不被截断 |

- `BATCH_SIZE = flags.asNumber('micro.batchSize')` (L83)
- 环境变量 `SCREAM_CODE_MICRO_BATCH_SIZE` 可覆盖

### 4.2 压缩动作

`compact(messages)` (L145-186)：

1. **`findSupersededPaths()`** (L34-71) — 找出 cutoff 之前被后续 Read 覆盖的旧 Read
2. **截断旧 tool.result** (L151-184) — cutoff 前的 tool 消息，内容替换为 `[Old tool result content cleared]`
3. **Supersede** (L173-175) — 被后续 Read 覆盖的旧 Read 标记为 `[Superseded by a newer read of ...]`
4. **存档原始内容** (L157-171, Point B) — 截断前调用 `contentArchive?.archive()` 保留原始内容

### 4.3 集成点

与 `context/index.ts` 的集成 (L235)：
```typescript
this.agent.microCompaction.detect();
```

与 `FullCompaction` 的协作：
- Full 完成后调用 `micro.reset()` 重置 cutoff (L98-101)
- `estimateSavings()` (L193-196) 给 Full 决策用

---

## 五、FullCompaction（全局压缩）

**文件**：`packages/agent-core/src/agent/compaction/full.ts`（587 行）

### 5.1 触发

- **自动检测**：`checkAutoCompaction()` (L140-170) — 每个用户消息后检查上下文容量是否达到 `triggerRatio`（0.75）
- **手动触发**：模型可调用 `full_compaction` tool（需 tool 注册）

### 5.2 完整流程

`compactionWorker()` (L318-428)：

1. **`project(history)`** (L306) — 从完整历史中选出代表消息（最近 + 随机采样）
2. **`maskToolObservations(projected, 1)`** (L354-355) — 遮蔽长 tool result，只保留最近 1 条
3. **LLM 调用** — 带 `COMPACTION_SYSTEM_PROMPT` 做摘要总结
4. **`reduceCompactOnOverflow()`** (L376-392) — 若 LLM 输出超长，缩小范围重试
5. **`applyCompaction()`** (L408) — 清上下文，保留最近 `maxRecentMessages(4)` 条
6. **`extractAndStoreMemos(summary)`** (L503-549) — 从总结中提取记忆条目，写入 memoStore
7. **`triggerPostCompactHook()`** (L435) — 触发后置钩子
8. **`micro.reset()`** — 重置 Micro 的 cutoff

**熔断**：连续 5 次失败后自动熔断（`full_compaction.cancel` 事件），状态保留可用

### 5.3 Token 节约效果

```typescript
// full.ts L342 / L414
const tokensBefore = estimateTokensForMessages(originalHistory);
const tokensAfter = estimateTokens(summary) + estimateTokensForMessages(recent);
```

- 实际数据通过 `compaction.completed` 事件写入 `wire.jsonl`
- 示例（200k 上下文）：tokensBefore ≈ 80k → tokensAfter ≈ 5k

### 5.4 与 Micro 的协作

`strategy.ts` 的 `shouldCompact()` (L55-60)：
```typescript
shouldCompact(usedSize: number): boolean {
  if (this.maxSize <= 0) return false;
  return (
    usedSize >= this.maxSize * this.config.triggerRatio ||  // triggerRatio=0.75
    this.shouldUseReservedContext(usedSize)
  );
}
```

- `reservedContextSize: 50000` — 保留上下文空间
- `maxRecentMessages: 4` — 保留最近消息数

---

## 六、ArchiveRecover MCP 工具

**文件**：`packages/agent-core/src/tools/builtin/context/archive-recover.ts`

### 6.1 注册

`packages/agent-core/src/agent/tool/index.ts` L639：
```typescript
this.agent.type === 'main' && this.agent.contentArchive && new b.ArchiveRecoverTool(this.agent.contentArchive)
```

### 6.2 调用方式

```typescript
ArchiveRecoverInput {
  key?: string;   // 精确匹配 key，返回单条内容
  query?: string; // 模糊搜 key（key.includes(query)），返回所有匹配
}
```

不传参数 → 返回所有可用 key（仅索引）
传 key → 返回单条内容
传 query → 返回 key.includes(query) 所有匹配

### 6.3 数据流

```
模型调用 ArchiveRecover(key=...)
  → ArchiveRecoverTool.resolveExecution() (L29-53)
    → contentArchive.recover(key)
      → TTL 检查 → 返回内容 / undefined
      → priority += 0.1
      → 刷新 lastAccessedAt
```

---

## 七、日志事件

**文件**：`packages/agent-core/src/agent/records/types.ts`

所有上下文管理事件写入 `wire.jsonl`：

| type | 说明 | 字段 |
|------|------|------|
| `micro_compaction.apply` | MicroCompaction 推进 cutoff | cutoff, reason |
| `full_compaction.begin` | Full 开始 | detail, reason |
| `full_compaction.complete` | Full 完成 | stores, tokensBefore, tokensAfter |
| `full_compaction.cancel` | Full 取消（含熔断） | reason |
| `context.apply_compaction` | 应用 compaction 到上下文 | tokensBefore, tokensAfter, compactedCount |
| `context.append_message` | 拼接系统消息到上下文 | message |
| `context.append_loop_event` | 流式输出切片 | event |
| `context.undo` | 回退上下文 | — |

---

## 八、完整数据流

```
用户消息
  │
  ├─→ context/index.ts: 拼接消息到上下文
  │
  ├─→ micro.ts: detect()
  │     ├─ stepsSinceLastDetect < BATCH_SIZE → 跳过
  │     └─ ≥ BATCH_SIZE → compact()
  │           ├─ findSupersededPaths() 找出重叠 Read
  │           ├─ Point B: archive() 截断前存档
  │           ├─ 替换旧 tool.result 为标记
  │           └─ Supersede 旧 Read
  │
  ├─→ strategy.ts: shouldCompact()
  │     ├─ triggerRatio(0.75) → FullCompaction
  │     └─ reservedContext(50000) → FullCompaction
  │
  ├─→ full.ts: compact()
  │     ├─ LLM 总结上下文
  │     ├─ 写记忆
  │     ├─ 清上下文
  │     └─ micro.reset() 重置 cutoff
  │
  ├─→ content-archive.ts: archive/recover
  │     ├─ Micro 截断前存档
  │     ├─ 模型通过 ArchiveRecover 召回
  │     └─ TTL 30min → prune()
  │
  └─→ records: 所有事件写 wire.jsonl
```

---

## 九、相关文件索引

| 文件 | 作用 |
|------|------|
| **代码文件** | |
| `packages/agent-core/src/agent/context/content-archive.ts` | ContentArchive 纯内存 LRU |
| `packages/agent-core/src/agent/context/prefix-stabilizer.ts` | PrefixStabilizer 前缀稳定化 |
| `packages/agent-core/src/agent/context/index.ts` | Turn 循环集成点（detect/archive gate） |
| `packages/agent-core/src/agent/context/types.ts` | ContextMessage/ContextStore 类型 |
| `packages/agent-core/src/utils/mask-tool-observations.ts` | maskToolObservations（每轮自动遮蔽旧 tool result） |
| `packages/agent-core/src/agent/compaction/micro.ts` | MicroCompaction 逻辑 |
| `packages/agent-core/src/agent/compaction/full.ts` | FullCompaction 逻辑 |
| `packages/agent-core/src/agent/compaction/strategy.ts` | Compaction 策略决策 |
| `packages/agent-core/src/agent/compaction/index.ts` | Compaction 调度入口 |
| `packages/agent-core/src/agent/tool/index.ts` | ArchiveRecover 工具注册 |
| `packages/agent-core/src/agent/index.ts` | ContentArchive 实例化 |
| `packages/agent-core/src/tools/builtin/context/archive-recover.ts` | ArchiveRecover MCP 工具 |
| `packages/agent-core/src/flags/registry.ts` | Flag 定义（content-archive / micro.batchSize） |
| `packages/agent-core/src/agent/records/types.ts` | 日志事件类型定义 |
| `packages/agent-core/src/agent/records/persistence.ts` | wire.jsonl 持久化 |
| `packages/agent-core/src/agent/audit/file-action-audit.ts` | FileActionAudit 审计日志（独立模块） |
| **决策文档（演化图见 INDEX.md）** | |
| `ZHU/DECISIONS/INDEX.md` | **← 上下文管理完整演化图（子线①+②→合并）** |
| `ZHU/DECISIONS/Phase19-落地检查与融合执行计划.md` | Phase 19 融合执行计划终稿（合并②+①） |
| `ZHU/DECISIONS/分析-ContentArchive-参数优化与FileActionAudit融合计划-最终执行方案.md` | ContentArchive 最终执行方案（三件套定型） |
| `ZHU/DECISIONS/分析-ContentArchive-保留缓冲区设计与融合计划.md` | ContentArchive 专项设计底稿 |
| `ZHU/DECISIONS/执行方案-Phase19-KV-cache优化六步走-从基线到跨会话复用.md` | KV-cache 优化六步走方案 |
| `ZHU/DECISIONS/分析-KV-cache前缀稳定化方案深度审计-真实性与优化方向.md` | PrefixStabilizer 深度审计（6条优化方向） |
| `ZHU/DECISIONS/分析-KV-cache深研-官方证据与方案修正.md` | KV-cache 深研终稿 |
| `ZHU/DECISIONS/分析-上下文管理方案全景调查.md` | 外部调查底稿（14篇来源） |

---

## 十、依赖关系图

```
agent/index.ts
  ├─ contentArchive: new ContentArchive(config)
  │    └─ flags/registry.ts: content-archive flag (default: true)
  └─ prefixStabilizer: stabilizePrefix()  ← prefix-stabilizer.ts (纯函数，无实例)

loop/turn-step.ts
  ├─ maskToolObservations(messages, 3)  ← mask-tool-observations.ts (L77)
  │    └─ keepLastN=3, 旧 tool result → 占位符
  └─ 调用 chain: turn → context/index → micro.detect()

agent/context/index.ts
  ├─ stabilizePrefix(msgs)             ← prefix-stabilizer.ts (L241-245)
  ├─ microCompaction.detect()          ← micro.ts
  ├─ contentArchive?.archive()         ← content-archive.ts
  │    └─ flags: content-archive flag gate
  └─ contentArchive?.recover()         → archive-recover.ts (通过 MCP)

agent/compaction/micro.ts
  ├─ archive() 截断前存档 (Point B)    → content-archive.ts
  ├─ detect() gate                     → flags: micro.batchSize
  └─ reset() Full 完调                 → full.ts

agent/tool/index.ts
  └─ ArchiveRecoverTool(contentArchive) → archive-recover.ts
       └─ contentArchive gate（已放开所有 agent，不再限 main）

agent/compaction/full.ts
  ├─ maskToolObservations(projected, 1) ← mask-tool-observations.ts (L354-355)
  ├─ project(history)                   → 选代表消息
  ├─ extractAndStoreMemos(summary)      → 写记忆库
  ├─ triggerPostCompactHook()           → 后置钩子
  ├─ micro.reset()                     → micro.ts
  └─ strategy.shouldCompact()          → strategy.ts

独立运行（不在上下文管理体系内）：
agent/audit/file-action-audit.ts
  └─ FileActionAudit extends FlushBuffer → 独立审计日志
       ├─ getRecentEntries(n) → 环状缓冲区（最近50条），供 AI 查错
       └─ turn/index.ts L1882-1889 → tool 失败时自动注入最近 5 条 FAA 记录

---

## 十一、2025-06-29 新功能新增

### §11.1 ContentArchive 跨 agent 共享（sharedStore）

- `ContentArchive.sharedStore` 静态 `Map<string, ContentArchiveEntry>`
- `archive()` 同步写入共享存储
- `recover()` 先查本地 store，未命中则回退到 sharedStore（copy-on-access）
- 不破坏子 agent 隔离：本地 store 独立，共享只作 fallback
- 生命周期：进程级，不持久化

### §11.2 FAA 查错注入

- `FileActionAudit.getRecentEntries(n)` — 环状缓冲区，最近 50 条审计记录
- `turn/index.ts` L1882-1889 — `lastToolFailure` 提示自动附上最近 5 条 FAA 记录
- 未来优化：按 toolName 过滤注入，当前为全量最近 5 条

### §11.3 ArchiveRecover 放开全部 agent

- `tool/index.ts L639` 注册条件从 `type === 'main' && contentArchive` 改为仅 `contentArchive`
- Agent 构造函数已无条件初始化 `ContentArchive`，所有 agent 均可使用 ArchiveRecover

### §11.4 Phase20 Bash 输出智能降噪

- `result-builder.ts` — `ToolResultBuilderOptions` 新增 `sanitize?: boolean`，`write()` 内自动调用 `sanitizeOutput()`（`stripAnsi` + `collapseCarriageReturnLines`）
- `bash.ts` — `new ToolResultBuilder({ sanitize: true })` 激活 builder 级自动洗白，`readStreamIntoBuilder` 恢复原始简洁形态
- `context/index.ts` — `truncateToolOutput` 首行调用 `collapseDuplicateLines(text, threshold=3)`，超 3 行连续重复行去重
- `quality.ts` detector — Signal 3：bash 输出 >3000 chars 时升一级 + `concise-summary constraint` 约束
- 效果：ANSI 颜色码/进度条残影在写入内存时即剥离；重复行在截断前省空间；AI 不会大段复述大输出
```