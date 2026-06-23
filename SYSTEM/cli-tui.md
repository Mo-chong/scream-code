# CLI/TUI 层交互

> 源码: `apps/scream-code/src/tui/`

---

## 命令调度链路

```
用户输入 /memory
  → dispatch.ts:153 dispatchInput()
    → executeSlashCommand()
      → handleBuiltInSlashCommand() case 'memory'
        → handleMemoryCommand()        (commands/memory.ts:6)
          → host.showMemoryPicker()    (commands/memory.ts:6)
            → scream-tui.ts:783 showMemoryPicker()
              → dialogManager.showMemoryPicker()  (dialog-manager.ts:173)
                → new MemoryPickerComponent({       (memory-picker.ts)
                    store, memos, ...
                    onInject: (memo) => host.sendNormalUserInput(...)
                  })
```

---

## /memory 命令 + i 键注入（memory-picker.ts:241）

```
按 i 键
  → ch === 'i' → this.onInject(memo)     (line 241-247)
    → dialog-manager.ts:207-208
      → host.sendNormalUserInput(formatMemoryMemoForInjection(memo))
        → formatMemoryMemoForInjection()   (memory.ts:9-34)
          生成结构化 Markdown
```

### 格式化的记忆文本 (memory.ts:16-31)

```
[用户从记忆备忘录中注入了以下历史记录]

## 历史备忘录 #memo-xxx

- **用户需求**: xxx
- **执行方案**: xxx
- **完成结果**: xxx
- **踩坑记录**: xxx
- **成功经验**: xxx
- **来源会话**: xxx
- **记录时间**: xxx

---
请参考以上历史经验来处理当前问题。特别注意踩坑记录中的错误不要重犯。
```

⚠️ 这是 `sendNormalUserInput()` 注入的—普通用户消息级别。

---

## 关键文件

| 文件 | 作用 |
|------|------|
| `commands/memory.ts` | `/memory` 命令处理 + 格式化 |
| `commands/dispatch.ts` | 所有斜杠命令调度 |
| `components/dialogs/memory-picker.ts` | TUI 选择器 UI + 键盘交互 |
| `managers/dialog-manager.ts` | 弹窗管理 + onInject 回调 |
| `scream-tui.ts` | TUI 主入口 |

---

## MemoryPicker 键盘操作

| 键 | 操作 |
|:--:|------|
| ↑↓ | 导航 |
| Enter | 查看详情 |
| **i** | **注入到当前对话** |
| d | 删除（需确认） |
| / | 搜索过滤 |
| Esc | 关闭 |

---

## 新版标签图标（2026-06-22 新增）

### 函数源码 (memory-picker.ts:108-116)

```typescript
function memoBadges(tags: string[] | undefined): string {
  if (!tags || tags.length === 0) return '';
  const icons: string[] = [];
  if (tags.includes('baohu')) icons.push('🔒');
  if (tags.includes('ding'))   icons.push('📌');
  if (tags.includes('chundu')) icons.push('🧠');
  return icons.length > 0 ? icons.join('') : '';
}
```

### 显示位置

**列表模式**：标题行尾部，紧跟在时间之前：

```
  ► 声称测试通过必须检查 exit code  🔒📌🧠    2分钟前  手动记录
```

**详情模式**：「状态: 🔒📌🧠」行，在「标签:」行之前。

### 映射表

| 标签 | 图标 | 含义 |
|:----:|:----:|------|
| `baohu` | 🔒 | 保护 — dream 不碰 |
| `ding` | 📌 | 置顶 — 搜索优先 |
| `chundu` | 🧠 | 纯度规则记忆 |

### 需要重启

改源码后需要 `cd apps/scream-code && pnpm build` 重新编译才能看到图标。
