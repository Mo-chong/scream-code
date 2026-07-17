---
tags: [type/reference, domain/context, status/final]
keywords: [上下文, context, 三层蒸馏塔, maskToolObservations, 归档摘要, 缓存]
updated: 2026-07-17
---

<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
# 上下文管理（Context Management）

> **参见：** [`compaction.md`](compaction.md)（压缩深度技术参考） | [`injection-system.md`](injection-system.md)（注入器系统/归档层） | [`记忆系统.md`](记忆系统.md) | [`architecture-overview.md`](architecture-overview.md)（架构全景）
>
> **核心设计文档**：`ZHU/DECISIONS/分析-从AI消费者视角看缓存保护与注意力优化方向.md`（三层蒸馏塔最终版）

---

## 功能实现状态总览（v3 — 上下文蒸馏塔）

| # | 功能 | 模块 | 状态 | 备注 |
|---|------|------|:----:|:-----|
| 1 | **ContentArchive** 纯内存 LRU 保留缓冲区 | `context/content-archive.ts` | ✅ | 仅对内调试，不做 AI 取回 |
| 2 | **MicroCompaction** 自动轻量压缩 | `compaction/micro.ts` | 🗑️ **已废弃** | ROI 负（0.01% token 换 44% 缓存断裂） |
| 3 | **FullCompaction** LLM 全局总结压缩 | `compaction/full.ts` + `strategy.ts` | ✅ | 大上下文压缩 |
| 4 | **PrefixStabilizer** 前缀稳定化 | `context/prefix-stabilizer.ts` | ✅ | 缓存前缀稳定基础 |
| 5 | **ArchiveRecover** 归档恢复工具 | `tools/builtin/context/archive-recover.ts` | 🗑️ **已废弃** | 5 天零调用，训练分布不支持 AI 主动取回 |
| 6 | **FileActionAudit** 文件操作审计 | `audit/file-action-audit.ts` | ✅ | 独立运行 |
| 7 | **FlushBuffer** 事件缓冲 | `audit/file-action-audit.ts` | ✅ | |
| 8 | **ObservationMasking** tool result 遮蔽（蒸馏塔核心） | `utils/mask-tool-observations.ts` | ✅ **v3 重写** | 三层蒸馏：保真/压缩/遮蔽 |
| 9 | **ArchivalSummaryInjector** 归档摘要注入器 | `injection/archival-summary.ts` | ✅ **新增** | 上下文 >50K 触发，尾部 append |
| 10 | **EditFailureLoop Detector** 连续 Edit 检测 | `interception/detectors/edit-failure-loop.ts` | ✅ **新增** | 同文件连续 Edit → 警告 |
| 11 | **增量 LLM 摘要** | `turn/index.ts`（已移除） | 🗑️ **已废弃** | splice 断缓存，被归档层替代 |
| 12 | **Predictor** 上下文增长预测器 | `compaction/predictor.ts` | ✅ | |
| 13 | **缓存审计系统** | `agent/usage/audit-log.ts` | ✅ | |

---

## 一、架构总览（v3 — 三层蒸馏塔）

上下文管理从轻到重：

```
运行阶段                         处理时机
─────────────────────────────────────────────────────────────────
ContentArchive (纯内存 LRU) ──→ 仅对内调试（不面向 AI）
     │

     ▼
maskToolObservations (三层蒸馏)  ──→ 每轮 LLM 调用前
     ├── (1) 保真层：错误按预算保留 ← 编译300/Edit不限/测试500/权限300
     │   └── 已解决 → 自动降级 "Edit path: resolved ✓"
     ├── (2) 压缩层：成功→一行摘要
     ├── (3) 结构化保护：JSON/代码/表格 → 保留完整
     └── 遮蔽：其余旧结果 → [masked:toolName]
         └── SnipHinter（可选裁剪声明）→ 工具声明 head:t/tail:n → 只保留首尾

     ▼
ArchivalSummaryInjector ──→ 上下文 >50K 时触发，尾部 append
     ├── <50K → 不触发
     ├── 50K-100K → 每 3 轮生成
     ├── >100K → 每轮生成
     └── 任务级聚合（高置信度时显示标题）

     ▼
FullCompaction (全局压缩)   ──→ triggerRatio(0.75)
                                LLM 总结 → 清上下文
                                micro.reset()

     ▼
EditFailureLoop Detector ──→ 同文件连续 Edit 2 次以上时警告
```

---

## 二、ContentArchive（纯内存保留缓冲区）

> 别名：内容归档 / 内容缓冲区 / ContentArchive
> 对应代码：ContentArchive (context/content-archive.ts)

**文件**：`packages/agent-core/src/agent/context/content-archive.ts`

### 2.1 配置常量

| 常量 | 值 | 含义 |
|------|----|------|
| `DEFAULT_TTL_MS` (L45) | `14_400_000` | 4 小时软 TTL（基于 lastAccessedAt），持续 recover 续命 |
| `DEFAULT_HARD_TTL_MS` (L46) | `86_400_000` | 24 小时硬 TTL（基于 timestamp），强制过期上限，protected 条目同样过期即删 |
| `DEFAULT_MAX_ENTRIES` (L47) | `2000` | 全局条目上限 |
| `PRIORITY_BOOST` (L50) | `0.1` | `recover()` 每次升权步长 |
| `PRIORITY_MAX` (L51) | `1.0` | 权重上限 |
| `PRIORITY_NEW` (L52) | `1.0` | 新条目初始权重 |
| `FORCED_THRESHOLD` (L53) | `0.1` | priority < 0.1 强制优先淘汰 |
| `ACCESS_BOOST_FACTOR` (L54) | `0.5` | 访问新鲜度因子 |

**Flag 控制**：

| flag | env | 默认 | 说明 |
|------|-----|------|------|
| `content-archive` | `SCREAM_CODE_EXPERIMENTAL_CONTENT_ARCHIVE` | `true` | 功能开关 |
| `contentArchive.ttlMs` | `SCREAM_CODE_CONTENT_ARCHIVE_TTL_MS` | `14400000` | TTL 可配置覆盖（毫秒） |
| `mask.keepLastN` | `SCREAM_CODE_MASK_KEEP_LAST_N` | `3` | maskToolObservations 保留条数 |

### 2.2 Point A 存档（每步写入存档）

**文件**：`packages/agent-core/src/agent/context/index.ts` L356-380

与 MicroCompaction 截断时的 Point B 存档不同，Point A 在 **每步** tool result 写入 `context.history` 时即时存档：

```typescript
// context/index.ts L370
this.contentArchive?.archive('tool:' + msg.toolCallId, textContent, {
  source: 'toolResult',
});
```

**存档时机**：
- Point A：`context/index.ts` — 每步 tool result 写入 history 后即时 archive（key: `tool:${callId}`）
- Point B：`micro.ts` — MicroCompaction 截断前 archive（key: `micro:${callId}`）

**两者互补**：Point A 保证每步数据都有备份，Point B 保证截断数据不丢失。

### 2.3 tool result 预处理流水线

**文件**：`packages/agent-core/src/agent/context/index.ts` L27-45

tool result 写入 history 前经过 3 道处理：

| 步骤 | 处理 | 参数 | 说明 |
|------|------|------|------|
| 1 | `collapseDuplicateLines(text, 3)` | 连续重复≥3行→合并为 `[previous line repeated N times]` | 去重 |
| 2 | `truncateToolOutput(text, maxTokens=8000)` | 纯文本/ContentPart 两种模式，保尾截断 | 长度控制 |
| 3 | `MAX_TOOL_RESULT_TOKENS=8000` | 超限 → `truncateToolOutput()` | 总量保护 |

```typescript
// context/index.ts L29
const MAX_TOOL_RESULT_TOKENS = 8000;
```

处理完的完整原始内容 → ContentArchive Point A 存档，截断后的精炼版本 → context.history。

### 2.4 核心方法

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

## 四、MicroCompaction（自动轻量压缩）— 🗑️ 已废弃 v3

> **废弃理由**：0.01% token 节省（日均 ~522K / 10M+）换 6.5-44% 缓存断裂率，ROI 负到极致。
> **替代**：保真层+压缩层（maskToolObservations）和归档层（ArchivalSummaryInjector）。
> **状态**：`flags/registry.ts` `default: false` + `@deprecated` 标记。

**文件**：`packages/agent-core/src/agent/compaction/micro.ts`

### 4.1 历史参数（保留参考）

| 参数 | 默认值 | 含义 |
|------|--------|------|
| `keepRecentMessages` | 20 | 最后 20 条消息永不截断 |
| `keepRecentTokens` | 40,000 | 尾部窗口 token 预算 |
| `pruneMinReclaimTokens` | 20,000 | 最少回收 20k tokens 才推进 cutoff |
| `minContentTokens` | 100 | tool result < 100 tokens 不截断 |
| `minContextUsageRatio` | 0.5 | 上下文用到 50% 才触发 |

### 4.2 废弃原因详细分析

**根因**：micro compaction 每 8 步推进一次 cutoff 线，cutoff 位置变化 = 消息前缀变化（被清的工具结果 → `[Cleared]`）。DeepSeek KV-cache 以消息前缀寻址，前缀变化迫使服务端丢弃缓存重建。

| 指标 | Micro 开启 | Micro 关闭 | 说明 |
|:----|:---------:|:---------:|:-----|
| 缓存断裂率（无注入器） | 6.5% | 0% | 单 micro 的净影响 |
| 缓存断裂率（有注入器） | 44% | 6.5% | micro + 注入器放大器效应 |
| Token 日均节省 | ~522K | 0 | 占总 token 量 < 0.01% |

### 4.3 替代方案

Micro 的三个目标都有更好的替代：

| Micro 目标 | 蒸馏塔替代 | 优势 |
|:----------|:----------|:-----|
| 省 token（清旧结果） | 压缩层（成功→一行） | 不破坏缓存 |
| 减少 AI 看旧信息 | 归档层（结构化摘要） | 不失忆 |
| 清旧 Read 结果 | 保真层（错误保留）+ 压缩层 | 按类型分级，更智能 |

---

## 五、FullCompaction（全局压缩）

> 别名：全局压缩 / 全量压缩 / FullCompaction
> 对应代码：FullCompaction (compaction/full.ts)

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

## 六、ArchiveRecover MCP 工具 — 🗑️ 已废弃 v3

> **废弃理由**：5 天审计数据零调用。训练分布不支持 AI 主动取回被遮内容——AI 在当前步骤没有"缺信息"的痛感。
> **替代**：三层蒸馏塔——保真层（错误不遮）+ 压缩层（成功一句话）+ 归档层（结构化尾部摘要）。信息直接送到 AI 面前，不需 AI 自己取。
> **状态**：代码保留在仓库中（标记 deprecated），已从工具注册表注销。

### 6.1 原始注册点（已移除）

```typescript
// agent/tool/index.ts — 已注释（cache-stable-v1）
// this.agent.contentArchive && new b.ArchiveRecoverTool(this.agent.contentArchive),
```

### 6.2 保留的 code（不删）

ContentArchive 保留作为内部调试存储，不再面向 AI。

### 6.3 历史调用方式（废弃，仅供阅读旧日志参考）

```typescript
ArchiveRecoverInput {
  key?: string;   // 精确匹配 key，返回单条内容
  query?: string; // 模糊搜 key，返回所有匹配
}
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
| `cache_metric.record` | 缓存审计指标 | hitRatio, totalInput, totalOutput, injected[].{variant,success,position}, apiKeySwitched |
| `api_key_switch.detected` | API key 切换检测 | prevRatio, currRatio, drop, modelChanged |

---

## 八、完整数据流（v3 — 上下文蒸馏塔管线）

```
用户消息
  ｜
  ├─→ context/index.ts: 拼接消息到上下文
  │     ├─ collapseDuplicateLines() 去重
  │     ├─ MAX_TOOL_RESULT_TOKENS(8000) 长度截断
  │     ├─ Point A: archive('tool:' + callId) → ContentArchive（内部调试）
  │     └─ 写入 context.history
  │
  ├─→ prefix-stabilizer.ts: stabilizePrefix()
  │     └─ 系统提示前缀固化 → 提高 KV-cache 前缀命中率
  │
  ├─→ maskToolObservations (三层蒸馏塔核心) [每步 LLM 调用前]
  │     ├── 保真层：错误按类型预算（编译300/Edit不限/测试500/权限300）
  │     │   └── 已解决 → 降级 "Edit path: resolved ✓"
  │     ├── 结构化保护：JSON/代码/表格 → 保留完整
  │     ├── 压缩层：成功→一行（"Build: 0 errors"）
  │     └── 遮蔽：其余 → [masked:toolName]
  │
  ├─→ ArchivalSummaryInjector (归档层) [条件触发]
  │     ├── <50K → 不触发（保真层+压缩层足够）
  │     ├── 50K-100K → 每 3 轮生成结构化摘要
  │     ├── >100K → 每轮生成
  │     ├── 任务级聚合（高置信度 >0.6 时显示标题）
  │     └── 尾部 append（appendSystemReminder，不碰缓存前缀）
  │
  ├─→ EditFailureLoop Detector [每步]
  │     └── 同文件连续 Edit 2 次 → appendSystemReminder 警告
  │
  ├─→ Predictor: 预测上下文增长趋势（每步）
  │     └── 提前预警 FullCompaction 触发
  │
  ├─→ strategy.ts: shouldCompact()
  │     ├─ triggerRatio(0.75) → FullCompaction
  │     └─ reservedContext(50000) → FullCompaction
  │
  ├─→ full.ts: compact()（全局压缩，满 75% 触发）
  │     ├─ LLM 总结上下文
  │     ├─ extractAndStoreMemos → 写记忆库
  │     └─ 清上下文
  │
  └─→ audit-log.ts: 缓存审计 [每步]
        ├─ hitRatio / totalInput / totalOutput
        ├─ injected[].{variant,success,position} / modelChanged / apiKeySwitched
        └─ 写入 cache-audit-YYYY-MM-DD.ndjson
```

**关键时间维度（v3）：

| 机制 | 触发频次 | 缓存影响 |
|------|----------|:--------:|
| PrefixStabilizer | **每步** | ✅ 稳定前缀 |
| maskToolObservations | **每步** | ✅ 操作 projected 副本，不改 _history |
| ArchivalSummaryInjector | **条件触发（>50K）** | ✅ 尾部 append，不碰前缀 |
| EditFailureLoop Detector | **检测到循环时** | ✅ 尾部 append |
| FullCompaction | **容量 > 75%** | ✅ 全局压缩后重建 |
---

## 九、偏差链（DeviationChain）

偏差链子系统检测 AI 连续偏离指令的行为模式，并尝试自动修复。实现在 `turn/index.ts` 内联方法，非独立注入器。

### §9.1 触发条件

`detectDeviationChain()`（`turn/index.ts` L1862-1894）检测三种模式：

| 模式 | 条件 | 计数器 |
|------|------|--------|
| 连续 Edit 未查 LSP | Edit 后未调用 LSP.references/definition | `editWithoutReference++` |
| 验证持续失败 | tool 返回 `verification` 且失败 | `consecutiveVerificationFailures++` |
| 行为规则累积 | system 回复含"行为规则"引用 | `behaviorRuleViolations++` |

任一类目连续 ≥3 次触发偏差链激活。

### §9.2 自动解析路径

`tryResolveDeviationChain()`（L1962-1984）按顺序尝试：

1. LSP 引用查询 → 修复遗漏的调用方
2. 调用验证工具 → 检查代码正确性
3. 代码质量计数器清零（`codeQualityResetCount`）
4. 行为变体标记为 `hasVerification=true` → 下次必须验证

偏差链激活时，`injectBudget.bypassBudget()`（L1672）绕开预算限制，确保修复提示一定被注入。

### §9.3 数据流位置

```
post-turn 检查:
  ├─ detectDeviationChain()     ← 3种触发条件
  ├─ tryResolveDeviationChain() ← 4种解析路径
  └─ activate → bypassBudget()  ← 绕过预算
```

---

## 十、注意力信号（AttentionSignals）

从 AI 回复文本中提取结构化指令完成状态信号。实现在 `turn/index.ts` `parseAttentionSignals()`（L2020-2034）。

### §10.1 信号类型

| 标记 | 字段 | 含义 |
|------|------|------|
| `[DONE]` | `signals.done = true` | 任务完成 |
| `[NEED]` | `signals.need = true` | 需要帮助 |
| `[CONFIRM]` | `signals.confirm = true` | 需要确认 |

存入 `crossTurnFlags.attentionSignals`，跨轮次持久化。

### §10.2 注入消费

`injectCrossTurnFlags()`（L2295-2320）读取信号注入对应提示：

| 信号 | 检测到 AI 行为 | 注入内容 |
|------|---------------|----------|
| `[DONE]` | 可能虚构完成 | "请先用构建/测试/检查工具验证后再确认完成" |
| `[NEED]` | 可能卡住走偏 | "请说明当前目标、已尝试的方法、具体卡在哪一步" |
| `[CONFIRM]` | 可能不敢决策 | "请根据已有信息自行判断并继续推进" |

三个注入均以 `system_trigger` 类型穿透 budget 限制，确保信号被及时响应。注入后自动复位 `attentionSignals = { done: false, need: false, confirm: false }`。

作为对比，同类注意力增强机制还包括：
- **DeviationChain**（§9）：检测连续 Edit 未查 LSP / 验证持续失败等行为偏差，bypassBudget 注入修复提示
- **GuardInjector**：行为规则注入，按残差公式调度
- **StuckInjector**：检测同一文件连续编辑 ≥3 次或同工具连续报错 ≥2 次

---

## 相关文件索引

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
| `packages/agent-core/src/agent/compaction/predictor.ts` | Predictor 上下文增长预测器 |
| `packages/agent-core/src/agent/usage/audit-log.ts` | 缓存审计系统（Phase29） |
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

## 十一、依赖关系图

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
  ├─ Point A: archive('tool:'+callId) → content-archive.ts (L369)
  │    └─ flags: content-archive flag gate
  ├─ contentArchive?.archive()         → content-archive.ts
  ├─ contentArchive?.recover()         → archive-recover.ts (通过 MCP)
  ├─ collapseDuplicateLines(text, 3)  ← context/index.ts (预处理)
  ├─ truncateToolOutput(text, 8000)   ← context/index.ts (长度截断)
  └─ Predictor.record()               ← compaction/predictor.ts

agent/compaction/micro.ts
  ├─ Point B: archive('micro:'+callId) → content-archive.ts (L223)
  ├─ compact(messages)                 → context/index.ts (L235)
  │    ├─ findSupersededPaths()
  │    ├─ minContentTokens=100 小结果保留
  │    ├─ pruneMinReclaimTokens=20000 收益保护
  │    ├─ keepRecentTokens=40000 尾部窗口
  │    └─ uselessMarker Phase20 Bash降噪
  ├─ detect() gate                     → flags: micro.batchSize (L123)
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
  ├─ strategy.shouldCompact()          → strategy.ts
  └─ Predictor.predict()               → compaction/predictor.ts (预估剩余容量)

独立运行（不在上下文管理体系内）：
agent/usage/audit-log.ts
  ├─ detectApiKeySwitch()              → 审计日志 (L47-71)
  ├─ prevRatio>0.7, drop≥0.25, inputRatio≤3, injected>0→false
  └─ cache-audit-YYYY-MM-DD.ndjson 轮转日志

agent/audit/file-action-audit.ts
  └─ FileActionAudit extends FlushBuffer → 独立审计日志
       ├─ getRecentEntries(n) → 环状缓冲区（最近50条），供 AI 查错
       └─ turn/index.ts L1882-1889 → tool 失败时自动注入最近 5 条 FAA 记录

---

## 十二、2025-06-29 新功能新增

### §12.1 ContentArchive 跨 agent 共享（sharedStore）

- `ContentArchive.sharedStore` 静态 `Map<string, ContentArchiveEntry>`
- `archive()` 同步写入共享存储
- `recover()` 先查本地 store，未命中则回退到 sharedStore（copy-on-access）
- 不破坏子 agent 隔离：本地 store 独立，共享只作 fallback
- 生命周期：进程级，不持久化

### §12.2 FAA 查错注入

- `FileActionAudit.getRecentEntries(n)` — 环状缓冲区，最近 50 条审计记录
- `turn/index.ts` L1882-1889 — `lastToolFailure` 提示自动附上最近 5 条 FAA 记录
- 未来优化：按 toolName 过滤注入，当前为全量最近 5 条

### §12.3 ArchiveRecover 放开全部 agent

- `tool/index.ts L639` 注册条件从 `type === 'main' && contentArchive` 改为仅 `contentArchive`
- Agent 构造函数已无条件初始化 `ContentArchive`，所有 agent 均可使用 ArchiveRecover

### §12.4 Phase20 Bash 输出智能降噪

- `result-builder.ts` — `ToolResultBuilderOptions` 新增 `sanitize?: boolean`，`write()` 内自动调用 `sanitizeOutput()`（`stripAnsi` + `collapseCarriageReturnLines`）
- `bash.ts` — `new ToolResultBuilder({ sanitize: true })` 激活 builder 级自动洗白，`readStreamIntoBuilder` 恢复原始简洁形态
- `context/index.ts` — `truncateToolOutput` 首行调用 `collapseDuplicateLines(text, threshold=3)`，超 3 行连续重复行去重
- `quality.ts` detector — Signal 3：bash 输出 >3000 chars 时升一级 + `concise-summary constraint` 约束
- 效果：ANSI 颜色码/进度条残影在写入内存时即剥离；重复行在截断前省空间；AI 不会大段复述大输出
```
