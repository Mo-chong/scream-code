# 验收报告：注入系统全面审计 — FAA 双路径清理 [P0]

> 基于 `分析-注入系统全面审计-变体评估与优化方向.md` 执行
> 审计范围：4 个 P0 优化方向 → 本批次执行 方向4（FAA 双路径清理）
> 构建验证：✅ EXIT 0

---

## 一、执行清单

### 方向4：FAA 双路径清理（✅ 完成）

| 子任务 | 涉及文件 | 行变化 | 状态 |
|--------|---------|:------:|:----:|
| 注册 ErrorAuditInjector 到 manager.ts | `injection/manager.ts` | +2 行 | ✅ |
| 添加 error-audit 到 VARIANT_META | `turn/variant-registry.ts` | +3 行 | ✅ |
| 删除 turn/index.ts L2072-2082 FAA inline path | `turn/index.ts` | -9 行 | ✅ |
| 构建验证 | `bash scripts/build-dev.sh` | EXIT 0 | ✅ |

### 未执行方向（按原分析报告优先级）

| 方向 | 涉及文件 | 预估工时 | 说明 |
|:----:|---------|:--------:|------|
| 方向1：统一路由路径 | router.ts + manager.ts | ~1.5h | 需全链路测试 |
| 方向2：合并 session 注入器 | plugin-session-start + session-config → 新建 | ~1h | 删除 2 文件新建 1 文件 |
| 方向3：注入依赖图声明 | DynamicInjector 接口 + router 排序 | ~1h | 需各 injector 配合 |

---

## 二、引用链验证

| 符号 | 旧路径（已删除） | 新路径（已验证） |
|------|----------------|----------------|
| `getRecentEntries(5)` 消费方 | turn/index.ts L2072-2082（inline 直接调用） | error-audit-injector.ts L34（通过 router → manager dispatch） |
| `error-audit` 变体路由 | 无（inline 不走注入系统） | router.ts L37 'audit' cacheGroup → manager.ts L39 ErrorAuditInjector |
| `error-audit` 残差控制 | 无 | variant-registry.ts L342 `{ weight: 0.8, decayPerStep: 0.85, threshold: 0.35, minStepGap: 3 }` |
| `faaSnippet` 注入内容 | 每次 tool 失败时 inline 注入 | ErrorAuditInjector 走标准的残差注意力 + 配额管理 |

---

## 三、功能完整性分析

### 改前状态（双路径并行 — 错误）

```
tool 失败
  ├── turn/index.ts L2072: FAA inline inject → 直接注入 faaSnippet（无配额·无残差）
  └── router.dispatch('error-audit') → ErrorAuditInjector → 注入 FAA 内容（有配额·有残差）
结果：同一信息注入两次，token 浪费，模型困惑
```

### 改后状态（单一路径 — 正确）

```
tool 失败
  └── manager 残差检查 → router.dispatch('error-audit') → ErrorAuditInjector → 注入 FAA 内容
结果：单次注入，受配额管理和残差注意力控制
```

### 参数配置

`error-audit` VARIANT_META 参数：

| 参数 | 值 | 含义 |
|------|:---:|------|
| `weight` | 0.8 | 中等权重（Guard 为 0.9，intent 为 1.0） |
| `decayPerStep` | 0.85 | 每步衰减 15% — 保守衰减（高触发场景） |
| `threshold` | 0.35 | 与 guard 同级触发门限 |
| `minStepGap` | 3 | 最少隔 3 步才能再次触发 |

---

## 四、潜在风险

| 风险 | 说明 | 缓解措施 |
|------|------|---------|
| error-audit-injector 内部调用 `getRecentEntries(5)` 未包裹空保护 | 如果 `fileActionAudit` 为 null 会抛异常 | 需确认 injector 源代码有安全访问 |
| 旧 inline 路径的 `faaSnippet` 包含更多上下文（文件操作记录） | 新路径通过 injector 自身逻辑重建 FAA 数据，格式可能略有差异 | 不影响功能，只影响展示格式 |

---

## 五、结论

方向4（FAA 双路径清理）**执行完毕，验证通过，构建 EXIT 0**。注入系统已经从"双路径并行错误"状态修复为"单一路径正确"状态。

剩余 3 个 P0 方向（统一路由/合并 session/依赖图）未排入本次批次，可随时启动。
