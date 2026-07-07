# 调研报告：metrics/ 目录、CacheStats、micro.ts 与 Agent 计数

> 调研范围：`D:/AI/ScreamCode/packages/agent-core/src`

---

## 1. metrics/ 目录是否存在？是否有 PerformanceMetrics 类？

**结论：metrics/ 目录不存在，无 PerformanceMetrics 类。**

- `Glob('metrics/**', src/)` → **0 个结果**。`src/` 下没有任何 `metrics/` 目录。
- `Grep('PerformanceMetrics|perf_', src/)` → **0 个匹配**（case-sensitive）。
- `Grep('Metrics|metrics', src/)` → **0 个匹配**（case-sensitive）。
- 项目中没有任何名叫 `performanceMetrics` / `metrics` 的文件、类或函数。

---

## 2. micro.ts 中有没有 `emit('micro_compaction')` 或 Metrics 调用？

**结论：没有 `emit(...)` 调用，没有 Metrics 类调用。**

`micro.ts`（219 行）只使用了一种"记录"机制：

```typescript
// micro.ts line 104-110
private apply(cutoff: number): void {
    this.agent.records.logRecord({
      type: 'micro_compaction.apply',
      cutoff,
    } as Record<string, unknown> as never);
    this.cutoff = cutoff;
}
```

- 调用 `this.agent.records.logRecord(...)`，不是 `this.agent.emit(...)`。
- `logRecord` 写入的是本地持久化记录（`AgentRecord`），不是 emit 事件。
- 没有任何地方 imports 或调用 Metrics 类。

---

## 3. CacheStats 框架是否存在？

**结论：不存在。**

- `Glob('**/cache*', src/)` → **0 个相关文件**。
- `Glob('**/Cache*', src/)` → **0 个相关文件**。
- `Grep('CacheStats|cacheStats|cache_stats', src/)` → **0 个匹配**。
- 项目中没有任何统计缓存命中/失效的框架、类或数据结构。

---

## 4. micro.ts 的 `apply()` 方法中有没有记录 metrics（仅 logRecord）？

**结论：仅 `logRecord`，没有 metrics 记录。**

`apply()` 方法的完整实现（第 104-110 行）：

| 记录方式 | 是否存在 | 详情 |
|----------|----------|------|
| `this.agent.emit(...)` | ❌ | 无 |
| `this.agent.emitEvent(...)` | ❌ | 无 |
| `this.agent.metrics.*` | ❌ | 不存在 |
| `this.agent.records.logRecord(...)` | ✅ | 唯一记录方式：写入 `{ type: 'micro_compaction.apply', cutoff }` 到持久化记录 |

此外，`MicroCompaction.compact()` 方法内部还调用了 `this.agent.contentArchive?.archive(...)`（第 165-169 行）用于内容存档（非 metrics）。

---

## 5. agent/index.ts 中有没有性能计数器？

**结论：Agent 类没有显式的 turnCount / tokenCount 字段，但通过 `UsageRecorder` 和 `context.tokenCount` 间接跟踪性能指标。**

### Agent 类字段（从 class 定义查看）

Agent 类（约 591 行，从第 95 行 class Agent 到第 685 行）的主要字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `records` | AgentRecords 实例 | 管理持久化记录 |
| `usage` | UsageRecorder 实例 | 按模型跟踪 token 用量 |
| `context` | AgentContext 实例 | 包含 `tokenCount` 和 `tokenCountWithPending` |
| `config.modelCapabilities.max_context_tokens` | number | 上下文窗口上限 |

### UsageRecorder（`agent/usage/index.ts`）

- `record(model, usage, scope)` — 记录每次 LLM 调用的 token 用量
- `data()` → `UsageStatus` — 返回 `{ byModel, total, currentTurn }`
- `status()` — 同上但可返回 undefined
- `beginTurn()` / `endTurn()` — 管理 turn 生命周期
- Token 统计按 scope 分：`session` 全局累计 / `turn` 当前轮次累计

### 事件中的性能数据

`emitStatusUpdated()`（第 642-665 行）emit 的事件包含：
```
contextTokens        — context.tokenCount
maxContextTokens     — config.modelCapabilities.max_context_tokens
contextUsage         — 比率
usage                — UsageRecorder.status()（按模型汇总 token 用量）
```

### 没有的计数器

- ❌ 没有 `turnCount` 或等效整数计数器（turn 数量不保存）
- ❌ 没有 `requestCount` 字段
- ❌ 没有 token 速率、延迟、失败率等性能监控
- ❌ 没有缓存命中/失效统计

Turn 的边界由 `UsageRecorder.beginTurn()` / `endTurn()` 隐式管理，但 turn 的 **次数** 没有被累加到一个专用计数器上。

---

## 总结

| 调研项 | 状态 |
|--------|------|
| `metrics/` 目录 | ❌ 不存在 |
| `PerformanceMetrics` 类 | ❌ 不存在 |
| `emit('micro_compaction')` 调用 | ❌ 不存在 |
| Metrics 类调用 | ❌ 不存在 |
| `CacheStats` 框架 | ❌ 不存在 |
| `apply()` 记录 metrics | ❌ 仅 `logRecord` |
| Agent 性能计数器 | ⚠️ 仅有 `UsageRecorder` 的 token 追踪，无 turnCount/requestCount |
