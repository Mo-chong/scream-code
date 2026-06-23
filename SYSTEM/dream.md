# Dream 记忆整理系统

> 源码: `packages/memory/src/dream.ts` (169 行) — DreamTracker（计时器+建议）
> 源码: `packages/memory/src/consolidator.ts` (458 行) — 实际整理逻辑
> 工具: `packages/agent-core/src/tools/builtin/memory/memory-consolidate.ts`

---

## 架构

两个独立模块：

```
DreamTracker (dream.ts)         ← 计时器，建议用户跑 /dream
  └── shouldSuggest() 条件:     距离上次 dream > 24小时 + 新会话 >= 5 个

Consolidator (consolidator.ts)  ← 实际干活，buildConsolidationPlan() + applyConsolidation()
  ├── 找重复组（相似度 ≥ 0.45）
  ├── 找相关组（关键词分组，不操作）
  ├── 找已解决（outcome=完成 + >7天）
  ├── 找过期（记录时间 >30天 + 未完成 + 非blocked）
  └── 跳过保护标签
```

---

## 运行流程

```
用户执行 /dream
  → MemoryConsolidatePlanTool
    → buildConsolidationPlan(store)
      → 读全量记忆
      → 过滤 baohu 标签 → active 列表
      → active 参与后续所有判断
      → 返回 ConsolidationPlan（含 duplicateGroups, resolved, stale, skippedProtected）
  → AI 展示计划给用户看
  → 用户确认
  → MemoryConsolidateApplyTool
    → applyConsolidation(store, plan)
      → 归档 resolved/stale → 删除原记录
      → 合并 duplicate → 新建 merged 记录 → 删除原记录
      → 记录 dream 时间
```

---

## 保护标签 baohu（2026-06-22 新增）

### 原理

```typescript
// consolidator.ts:74-75
const PROTECTED_TAGS = ['baohu'];
const active = allMemos.filter(m => !m.tags?.includes('baohu'));
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
| 合并重复 | `findDuplicateGroups()` | 关键词相似度 ≥ 0.45 | 合并 → 删原始 |
| 标记相关 | `findRelatedGroups()` | 共享关键词锚点 | 只显示，不操作 |
| 已解决删除 | `findResolved()` | outcome=完成 + >7天 | 归档后删除 |
| 过期删除 | `findStale()` | >30天 + 未完成 + 非blocked | 归档后删除 |

### 重复合并逻辑 (consolidator.ts:197-231)

- 两两计算 `computeKeywordSimilarity()` ≥ 0.45
- 合并时的矛盾处理：新的什么Failed/什么Worked 覆盖旧的

### 过期判断 (consolidator.ts:437-447)

```typescript
m.recordedAt < threshold &&        // 超过 staleDays（30天）
!isOutcomeCompleted(m.outcome) &&   // 未完成
!m.outcome.includes('blocked')      // 非阻塞
```

⚠️ 行为矫正的规则记忆 `outcome: "规则定义 - 永久有效"` 不含"完成"不匹配 completed，30天后也会被标记过期——除非加了 `baohu` 标签。

---

## 保护标签最佳实践

| 需求 | tags |
|------|:----:|
| 规则记忆 + 受保护 | `["behavior-rule", "baohu"]` |
| 规则记忆 + 受保护 + 置顶 | `["behavior-rule", "baohu", "ding"]` |
| 纯保护不想被管 | `["baohu"]` |
| 可被 dream 整理的普通规则 | `["behavior-rule"]`（不带 baohu） |
