# Dream 记忆整理系统

> 源码: `packages/memory/src/dream.ts` (169 行) — DreamTracker（计时器+建议）
> 源码: `packages/memory/src/consolidator.ts` (458 行) — 实际整理逻辑
> 工具: `packages/agent-core/src/tools/builtin/memory/memory-consolidate.ts`

---

## 架构

两个独立模块：

```
DreamTracker (dream.ts:24-108)  ← 计时器，建议用户跑 /dream
  └── shouldSuggest() 条件:     距离上次 dream > 24小时 + 新会话 >= 5 个

Consolidator (consolidator.ts)  ← 实际干活，buildConsolidationPlan() + applyConsolidation()
  ├── 找重复组（关键词相似度 ≥ 0.45）
  ├── 找相关组（关键词锚点分组，不操作）
  ├── 找已解决（outcome=完成 + >7天）
  ├── 找过期（记录时间 >30天 + 未完成 + 非blocked）
  └── 跳过保护标签 baohu / chundu / yongjiu
```

---

## 运行流程

```
用户执行 /dream
  → MemoryConsolidatePlanTool (memory-consolidate.ts:70-108)
    → buildConsolidationPlan(store) (consolidator.ts:64-101)
      → 读全量记忆
      → 过滤 baohu/chundu/yongjiu 标签 → active 列表
      → active 参与后续所有判断
      → 返回 ConsolidationPlan（含 duplicateGroups, resolved, stale, skippedProtected）
  → AI 展示计划给用户看
  → 用户确认
  → MemoryConsolidateApplyTool (memory-consolidate.ts:116-148)
    → applyConsolidation(store, plan) (consolidator.ts:107-217)
      → 归档 resolved/stale → demote 到冷层（保留 vec0 可搜索）
      → 合并 duplicate → 先 append merged → 再删 originals（防崩溃安全）
      → 记录 dream 时间 (dreamTracker.recordDream())
```

---

## 保护标签 baohu + chundu（2026-06-22 新增，v0.6.10 扩展）

### 原理

```typescript
// consolidator.ts:74-75
const PROTECTED_TAGS = ['baohu', 'chundu', 'yongjiu'];
const active = allMemos.filter(m => !m.tags?.some(t => PROTECTED_TAGS.includes(t)));
// active 不包含保护记忆 → 不会进入合并/删除/过期判断
```

### 保护内容

| 操作 | 保护效果 |
|------|----------|
| 重复合并 | ✅ 完全免疫 |
| 已解决删除 | ✅ 完全免疫 |
| 过期删除 | ✅ 完全免疫 |
| 相关分组 | ✅ 完全免疫 |

### 报告

`summary.skippedProtected` 字段显示跳过了多少条保护记忆。

---

## 4 种操作

| 操作 | 函数 | 条件 | 动作 |
|------|------|------|------|
| 合并重复 | `findDuplicateGroups()` (consolidator.ts:219-254) | 关键词相似度 ≥ 0.45 | 合并 → 删原始 |
| 标记相关 | `findRelatedGroups()` (consolidator.ts:388-437) | 共享关键词锚点 | 只显示，不操作 |
| 已解决降级 | `findResolved()` (:450-457) | outcome=完成 + >7天 | demote(ctx层) |
| 过期降级 | `findStale()` (:459-469) | >30天 + 未完成 + 非blocked | demote(ctx层) |

### 重复检测算法

纯文本 **零 LLM** 检测。不使用 embedding/向量距离。

**Step 1 — 关键词提取** `extractKeywords()` (scoring.ts:224-249)

把 memo 的 userNeed + approach + whatFailed + whatWorked 拼成文本，然后：

- ASCII 词 ≥ 2 字符保留（去停用词）
- 中文单字保留（去停用词）
- 中英文交界处自动加空格分隔（如 "使用redis缓存" → "使用 redis 缓存"）

**Step 2 — Jaccard 相似度** `computeKeywordSimilarity()` (scoring.ts:251-266)

```
score = |intersection| / |union|
```

阈值 `SIMILARITY_THRESHOLD = 0.45` (consolidator.ts:55)

**Step 3 — 聚类分组** `findDuplicateGroups()` (:219-254)

- 全对全比较：对每个 memo，与 cluster 内所有已接受的 memo 算相似度
- 如果与 cluster 中**任意一条**相似度 ≥ 0.45，就纳入该 cluster
- 已分组的 memo 标记 `used`，不会重复放入多个组
- 最终 cluster.length > 1 才形成 DuplicateGroup

### 矛盾解决算法（新<旧覆盖）

`buildDuplicateGroup()` (consolidator.ts:302-347) 是真正"解决矛盾"的地方。

**核心思想：新的经验覆盖旧的。**

1. 把 cluster 按时间 `recordedAt` 排序
2. 取中位数，分成 newer 半区和 older 半区
3. `splitClaims()` (:260-266)：把 `whatFailed`/`whatWorked` 用 `;` 或 `；` 分割成独立的 claims
4. `extractSignificantWords()` (:272-285)：从每条 claim 提取"重要词"——ASCII ≥3 字符 + CJK 2-grams
5. `claimsOverlap()` (:291-300)：两条 claim 共享 ≥2 个重要词即为 overlap

**矛盾消除规则（两条）：**

| 检测条件 | 结果 |
|----------|------|
| older 的 whatFailed 与 newer 的 whatWorked 重叠 | → 问题已解决，丢弃这条 failed claim |
| older 的 whatWorked 与 newer 的 whatFailed 重叠 | → 这个方法后来失败了，丢弃这条 worked claim |

**示例** ── MCP PATHEXT 排查的记忆会有三条：
- 旧："加 PATHEXT 白名单没用" → 在 newer 的 whatWorked 中被提及为已解决 → 丢弃
- 中："裸命令加 .cmd 后缀走通了部分" → 在 newer 的 whatFailed 中仍有提及 → 保留
- 新："清洗 PATHEXT 双引号才完全生效" → 作为最终的 whatWorked

**outcome 择优：** 从 cluster 中选最优——如果任意一条含"完成"/"done"，merged.outcome 就写 "完成"。

### 相关组检测

`findRelatedGroups()` (consolidator.ts:388-437) 与重复组不同——它找的是**共享话题但不相似**的记录，只展示不操作。

**锚点提取** `extractTopicAnchors()` (:357-386)：
- 复合标识符（含 `-` `_` 的 token，如 `sample-project`）→ 强信号，整体保留
- ASCII 词 ≥3 字符（去停用词）
- CJK 2-gram：中文按 2 字滑动窗口切分（如 "用户认证" → ["用户","户认","认证"]）

**分组策略：**
- 已进入 duplicateGroups 的记录不再参与 relatedGroups（:392-397）
- 按锚点出现频率排序，高频优先
- 一条记录只会归属一个 relatedGroup

### 过期判断 (consolidator.ts:459-469)

```typescript
m.recordedAt < threshold &&        // 超过 staleDays（30天）
!isOutcomeCompleted(m.outcome) &&   // 未完成
!m.outcome.includes('blocked')      // 非阻塞
```

⚠️ baohu/chundu/yongjiu 标签对以上全部免疫，不会进入任何判断。

### 归档行为变化（2026-06 修改：delete → demote）

之前 resolved/stale 直接 `delete()`。现在走 `store.demote(id)` (consolidator.ts:165-182)：

1. 先提取所有 resolved/stale 的 whatWorked/whatFailed，合并为一条归档回忆 append 进去（"esolved 任务的经验归档"/"过期记忆的经验归档"）
2. 然后对每条原始记录调用 `store.demote(id)` — 移入 memos_archive 冷层
3. 冷层 vec0 标记为 `ARCHIVED` tier，仍然可被搜索到
4. 搜索命中后通过 `autoPromoteHits()` 自动升回 HOT

这样已解决/过期的记忆不会消失——用户搜冷门话题时仍可能命中。

### 标签处理更新（v0.6.10）

Dream 合并路径 `consolidator.ts:189-193` 改为走 `processTags()` 统一路由：

```
旧: normalizeTags(flatTags)                 → 纯继承，无黑名单+无同义合并
新: await processTags(flatTags, { existingTags })  → 走黑名单+同义合并+动态预算
```

⚠️ **同步→async**：因 `processTags()` 内部有异步后备生成，`applyConsolidation()` 改为 async。

---

## 保护标签最佳实践

| 需求 | tags |
|------|:----:|
| 规则记忆 + 受保护 | `["chundu", "baohu"]` |
| 规则记忆 + 受保护 + 置顶 | `["chundu", "baohu", "ding"]` |
| 纯保护不想被管 | `["baohu"]` |
| 永久保留的记忆 | `["yongjiu"]` |
| 可被 dream 整理的普通规则 | `["chundu"]`（但 chundu 本身已免疫整理——此场景不再存在） |
