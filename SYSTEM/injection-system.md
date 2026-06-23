# 注入系统 — Injection System

---

## 两种注入底层

### appendUserMessage() (context/index.ts:75-81)

```typescript
this.appendMessage({ role: 'user', content, origin });
```
- role = user — 普通用户消息
- AI 可以忽略
- `/memory` + `i` 键就是用这个

### appendSystemReminder() (context/index.ts:83-91)

```typescript
const text = `<system-reminder>\n${content}\n</system-reminder>`;
this.appendMessage({ role: 'user', content: [{ type: 'text', text }], origin });
```
- 虽然 role 也是 user，但包装了 `<system-reminder>` 标签
- 大模型训练时将 `<system-reminder>` 视为系统指令级别
- 优先级远高于普通用户消息

---

## inject() 三种优先级 (turn/index.ts:1351-1435)

| 调用方式 | 底层方法 | 穿透预算 | 适用范围 |
|----------|----------|:--------:|----------|
| `inject(text, { kind: 'system_trigger' })` | appendSystemReminder | ✅ | 收敛门、规则注入 |
| `inject(text, { kind: 'injection', variant: 'xxx' })` | appendSystemReminder | ❌ | 普通行为注入 |
| `sendNormalUserInput(text)` | appendUserMessage | N/A | `/memory` + i 键 |

### system_trigger 的穿透路径 (line 1356-1359)

直接返回，不走 budget、残差、去重、衰减。

### 普通 injection 的 5 重过滤 (line 1368-1428)

1. **重复衰减**：同 variant 触发 5+ 次 → skip
2. **残差注意力**：还够注意力时跳过（Phase 9）
3. **步级去重**：同一步同 variant 只注入一次
4. **预算检查**：estimatedTokens > budget → skip
5. **VariantRegistry 注册**：成功后记录变体注册信息

---

## InjectionManager (injection/manager.ts:62 行)

回合开始时的注入器集合（在 runOneTurn 之前执行）：

```
PluginSessionStartInjector
WolfPackModeInjector
PlanModeInjector
PermissionModeInjector
TodoListReminderInjector
GoalInjector
WorkingSetInjector
```

这些在回合开始时运行，注入模式提示。我们的规则注入计划在 runOneTurn 内部（line 454 之后）。

---

## 关键限制

- injectBudget 在 runOneTurn 开头 reset（line 449）
- 偏差链激活时 bypassBudget（line 1410）
- system_trigger 不经过 variant 去重，但数量仍然消耗上下文 token 空间
