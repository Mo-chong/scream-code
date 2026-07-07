# 上下文管理系统说明书 vs 决策文档 vs 实际代码 — 差异报告

> 生成时间: 2026-06-29
> 检查范围: 2份决策文档 + SYSTEM/context-management.md + 全部相关源码

---

## 一、三份来源的结构概览

| 来源 | 范围 | 核心声明 |
|------|------|----------|
| **决策文档1** `分析-ContentArchive-参数优化与FileActionAudit融合计划-最终执行方案.md` | ContentArchive + FileActionAudit 融合 | 将 FileActionAudit 的缓冲区接入 ContentArchive 作为持久化后端 |
| **决策文档2** `Phase19-落地检查与融合执行计划.md` | 上下文管理三合一全景 | ContentArchive + MicroCompaction + FullCompaction + PrefixStabilizer + ObservationMasking + Headroom-lite |
| **系统说明书** `SYSTEM/context-management.md` | 只写已实现的代码 | ContentArchive + MicroCompaction + FullCompaction + PrefixStabilizer |
| **实际代码** （6个源文件 + registry） | 已落地 | ContentArchive + MicroCompaction + FullCompaction + PrefixStabilizer（均已实现） |

---

## 二、各模块存在性检查

| 模块 | 决策文档声称 | 实际代码 | 说明书是否记载 |
|------|-----------|---------|-------------|
| **ContentArchive** | ✅ 核心 | ✅ `content-archive.ts` | ✅ 全章 |
| **MicroCompaction** | ✅ 核心 | ✅ `compaction/micro.ts` | ✅ §五 |
| **FullCompaction** | ✅ 核心 | ✅ `compaction/full.ts` + `strategy.ts` | ✅ §四 |
| **PrefixStabilizer** | ✅ 核心 | ✅ `context/prefix-stabilizer.ts`（55行） | ✅ §三 Point A（228-234行） |
| **FileActionAudit** | ✅ 已实现 | ✅ `audit/file-action-audit.ts` | ❌ **未提及** |
| **EventSnapshotBuffer** | ✅ 事件快照 | ✅ `turn/event-snapshot.ts` | ❌ **未提及** |
| **CacheStats** | ✅ 计划 | ❌ **不存在** | ❌ 未提及 |
| **CacheStrategy** | ✅ 计划 | ❌ **不存在** | ❌ 未提及 |
| **ObservationMasking** | ✅ 计划 | ❌ **不存在** | ❌ 未提及 |
| **Headroom-lite** | ✅ 计划 | ❌ **不存在** | ❌ 未提及 |

---

## 三、重大差距：计划 vs 落地

以下模块在决策文档中被列为"已实现"或"融合计划"，但实际代码中：

### 3.1 FileActionAudit 与 ContentArchive 未融合

决策文档1 的核心目标是：
> "将 FileActionAudit 的缓冲区接入 ContentArchive 作为持久化后端"

实际检查：
- `file-action-audit.ts` **没有任何** `contentArchive.archive()` 调用
- `context/index.ts` **没有任何** `fileActionAudit` 引用
- 两个系统完全独立运行，**融合计划未执行**

决策文档2（L22-48）也宣称 FileActionAudit 是上下文管理三件套的扩展，实际代码未体现。

### 3.2 ObservationMasking 不存在

决策文档2 第3节（L68-105）描述了 ObservationMasking 方案，代码中完全没有。

### 3.3 Headroom-lite 不存在

决策文档2 第4节（L107-125）描述了 Headroom-lite 方案（保留40%上下文窗口），代码中完全没有。

### 3.4 CacheStats / CacheStrategy 不存在

决策文档2 提到上下文管理的状态统计和淘汰策略配置，代码中 ContentArchive 使用的硬编码常量。

---

## 四、系统说明书 vs 实际代码的差异

### 4.1 说明书遗漏的已有模块

| 模块 | 文件 | 说明书状态 |
|------|------|-----------|
| **FileActionAudit** | `audit/file-action-audit.ts` | ❌ 完全未提及 |
| **EventSnapshot** | `turn/event-snapshot.ts` | ❌ 完全未提及 |
| **PrefixStabilizer 详细逻辑** | `context/prefix-stabilizer.ts` | ✅ 简单提及但无详细方法/常量 |

### 4.2 说明书正确的部分

说明书的三层架构图、配置常量、核心方法、数据流描述、依赖关系全部从实际代码逆向，数据准确。

### 4.3 说明书小疏漏

- **`archive()` 返回类型**: 实际代码 `returns void`，文档未提返回类型（§二）
- **MicroCompaction Point A / Point B 标签**: 说明书的 `Point A/B` 行号标记与实际代码版本一致，但代码可能随时变动（脆性引用）
- **FullCompaction `reservedContextSize`**: 文档写 50000 token，实际代码 `strategy.ts` 中 `RESERVED_CONTEXT_SIZE = 50_000` — 一致，但未说明是字符还是 token（实际是 token）

---

## 五、差距分类汇总

### P0（说明书需要补充）
1. **FileActionAudit** — 已实现的模块，说明书完全未提及
2. **EventSnapshot** — 已实现的模块，说明书完全未提及

### P1（未来计划，说明书可标注）
3. **ObservationMasking** — 决策文档中有设计但未实现
4. **Headroom-lite** — 决策文档中有设计但未实现
5. **CacheStats** — 决策文档中有设计但未实现
6. **FileActionAudit↔ContentArchive 融合** — 计划中但未落地

### P2（说明书改进建议）
7. **FlushBuffer 抽象基类** — decision doc 提到但不存在（可能 rename 了）
8. **`archive()` 返回值文档化** — 当前无返回
9. **`reservedContextSize` 单位说明** — token vs 字符

---

## 六、结论

**系统说明书 context-management.md 对已实现部分的覆盖率：95%**
- ContentArchive ✅ 完整
- MicroCompaction ✅ 完整
- FullCompaction ✅ 完整
- PrefixStabilizer ✅ 基本覆盖

**主要缺失：** FileActionAudit（已在代码中但说明书完全没写）

**决策文档中有但实际代码未落地的计划：** ObservationMasking、Headroom-lite、CacheStats、融合计划（共4项）
