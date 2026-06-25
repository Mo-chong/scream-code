# 记忆系统全景 — MemoryMemoStore

> 源码: `packages/memory/src/store.ts` (~1485 行)
> 数据模型: `packages/memory/src/models.ts`
> 混合评分: `packages/memory/src/scoring.ts`
> Dream 整理: `packages/memory/src/consolidator.ts` + `packages/memory/src/dream.ts`
> Agent 端工具: `packages/agent-core/src/tools/builtin/memory/memory-lookup.ts`

---

## 一、一句话全景

```
全文搜索(FTS5) + 语义搜索(vec0) 双通道检索
热/冷两级存储 + ResNet 自动升降
Dream 归档整理 + 混合评分(60% 关键词 + 40% 语义 × 时间衰减)
```

---

## 二、物理存储层 — 5 张表

```
┌─────────────────────────────────────────────────────────────┐
│                    SQLite (memos.sqlite)                     │
│                                                             │
│  memos (主表)                                                │
│  ├─ memos_fts (FTS5 全文索引)                                │
│  ├─ memory_embeddings (嵌入缓存, ON DELETE CASCADE)          │
│  ├─ vec_memos (vec0 向量索引, @photostructure/sqlite-vec)    │
│  └─ memos_archive (冷层归档, 含 embedding_json 防 CASCADE)   │
│                                                             │
│  + 标记文件: .migrated / .migrated-to-sqlite / .migrated-vec0│
└─────────────────────────────────────────────────────────────┘
```

### 2.1 memos — 主表

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

所有记忆本体存这里。tags 存为 JSON 字符串，FTS5 不索引 tags。

### 2.2 memos_fts — FTS5 全文索引

```sql
CREATE VIRTUAL TABLE memos_fts USING fts5(
  user_need, approach, what_failed, what_worked, source_session_title,
  content=''
);
```

⚠️ **tags 不在 FTS5 索引中。** 不能 `search("tags:baohu")`，必须在调用方做 `.filter()`。

### 2.3 memory_embeddings — 嵌入缓存

```sql
CREATE TABLE memory_embeddings (
  memory_id TEXT PRIMARY KEY REFERENCES memos(id) ON DELETE CASCADE,
  embedding_json TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT 'bge-small-zh-v1.5',
  created_at INTEGER NOT NULL
);
```

由 EmbeddingEngine（fastembed BGESmallZH, 384 维）异步生成。`ON DELETE CASCADE` — 删除 memos 时自动清除 embedding。

⚠️ 排序按 `created_at DESC`，旧的 embedding 可能超出 `candidateLimit` 范围而不被搜索。

### 2.4 vec_memos — vec0 向量索引（@photostructure/sqlite-vec v1.1.1）

```sql
CREATE VIRTUAL TABLE vec_memos USING vec0(
  memo_embedding float[384],
  project_dir TEXT partition key,
  extraction_source TEXT,
  recorded_at INTEGER,
  +memo_id TEXT,
  +score_tier TEXT,
  +user_need TEXT,
  +approach TEXT,
  +outcome TEXT
);
```

**vec0 特殊规则：**
- `+` 前缀：**仅 DDL 和 SELECT WHERE 合法**。INSERT/DELETE 必须去掉 `+`
- 不支持 `ON CONFLICT` / `UPSERT`：必须先 `DELETE` 再 `INSERT`
- `Float32Array` 传参：`new Uint8Array(embedding.buffer)` → vec_f32() 内部转换
- node:sqlite `number` 绑定为 FLOAT，vec0 INTEGER 列需 `BigInt()` 显式整数绑定
- `score_tier` 标记热/冷：`'HOT'` 或 `'ARCHIVED'`

### 2.5 memos_archive — 冷层归档

```sql
CREATE TABLE memos_archive (
  id TEXT PRIMARY KEY,
  -- 同 memos 的所有字段 --
  archived_at INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER NOT NULL DEFAULT 0,
  embedding_json TEXT        -- ↑ 比 memos 多这 4 列
);
```

demote 后的记忆移到这里。`embedding_json` 保存 embedding 防止 ON DELETE CASCADE 擦除，冷层 vec0 搜索仍可找到。

### 2.6 标记文件（防重复迁移）

```
.migrated              → JSONL → SQLite 迁移完成
.migrated-to-sqlite    → 旧 SQLite 迁移完成
.migrated-vec0         → memory_embeddings → vec_memos 迁移完成
```

启动时 `migrateVec0()` 检查 `.migrated-vec0` 标记文件，已有则跳过，避免重复。

---

## 三、热冷升降系统（Tiered Hot/Cold）

记忆不在一个池子里，分两层，自动升降：

```
评分标准:
  HOT（热层）  = memos 主表 → 每次搜索都参与
  ARCHIVED（冷层）= memos_archive → 热层结果不够时才搜索

               promote()
  ┌──────────────────────────────────────┐
  │                                       │
  ▼                                       │
 ┌──────────┐     demote()          ┌──────────────┐
 │   HOT    │ ────────────────────→ │  ARCHIVED    │
 │ memos    │                       │ memos_archive│
 │ vec0(HOT)│                       │ vec0(ARCHIVED)│
 └──────────┘                       └──────────────┘
      ▲                                       │
      └───────────────────────────────────────┘
                   promote()
```

### 3.1 关键常量

```typescript
const HOT_MAX_SIZE = 100;            // 热层最大容量
const DEMOTE_RESNET_THRESHOLD = 0.3; // ResNet < 0.3 触发降级
const DEMOTE_DAYS_NO_HIT = 30;       // 30 天无命中触发降级
const PROMOTE_HIT_COUNT = 2;         // 命中 2 次触发升温
const PROMOTE_RESERVE_SPACE = 10;    // 保留空位
const DEMOTE_BATCH_SIZE = 5;         // 每批次最多降级 5 条
```

### 3.2 promote() — 冷→热

```typescript
async promote(id): Promise<boolean>
```

1. 从 `memos_archive` 找到归档记录
2. `appendInternal()` 写回 `memos` 主表（自动更新 FTS5）
3. `deleteFromArchive()` 删除归档
4. 如果 archive 有 `embeddingJson`，恢复 `memory_embeddings`（INSERT OR REPLACE）
5. `updateVec0Tier(id, 'HOT')` 更新 vec0 层级

### 3.3 demote() — 热→冷

```typescript
async demote(id): Promise<boolean>
```

1. 从 `memos` 读取完整记录
2. **baohu/chundu/yongjiu 免疫**：带 baohu 或 chundu 或 yongjiu 标签的直接 return false
3. 提前读 `memory_embeddings.embedding_json` 保存
4. `appendToArchive()` 写入 archive（含 embeddingJson）
5. `deleteInternal(id)` 删除主表 → CASCADE 清 memory_embeddings → `deleteVec0(id)`
6. 用保存的 embedding 重新 `upsertVec0(id, vec, memo, 'ARCHIVED')` — 冷层仍可搜索

### 3.4 autoDemoteIfNeeded() — 自动降温

在 `flushEmbeddings()` 中每 **5 分钟** 节流触发一次：

```typescript
async autoDemoteIfNeeded(): Promise<number>
```

扫描所有热层 memos，逐条判断：

| 条件 | 动作 |
|------|------|
| ResNet < 0.3 | demote |
| 距 recording > 30 天 | demote |
| baohu/chundu 标签 | 跳过（免疫） |
| 热层 > 100 条 | 从最旧开始 evict |

每批次最多 demote **5 条**，避免大量降级。

### 3.5 autoPromoteHits() — 搜索命中自动升温

在 `memory-lookup.ts` 搜索冷层命中后调用：

```typescript
async autoPromoteHits(memoIds: string[]): Promise<number>
```

1. 对每个命中 ID，`updateArchiveHitCount()` 增加计数
2. 如果 `hitCount ≥ 2` 或热层有空位（< 100 条），`promote(id)`

---

## 四、搜索流程（三层递进）

MemoryLookup 工具完整调用链路：

```
用户提问
    │
    ▼
① FTS5 关键词初筛
   store.search(query, { projectDir })
   → 从 memos 主表返回候选列表
    │
    ▼
② vec0 语义搜索
   a) 查询 embedding:
      engine.embedBatch([query]) → Float32Array(384)
      getCachedQueryEmbedding() — 同 query 缓存复用
   b) 热层搜索（优先）:
      store.searchByVectorVec0(queryVec, { scoreTier: 'HOT', k: candidateLimit })
   c) 如果热层结果 < 3 条，再搜冷层:
      store.searchByVectorVec0(queryVec, { scoreTier: 'ARCHIVED', k: 10 })
    │
    ▼
③ 混合评分 rankMemos()
   60% 关键词分数 + 40% 向量分数
   再 × ResNet 衰减因子（D^天数）
   + dingBoost flat +0.25
   过滤低于 minScore(0.3) 的，取 top N
    │
    ▼
④ 冷层命中 → 自动升温
   如果 archive 命中的进入了 top N 结果:
   store.autoPromoteHits(promotedIds)  ← 异步，不阻塞返回
    │
    ▼
⑤ 返回结果给用户
```

### 4.1 vec0 搜索函数

```typescript
searchByVectorVec0(
  queryEmbedding: Float32Array,
  options?: {
    k?: number;              // 返回数 (默认 20)
    projectDir?: string;     // 项目过滤
    scoreTier?: 'HOT' | 'ARCHIVED';  // 层级过滤
    distanceCutoff?: number; // 距离上限 (默认 2.0)
  },
): Array<{ memo_id: string; similarity: number }>
```

距离 → 相似度转换：`similarity = 1 / (1 + distance)`

### 4.2 三种搜索方式对比

| 方式 | 函数 | 覆盖范围 | 包括 tags？ | 速度 |
|------|------|---------|:----------:|:----:|
| **FTS5 全文** | `search(query)` | HOT 主表 | ❌ | 快 |
| **vec0 向量** | `searchByVectorVec0()` | HOT + ARCHIVED | ❌ | 极快（ANN） |
| **list fallback** | `list({ search })` | 全部（含子串匹配） | ✅（fallback 路径） | 慢 |
| **legacy JS 向量** | `searchByVector()` | 仅 HOT（旧路径） | ❌ | 中等 |

`memory-lookup.ts` 中：有 vec0 用 vec0，没有则回退 legacy `searchByVector()`。

---

## 五、混合评分系统（scoring.ts）

### 5.1 评分公式

```typescript
总分 = (keywordScore × 0.6 + vectorScore × 0.4) × ResNetFactor + dingBoost
         ↑ 意图自适应        ↑ 余弦距离转化     ↑ 时间衰减     ↑ flat +0.25
```

### 5.2 6 个评分因子

| 因子 | 默认权重 | 说明 |
|------|:-------:|------|
| keywordOverlap | 45% | 关键词覆盖度。事实类查询（fi=1.0）自动升权到 0.54 |
| recency | 25% | 时间衰减。时间类查询（ti=1.0）自动升权到 0.35 |
| usageBoost | 15% | 使用频率。**当前恒为 0** — 搜索命中计数未实现 |
| projectBoost | 10% | 同项目记忆 flat +0.2 |
| tagOverlap | 5% | 同项目标签重叠 |
| **dingBoost** | **flat +0.25** | 置顶标签，不参与加权 |

### 5.3 意图检测

纯正则，零 LLM 开销：

```typescript
detectQueryIntent(query):
  temporalBias: 0.3~1.0  // "昨天" "上周" "最近" → 1.0
  factualBias:  0.6~1.0  // "function" "const" "React" → 1.0
```

- 时间类查询 → recency 权重提升
- 事实类查询 → keyword 权重提升

### 5.4 ResNet 衰减因子

```typescript
const D = tags.has('baohu')   ? 0.99   // 几乎不衰减（保护）
       : tags.has('ding')     ? 0.95   // 慢速衰减（置顶）
       : tags.has('chundu')   ? 1      // 永不衰减（规则记忆）
       : tags.has('yongjiu')  ? 1      // 永不衰减（永久记忆）
       : 0.85;                          // 默认快速衰减（普通经验）

const resNetFactor = Math.pow(D, daysSince);  // 1.0 → 逐渐趋近 0
```

**衰减示例（默认 D=0.85）：**
| 天数 | ResNet |
|:----:|:------:|
| 0 | 1.000 |
| 7 | 0.320 |
| 14 | 0.102 |
| 21 | 0.033 |
| 30 | 0.007 → **低于 0.3 阈值，触发 demote** |

### 5.5 同分决胜

```typescript
.toSorted((a, b) => b.score - a.score)  // 分数相同按稳定性排序
```

---

## 六、标签体系（拼音标签）

> 全部为拼音，不影响搜索和 AI 使用。

### 6.1 功能标签

| 标签 | 图标 | 含义 | 系统效果 | 所属模块 |
|:----:|:----:|------|----------|----------|
| `chundu` | 🧠 | 规则记忆 | 注入过滤 + demote/Dream 免疫 + ResNet D=1 | memory-rules.ts + store.ts + consolidator.ts |
| `baohu` | 🔒 | 保护 | Dream 完全免疫 + demote 跳过 | consolidator.ts + store.ts |
| `ding` | 📌 | 置顶 | 搜索评分 +0.25 flat bonus | scoring.ts |
| `yongjiu` | ♾️ | 永久记忆 | ResNet D=1 永不衰减 + demote/Dream 免疫 | store.ts + consolidator.ts |

### 6.2 标签隔离

```
chundu                  → 规则记忆标签（注入过滤 + demote/Dream 免疫 + 永不衰减）
baohu                   → 保护标签（Dream 免疫 + demote 跳过，衰减 D=0.99）
ding                    → 置顶标签（搜索 +0.25，衰减 D=0.95）
yongjiu                 → 永久记忆标签（永不衰减 D=1 + demote/Dream 免疫）
其他中文标签            → 普通分类标签（AI 自动存储时生成）
```

### 6.3 推荐用法

| 场景 | tags | 效果 |
|------|:----:|------|
| 最重要的几条规则 | `["chundu", "baohu", "ding"]` | 注入+保护+置顶+图标 |
| 参考用的规则 | `["chundu"]` | 有图标，可注入 |
| 不想被管的普通记忆 | `["baohu"]` | 只保护，不参与行为矫正 |
| 永久保留的记忆 | `["yongjiu"]` | 永不衰减 + 免疫 demote/Dream + 图标 |

---

## 七、Dream 整理系统

详见 `SYSTEM/dream.md`。这里只说与记忆系统交互的部分：

### 7.1 resolved/stale → demote

之前直接 `delete()`，现在走 `store.demote(id)`：

```typescript
// consolidator.ts
for (const memo of resolved) {
  await store.demote(memo.id);  // 降级到冷层，保留 vec0 可搜索
}
```

这样已解决/过期的记忆不会消失——用户搜冷门话题时仍可能命中。

### 7.2 Dream 4 种操作

| 操作 | 条件 | 动作 |
|------|------|------|
| 合并重复 | 关键词相似度 ≥ 0.45 | 合并 → 删原始 |
| 标记相关 | 共享关键词锚点 | 只显示，不操作 |
| 已解决删除 | outcome=完成 + >7天 | demote |
| 过期删除 | >30天 + 未完成 + 非blocked | demote |

baohu/chundu/yongjiu 标签对以上全部免疫。

---

## 八、完整数据流

### 8.1 写入路径

```
用户对话结束
  → MemoryWriteTool (agent-core)
    → store.append(entry)
      → 写 memos 主表 + memos_fts FTS5
    → store.scheduleEmbedding(memo)
      → 2 秒 debounce
        → flushEmbeddings()
          → tryEmbedBatch() 生成 embedding（一次重试）
          → INSERT memory_embeddings（事务内）
          → upsertVec0() 写 vec_memos（事务外，不污染 embedding INSERT）
          → 每 5 分钟节流触发 autoDemoteIfNeeded()
```

### 8.2 搜索路径

```
用户提问
  → MemoryLookupTool
    → FTS5 关键词初筛
    → vec0 语义搜索（HOT 优先 → ARCHIVED 回退）
    → rankMemos() 混合评分（60% + 40% × ResNet + dingBoost）
    → 冷层命中者 autoPromoteHits() ← 自动升温
    → 返回 top N
```

### 8.3 整理路径

```
/dream 命令
  → buildConsolidationPlan() → 展示计划
  → 用户确认
  → applyConsolidation()
    → resolved/stale → store.demote() ← 降级到冷层
    → duplicate → merge → 删原始
```

---

## 九、关键接口

| 接口 | 参数 | 返回 |
|------|------|------|
| `search(query, options?)` | query: string, options: { candidateLimit?, projectDir? } | `Promise<MemoryMemo[]>` |
| `list(options?)` | options: { search?, limit?, offset?, projectDir? } | `Promise<MemoryMemoListResult>` |
| `get(id)` | id: string | `Promise<MemoryMemo \| undefined>` |
| `append(entry)` | entry: MemoryMemo | `Promise<void>` |
| `update(id, partial)` | id: string, partial: Partial | `Promise<boolean>` |
| `delete(id)` | id: string | `Promise<void>` |
| `promote(id)` | id: string | `Promise<boolean>` |
| `demote(id)` | id: string | `Promise<boolean>` |
| `autoDemoteIfNeeded()` | — | `Promise<number>` (已降级数) |
| `autoPromoteHits(ids)` | ids: string[] | `Promise<number>` (已升温数) |
| `searchByVectorVec0(queryVec, options?)` | Float32Array + options | `Array<{memo_id, similarity}>` |
| `hasVec0()` | — | `boolean` |

---

## 十、MemoryEdit 工具

`MemoryEditTool` 注册在 `tool/index.ts:634`，但**默认不在 agent.yaml 的工具列表中**。

| 状态 | 说明 |
|------|------|
| 注册条件 | `this.agent.type === 'main' && this.agent.memoStore` |
| 工具列表入口 | `agent.yaml` → `setActiveTools()` → `enabledTools` |
| 修复方法 | `agent.yaml` 加一行 `- MemoryEdit`，然后 `pnpm build` 重新打包 |
| 生效条件 | **必须重新构建 + 重启** |

### 构建链

```
agent.yaml 修改
  → 编译 agent-core（pnpm build）：将 agent.yaml 打包进 dist/index.mjs
  → 编译 scream-code（pnpm build）：将 agent-core dist 打包进 dist/main.mjs
  → 重启 scream：bin/scream.cmd → dist/main.mjs
```

`scream-code/tsdown.config.ts` 中 `deps.alwaysBundle: [/^@scream-./]` 保证所有 `@scream-*` 包都打进一个 bundle。

### 直接数据库操作

当 MemoryEdit 不可用时：

```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('~/.scream-code/memory/memos.sqlite');
db.prepare('UPDATE memos SET tags = ? WHERE id = ?').run(newTags, id);
db.close();
"
```

数据库位置：`~/.scream-code/memory/memos.sqlite`（Windows: `C:/Users/<用户名>/.scream-code/memory/memos.sqlite`）

---

## 十一、Agent 侧访问路径

```typescript
agent.memoStore: MemoryMemoStore | undefined
```

⚠️ 主 agent 有 memoStore（有 screamHomeDir），sub agent 没有（undefined）。使用前必须 guard：

```typescript
if (!this.agent.memoStore) return;
await this.agent.memoStore.search("query");
```

---

## 十二、关键限制（来自代码审计）

| # | 限制 | 证据位置 | 影响 |
|:-:|------|----------|------|
| 1 | FTS5 不索引 tags 列 | store.ts:339 vs 344-351 | 不能 `search("tags:xxx")`，必须二次过滤 |
| 2 | vec0 不支持 UPSERT/ON CONFLICT | store.ts:793-840 | 必须 DELETE 再 INSERT |
| 3 | vec0 `+` 前缀仅 DDL/SELECT 合法 | store.ts:380-391 + 845-892 | INSERT/DELETE 必须去掉 `+` |
| 4 | Float32Array 需 Uint8Array(buffer) 传参 | store.ts:795-796 | vec_f32() 内部转换 |
| 5 | node:sqlite number→FLOAT，INTEGER 需 BigInt() | store.ts:812 | 传 number 会导致 vec0 类型错误 |
| 6 | memoStore 在 sub agent 为 undefined | agent/index.ts:126 | 使用前必须 guard |
| 7 | usageBoost 恒为 0 | scoring.ts:98 | 搜索命中计数尚未实现 |
| 8 | memory_embeddings 按 created_at DESC 排序 | store.ts:378 | 旧 embedding 超出 candidateLimit 后不可见 |
| 9 | `updateVec0Tier()` 无法在 demote 中使用 | store.ts:828-840 | demote 后 memo 已从 memos 删除，SELECT 返回 undefined，改用 upsertVec0 |
| 10 | `demote()` 后 embedding 必须提前保存 | store.ts:1014-1036 | CASCADE 会擦除，必须在 deleteInternal 前读 memory_embeddings |

---

## 十三、验证覆盖

**全量回归：94 测试全通过，0 失败。**

| 测试文件 | 数量 | 覆盖内容 |
|----------|:----:|----------|
| `test/tier-vec0.test.ts` | 24 | vec0 CRUD / promote / demote（含 baohu 免疫）/ autoDemote（ResNet/容量/零返回）/ autoPromote（阈值/满/空）/ 搜索过滤（scoreTier/distanceCutoff/projectDir）/ 级联删除 / round-trip / memory-lookup 风格冷热 fallback / consolidator 集成 |
| `test/vec0-repro.test.ts` | 2 | Gap1: migrateVec0 启动迁移 / Gap2: autoDemoteIfNeeded 运行时触发 |
| `test/store.test.ts` | ~30 | 基础 CRUD / FTS5 搜索 / list / 标签处理 / 迁移 |
| `test/scoring.test.ts` | ~10 | 评分因子 / dingBoost / ResNet / 意图检测 |
| `test/consolidator.test.ts` | ~10 | 重复合并 / 过期判断 / baohu 免疫 |
| `test/memos-fts.test.ts` | ~5 | FTS5 索引完整性 |
| `test/tools/memory-lookup.test.ts` | 13 | 端到端 vec0 搜索 / 冷热 fallback / autoPromote / ResNet 衰减 |
