# 记忆系统 — MemoryMemoStore

> 源码: `packages/memory/src/store.ts` (1016 行)
> 数据模型: `packages/memory/src/models.ts`

---

## 数据存储

### SQLite 主存储

表 `memos` 定义（store.ts:329-340）：

```sql
CREATE TABLE memos (
  id TEXT PRIMARY KEY,
  source_session_id TEXT NOT NULL,
  source_session_title TEXT,
  user_need TEXT NOT NULL,
  approach TEXT NOT NULL,
  outcome TEXT NOT NULL,
  what_failed TEXT NOT NULL DEFAULT 'none',
  what_worked TEXT NOT NULL DEFAULT 'none',
  extraction_source TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  project_dir TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]'
);
```

### JSONL 备份

`entries.jsonl` 每行一条 JSON，作用：SQLite 损坏时恢复。

### FTS5 全文索引（store.ts:344-351）

```sql
CREATE VIRTUAL TABLE memos_fts USING fts5(
  user_need,       -- FTS5 索引
  approach,        -- FTS5 索引
  what_failed,     -- FTS5 索引
  what_worked,     -- FTS5 索引
  source_session_title,  -- FTS5 索引
  content=''
);
```

⚠️ **tags 不在 FTS5 索引中。** tags 存为 JSON 字符串（store.ts:339），FTS5 只索引以上 5 列。

### 向量嵌入（store.ts 后半部分）

`memory_embeddings` 表，由 EmbeddingEngine 异步生成，用于语义相似度搜索。

---

## 三种搜索方式

| 方式 | 函数 | 原理 | 包括 tags？ |
|------|------|------|:----------:|
| FTS5 全文 | `search(query)` | SQLite FTS5 分词匹配 | ❌ |
| 列表搜索 | `list({ search })` | FTS5 初筛 + fallback 全量扫描 | ✅（fallback 才检查） |
| 向量搜索 | `searchByVector()` | embedding 余弦相似度 | ❌ |

### search() 细节（store.ts:136-164）

- FTS5 MATCH 查询
- `option.projectDir` 过滤：只搜指定项目或空项目（跨项目记忆）
- 返回完整 MemoryMemo 对象（含 tags）
- tags 过滤必须在调用方做：`.filter(m => m.tags?.includes('xxx'))`

### list() 细节（store.ts:166-196）

- 先调 search() FTS5 初筛
- 如果 FTS5 没结果 → fallback 全量扫描（store.ts:189-191）
- `memoMatchesSearch()`（store.ts:969-981）把 tags 拼入 haystack 做子串匹配
- 这意味着：`list({ search: "behavior-rule" })` 在 fallback 路径下能找到标签匹配

---

## 纯度控制（针对行为矫正系统）

规则记忆和经验记忆共存在同一个表里，靠 tag 区分：

```
规则记忆: tags = ["behavior-rule", "baohu", "ding", "chundu", "verification"]
经验记忆: tags = ["react", "auth"]    （AI 自动存，不含 behavior-rule）
```

注入时代码：

```typescript
const memos = await store.search(query, { projectDir });
const rules = memos.filter(m => m.tags?.includes('behavior-rule'));
// 只注入 rules，不注入经验记忆
```

⚠️ **重要限制**：不能直接 `search("behavior-rule")` 按 tag 搜——FTS5 不索引 tags。要么：
1. `search("关键词")` → `.filter(tags)`（推荐，先语义初筛再 tag 精筛）
2. `list({ search: "behavior-rule" })` 依赖 fallback 路径（不保证命中率）

---

## 标签体系（拼音标签）

> 2026-06-22 新增。全部为拼音，不影响搜索和 AI 使用。

### 功能标签

| 标签 | 图标 | 含义 | 系统效果 | 所属模块 |
|:----:|:----:|------|----------|----------|
| `baohu` | 🔒 | 保护 | Dream 完全免疫，不合并/删除/归档 | consolidate.ts |
| `ding` | 📌 | 置顶 | 搜索评分 +0.25 flat bonus，始终排前面 | scoring.ts |
| `chundu` | 🧠 | 纯度规则 | UI 显示 🧠 标记方便识别 | memory-picker.ts |
| `yongjiu` | — | 永久 | 预留，效果同 baohu | — |
| `behavior-rule` | — | 行为规则 | 注入系统过滤标记，决定是否注入 | turn/index.ts |

### 标签隔离

```
baohu/ding/chundu     → 系统功能标签（保护/置顶/标记）
behavior-rule          → 注入系统标签（决定注入与否）
其他中文标签           → 普通分类标签（AI 自动存储时生成）
```

**两条线不交叉**：`baohu` 控制 dream 行为，`behavior-rule` 控制注入行为。一条记忆可以同时拥有两者。

### 评分权重 — dingBoost (scoring.ts:98-99)

```typescript
dingBoost: memo.tags?.includes('ding') ? 0.25 : 0
```

`dingBoost` 是 flat bonus，不参与加权计算，直接加到总分：

```typescript
return (
  factors.keywordOverlap * (kwWeight / total) +
  factors.recency * (recencyWeight / total) +
  factors.usageBoost * (usageWeight / total) +
  factors.projectBoost * (projectWeight / total) +
  factors.tagOverlap * (tagWeight / total) +
  factors.dingBoost  // ← flat +0.25，置顶记忆永远优先
);
```

0.25 约等于一个"中等关键词匹配"的分数，足够让置顶记忆排到普通记忆前面，但不会碾压完全不相关的记忆。

### 推荐用法

| 场景 | tags | 效果 |
|------|:----:|------|
| 最重要的几条规则 | `["behavior-rule","baohu","ding","chundu"]` | 保护+置顶+图标 |
| 参考用的规则 | `["behavior-rule","chundu"]` | 有图标，dream 可整理 |
| 不想被管的普通记忆 | `["baohu"]` | 只保护，不参与行为矫正 |

---

## 关键接口

| 接口 | 参数 | 返回 |
|------|------|------|
| `search(query, options?)` | query: string, options: { candidateLimit?, projectDir? } | `Promise<MemoryMemo[]>` |
| `list(options?)` | options: { search?, limit?, offset?, projectDir? } | `Promise<MemoryMemoListResult>` |
| `get(id)` | id: string | `Promise<MemoryMemo \| undefined>` |
| `append(entry)` | entry: MemoryMemo | `Promise<void>` |
| `update(id, partial)` | id: string, partial: Partial | `Promise<boolean>` |
| `delete(id)` | id: string | `Promise<void>` |

---

## Agent 侧访问路径

`agent.memoStore: MemoryMemoStore | undefined`（agent/index.ts:126）

⚠️ 主 agent 有 memoStore（有 screamHomeDir），sub agent 没有（undefined）。使用前必须 guard。

```typescript
if (!this.agent.memoStore) return;
await this.agent.memoStore.search("query");
```
