<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
<format>
key: value — 定义 | A → B → C — 流程 | A / B / C — 任一
(条件) 动作 — 条件执行 | indent — 嵌套 | [P0][P1][P2] — 优先级
无连接词。每段独立解读。
</format>

# 系统说明书维护SOP [P0]

> 用户说"更新文档" → Read 本文件 → 按流程执行。

## 1. 决策树

变更来了 → 逐条判断，只选符合的：

1. 全新模块 / 已有增量 → 新建 SYSTEM/xxx.md / 更新已有
2. 新接口/类型/配置 → API-REFERENCE.md + `<!-- ref: xxx -->`
3. 踩坑/教训 → pitfalls.md（三段：根因/修复/预防）
4. 值得记录 → CHANGELOG.md（倒序）
5. SYSTEM/ 文件增删 → MAP.md（注册）+ INDEX.md（路径）+ SYSTEM-INDEX（索引+层级图）
6. 都不触发 → 不更新

（条件）变更无关任何规则 → 跳过，交付前告知。

## 2. 执行流程 [P0]

调研 → 分类(给用户确认) → 按依赖顺序执行 → 验证。

调研：先 Read 所有待更新文件 L1-5，确认 maintain 标签 + 顶部规范。缺失补之。

分类：列影响文件清单给用户确认，确认后才动手。

执行顺序（不可乱）：
```
1. SYSTEM/xxx.md（专题）→ 2. MAP.md → 3. SYSTEM-INDEX.md → 4. API-REFERENCE.md
→ 5. pitfalls.md → 6. CHANGELOG.md → 7. SYSTEM/INDEX.md
```

验证：maintain √ | MAP注册 √ | 索引 √ | ref标签 √ | pitfalls三段 √ | 路径Read可访问 √ | 函数名Grep一致 √ | compact notation √ | 无多余改动 √

## 3. 写入规范

### 3.1 专题文档 SYSTEM/xxx.md

```
<format>...compact notation...</format>
# 标题 [P0]  > 一句话描述
## 设计原理  ## 核心流程  ## 接口/配置  ## 边界/约束
```

追加/修改：尾部追加 / 精确替换。废弃标 (deprecated)。

### 3.2 SYSTEM-INDEX.md

索引表：`| 路径 | 用途(≤15字) | 更新日 |` 字母序插入。层级图：找到模块分支追加。

### 3.3 API-REFERENCE.md

```
### N.x 功能名
<!-- ref: FunctionName -->
- 用途 / 参数: {key: type} / 返回: type / 调用方: [path] / 备注
```

续编。改旧不改号。废弃加 (deprecated)。

### 3.4 MAP.md / 3.5 pitfalls.md / 3.6 CHANGELOG.md / 3.7 INDEX.md

- MAP: `├─ 文件名.md — 一句话描述` 追加到模块层级
- pitfalls: `## 标题 → 症状 → **根因** / **修复** / **预防** / **相关**: [path]`
- CHANGELOG: `### YYYY-MM-DD → - 模块: 描述` 倒序，标路径，小修不记
- INDEX: `→ [标题](./xxx.md)` 文件增删时同步

## 4. 禁止 [P0]

- ❌ 不 Read 就写 | ❌ 乱序（必须 2 依赖顺序）
- ❌ 改没要求的文件 | ❌ 发明新格式（按顶部规范）
- ❌ 贴大段代码 | ❌ 模糊描述（必须有路径/函数名）
- ❌ 删旧内容（只追加或 deprecated）