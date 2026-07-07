<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
# Knowledge 知识库系统 [P2]

> 外部文档知识库 — 用户喂文档 → 自动切块/向量化/AI 对话时搜到并引用。与记忆系统（对话经验）互补。
> 源码：`packages/knowledge/` | 上层工具：`packages/agent-core/src/tools/builtin/knowledge/knowledge-lookup.ts`

---

## §1 解决什么问题 [P2]

AI 对话时靠记忆系统只能回忆"之前聊过什么"，无法引用**你事先喂给它的文档**（说明书、技术手册、研究报告等）。

**Knowledge 知识库 = 外接大脑记忆体**：你把文档导入 → 系统切成小块 → 转成向量索引 → AI 在对话中自动检索并引用相关内容。

---

## §2 整体架构 [P2]

```
用户喂文件 (MD/TXT)
       │
       ▼
┌─────────────────┐
│  Ingestion 管线  │  吃文档 → 切块 → 向量化 → 入库
└────────┬────────┘
         │
         ▼
┌─────────────────┐       ┌──────────────────────┐
│  SQLite 存储     │──────▶│  实体/事件抽取        │
│                  │       │  (Extractor)          │
│  6 张核心表      │       │  识别: 人名/地名/概念  │
│  + 向量索引      │       │  事件及其关联关系       │
│  + FTS5 全文索引  │       └──────────────────────┘
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  检索引擎 Search │  语义搜索 + 关键词搜索 + 混合
└────────┬────────┘
         │
         ▼
┌──────────────────────────────┐
│  KnowledgeLookup MCP 工具     │  AI 对话中自动调用
│  (agent-core 内置工具)        │
└──────────────────────────────┘
```

---

## §3 文档"吃"进来 — Ingestion 管线 [P2]

### 3.1 流程

```
文件路径 → readFileSync → 按格式切块(chunking) → 清洗Markdown → 向量化 → 三级入库
```

- **读取**：`ingest.ts` — 从磁盘读文件，支持 `.md` 和 `.txt`
- **切块**：`chunking.ts` — MD 按标题层级切，TXT 按空行切
- **清洗**：`chunking.ts` — 剥离代码块/链接/图片/加粗标记，只留纯文字
- **大小限制**：每块 ≤ 480 tokens（嵌入模型上限 512 tokens，留余量）
- **向量化**：`ingest.ts` → 调 `memory/embeddings.ts` 引擎转向量
- **入库**：`store.ts` → 三级结构：source → document → chunk

### 3.2 三级存储结构

| 层级 | 表 | 存什么 | 类比 |
|------|------|--------|------|
| Level 1 | `knowledge_sources` | 你喂的原始文件/来源 | 一本书封面 |
| Level 2 | `knowledge_documents` | 来源包含的文档单元 | 书里的章节 |
| Level 3 | `knowledge_chunks` | 切成的小碎片 + 向量 | 每一段文字 + 语义标签 |

---

## §4 存储 — Store [P2]

### 4.1 物理位置

SQLite 数据库文件，路径由配置决定。默认在 scream-code 数据目录的 `knowledge/` 子目录。

### 4.2 核心表

| 表名 | 字段摘要 | 用途 |
|------|---------|------|
| `knowledge_sources` | id, name, path, type, status, created_at | 文件来源记录 |
| `knowledge_documents` | id, source_id, title, path, page, metadata | 文档单元 |
| `knowledge_chunks` | id, document_id, content, embedding_vec, metadata | 碎片 + 向量 |
| `knowledge_entities` | id, name, type, canonical_name, metadata | 抽取的实体（人名/地名/概念） |
| `knowledge_events` | id, description, date, location, metadata | 抽取的事件 |
| `knowledge_event_entities` | event_id, entity_id, role | 实体和事件的关联关系 |

### 4.3 向量索引 (vec0)

- `knowledge_chunks.embedding_vec` — float32 向量列（sqlite-vec0 虚拟表）
- 用于语义搜索：向量距离越小 → 语义越相似

### 4.4 全文索引 (FTS5)

- `knowledge_sources_fts` — 来源名称/路径全文索引
- `knowledge_documents_fts` — 文档标题全文索引
- `knowledge_chunks_fts` — 碎片内容全文索引
- 用于关键词精确匹配搜索

---

## §5 抽实体和事件 — Extractor [P2]

### 5.1 功能

从碎片的纯文字中自动识别结构化信息：

| 提取类型 | 识别什么 | 例 |
|---------|---------|----|
| 实体 (Entity) | 人名/地名/组织/产品/概念等 11 种类型 | person / org / location / concept / product / event / technology / tool / framework / language / other |
| 事件 (Event) | 谁在什么时候做了什么 | "MemoryWrite 保存对话经验到记忆库" |
| 归一化 (Normalize) | 同一实体的不同写法合并 + 存储时 UNIQUE(source_id,type,normalized_name) 去重 | "Apple"、"苹果"、"苹果公司" → 同一实体 |
| 关联 (Relation) | 实体和事件之间的多对多关系，INSERT OR IGNORE 去重 | 实体A → 角色"subject" → 事件X |

### 5.2 抽取粒度

每个 chunk → 1 个 event + 2-6 个 entities。LLM 调用一次完成抽取。

### 5.2 存储

实体和事件通过 `knowledge_event_entities` 关联表建立**多对多**关系：
- 一个事件可以关联多个实体
- 一个实体可以参与多个事件

---

## §6 检索 — Search [P2]

检索管线是 **7 步多跳知识图谱检索**（`search.ts: multiSearchWithTrace`），不是简单向量搜索。

### 6.1 完整管线

```
query → 向量化(embedding)
  │
  ├─ Step 1: FTS5 关键词搜索 → 命中文档+chunks
  │   (精确匹配，O(log n))
  │
  ├─ Step 2: 向量语义搜索 → vec0 L2 距离排序
  │   (语义相似度匹配)
  │
  ├─ Step 3: LLM 从 query 中抽取实体
  │   → 匹配库中 entities 表
  │   (从自然语言提取结构化查询)
  │
  ├─ Step 4: 命中实体 → 查 knowledge_event_entities
  │   → 找到关联的 seed events
  │
  ├─ Step 5: BFS 1 跳沿实体关系扩展
  │   → seed events 关联的其他 entities → 更多 events
  │   (知识图谱多跳联想)
  │
  ├─ Step 6: 粗排合并所有结果
  │
  ├─ Step 7: LLM rerank 精排
  │   (用 LLM 重新评估相关性)
  │
  └─ 兜底: 结果不够时补纯向量搜索结果
```

### 6.2 管线特征

| 特征 | 说明 |
|------|------|
| **多跳联想** | BFS 1 跳沿实体关系扩展，搜 A 时可能带出 B 和 C |
| **LLM 参与** | 每次查询最多调 2 次 LLM（实体抽取 + 可选 rerank） |
| **检索链路追踪** | 每步耗时记录在 `KnowledgeSearchTrace` 中随结果返回 |
| **兜底机制** | 多跳结果不足时，补全纯向量搜索结果保底 |

### 6.3 返回结果

| 字段 | 说明 |
|------|------|
| chunks | 匹配的内容片段 + 关联的 source/doc 路径 |
| score | 相关性评分 |
| event entity | 关联的事件/实体链条 |
| trace | 检索链路追踪（每步耗时，方便下一轮修正查询） |

---

## §7 AI 怎么用 — KnowledgeLookup MCP 工具 [P2]

### 7.1 工具入口

`packages/agent-core/src/tools/builtin/knowledge/knowledge-lookup.ts`

### 7.2 工具注册条件

与 Memory 工具对等：`this.agent.type === 'main' && this.agent.knowledgeStore`

知识库初始化后工具自动可见，不要求库中有数据。

### 7.3 system.md 描述（行207）

```
KnowledgeLookup: SYSTEM docs + project source docs. query. top_k(max 20). 
Returns ranked chunks + source doc + heading + event entities + search trace.
```

### 7.4 触发场景

| 场景 | AI 能做什么 | 不用会怎样 |
|------|------------|-----------|
| 查系统说明书文档 | 引用结构/规则说明 | 凭记忆编 |
| 查项目源码文档 | 理解代码结构 | 靠推测 |
| 遇到问题症状 | 搜已记录的踩坑经验找根因 | 反复试错 |

---

## §8 当前功能状态 [P2]

| 功能 | 状态 | 说明 |
|------|------|------|
| Ingestion 管线 | ✅ 就绪 | 读文件/切块/清洗/向量化/入库 |
| Store 存储 | ✅ 就绪 | SQLite 6 表 + FTS5 + vec0 |
| Search 检索 | ✅ 就绪 | 语义/关键词/混合三种 |
| Extractor 抽取 | ✅ 就绪 | 实体+事件+归一化+关联 |
| KnowledgeLookup 工具 | ✅ 就绪 | AI 对话中使用，SYSTEM docs + project source docs |
| 增量更新文档 | ⏳ 未支持 | 更新=先 deleteSource 再重新 ingest（全量重跑，无增量） |
| 去重机制 | ✅ 部分去重 | 实体层 UNIQUE 去重，event-entity 边 INSERT OR IGNORE 去重。文件层重复摄入报错 |
| **CLI 命令** | ⏳ 未暴露 | 暂无 `/knowledge ingest` 命令 |

---

## §9 与记忆系统的区别 [P2]

| 对比维度 | Knowledge 知识库 | Memory 记忆系统 |
|---------|----------------|----------------|
| **数据来源** | 你主动喂的文档 | AI 自动记录的对话经验 |
| **填入方式** | `ingestDocument()` 编程调用 | 每回合自动写入 |
| **查询方式** | KnowledgeLookup 工具 | MemoryLookup 工具 |
| **数据结构** | source→document→chunk 三级 + 实体/事件 | 扁平 memo + 向量 |
| **检索** | 语义/关键词/混合 | 60% keyword + 40% vector + ResNet 热冷 |
| **持久化** | SQLite 独立库 | SQLite FTS5 + vec0 联合 |
| **典型用途** | "查一下这个文档里怎么说" | "记得上次怎么做的吗" |

---

## §10 源码文件索引 [P2]

```
packages/knowledge/src/
  index.ts          — 包入口, 导出所有公开 API
  types.ts          — 核心类型定义 (KnowledgeDocument, Chunk, Entity, Event 等)
  store.ts          — SQLite 存储 (建表/CRUD/FTS5/vec0 向量)
  ingest.ts         — 导入管线 (读文件 → 切块 → 向量化 → 入库)
  chunking.ts       — 文档切块 + Markdown 清洗
  extractor.ts      — 实体/事件抽取 + 归一化 + 关联
  search.ts         — 语义搜索/关键词搜索/混合搜索

packages/agent-core/src/tools/builtin/knowledge/
  knowledge-lookup.ts — KnowledgeLookup MCP 工具 (AI 对话中调用)
```
