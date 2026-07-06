# AGENTS.md Hierarchy Design [P0]

> 框架: system.md 定义不可违抗的引擎行为 | AGENTS.md 提供领域规则 + 注意力引导 | 两者叠加，各司其职

---

## 一、为什么需要多层 AGENTS.md [P1]

```
system.md（~9KB 全英文内核）:
  → AI 不可违抗的引擎指令（工具规则/工程约束/优先级）
  → 每次 session 固定注入

AGENTS.md（1.9-12KB 中文项目规则）:
  → AI 的"领域知识"（目录地图/决策门槛/规范）
  → 按项目层级叠加，适应不同办公场景
```

**一个 system.md（内核）不可覆盖所有项目场景**——项目集有边界，子项目有独特规则。三层 AGENTS.md 提供了灵活度，同时不让任何场景空跑 32KB budget。

---

## 二、三层架构总览 [P0]

```
L0-全局:  ~/.scream-code/AGENTS.md
  → 跨项目通用规则：回收站安全、工作区、用户偏好
  → 所有 session 的 fallback，lKB-2KB

L1-项目集合: <project-root>/AGENTS.md（如 ScreamCode/AGENTS.md）
  → 项目集合级：目录地图、决策门槛、框架认知
  → projectRoot = 无 .git 时的 fallback 目录

L2-项目专有: <sub-project>/AGENTS.md（如 ZHU/AGENTS.md）
  → 子项目特有：决策规范、格式契约、命令速查
  → projectRoot = 子项目的 .git 所在目录
```

### 叠加规则 [P0]（framework constraint）

- 不覆盖不合并，三层内容**简单拼接**
- 后加载不覆盖先加载 | 冲突由 AI 自行判断
- 设计时避免相互矛盾的规则

---

## 三、加载链（framework source）[P0]

取自 `packages/agent-core/src/profile/context.ts`：

### 3.1 findProjectRoot [P0]

```
findProjectRoot(cwd):
  current = cwd
  while (current !== resolve(current, '..')):
    if exists(join(current, '.git')) → return current   // 有 .git → 项目根
    current = resolve(current, '..')                     // 无 .git → 向上找
  return initial  // 到根都没有 → fallback 到 cwd 自身
```

来源: context.ts:82-91 ✅

**结论**：.git 的唯一作用是**定位 projectRoot**。有 .git → projectRoot = .git 所在目录。无 .git → projectRoot = cwd 自身。

### 3.2 dirsRootToLeaf [P0]

```
dirsRootToLeaf(projectRoot, cwd):
  dirs = [projectRoot]
  while (dirs.last() !== cwd):
    if (same(dirs.last(), cwd)) break
    dirs.push(...)  // 从 projectRoot 逐步走向 cwd
  return dirs.reversed()  // 以 projectRoot 开始的目录链
```

来源: context.ts:94-107 ✅

**结论**：搜索范围是**从 projectRoot 到 cwd 的目录链**，不往下进子目录。所以从 ScreamCode/ 启动 → 只搜 ScreamCode/AGENTS.md，不搜 ZHU/AGENTS.md。

### 3.3 collectAgentsFiles [P0]

```
collectAgentsFiles(dirs):
  for dir of dirs:
    → dir/.scream-code/AGENTS.md          // 项目级 .scream-code 配置
    → dir/AGENTS.md | dir/agents.md       // 项目级 AGENTS 规则（首文件命中即 break）
  + home/.scream-code/AGENTS.md           // 全局配置（始终收集）
```

来源: context.ts:72-77 + L60-61 ✅

### 3.4 renderAgentFiles & Budget [P0]

```
renderAgentFiles(files):
  // budget 分配：反向循环（最后收集的先分配）
  for i = files.length-1 → 0:
    consume budget from 'project root first, global last'

AGENTS_MD_MAX_BYTES = 32 * 1024  // 总 budget
```

来源: context.ts:145-164 + L9 ✅

**budget 结论**：
- **项目级 AGENTS.md 优先分配**（L1/L2 先吃 budget）
- home AGENTS.md 吃剩余
- L1/L2 超过 24KB 时 home 会被截断

### 3.5 三场景加载表

| 场景 | .git | projectRoot | dirsRootToLeaf | 收集的 AGENTS.md | 总大小预算 |
|------|------|------------|---------------|-----------------|-----------|
| ScreamCode/ | ❌ 无 | ScreamCode/ | [ScreamCode/] | home(1.9K) + L1(4.5K) | ~6.4K < 32K ✅ |
| ZHU/ | ✅ 有 | ZHU/ | [ZHU/] | home(1.9K) + L2(6.3K) | ~8.3K < 32K ✅ |
| obsidian/ | ❌ 无 | obsidian/ | [obsidian/] | home(1.9K) | ~1.9K < 32K |

---

## 四、.git 影响范围 [P0]

### 4.1 受影响的

| 能力 | 影响 |
|------|------|
| **projectRoot** | .git 存在与否决定 projectRoot 值 |
| **AGENTS.md 搜索起点** | projectRoot 决定 dirsRootToLeaf 起点 |
| **项目级 AGENTS 加载** | 有 .git → 只加载子项目自身 AGENTS.md 不加载父级 |

### 4.2 不受影响的

| 能力 | 说明 |
|------|------|
| 文件读写 Read/Write/Edit | 任意绝对路径，不受 .git 限制 |
| LSP/Glob/Grep/Bash | 同 |
| system.md 注入 | 由 profile 决定 |
| 记忆系统/memory | 独立系统 |
| 定时任务/cron | 独立系统 |
| 工具 budget | 由 system.md 定义 |
| session 生命周期 | 独立系统 |

**一句话**：`.git` 只决定 AGENTS.md 的搜索起点范围。不是能力开关。

---

## 五、内容设计框架：四维评估 [P1]

每一条写入 AGENTS.md 的规则，应该至少贡献以下四个维度中的两个：

| 维度 | 定义 | 对 AI 的意义 |
|------|------|-------------|
| 🎯 注意力 | 告诉 AI 什么重要、什么可忽略 | 减少无关干扰，聚焦关键决策 |
| 🛡 防幻 | 硬边界 + 硬检查点 + 可靠参考锚点 | 不确定时有确定出口，不编 |
| 🧠 防降智 | 正确思维路径，不走捷径 | 保持推理质量，不跳过验证 |
| ⚡ 能力增强 | AI 本来没有的信息 | 从需要猜变成确实知道 |

**三条铁律** [P0]：
1. 在 ≥2 维度有贡献 → 写，不管与 system.md 是否重复
2. 0 维度贡献 → 不管多短都不写
3. system.md 覆盖不深入 → AGENTS.md 补充执行细节，不回避

---

## 六、语言设计规范 [P1]

受 system.md（全英文/紧凑 notation/权重标签）启发，AGENTS.md 发展出更适合"领域知识"的语言体系：

### 6.1 三层语言

```
结构标签 → English          # Heading: # Project Map [P0], 权重: [P0][P1][P2]
规则核心 → Chinese           # 条件 → 动作 | 边界 → 结果
技术术语 → English           # workspace, LSP, TypeScript, .git, Bash
```

**English headings**：与 system.md 一致的权重标签，AI 识别为跨层统一指令
**Chinese rules**：AI 做"域知识"处理，执行灵活度恰当
**English terms**：技术概念用原生英文，不翻译

### 6.2 格式契约 [P1]

| 元素 | 规则 | 示例 |
|------|------|------|
| Heading [P0] | `# EnglishTitle [Pn]` | `# Navigation Rules [P2]` |
| 权重标记 [P0] | 每节必带 | `[P0]` 硬规则 / `[P1]` 建议 / `[P2]` 参考 |
| Clause [P1] | 条件 → 动作 \| 边界 → 结果 | `改代码前 → 读源文件 \| 搜引用` |
| 长段落 [P2] | 不超过 3 行 | 超则拆 bullet 或 pipe |
| 技术术语 [P0] | 用英文原生 | `workspace` 不写 `工作区` |
| 路径 [P0] | 保持原格式 | `D:\AI\ScreamCode\SYSTEM/` |
| 引用 [P1] | `→` 箭头 | `条件 → 动作` |

### 6.3 注意力布局 [P1]

利用 system.md 头部/尾部 recency 高注意力的原则：

```
§1 [P0] 硬规则（头部，最高注意力）
  → 边界声明、不可违背规则
§2 [P0] 决策门槛（次高）
  → 改代码前的硬性 checkpoint、验证范围
§3 [P1/P2] 参考信息（中部，注意力衰减）
  → 架构/命令/规范（能力增强类）
§4+ [P2] 辅助信息
  → 注意力地图、通用规则
最后 § [P0] 回退锚点（尾部 recency，高注意力）
  → 不确定时的出口
```

---

## 七、55KB 提取方法论 [P2]

`D:\AI\ScreamCode\AGENTS.md`（作者 716 行，16 章）不是所有内容都有用。提取规则：

1. **只看四维贡献**：只在「已由 system.md 覆盖」和「被 SYSTEM/ 文档覆盖」两个条件下跳过
2. **逐章分析**：不凭印象，每章标注归属（system.md / L1 / L2 / 跳过）
3. **保持去重但不过度**：即使与 system.md 有字面重复，只要增强 AI 执行力就保留

### 55KB 逐章分析表

| § | 章节 | 四维评估 | 结论 | 目标层 |
|---|------|---------|------|--------|
| §1 | 系统提示/角色 | system.md 完整覆盖 | ❌ 跳过 | — |
| **§2** | **项目架构概览（200行）** | ⭐⭐⭐⭐ | **✅ 提取** | **L1** |
| §3-6 | 子系统（240行） | 被 SYSTEM/ 文档覆盖 | ❌ 跳过 | — |
| §7-12 | LSP/Todo/Verification/Cron | system.md 完整覆盖 | ❌ 跳过 | — |
| §13 | Welcome | 完全无关 | ❌ 跳过 | — |
| **§14** | **编码规范** | ⭐⭐⭐⭐ | **✅ 提取** | **L1** |
| **§15** | **构建命令** | ⭐⭐⭐ | **✅ 提取** | **L1** |
| **§16** | **文档格式契约** | ⭐⭐（概念可用） | **✅ 借概念改编** | **L2** |

### 7.1 总提取量

| 源 | 目标 | 提取量 |
|----|------|--------|
| §2 项目架构 | L1 §3 Framework Knowledge | ~1KB |
| §14 编码规范 | L1 §3 Coding Standards | ~0.3KB |
| §15 构建命令 | L1 §3 Build Commands | ~0.5KB |
| §16 格式契约 | L2 §2 Format Contract（改编） | ~0.3KB |
| **合计** | | **~2.1KB** |

---

## 八、与 system.md 的职责边界 [P2]

```
system.md（内核指令, ~9KB）
  Role + Subagents → AI 角色定义
  DIY/Delegate → 行动模式选择
  Engineering judgment → 决策原则
  CONTRACT → 不可违背承诺
  Tool priority/mapping/rules → 工具使用规范
  Agent delegation → 子代理使用
  Coding → 编码方式
  Verification/Review → 验证规则
  Memory → 记忆操作
  Skills/Low-frequency → 次要信息

AGENTS.md（领域规则, 1.9-12KB）
  Project Map → 目录结构 + 边界 🎯注意力
  Decision Gates → 改代码 checklist 🛡防幻
  Framework Knowledge → 包结构 + 构建命令 ⚡能力增强
  Attention Map → 当前重点 🎯注意力
  Anti-Degradation → 常见错误预防 🧠防降智
  Fallback Anchors → 不确定时的出口 🛡防幻
  Decision Standards → 决策文档格式规范
  Format Contract → 格式一致
```

---

## 九、参考实现 [P2]

| 资产 | 路径 | 说明 |
|------|------|------|
| L0 home AGENTS.md | `~/.scream-code/AGENTS.md` | 全局偏好 1.9KB |
| L1 ScreamCode AGENTS.md | `D:\AI\allgzmulu\ScreamCode\AGENTS.md` | 项目集合级 4.5KB |
| L2 ZHU AGENTS.md | `D:\AI\allgzmulu\ScreamCode\ZHU\AGENTS.md` | ZHU 项目规则 6.3KB |
| 分层方案设计 | `DECISIONS/AGENTS-MD分层方案-当前真实状态.md` | 完整决策记录 |
| 框架加载源 | `packages/agent-core/src/profile/context.ts` | context.ts L42-170 |
| system.md 模板 | `packages/agent-core/src/profile/default/system.md` | ~210 行 Jinja2 |

---

## 十、CHANGELOG

| 日期 | 变更 |
|------|------|
| 2026-07-05 | 初版：三层架构设计 + 加载链源码验证 + 55KB 提取方法论 + 语言设计规范 |
