# Scream Code 系统架构索引

> 说明书索引文件 | **构建工具** | `scripts/build-dev.sh` | agent-core → scream-code 两段构建链，绕过 pnpm lifecycle 直调 tsdown | 只放链接和一句话定位
> 详细描述在 `SYSTEM/*.md`，按子系统拆分

---

## 如何用这个索引

```
你问系统问题 → 查这个索引找到对应文件
→ 读 SYSTEM/xxx.md 获取完整描述
→ 不需要每次从零查源码
```

---

## 索引表

| 子系统 | 索引文件 | 一句话定位 |
|--------|----------|-----------|
| **记忆系统** | `SYSTEM/memory-store.md` | SQLite + FTS5 + vec0 向量三重检索 + 热冷升降(ResNet 衰减)，tags 存 JSON 不在 FTS5 索引中；**v0.6.10: 标签质量四层优化（统一路由+后备+黑名单+动态预算+偏差链+新鲜度+质量统计）**；**recallCount 增强：记录召回次数、降级保护（baohu/ding/yongjiu/chundu）、search blend (relevance×0.7 + heatScore×0.3)、recalcRecallCountFromLog 运维工具** |
| **MCP 服务器集成** 🆕 | `SYSTEM/mcp-server.md` | MCP 三层配置（用户级→父目录→项目级），codegraph/context7/anysearch，内置与 MCP 工具无权重差别 |
| **Dream 整理系统** | `SYSTEM/dream.md` | 自动去重合并/清理过期/保护标签（baohu）免疫 |
| **回合控制** | `SYSTEM/turn-control.md` | turn/index.ts 2150 行，runOneTurn → afterStep → shouldContinueAfterStop 闭环；**v0.6.10: Phase16 工具优先级（codegraph优先、收敛门用代码文件计数、LSP双层fallback修复）** |
| **注入系统** | `SYSTEM/injection-system.md` | inject() 三种优先级 + InjectionManager + VariantRegistry |
| **Guard 规则引擎** | `SYSTEM/guard-engine.md` | afterStep 后处理检查，confabulationBlocked → 收敛门拦截 |
| **上下文压缩** | `SYSTEM/compaction.md` | FullCompaction（LLM 摘要）+ MicroCompaction（删覆盖 Read），自动缓解窗口溢出；**v0.7 fork 新增：前缀稳定化（stabilizePrefix 提升 KV-cache 命中率）+ Observation Masking（遮蔽旧工具输出省 token，压缩/对话双路径）+ MicroCompaction 批次门控（BATCH_SIZE=8）** |
| **拦截日志** | `SYSTEM/interception.md` | 环形缓冲区 + W 驱动采样 + 磁盘持久化（每回合刷盘） |
| **CLI/TUI 层** | `SYSTEM/cli-tui.md` | apps/scream-code，dispatch → screm-tui → dialog，/memory 命令链路 + 新版标签图标 |
| **整体架构** | `SYSTEM/architecture.md` | Agent 类（agent/index.ts）组合所有子系统 |
| **踩坑与经验** | `SYSTEM/pitfalls.md` | 构建链陷阱、FTS5 限制、中文权重、路径修复、**v0.7 升级合并踩坑、策略层防御模式、merge SOP、Observation Masking 压缩路径漏遮、构建卡 prepare 脚本** |
| **Phase14：可执行优化** 🆕 | `SYSTEM/Phase14-可执行优化.md` | afterStep 分段命名化 + 收敛条件数组化 + 跨回合标记 + 模块减肥 |
| **Phase15：行为偏差拦截通道** 🆕 | `SYSTEM/Phase15-行为偏差拦截通道.md` | BEB 通道 + 增强日志基础设施 + 数据驱动配置 |
| **行为矫正方案** | `../DECISIONS/行为矫正系统-完整实战方案.md` | 融合 Guard + 记忆注入 + 收敛门的完整计划 |

---

## 快速查找

### 常见问题 → 查哪个文件

| 问题 | 先查这个文件 |
|------|-------------|
| 记忆存在哪里/怎么搜 | `SYSTEM/memory-store.md` |
| FTS5 索引了什么字段 | `SYSTEM/memory-store.md` §FTS5 |
| 能不能按 tag 过滤 | `SYSTEM/memory-store.md` §Tags |
| 注入有几种优先级 | `SYSTEM/injection-system.md` §优先级 |
| system_trigger 是什么 | `SYSTEM/injection-system.md` §system_trigger |
| 收敛门怎么拦住 AI | `SYSTEM/turn-control.md` §收敛门 |
| Guard 什么时候触发 | `SYSTEM/guard-engine.md` §触发时机 |
| /memory + i 键的完整链路 | `SYSTEM/cli-tui.md` §memory-命令 |
| 回合生命周期 | `SYSTEM/turn-control.md` §生命周期 |
| AI 编造怎么检测 | `SYSTEM/guard-engine.md` §反事实检测 |
| memory 选择器图标 | `SYSTEM/cli-tui.md` §新版图标 |
| Dream 运行流程 | `SYSTEM/dream.md` §生命周期 |
| 保护标签 baohu | `SYSTEM/dream.md` §保护标签 |
| 置顶标签 ding | `SYSTEM/memory-store.md` §标签体系 |
| 拼音标签体系 | `SYSTEM/memory-store.md` §标签体系 |
| chundu 怎么过滤规则 | `SYSTEM/memory-store.md` §纯度控制 |
| yongjiu 标签有什么用 | `SYSTEM/memory-store.md` §标签体系 |
| 搜索评分 ding 权重 | `SYSTEM/memory-store.md` §dingBoost |
| MemoryEdit 怎么启用 | `SYSTEM/memory-store.md` §MemoryEdit-工具 |
| 改 agent.yaml 不生效 | `SYSTEM/memory-store.md` §构建链 |
| 数据库直接在哪里 | `SYSTEM/memory-store.md` §直接数据库操作 |
| 上下文压缩触发条件 | `SYSTEM/compaction.md` §两层压缩 |
| MicroCompaction 做什么 | `SYSTEM/compaction.md` §MicroCompaction |
| FullCompaction 什么时候调 | `SYSTEM/compaction.md` §FullCompaction |
| 拦截日志写在磁盘哪里 | `SYSTEM/interception.md` §刷盘策略 |
| 拦截日志有没有 CLI 命令 | 暂无，参考 `SYSTEM/interception.md` §关键限制 |
| 踩坑记录在哪里 | `SYSTEM/pitfalls.md` |
| MCP 连接失败（PATHEXT 被删） | `SYSTEM/pitfalls.md` §MCP 连接失败 |
| yongjiu 不生效（构建链陷阱） | `SYSTEM/pitfalls.md` §yongjiu 标签不生效 |
| 双构建链陷阱的验证方法 | `SYSTEM/pitfalls.md` §双构建链陷阱的验证方法 |
| 标签质量优化原理/配置 | `SYSTEM/memory-store.md` §六点五、标签质量四层优化 |
| 标签黑名单词有哪些 | `SYSTEM/memory-store.md` §TAG_CONFIG |
| 动态预算公式 | `SYSTEM/memory-store.md` §动态预算公式 |
| normalizeTags 为什么用 MAX_TAGS_ABSOLUTE | `SYSTEM/pitfalls.md` §坑 1：normalizeTags 硬编码 |
| Dream 合并标签为什么不继承黑名单 | `SYSTEM/pitfalls.md` §坑 2：Dream 合并跳过 processTags |
| 标签质量统计在哪 | `SYSTEM/memory-store.md` §六点五 → tag-stats.ts |
| 代码探索用什么工具优先 | `SYSTEM/turn-control.md` §工具优先级 |
| LSP 报 spawn EINVAL / npx fallback 失败 | `SYSTEM/pitfalls.md` §LSP 故障 #2：bundle 环境双重 fallback 失败 |
| bundle 环境 PATH 极简，外部命令找不到 | `SYSTEM/pitfalls.md` §LSP 故障 #2 → bundle env 的 PATH 构成 |
| MCP 工具有几种/怎么配 | `SYSTEM/mcp-server.md` |
| codegraph 索引了什么 | `SYSTEM/mcp-server.md` §codegraph |
| 内置工具和 MCP 工具有权重差吗 | `SYSTEM/mcp-server.md` §工具类型与权重 |
| 安装新 MCP server 怎么配置 | `SYSTEM/mcp-server.md` §配置格式 |
| 作者 force-push 后怎么合并 | `SYSTEM/pitfalls.md` §Git 与仓库管理 |
| Cherry-pick 后文件缺失 | `SYSTEM/pitfalls.md` §被抹掉的文件要主动从旧历史恢复 |
| 包名变更导致 import 找不到 | `SYSTEM/pitfalls.md` §包名变更 |
| Cherry-pick 后构建/bundle 不工作 | `SYSTEM/pitfalls.md` §pnpm install 是 cherry-pick 后的必修课 |
| v0.7 新功能有哪些 | `SYSTEM/pitfalls.md` §v0.7 升级与合并 → 新功能总览 |
| 合并上游 v0.8/v0.9 的标准流程 | `SYSTEM/pitfalls.md` §合并上游更新的标准操作流程 (SOP) |
| 策略层防御模式（install-strategy.ts） | `SYSTEM/pitfalls.md` §策略层防御模式 |
| 合并 v0.7 的真实冲突经验 | `SYSTEM/pitfalls.md` §合并上游 v0.7 的真实冲突复盘 |
| installUpdate 签名不匹配 | `SYSTEM/pitfalls.md` §踩坑点总结 |
| 构建卡 prepare 脚本（node 不在 PATH） | `SYSTEM/pitfalls.md` §构建卡在 prepare 脚本 |
| 开发构建怎么跑 | `scripts/build-dev.sh` |
| FullCompaction 557k 超限 | `SYSTEM/pitfalls.md` §FullCompaction 缺少 Observation Masking |
| vec0 向量搜索原理 | store.ts §searchByVectorVec0 + memory-lookup.ts §vec0搜索冷热fallback |
| 热冷升降触发条件 | store.ts §promote/demote/autoDemote/autoPromote |
| ResNet 衰减因子 | scoring.ts §resNetFactors + store.ts §autoDemoteIfNeeded |
| sqlite-vec 初始化 | store.ts §_doInit + `@photostructure/sqlite-vec` |
| 全量验证结果（81+13测试） | `DECISIONS/INDEX.md` §sqlite-vec 对接方案，验证记录在 test/tier-vec0.test.ts + vec0-repro.test.ts |

### 决策文档 / ADR（ZHU/DECISIONS/）

先看 `DECISIONS/INDEX.md` 分类索引（ADR/方案/分析/执行记录全分类）。

| 文档 | 内容 |
|------|------|
| `DECISIONS/INDEX.md` | DECISIONS/ 目录的全量分类索引 |
| `DECISIONS/行为矫正系统-完整实战方案.md` | 融合方案总设计 |
| `DECISIONS/Guard规则引擎-实战执行方案.md` | Guard 执行细节 |
| `DECISIONS/分析-长期记忆系统外挂方案-开源调查与适配分析.md` 🆕 | 12 方案全面分析，结论：无需外挂，缺沉淀策略 |
| `DECISIONS/扩展方向-架构进化路线-行为学习与闭环.md` | 未来方向：P0反馈/P1学习/P2沙盒 |

---

## 文件位置速查

```
源码位置:
  packages/agent-core/src/
    agent/index.ts                → Agent 类（所有子系统的容器）
    agent/turn/index.ts           → 回合控制核心（1737 行）
    agent/context/index.ts        → appendUserMessage / appendSystemReminder
    agent/injection/manager.ts    → InjectionManager（6 个 injector）
    agent/injection/goal.ts       → GoalInjector
    agent/injection/todo-list.ts  → TodoListReminderInjector
    tools/builtin/memory/
      memory-lookup.ts            → MemoryLookup 工具
      memory-write.ts             → MemoryWrite 工具
      memory-edit.ts              → MemoryEdit 工具
  packages/memory/src/
    store.ts                      → MemoryMemoStore（SQLite + FTS5 + vec0 向量 + 热冷升降，~1485 行）
    models.ts                     → MemoryMemo 数据模型
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
---
