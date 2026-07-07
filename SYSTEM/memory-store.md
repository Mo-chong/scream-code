# 记忆系统 — Memory Store

> SQLite + FTS5 + vec0 向量三重检索 + 热冷升降(ResNet 衰减)。tags 存 JSON 不在 FTS5 索引中。踩坑/调试/版本历史在 `SYSTEM/pitfalls.md`。

---

## 一、物理存储层

### 表结构（store.ts）
| 表 | 作用 | 关键字段 |
|----|------|---------|
| `memos` | 主数据 | id TEXT PK, userNeed TEXT, approach TEXT, outcome TEXT, whatFailed TEXT, whatWorked TEXT, projectDir TEXT, sourceSessionId TEXT, sourceSessionTitle TEXT, tags TEXT(JSON), tier TEXT, recalledAt TEXT, recallCount INT, createdAt TEXT, updatedAt TEXT, summarizedBy TEXT |
| `fts_memos` | 全文索引(memos 子集) | user_need, approach, what_failed, what_worked, source_session_title |
| `memo_tags` | 标签维表 | memoId → tag |
| `recall_logs` | 召回日志 | memoId + timestamp |
| `ownership` | 所有权 | memoId ↔ 标签 |

- tags 存储在 memos.tags(TEXT JSON) 的字符串列中，不在 FTS5 索引里
- `recalledAt` 是 ISO 字符串，存最新召回时间
- `recallCount` 是整数计数器，每次 `recordRecall()` +1

### FTS5 索引范围（store.ts:344-351）
```sql
CREATE VIRTUAL TABLE fts_memos USING fts5(
    user_need, approach, what_failed, what_worked, source_session_title,
    tokenize='unicode61 remove_diacritics 2'
);
```
- 不索引：`tags`, `projectDir`, `tier`, `recalledAt`, `recallCount`
- 不索引原因：tags 存 JSON 结构、tier/recalledAt/recallCount 是数值型或过滤条件，不适合全文搜索

### vec0 向量集成
- `vec0_memos(embedding float[384])` — 向量索引表
- 操作限制：INSERT 不支持 ON CONFLICT/UPSERT，必须 DELETE 再 INSERT（store.ts:793-840）
- `+` 前缀仅 DDL/SELECT 合法，INSERT/DELETE 必须去掉（store.ts:380-391, 845-892）
- Float32Array→Uint8Array(buffer) 传 vec0，vec_f32() 内部转换（store.ts:795-796）

### 内存查询（memoStore）
- 内存中全量缓存在 `memoStore` 对象（Map），所有读写先走缓存再同步 DB
- 缓存是写操作的主数据路径，DB 是持久化副本

---

## 二、热冷升降

### 热层容量
- `HOT_TIER_CAP` = 50（常数）
- `COLD_TIER_CAP` = 500（常数）

### 常温常量
| 常量 | 默认值 | 文件 |
|------|--------|------|
| `roomTemperature` | 28（天） | store.ts:273 |
| `highTemperature` | 34（天） | store.ts:274 |
| `HOT_TIER_CAP` | 50 | store.ts:278 |

### 保护标签
| 标签 | 保护规则 |
|------|---------|
| baohu | Dream 免疫，不可 merge/delete/stale |
| ding | 免疫热层裁剪，不受 `enforceHotTierCap`/`demote`/`autoDemoteIfNeeded` 影响 |
| chundu | 完整保护，不可淘汰/修改 |
| yongjiu | ✅ demote 免疫、ResNet D=1（不衰减）、PROTECTED_TAGS 配置、♾️图标 |

- 保护名单散落在 6 处：`demote()`, `autoDemoteIfNeeded()`×2, `enforceHotTierCap()`×2, `listAll()`（必须一处定义数组常量）

### 升温/降温流程
```
writeMemory → promote(upsert) → calculateRecallCount → recordRecall
                                         ↓
                                  enforceHotTierCap / demote / autoDemoteIfNeeded
```
- `promote()`: upsert 记忆到热层，联动召回计数
- `enforceHotTierCap()`: 热层超过 HOT_TIER_CAP（50）时，按排序溢出到冷层
- `demote()`: 将指定记忆从热层移到冷层
- `autoDemoteIfNeeded()`: 每 50 次写入触发一次冷层容量检查（COLD_TIER_CAP=500），超限后淘汰 LRU 中的冷层记忆

---

## 三、搜索流程

### 三层递进（search.ts）
```
第一层(embedding): vec0 向量搜索 → top-k(30) ID 队列
第二层(keyword): FTS5 全文搜索 → top-k(50)
第三层(mixed): ID 交集/并集 → 混合评分(60% keyword + 40% vector)
```

### 搜索参数
| 参数 | 默认值 | 说明 |
|------|--------|------|
| `defaultResultCount` | 5 | 默认返回条数 |
| `maxResultCount` | 50 | 最大返回条数 |
| `keywordWeight` | 0.6 | FTS5 评分权重 |
| `vectorWeight` | 0.4 | vec0 评分权重 |
| `dingBoost` | 0.3 | ding 标签命中后 boost（加 0.3）|
| `heatFactor` | 0.1 | 热度新近度因子 |
| `defaultBlend` | `relevance×0.7 + heatScore×0.3` | search() 默认混合模式 |

### 对比搜索方式
| 方式 | 速度 | 适合场景 |
|------|------|---------|
| FTS5 全文 | 快 | 精确关键词匹配 |
| vec0 向量 | 中 | 语义近似匹配 |
| 混合(默认) | 中 | 综合召回，默认 |
| `scope:'all'` | 同 search() | 显式跨项目（默认已支持跨项目） |

---

## 四、评分公式

### 混合评分
```
score = (keywordScore × 0.6 + vectorScore × 0.4) × ResNet 衰减因子
  + (hasDing ? dingBoost : 0) 
  + (relevanceMode ? 0 : heatFactor × heatScore)
```

### ResNet 衰减因子（store.ts:1281-1287 + scoring.ts:162-163）
```
decayFactor = W × D^Δd
```
- W（weight）：初始权重 = 1.0
- D（decay rate）：面：0.85 / 线：0.9 / 点：0.95（记忆层面统一下降到 0.9）
- Δd = (今天 - recalledAt) 的天数差
- 衰减是天级的，不是步级的
- **yongjiu 标签：D=1**（不衰减）

### 意图检测
- AI 用自然语言关键词搜索，FTS5 搜索 `user_need`/`approach` 等字段
- 标签本身不参与搜索
- 标签是系统侧的分类标记，不是搜索词

---

## 五、标签体系

### 当前标签列表
| 标签 | 用途 | 来源 |
|------|------|------|
| `baohu` | 保护/固定 | MemoryEdit 手工添加 |
| `ding` | 置顶/热点 | MemoryEdit 手工添加 |
| `yongjiu` | 持久/不衰减 | MemoryEdit 自动 |
| `chundu` | 纯净/无污染 | 系统自动 |
| 日期标签 | 记忆生成日 | 系统自动（`2026-06-28`）|
| 描述标签 | 总结关键词 | AI 自动生成/用户手动 |

### baohu（保护）
- Dream 跳过：`consolidator.ts` 的 `PROTECTED_TAGS = ['baohu']`
- 意义：保护不被 Dream 误删或合并
- 副作用：保护了也不被工具编辑，需直连 SQLite 操作

### ding（置顶）
- 免疫热层裁剪：`enforceHotTierCap()`/`demote()`/`autoDemoteIfNeeded()` 跳过
- search() 中加 dingBoost(0.3)
- 6 处保护名单需同步

### yongjiu（持久）
- demote 免疫
- ResNet D=1（不衰减）
- 在 PROTECTED_TAGS 配置中
- ♾️图标

### chundu（纯净）
- 完整保护，不可淘汰/修改
- 用于系统级保留记录

### 系统自动标签
- 日期标签：记忆生成日的 ISO 日期格式
- 描述标签：AI 通过 processTags 自动生成总结性描述标签

---

## 六、标签处理流程

### processTags（统一入口）
```
用户输入 tags → 黑名单过滤 → 中文同义合并(Map) → 同义词标准化 → 
优先级保留(unionWithPriority) → 去重 → budget 裁剪 → 写数据库
```

### smartTags
- AI 自动标签生成（MemoryWrite 时 call LLM 提取标签）
- 后接 processTags 过滤

### unionWithPriority
- 多个来源 tags 合并时的优先级策略
- 保留标签 = 取并集，重复时保留优先级高的
- MemoryEdit 不走 processTags 过滤（直接写入）

---

## 七、Dream 交互

### 清理时机
| 触发方式 | 调用链 |
|---------|--------|
| 用户 `/dream` 命令 | `cli → memory.ts → consolidateAndArchive()` |
| 定时（环境变量） | `SCREAM_DREAM_INTERVAL_MS`（默认不启用） |
| 自动（写入感染） | 第 10 次 writeMemory 自动触发（AUTO_CONSOLIDATE_INTERVAL=10） |

### Dream 跳过规则
- PROTECTED_TAGS = ['baohu'] → 所有带 baohu 的记忆跳过去重合并
- stale 判断条件：createdAt + 30 天没有更新的 → 移动 coldTier → demote / 删除
- 合并条件：claims 重叠 > 80%（已修复大小写不敏感）

---

## 八、完整数据流

```
用户输入 / 模型输出 → think/search/MemoryWrite
    ↓
MemoryLookupTool.search(query) → search(query, scope, limit) → 
  [embedding 初筛 → FTS5 精筛 → 混合排序] → 
  [dingBoost → recallLog 记录 → 返回推荐列表]
    ↓
MemoryWriteTool.write(memo) → processTags(tags) → promote() → 
  [calculateRecallCount → recordRecall → enforceHotTierCap → autoDemoteIfNeeded]
    ↓
Dream(/dream) → findDuplicates → mergeDuplicates → 
  [processTags 同义合并(继承黑名单)] → stale clean → demote cold tier
    ↓
MemoryEditTool.edit(id, updates) → writeMemory(upsert) → 
  不走 processTags 过滤 → tags 直接存储
```

---

## 九、关键接口

| 接口 | 入口位置 | 参数 | 说明 |
|------|---------|------|------|
| `search()` | store.ts | query, scope, limit, minScore | 三层递进搜索 |
| `searchByTags()` | store.ts | tags[], mode(AND/OR) | 精确标签过滤 |
| `writeMemory()` | store.ts | MemoryMemo | 主写入路径，走 promote |
| `promote()` | store.ts | id, upsert | 升温 + 召回计数联动 |
| `recordRecall()` | store.ts | id | 记录召回日志 + 更新 countedAt |
| `calculateRecallCount()` | store.ts | id | 从 recall_logs 重算 |
| `deleteMemoryById()` | store.ts | id | 删除 |
| `listAll()` | store.ts | scope, tier, includeTags | 枚举 + 过滤 |
| `consolidateAndArchive()` | storage.ts | → Dream | 去重合并 + 归档 |
| `MemoryLookup.search()` | memory-lookup.ts | query, top_k, tags | 工具入口 → store.search |
| `MemoryWrite.write()` | memory-write.ts | userNeed, approach... | 工具入口 → processTags → store.writeMemory |
| `MemoryEdit.edit()` | memory-edit.ts | id, updates | 工具入口 → store.writeMemory(跳过 processTags) |

---

## 十、MemoryEdit 工具

### 注册
- 代码注册：`tool/index.ts:634` → `new MemoryEditTool()`
- 配置注册：`agent.yaml` 加 `- MemoryEdit`
- 工具权限：默认对所有 agent 可用

### 行为
- `edit(id, updates)` → `writeMemory({ ...old, ...updates })`（upsert）
- 不走 processTags 过滤（tags 直接存）
- `id` 参数必须带 `memo-` 前缀

### 标签写入规则
| 工具 | 是否过 processTags | 能否写保护标签 |
|------|-------------------|---------------|
| MemoryWrite | ✅ | ❌（baohu/ding/chundu/yongjiu 被过滤）|
| MemoryEdit | ❌ | ✅（直接存） |

---

## 十一、recallCount

### 当前行为
- `promote()` 调用 `calculateRecallCount()` 从 `recall_logs` 表重算
- `recordRecall()` 记录访问日志 + 更新 `recalledAt`
- 计数来自 `SELECT COUNT(*) FROM recall_logs WHERE memoId=?`

### 关键调用关系
```
promote(upsert) → calculateRecallCount()
                → recordRecall() → [记录 recall_logs]
[注意] promote() 传 recallCount:0 不走 recordRecall() 内部计数
```

### 防双计数
- `promote()` 的 upsert 传 `recallCount: 0`，不触发 `recordRecall()` 内部重算
- 双计数历史 bug 已修（详见 `SYSTEM/pitfalls.md` §promote() 双计数 Bug）

---

## 十二、关键限制

| 限制 | 原因 | 影响 |
|------|------|------|
| FTS5 不索引 tags 列 | tags 存 JSON + 字符串列 | 不能 `search("tags:xxx")`，必须二次过滤 |
| memoStore 可能为 undefined | sub agent 没有 | 必须加 guard |
| vec0 INSERT 不支持 ON CONFLICT/UPSERT | SQLite vec0 扩展限制 | 必须 DELETE 再 INSERT |
| vec0 `+` 前缀仅 DDL/SELECT 合法 | vec0 扩展语法 | INSERT/DELETE 必须去掉 `+` |
| Float32Array→Uint8Array(buffer) 传 vec0 | SQLite 的 C 接口要求 | vec_f32() 内部转换 |
| processTags 过滤 baohu/ding/chundu/yongjiu | 保护标签不住 MemoryWrite 写入 | 补标签走 MemoryEdit |
| MemoryEdit id 必须带 `memo-` 前缀 | 工具参数约定 | 不带前缀报错 |
| Dream 合并跳过了 processTags（已修） | 历史代码 | 已修复为统一路由 |
| processTags(undefined) 返回空数组 | 低阶函数设计 | 始终传 `?? []` |
| 双构建链 | alwaysBundle 策略 | 改标签配置必须两段构建 |
| 无增量更新 | SQLite 全量替换 | 改文件需删掉重录 |
| 每 chunk 1 次 LLM 调用 | 事件抽取设计 | 长文档摄入成本高 |
| SQLite 查询随数据量线性增长 | 无分片 | 万级以下可用 |