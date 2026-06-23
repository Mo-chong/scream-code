# 上下文压缩系统 — Compaction

> 源码: `packages/agent-core/src/agent/compaction/`（6 个文件）
> 核心: `full.ts` (569 行), `micro.ts` (188 行), `strategy.ts`

---

## 解决的问题

AI 回合多了 -> 上下文窗口满了 -> 旧的无关信息占位置 -> 注意力稀释 -> 性能下降

压缩系统在窗口快满时自动压缩旧对话历史，保留关键信息。**AI 侧无感知**。

---

## 两层压缩

| 层级 | 文件 | 触发条件 | 做了什么 |
|------|------|----------|---------|
| **MicroCompaction** | `micro.ts` | 上下文用量 > 50%（默认） | 删掉被覆盖的 Read 结果（读了同一个文件两次，旧的删掉）、截断超长 tool result |
| **FullCompaction** | `full.ts` | 上下文用量 > 触发比例（默认约 70%） | 把旧对话发给模型，让模型压缩成摘要，替换掉原消息 |

### MicroCompaction（轻量级，不调 LLM）

- `micro.ts:18-23` — 默认配置：保留最近 20 条消息，只处理 >100 token 的 tool result
- 找到被覆盖的 Read 调用（第二次读同一个文件 → 第一次的可以删）
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
