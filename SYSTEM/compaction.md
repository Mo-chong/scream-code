# 上下文压缩系统 — Compaction

> 源码: `packages/agent-core/src/agent/compaction/`（6 个文件）
> 核心: `full.ts` (~571 行), `micro.ts` (~204 行), `strategy.ts`
> **v0.7 fork 新增**: 前缀稳定化 `prefix-stabilizer.ts` + Observation Masking `mask-tool-observations.ts`
> **v0.7 fork 新增**: MicroCompaction 批次门控（BATCH_SIZE=8 减少 cutoff 跳动）

---

## 解决的问题

AI 回合多了 -> 上下文窗口满了 -> 旧的无关信息占位置 -> 注意力稀释 -> 性能下降 -> **加上 KV-cache 命中率偏低（system prompt 里的时间戳/UUID 每次变化导致前缀不稳定）**

压缩系统在窗口快满时自动压缩旧对话历史，保留关键信息。**AI 侧无感知**。

---

## 三层优化

v0.7 fork 新增三层优化，针对 **KV-cache 命中率** 和 **token 开销**（基于 KV-cache 深研 + TokenPilot 论文，总代码量 ~38 行）：

| 层级 | 文件 | 影响范围 | 省什么 |
|------|------|----------|--------|
| **A. 前缀稳定化** | `prefix-stabilizer.ts`（新建） | system prompt 中的 ISO timestamp/UUID | 缓存命中率 ↑73%（TokenPilot 数据） |
| **B. Observation Masking** | `mask-tool-observations.ts`（新建） | 发给 LLM 的消息尾部 tool result | 每个旧 tool result 省 ~3000 token |
| **C. 批次门控 MicroCompaction** | `micro.ts` (修改) | cutoff 线变化频率 | 减少隐式缓存前缀变动 |

### A. 前缀稳定化（P0 — 直接影响缓存命中率）

**位置**：`context/index.ts` `get messages()` 管道中：`compact → **stabilizePrefix** → project`

**原理**：ISO 时间戳 `2026-06-28T13:00:47Z` 和 UUID `f47ac10b-58cc-4372` 每次请求都不相同，嵌入 system prompt 后导致缓存前缀字节不一致 → 缓存永不命中。用正则替换为固定占位符 `[timestamp]` / `[uuid]` 后，相同任务的 system prompt 字节完全一致。

**纯函数设计**（`prefix-stabilizer.ts:28-44`）：
```
只处理 role === 'system' 的消息
→ 只替换 text type 的 content part
→ 非 text part（image/audio/video）跳过
→ 非 system 消息直接返回
```

**两个入口**：
- `stabilizePrefix(messages)` — 用于 OpenAI/Gemini（system prompt 嵌入消息列表）
- `stabilizeSystemPrompt(prompt)` — 用于 Anthropic（system prompt 独立参数）

**Provider 影响**：

| Provider | 缓存机制 | 前缀稳定化影响 | Observation Masking 影响 |
|:---------|:---------|:--------------|:------------------------|
| Anthropic | 显式 `cache_control` 断点 | ✅ 大幅提升（system prompt 稳定） | ❌ 不影响（遮蔽在断点后的尾部） |
| OpenAI | 隐式前缀匹配 | ✅ 大幅提升 | ⚠️ 轻微（消息结构变化影响匹配） |
| Gemini | 隐式前缀匹配 | ✅ 大幅提升 | ⚠️ 轻微 |

### B. Observation Masking（P1 — 省 attention 省 token）

**位置**：`turn-step.ts:73-77` — `buildMessages()` → `maskToolObservations()` → `llm.chat()`

**原理**：旧工具输出（read_file 返回的几百行代码）对当前轮次的推理几乎无用，但仍占据 attention 窗口。将旧 tool result 替换为固定占位符 `[Old tool output: obscured — tool may be re-invoked if needed]`，保留最近 3 条。

**关键设计决策**：
- **无 polling**：旧方案（三合一融合）假设遮蔽会破坏缓存，加了每 15 步刷新一次的 polling。KV-cache 深研发现这是错的——缓存前缀在断点前，遮蔽在断点后，完全不重叠。polling 是在解决不存在的问题。
- **只改副本不改 history**：遮蔽操作在 `turn-step.ts` (`executeLoopStep` 内)，操作的是 `buildMessages()` 返回的消息列表（投影后的副本），`context.history` 不变。
- **无展开功能**：遮蔽不可逆。AI 想查旧内容需重新调用工具（`Read`/`cat`/`grep` 等）。

### C. 批次门控 MicroCompaction（P2 — 减少 cutoff 跳动）

**位置**：`micro.ts:117` — `detect(force?)` 加批次计数器

**原理**：MicroCompaction 每步都检查上下文用量，推进 cutoff 线。cutoff 变动会改变消息列表结构（部分 tool result 被截断），对隐式前缀匹配的 provider（OpenAI/Gemini）来说，这个消息列表字节变了，缓存 key 就变了。改为每 8 步才实际检查一次（`BATCH_SIZE=8`）。

```
改前: detect() → 每步都可能 ↑cutoff → 消息结构频繁变 → 缓存 key 变化
改后: detect() → 每步递增计数器 → 第 8 步才真正检查 → 8 步内消息结构不变
```

`force` 参数：`full.ts:204` 中 FullCompaction 前的 `detect(true)` 绕过门控，确保全量压缩前有最新的 cutoff 数据。

---

## 两层压缩

| 层级 | 文件 | 触发条件 | 做了什么 |
|------|------|----------|---------|
| **MicroCompaction** | `micro.ts` | 上下文用量 > 50%（默认），**每 8 步检测一次** | 删掉被覆盖的 Read 结果（读了同一个文件两次，旧的删掉）、截断超长 tool result |
| **FullCompaction** | `full.ts` | 上下文用量 > 触发比例（默认约 70%） | 把旧对话发给模型，让模型压缩成摘要，替换掉原消息 |

### MicroCompaction（轻量级，不调 LLM）

- `micro.ts:18-23` — 默认配置：保留最近 20 条消息，只处理 >100 token 的 tool result
- `micro.ts:82-83` — **BATCH_SIZE=8 批次门控**（v0.7 fork 新增）：减少 cutoff 跳动频率保护缓存
- 找到被覆盖的 Read 调用（第二次读同一个文件 → 第一次的可以删，标记 `[Superseded by a newer read of xxx]`）
- 把超长 tool result 替换为 `[Old tool result content cleared]`
- **不调 LLM，纯规则处理，毫秒级**

### FullCompaction（重量级，调 LLM 做摘要）

触发路径（`full.ts:252-277`）：

```
context 使用量 > 阈值
  → beginAutoCompaction()
    → begin({ source: 'auto' })
      → startCompactionWorker()
        → LLM 生成压缩摘要
        → extractAndStoreMemos()  从摘要中提取记忆并写入 SQLite
        → postProcessSummary()    把 TODO List 追加到摘要末尾
        → 替换上下文中的旧消息为摘要
```

关键机制：

| 机制 | 代码位置 | 说明 |
|------|----------|------|
| 阈值触发 | `strategy.ts` `shouldCompact()` | 默认约 70% 触发（可配置 `compactionTriggerRatio`） |
| 主动触发 | `strategy.ts` `shouldCompactProactively()` | 预测下一步会超限时提前触发 |
| 熔断保护 | `full.ts:261-264` | 连续失败 3 次 → 本回合不再自动压缩 |
| 每回合上限 | `strategy.ts` 默认 maxCompactionPerTurn | 防无限压缩 |
| LLM 专用 prompt | `full.ts:53-59` | 压缩时用精简 system prompt，避免 AI 以为还能调工具 |
| TODO 保留 | `full.ts:539-550` | 压缩后 TODO 状态追加到摘要末尾，防止丢失 |
| 记忆提取 | `full.ts:485-531` | 压缩时发现任务闭环 → 自动提取记忆 → 写入 SQLite |

---

## 记忆提取（压缩时 + 会话退出时）

### 压缩时提取

FullCompaction 生成摘要后，`extractAndStoreMemos()`（`full.ts:485-531`）调用 `parseMemoryMemos()` 从摘要中解析记忆块，写入 `memoStore`。

### 会话退出时提取

`agent/index.ts:493-567` — `extractMemoriesOnExit()`：
- 取最后 30 条消息
- 构建抽取 prompt，调 LLM 提取记忆
- 写入 `memoStore`，标记 `extractionSource = 'exit'`
- 历史不足 4 条时跳过

---

## 关键限制

| 限制 | 说明 |
|------|------|
| FullCompaction 调 LLM | 每次压缩就是一次 LLM 调用，有 token 成本 |
| 熔断是软保护 | 连续失败才熔断，单次失败仍然阻塞生成 |
| MicroCompaction 只处理 Read 覆盖和长度 | 不处理其他类型 tool result 的冗余 |
| 记忆提取依赖 parseMemoryMemos | 如果 LLM 生成的记忆格式不对，提取会失败（静默跳过） |
| 退出提取只用最后 30 条 | 长会话中间的重要信息可能丢失 |

---

## 相关配置

```
loopControl:
  reservedContextSize: 4000        # 预览保留的上下文空间
  compactionTriggerRatio: 0.7      # 触发压缩的上下文占比
```
