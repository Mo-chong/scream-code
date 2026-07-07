<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
# Scream Code 系统架构索引

> **AI 说明书索引** — 按功能域分组，每组一个独立 chunk。找文件路径→查索引表。找具体问题→查对应 domain 子表。详细描述在 `SYSTEM/*.md`，版本历史在 `SYSTEM/CHANGELOG.md`。**维护规范：索引表只放路径+一句话定位（不超过 20 字）；快速查找按 `####` 子域独立，新增条目归入对应子域；禁止放入踩坑/更新日志的详细描述。**

> **整体架构分层图 → `SYSTEM/architecture-overview.md`**（第0层 Monorepo → 第4层外部系统，看完再查子系统）

---

## 模块层级关系

```
├─ 接口手册        API-REFERENCE.md
├─ AGENTS 架构
│   └─ 三层加载链  agents-hierarchy.md
├─ 执行架构
│   ├─ 回合控制    turn-control.md
│   ├─ 注入系统    injection-system.md
│   ├─ 注意力管理  attention-management.md
│   ├─ Guard引擎   guard-engine.md
│   └─ 工具执行    prompt-assembly.md
├─ 上下文管理
│   ├─ 总架构      context-management.md
│   ├─ 压缩策略    compaction.md
│   └─ 缓存感知    phase26-cache-aware.md
├─ 记忆系统
│   ├─ 核心存储    memory-store.md
│   └─ Dream整理   dream.md
├─ MCP服务器集成   mcp-server.md
├─ CLI/TUI         cli-tui.md
├─ 拦截日志        interception.md
├─ 经验库
│   ├─ 踩坑记录    pitfalls.md
│   ├─ 变更日志    CHANGELOG.md
│   ├─ 合并上游SOP 合并上游仓库SOP.md
│   └─ 维护SOP    系统说明书维护SOP.md
└─ 专题/Phase文档
    ├─ Phase14     phase14-可执行优化.md
    └─ Phase15     phase15-行为偏差拦截通道.md
```

完整层级地图 → `SYSTEM/MAP.md`

## 索引表

| 子系统 | 索引文件 | 一句话定位 |
|--------|----------|-----------|
| **整体架构(分层图)** | `SYSTEM/architecture-overview.md` | ☑ **优先读这个**：0→4层完整分层，大架构套小架构，看完再查具体模块 |
| **记忆系统** | `SYSTEM/memory-store.md` | SQLite + FTS5 + vec0 向量三重检索 + 热冷升降(ResNet 衰减)，tags 存 JSON 不在 FTS5 索引中 |
| **MCP 服务器集成** 🆕 | `SYSTEM/mcp-server.md` | MCP 三层配置（用户级→父目录→项目级），codegraph/context7/anysearch，内置与 MCP 工具无权重差别 |
| **Dream 整理系统** | `SYSTEM/dream.md` | 自动去重合并/清理过期/保护标签（baohu）免疫 |
| **注意力管理** | `SYSTEM/attention-management.md` | ResNet 残差调度(R=W×D^Δs) + W/D/T 三级参数 + VariantScheduler 残差门控 + Step 反馈注入 + Guard 行为验证 + 反事实检测 |
| **回合控制** | `SYSTEM/turn-control.md` | turn/index.ts 2150 行，runOneTurn → afterStep → shouldContinueAfterStop 闭环 |
| **注入系统** 🆕 | `SYSTEM/injection-system.md` | 指令权重体系 S/A/B/C/D + InjectionManager + VariantScheduler 残差公式 R=W×D^Δs + 阈值衰减防脱敏 |
| **Guard 规则引擎** | `SYSTEM/guard-engine.md` | 4 条规则全量编码（exit code 矛盾/无证据声称/无编辑声称改/记忆仅代码断言），14 测试覆盖 |
| **上下文管理** 🆕 | `SYSTEM/context-management.md` | 四层架构：maskToolObservations + ContentArchive（LRU 2000 条/30min TTL，sharedStore 跨子 agent 共享）+ MicroCompaction（3 道关卡）+ FullCompaction（LLM 总结→记忆库）。ArchiveRecover MCP 工具已放开。Bash 降噪：ANSI 剥离 + 重复行去重 |
| **上下文压缩**（旧版） | `SYSTEM/compaction.md` | FullCompaction（summarizeOnce 封装 + CompactionReport）+ MicroCompaction（isUseless/isOversizedTruncatable 两阶段）+ render-messages.ts。前缀稳定化 + maskToolObservations + 批次门控 + pipeline counters |
| **AGENTS 分层设计** 🆕 | `SYSTEM/agents-hierarchy.md` | 三层加载链(findProjectRoot→dirsRootToLeaf→collectAgentsFiles→budget) + 四维评估框架 + 语言设计规范 + 55KB 提取方法论 |
| **System Prompt 装配** | `SYSTEM/prompt-assembly.md` | Template → Render → Inject → API 全链路，模板变量/AGENTS合并/user-prefs双路 |
| **拦截日志** | `SYSTEM/interception.md` | 环形缓冲区 + W 驱动采样 + 磁盘持久化（每回合刷盘） |
| **CLI/TUI 层** | `SYSTEM/cli-tui.md` | apps/scream-code，dispatch → screm-tui → dialog，/memory 命令链路 + 新版标签图标 |
| **踩坑与经验** | `SYSTEM/pitfalls.md` | 构建链陷阱、FTS5 限制、中文权重、路径修复、上游合并踩坑、merge SOP、Phase22 4 坑 |
| **Phase14：可执行优化** 🆕 | `SYSTEM/Phase14-可执行优化.md` | afterStep 分段命名化 + 收敛条件数组化 + 跨回合标记 + 模块减肥 |
| **Phase15：行为偏差拦截通道** 🆕 | `SYSTEM/Phase15-行为偏差拦截通道.md` | BEB 通道 + 增强日志基础设施 + 数据驱动配置 |
| **Phase26：缓存感知架构** 🆕 | `SYSTEM/phase26-cache-aware.md` | DeepSeek KV Cache 兼容，注入位置修正(A→head/feedback→tail)，实时缓存审计日志 ndjson，动态自适应压缩阈值(GrowthPredictor) |
| **系统说明书维护SOP** 🆕 | `SYSTEM/系统说明书维护SOP.md` | AI 更新文档的标准流程：决策树→分类→执行→交叉验证，含每个文件的写入规范 |
| **合并上游仓库SOP** 🆕 | `SYSTEM/合并上游仓库SOP.md` | 二开 fork 合并上游作者仓库的标准流程：双 remote 结构、冲突策略、guard 验证、force-push 恢复 |
| **行为矫正方案** | `../DECISIONS/行为矫正系统-完整实战方案.md` | 融合 Guard + 记忆注入 + 收敛门的完整计划 |

---

## 快速查找

### 记忆系统
| 问题 | 先查这个文件 |
|------|-------------|
| 记忆存在哪里/怎么搜 | `SYSTEM/memory-store.md` |
| FTS5 索引了什么字段 | `SYSTEM/memory-store.md` §FTS5 |
| 能不能按 tag 过滤 | `SYSTEM/memory-store.md` §Tags |
| 搜索评分 ding 权重 | `SYSTEM/memory-store.md` §dingBoost |
| 记忆 ResNet 衰减因子 | `SYSTEM/memory-store.md` §热冷升降 / `scoring.ts` §resNetFactors |
| 保护标签 baohu | `SYSTEM/dream.md` §保护标签 |
| 置顶标签 ding | `SYSTEM/memory-store.md` §标签体系 |
| 拼音标签体系 | `SYSTEM/memory-store.md` §标签体系 |
| chundu 怎么过滤规则 | `SYSTEM/memory-store.md` §纯度控制 |
| yongjiu 标签有什么用 | `SYSTEM/memory-store.md` §标签体系 |
| 标签质量优化原理/配置 | `SYSTEM/memory-store.md` §六点五、标签质量四层优化 |
| 标签黑名单词有哪些 | `SYSTEM/memory-store.md` §TAG_CONFIG |
| 动态预算公式 | `SYSTEM/memory-store.md` §动态预算公式 |
| 标签质量统计在哪 | `SYSTEM/memory-store.md` §六点五 → tag-stats.ts |
| MemoryEdit 怎么启用 | `SYSTEM/memory-store.md` §MemoryEdit-工具 |
| 改 agent.yaml 不生效 | `SYSTEM/memory-store.md` §构建链 |
| 数据库直接在哪里 | `SYSTEM/memory-store.md` §直接数据库操作 |
| zz 记忆选择器图标 | `SYSTEM/cli-tui.md` §新版图标 |
| MemoryWrite 标签被过滤（baohu/ding） | `SYSTEM/pitfalls.md` §踩坑 #9 |
| MemoryEdit id 要带 memo- 前缀 | `SYSTEM/pitfalls.md` §踩坑 #9 |
| promote 双计数 bug | `SYSTEM/pitfalls.md` §踩坑 #11 |
| claimsOverlap 大小写不敏感 | `SYSTEM/pitfalls.md` §踩坑 #12 |
| search() scope:'all' 是否新功能 | `SYSTEM/pitfalls.md` §踩坑 #10 |
| Dream 运行流程 | `SYSTEM/dream.md` §生命周期 |
| Dream 合并标签为什么不继承黑名单 | `SYSTEM/pitfalls.md` §坑 2：Dream 合并跳过 processTags |
| yongjiu 不生效（构建链陷阱） | `SYSTEM/pitfalls.md` §yongjiu 标签不生效 |
| 全量验证结果（81+13测试） | `DECISIONS/INDEX.md` §sqlite-vec 对接方案，验证记录在 test/tier-vec0.test.ts + vec0-repro.test.ts |

### 上下文管理
| 问题 | 先查这个文件 |
|------|-------------|
| ContentArchive 扩容与加权淘汰 | `SYSTEM/API-REFERENCE.md` §18 |
| 上下文压缩触发条件 | `SYSTEM/compaction.md` §两层压缩 / `SYSTEM/context-management.md` §三、四 |
| MicroCompaction 做什么 | `SYSTEM/compaction.md` §MicroCompaction / `SYSTEM/context-management.md` §三 |
| FullCompaction 什么时候调 | `SYSTEM/compaction.md` §FullCompaction / `SYSTEM/context-management.md` §四 |
| FullCompaction 557k 超限 | `SYSTEM/pitfalls.md` §FullCompaction 缺少 Observation Masking |
| ContentArchive（保留缓冲区） | `SYSTEM/context-management.md` §二 |
| ArchiveRecover MCP 工具 | `SYSTEM/context-management.md` §五 |
| ArchiveRecoverTool 内容存档恢复 | `SYSTEM/API-REFERENCE.md` §20 |
| Bash 降噪/ANSI 剥离/sanitize | `SYSTEM/context-management.md` §11.4 / `SYSTEM/API-REFERENCE.md` §21 |
| 上下文管理四层架构总览 | `SYSTEM/context-management.md` §一、七、十一 |
| content-archive / file-action-audit flag | `flags/registry.ts` |
| FileActionAudit 文件审计日志 | `SYSTEM/API-REFERENCE.md` §19 |

### 注入系统
| 问题 | 先查这个文件 |
|------|-------------|
| 注入有几种优先级 | `SYSTEM/injection-system.md` §优先级 |
| system_trigger 是什么 | `SYSTEM/injection-system.md` §system_trigger |
| 注入 ResNet 残差调度 | `SYSTEM/injection-system.md` §variant-registry L319-345 |
| VariantScheduler 残差调度 | `SYSTEM/injection-system.md` §7 |
| 残差公式与阈值衰减 | `SYSTEM/injection-system.md` §7 |
| protected compaction 保护 | `SYSTEM/API-REFERENCE.md` §22.1-22.4 |
| 两套 ResNet 什么关系 | `Phase21.1-深度分析-系统引用重构方案.md` §四 |
| normalTags 为什么用 MAX_TAGS_ABSOLUTE | `SYSTEM/pitfalls.md` §坑 1：normalizeTags 硬编码 |

### 回合控制 + Guard
| 问题 | 先查这个文件 |
|------|-------------|
| 收敛门怎么拦住 AI | `SYSTEM/turn-control.md` §收敛门 |
| Guard 什么时候触发 | `SYSTEM/guard-engine.md` §触发时机 |
| AI 编造怎么检测 | `SYSTEM/guard-engine.md` §反事实检测 |
| 回合生命周期 | `SYSTEM/turn-control.md` §生命周期 |
| 代码探索用什么工具优先 | `SYSTEM/turn-control.md` §工具优先级 |
| LSP 报 spawn EINVAL / npx fallback 失败 | `SYSTEM/pitfalls.md` §LSP 故障 #2：bundle 环境双重 fallback 失败 |
| bundle 环境 PATH 极简，外部命令找不到 | `SYSTEM/pitfalls.md` §LSP 故障 #2 → bundle env 的 PATH 构成 |

### TruncationTracker（Phase24）
| 问题 | 先查这个文件 |
|------|-------------|
| TruncationTracker 自动恢复 | `SYSTEM/API-REFERENCE.md §23` |
| stepRecovered 并行竞争保护 | `SYSTEM/API-REFERENCE.md §23.2` |
| 诊断式注入预览 | `SYSTEM/API-REFERENCE.md §23.2` |
| readOnlyTools 配置 | `SYSTEM/API-REFERENCE.md §23.1` |

### MCP + 构建
| 问题 | 先查这个文件 |
|------|-------------|
| MCP 工具有几种/怎么配 | `SYSTEM/mcp-server.md` |
| codegraph 索引了什么 | `SYSTEM/mcp-server.md` §codegraph |
| 内置工具和 MCP 工具有权重差吗 | `SYSTEM/mcp-server.md` §工具类型与权重 |
| 安装新 MCP server 怎么配置 | `SYSTEM/mcp-server.md` §配置格式 |
| MCP 连接失败（PATHEXT 被删） | `SYSTEM/pitfalls.md` §MCP 连接失败 |
| 开发构建怎么跑 | `scripts/build-dev.sh` |
| 双构建链陷阱的验证方法 | `SYSTEM/pitfalls.md` §双构建链陷阱的验证方法 |
| 构建卡 prepare 脚本（node 不在 PATH） | `SYSTEM/pitfalls.md` §构建卡在 prepare 脚本 |

### 踩坑与经验
| 问题 | 先查这个文件 |
|------|-------------|
| 踩坑记录在哪里 | `SYSTEM/pitfalls.md` |
| 数据库备份找错系统 | `SYSTEM/pitfalls.md` §踩坑 #8 |
| 拦截日志写在磁盘哪里 | `SYSTEM/interception.md` §刷盘策略 |
| 拦截日志有没有 CLI 命令 | 暂无，参考 `SYSTEM/interception.md` §关键限制 |

### Git 与上游合并
| 问题 | 先查这个文件 |
|------|-------------|
| **合并上游完整流程（推荐）** | **`SYSTEM/合并上游仓库SOP.md`** |
| **system.md ⚠️ 保护+同步规则** | **`SYSTEM/合并上游仓库SOP.md` §7** |
| 作者 force-push 后怎么合并 | `SYSTEM/pitfalls.md` §Git 与仓库管理 |
| Cherry-pick 后文件缺失 | `SYSTEM/pitfalls.md` §被抹掉的文件要主动从旧历史恢复 |
| 包名变更导致 import 找不到 | `SYSTEM/pitfalls.md` §包名变更 |
| Cherry-pick 后构建/bundle 不工作 | `SYSTEM/pitfalls.md` §pnpm install 是 cherry-pick 后的必修课 |
| v0.7 新功能有哪些 | `SYSTEM/pitfalls.md` §v0.7 升级与合并 → 新功能总览 |
| 合并上游 v0.8/v0.9 的标准流程 | `SYSTEM/pitfalls.md` §合并上游更新的标准操作流程 (SOP) |
| 策略层防御模式（install-strategy.ts） | `SYSTEM/pitfalls.md` §策略层防御模式 |
| 合并 v0.7 的真实冲突经验 | `SYSTEM/pitfalls.md` §合并上游 v0.7 的真实冲突复盘 |
| installUpdate 签名不匹配 | `SYSTEM/pitfalls.md` §踩坑点总结 |

---

## 决策文档 / ADR

先看 `DECISIONS/INDEX.md` 分类索引（ADR/方案/分析/执行记录全分类）。

| 文档 | 内容 |
|------|------|
| `DECISIONS/INDEX.md` | DECISIONS/ 目录的全量分类索引 |
| `DECISIONS/行为矫正系统-完整实战方案.md` | 融合方案总设计 |
| `DECISIONS/Guard规则引擎-实战执行方案.md` | Guard 执行细节 |
| `DECISIONS/分析-长期记忆系统外挂方案-开源调查与适配分析.md` | 12 方案全面分析，结论：无需外挂，缺沉淀策略 |
| `DECISIONS/扩展方向-架构进化路线-行为学习与闭环.md` | 未来方向：P0反馈/P1学习/P2沙盒 |
| `DECISIONS/分析-ContentArchive-参数优化与FileActionAudit融合计划-最终执行方案.md` | ContentArchive v2 升级+FileActionAudit+ArchiveRecoverTool 三阶段实现 |

---

## 文件位置速查

```
源码位置:
  packages/agent-core/src/
    agent/index.ts                → Agent 类（所有子系统的容器）
    agent/turn/index.ts           → 回合控制核心（1737 行）
    agent/context/index.ts        → appendUserMessage / appendSystemReminder
    agent/injection/manager.ts    → InjectionManager（10 个 DynamicInjector，Phase21 移除 system-ref）
    agent/injection/goal.ts       → GoalInjector
    agent/injection/todo-list.ts  → TodoListReminderInjector
    tools/builtin/memory/
      memory-lookup.ts            → MemoryLookup 工具
      memory-write.ts             → MemoryWrite 工具
      memory-edit.ts              → MemoryEdit 工具
  packages/memory/src/
    store.ts                      → MemoryMemoStore（SQLite + FTS5 + vec0 向量 + 热冷升降，~1485 行）
    models.ts                     → MemoryMemo 数据模型
    embeddings.ts                 → 向量引擎 (engine cache + sidecar 自动补全)
    classifiers/
      value-classifier.ts         → 记忆价值自动分类 (v0.8.5 新增)
      category-tagger.ts          → 类别标签推断 (v0.8.5 新增)
    scoring.ts                    → 混合评分(60% keyword + 40% vector) × ResNet 因子
    consolidator.ts               → Dream 去重合并 + demote 归档

CLI/TUI 源码:
  apps/scream-code/src/
    tui/commands/memory.ts        → /memory 命令处理
    tui/commands/dispatch.ts      → 命令调度
    tui/components/dialogs/memory-picker.ts  → TUI 选择器
    tui/managers/dialog-manager.ts           → 弹窗管理
    tui/scream-tui.ts             → TUI 主入口
```

---

## 关键发现（速查）

> 这些是从代码审计中发现的、文档里没有的关键限制

| 发现 | 证据位置 | 影响 |
|------|----------|------|
| FTS5 不索引 tags 列 | store.ts:339 vs 344-351 | 不能 `search("tags:xxx")`，必须二次过滤 |
| memoStore 可能为 undefined | agent/index.ts:126 | sub agent 没有，必须加 guard |
| vec0 INSERT 不支持 ON CONFLICT/UPSERT | store.ts:793-840 | 必须 DELETE 再 INSERT |
| vec0 `+` 前缀：仅 DDL/SELECT 合法 | store.ts:380-391 + 845-892 | INSERT/DELETE 必须去掉 `+` |
| Float32Array→Uint8Array(buffer) 传 vec0 | store.ts:795-796 | vec_f32() 内部转换，node:sqlite number→FLOAT 需 BigInt() |
| system_trigger 穿透预算 | turn/index.ts:1356-1359 | 收敛门注入不受 budget 限制 |
| sendNormalUserInput ≠ inject | context/index.ts:75-80 vs 83-91 | 前者是普通用户消息，后者是 <system-reminder> |
| inject('injection') 受 5 重限制 | turn/index.ts:1368-1419 | 重复衰减→残差→去重→预算→注册 |
| **system-ref 废弃 → stuck 注入器 (Phase21)** | turn/injectors/stuck.ts + turn/index.ts:1579-1598 + variant-registry.ts:313 | 旧 system-ref.ts DynamicInjector 绕过所有 guard 被删除；替代为 stuck 注入器走残差系统。检测 3 种 stuck 模式（同文件连续编辑≥3步/同工具连续报错≥2步），受 budget/dedup/残差三重门控 |
| **ResNet 双系统** | variant-registry.ts L319-345 + store.ts:1281-1287 + scoring.ts:162-163 | 记忆 ResNet（天级幂衰减）+ 注入调度 ResNet（步级幂衰减），公式均为 R = W×D^Δs |