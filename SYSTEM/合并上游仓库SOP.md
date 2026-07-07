<!-- maintain: SYSTEM/系统说明书维护SOP.md -->
# 合并上游仓库 SOP（AI 执行手册）[P0]

> **用途**: 二开 fork 合并上游作者仓库，AI 按此流程执行，用户逐条确认。
> **版本通用**: 同一份 SOP 适用于任何版本（v0.8→v0.9→v0.10...），只改 `$上次合并tag` 值。
> **不是给人看的说明书** — 指令式，每段可直接执行。

---

## §0 本次合并变量 [P0]

```
$上次合并tag  = v0.8.5               ← 上次合到的 tag
$上游remote   = origin                ← 上游作者仓库
$本地remote   = mochong               ← 二开 fork 仓库
$合并分支     = merge/upstream        ← 合并用的临时分支名（固定名，每次都一样）
$构建命令     = bash scripts/build-dev.sh
$验证命令     = bash scripts/guards/check-all.sh
$包安装命令   = pnpm install
```

**SOP 执行前**: 把 `$上次合并tag` 改成当前值，其余不改。本次用完不删，下次改 tag 重复用。

---

## §1 预分析 [P0]

### 1.1 创建合并分支

```bash
git fetch $上游remote
git checkout -b $合并分支 $上游remote/main
```

### 1.2 列出上游改动

```bash
# 上游自上次合并以来所有 commit
git log --oneline --no-merges $上次合并tag..$上游remote/main
```

**→ 展示给用户**: "上游共 N 个 commit：`<列表>`。是否继续合并？[y/N]"

用户 N → `git checkout main && git branch -D $合并分支` 退出。

用户 y → 继续。

### 1.3 拉入本地代码暴露冲突

```bash
git merge $本地remote/main
```

**如果无冲突** → 跳到 §4（验证收尾）

**如果有冲突** → 进入 §2

---

## §2 冲突排查 [P0]

### 2.1 获取冲突文件列表

```bash
git diff --name-only --diff-filter=U
```

**→ 展示给用户**: "共 X 个冲突文件：`<列表>`"

### 2.2 对每个冲突文件做三步分析

对每个冲突文件，执行：

**Step A — 读双方改动**

```
读冲突文件 → 识别:
  <<<<<<< HEAD 到 =======       = 二开改动（本地侧）
  ======= 到 >>>>>>> $上游remote/main = 上游改动
```

**Step B — 分类冲突（6 种之一）**

| 类型 | 判定规则 | 处理规则 |
|------|---------|---------|
| 互补冲突 | 双方改同区域，目标功能不同 | 双方保留 |
| 替代冲突 | 一方重构/重写另一方的改区域 | 选更优方案，补回丢失功能 |
| 架构冲突 | 上游改接口签名/架构 | 以上游为基底，重实现二开逻辑 |
| 配置冲突 | 双方改同一配置项 | 按优先级矩阵 |
| 新增重叠 | 双方各自实现同名/同功能模块 | 合并接口，合并功能 |
| 删除冲突 | 上游删了本地依赖的文件 | 检查兼容性，补回缺失引用 |

**Step C — 生成建议**

格式：

```
#{序号} {文件路径} [{冲突类型}]
  上游改动: {一句话}
  本地改动: {一句话}
  建议: {处理规则 + 具体操作}
  → 等确认 [y/N]
```

### 2.3 优先级矩阵（决定处理顺序）

冲突文件按以下优先级排序：

```
P0 - packages/agent-core/**       (核心包，优先级最高)
P0 - packages/scream-code/**      (入口包)
P1 - packages/*/src/**            (业务代码，需功能分析)
P2 - packages/*/test/**           (测试文件)
P2 - scripts/guards/**            (guard 脚本 — keep-local 自动通过)
P2 - tsdown.config.ts             (构建配置 — keep-local 自动通过)
P3 - **/*.md                      (文档 — keep-upstream 自动通过)
```

### 2.4 完整冲突报告一次性展示

将所有冲突文件按 P0→P1→P2→P3 排序，一次性展示给用户：

```
冲突报告: 合并上游（基于 $上次合并tag）
总计: X 个冲突文件

--- P0 ---
#1 path/file.ts [类型]
  上游: xxx
  本地: xxx
  建议: xxx
  → 等确认 [y/N]

--- P1 ---
...

--- P2（自动处理，不需确认） ---
#N path/file.md [配置冲突] → 自动 keep-upstream

→ 请逐条确认 [y/N]
```

**用户逐条回复 y/N** → AI 立即执行该条。

---

## §3 冲突解决技术指令 [P1]

### 互补冲突 — 双方保留

```bash
# 读取文件，去掉冲突标记保留双方代码
python -c "
import re
with open('{文件路径}', 'r', encoding='utf-8') as f:
    c = f.read()
c = re.sub(r'<<<<<<< HEAD\n(.*?)\n=======\n(.*?)\n>>>>>>> [^\n]+',
           r'\1\n\2', c, flags=re.DOTALL)
with open('{文件路径}', 'w', encoding='utf-8') as f:
    f.write(c)
"
```

### 替代/架构冲突 — 取上游版本后补回

```bash
# 取上游版本
git checkout --theirs {文件路径}
# 从本地旧版本找回丢失的二开功能点
git show HEAD:{文件路径} | grep -n "{二开独有关键字}"
# 手动编辑补回
```

### 配置冲突 — 按优先级矩阵自动

- `priority_matrix` 中 `keep-local` → 不动（自动跳过）
- `keep-upstream` → `git checkout --theirs {文件路径}`

### 每解决一条 → 立即验证

```bash
# 检查冲突标记是否残留
git diff --check
# 语法检查（TS 项目）
npx tsc --noEmit --skipLibCheck {文件路径} 2>/dev/null || echo "语法需修复"
```

---

## §4 回归验证 [P1]

### 4.1 全量构建

```bash
$构建命令
```

**如果 build 失败** → 显示错误信息，修复后重试。禁止跳过。

### 4.2 全量验证

```bash
$验证命令
$包安装命令

# 关键功能冒烟
node -e "require('@scream-exam/agent-core')"
node -e "require('@scream-exam/memory')"
```

### 4.3 提交

```bash
git add -A
git commit -m "merge: 合并上游（基于 $上次合并tag）"
git tag merge-$上次合并tag
```

### 4.4 合入 main

```bash
git checkout main
git merge $合并分支 --no-ff
git push $本地remote main --tags
```

### 4.5 清理

```bash
git branch -D $合并分支
```

---

## §5 回滚（出事用）[P1]

| 场景 | 命令 |
|------|------|
| 冲突解到一半放弃 | `git merge --abort && git checkout main && git branch -D $合并分支` |
| 已 commit 未 push | `git reset --hard HEAD~1 && git checkout main && git branch -D $合并分支` |
| 已合入 main 未 push | `git revert --no-edit HEAD && git checkout main` |
| 已 push | `git revert --no-edit HEAD && git push $本地remote main` |

---

## §6 常见异常处理 [P2]

| 症状 | 根因 | 处理 |
|------|------|------|
| build 失败 — node not found | Git Bash PATH 无 node | 用 `build-dev.sh`，不要直接 `pnpm build` |
| build 失败 — 包名找不到 | 上游改了包名 | `$包安装命令` → `grep -r "旧包名" packages/ --include="*.ts"` → 替换 |
| 功能异常但无冲突标记 | 语义冲突（接口兼容） | 回滚 → 按 §2.2 做功能分析，手动适配 |
| 上游 force-push 历史不一致 | 上游 rebase 了 | 删 `$合并分支` → 从 `$上游remote/main` 重开分支 → cherry-pick 二开 commit |
| guard 拦截 commit | pre-commit 检测到未 build | 先 `$构建命令`，再 `git add -A && git commit` |

---

## §7 上次合并记录 [P3]

| 日期 | 版本 | 冲突数 | 关键决策 |
|------|------|--------|---------|
| 2026-06 | v0.7.2→v0.8.4 | 8 | 互补冲突双方保留 |
| 2026-06 | v0.8.5 | 6 | 架构冲突上游为基底 |
| — | _追加上次_ | — | — |

<!-- EOF -->
