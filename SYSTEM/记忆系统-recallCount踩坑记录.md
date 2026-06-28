# SYSTEM — 记忆系统 recallCount 调用计数增强踩坑记录

> 系统知识：子系统限制 & 修复记录
> 关联：`记忆系统-调用计数增强-v3精简版.md`

---

## 功能概述

给每条记忆加上 `recallCount`（召回次数）字段的全链路支持：

- 存储层：`memos` 表 `recall_count` 列 + `recall_log` 审计表
- 模型层：`MemoryMemo`/`MemoryMemoSummary` 接口 `recallCount?` 字段
- 检索层：搜索重排序 blend（relevance×0.7 + heatScore×0.3）
- 冷热升降级：降级优先 `recall_count ASC`
- 展示层：TUI `/memory` 列表和详情页 + MemoryLookup 工具输出

---

## 踩坑记录

### 坑 1：TUI 渲染在打包产物里，改源文件不生效

**现象：** 改完 `memory-picker.ts` 后重启 `scream`，看不到任何变化。

**原因：** `apps/scream-code` 用 `tsdown` 打包成 `dist/main.mjs`（入口）+ `dist/app-*.mjs`（业务包）。`scream` 命令指向 `dist/main.mjs`，**只改 `.ts` 源文件不会被运行时加载**，必须重建 dist。

**修复：** 每次改完 `memory-picker.ts` 或其他 TUI 代码后，跑 `tsdown` 重建：
```
cd apps/scream-code
node ../../node_modules/.pnpm/tsdown@0.22.0_.../node_modules/tsdown/dist/run.mjs
```

**排查方法：** 查 dist 产物确认改动已打包：
```
grep -n 'recallCount\|召回' dist/app-*.mjs
```

### 坑 2：`> 0` 守卫导致功能完全不可见

**现象：** 所有记忆都不显示 `召回N` 标识。

**原因：** 渲染代码用了 `(memo.recallCount ?? 0) > 0 ? '召回N' : ''`，但所有旧记忆的 `recall_count` 默认是 0，且 `recordRecall()` 只在搜索路径触发，所以条件永远不成立。

**修复：** 去掉 `> 0` 条件，始终显示 `召回${String(memo.recallCount ?? 0)}`。用户看到 `召回0` 自然会期待后续自增。

### 坑 3：运行时入口是另一个目录

**现象：** 明明改了 `D:/AI/ScreamCode/apps/scream-code/dist/`，重启后仍然是老代码。

**原因：** `which scream` 返回 `/d/reasonix/scream`，入口文件是 `/d/reasonix/node_modules/scream-code/dist/main.mjs`。pnpm workspace 会把 `D:/AI/ScreamCode/apps/scream-code` link 到 `/d/reasonix/node_modules/scream-code`，**但 link 的是目录，不是具体文件**——dist 需要重建后 watch 才会自动同步。

**修复：** 在源项目目录重建 dist 后，workspace link 侧的文件会自动更新。但如果有 `pnpm install` 重装，link 会被覆盖。

**排查方法：** 先查 `which scream` 确认入口路径，再查 `ls -la /d/reasonix/node_modules/scream-code/dist/` 确认时间戳是否匹配重建时间。

### 坑 4：`pnpm -C apps/scream-code run build` 在 Git Bash 中失败

**现象：** `pnpm run build` 触发 `prepare` 脚本，但子进程找不到 `node`。

**原因：** Git Bash 的 PATH 经过多层封装，`prepare` 脚本的 shell 继承的 PATH 不包含 `C:\Program Files\nodejs`。

**修复：** 避免走 `pnpm run build`，直接调用 `tsdown` 的 JS 入口：
```
node ../../node_modules/.pnpm/tsdown@0.22.0_.../node_modules/tsdown/dist/run.mjs
```
或者显式传 PATH：
```
PATH="/c/Program Files/nodejs:$PATH" pnpm run build
```

---

## 数据流链路（排查参考）

```
SQL查询 (SELECT *) 
  → rowToMemo (row.recall_count → memo.recallCount)
  → toSummary (透传 recallCount)
  → list() / listAll() / search()
  → memory-lookup.ts (Recalls: N)
  → memory-picker.ts (召回N / 召回: N 次)
```

断裂点排查顺序：
1. 数据库是否有 `recall_count` 列？→ `migrateSchema()` 跑过了吗？
2. `rowToMemo` 是否映射了该列？
3. `toSummary` 是否透传？
4. TUI 渲染是否无条件显示？
5. dist 是否重建？
6. `which scream` 指向哪个目录？
