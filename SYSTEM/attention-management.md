---
tags: [type/reference, domain/system, status/final]
---

# 注意力管理

> 注意力管理是系统对模型注意力"往哪看、看多久、是否真的看了"的显式干预机制。
> 与上下文管理（"往上下文窗口塞什么"）是互补但不同的维度。
>
> 核心管控链路：ResNet 残差调度（Phase 9）→ InjectBudget 预算（Phase 9）→ VariantScheduler 配额（Phase 22.3）→ Behavior 观察闭环（Phase 15）

---

## 注意力管控架构图

```
回合开始
│
├─ [Phase 15] 行为观察重置 ←──────────────────────────────┐
│   resetObservedBehaviorViolations()                      │
│   检测模型是否遵守了上回合的注入提醒                      │
│   已遵守 → 降低同变体后续注入强度 / 重置违规计数          │
│   未遵守 → 保留 escalate 路径                             │
│                                                          │
├─ [Phase 9] ResNet 残差注意力调度                          │
│   variant-registry.ts                                    │
│                                                          │
│   ┌─────────────────────────────────────────────┐        │
│   │ 每变体注册: R = W × D^Δs                    │        │
│   │  W (weight)    = 出厂权重（0-1）            │        │
│   │  D (decay)     = 衰减率（0.80）             │        │
│   │  Δs            = 距上次触发步数              │        │
│   │  T (threshold) = 触发阈值（0.40）           │        │
│   │                                             │        │
│   │  R < T ？→ 不触发（注意力还够，别打扰）     │        │
│   │  R ≥ T (刚刚越线)？→ 短文本（full→sparse）  │        │
│   │  R 远大于 T？→ 完整文本                     │        │
│   └─────────────────────────────────────────────┘        │
│                                                          │
├─ [复读衰减] repeatDecay()                                │
│   同变体本回合触发 ≥5 次 → 自动跳过                     │
│                                                          │
├─ [VariantScheduler] 配额调度（Phase 22.3）               │
│   injection/manage.ts                                    │
│   每变体配额 = floor(perTurnMax / priority)              │
│   超配额 → skip（quota-based throttling）                │
│                                                          │
├─ [InjectBudget] 回合级预算（Phase 9）                    │
│   injectors/budget.ts                                    │
│                                                          │
│   ┌─────────────────────────────────────────────┐        │
│   │ perTurnMax / perStepMax 权重分级            │        │
│   │ S: 800/250 (最高优先级)                     │        │
│   │ A: 600/200                                   │        │
│   │ B: 500/150                                   │        │
│   │ C: 300/100                                   │        │
│   │ D: 200/80 (最低优先级)                      │        │
│   │                                             │        │
│   │ stepNorm = 1 + 1/(step+1)                   │        │
│   │   → step 1 最宽裕(1.50)，step 10+ 趋近 1.0  │        │
│   │ degradationFactor = max(0.4, 1-N×0.1)       │        │
│   │   → 变体越多新增注入价值越低，总预算衰减    │        │
│   │                                             │        │
│   │ 穿透预算: system_trigger / quality_escalate │        │
│   │ 毒性绕过: deviationChainActive → bypass     │        │
│   └─────────────────────────────────────────────┘        │
│                                                          │
├─ [Guard Engine] 行为验证                                │
│   turn/guard-engine.ts                                   │
│   工具调用后验证模型行为是否违反约束                      │
│   违例 → 阻断/警告/注入 escalate                          │
│                                                          │
├─ [质量检测器] 回合输出评估                              │
│   detectors/quality.ts + detectors/intent.ts             │
│   检测输出偏差 → 下回合注入纠正                          │
│                                                          │
├─ [Confabulation Detection] 反事实检测                   │
│   检测模型是否编造了工具输出或文件内容                    │
│   confidence ≥ 3 → confabulationBlocked = true           │
│                                                          │
├─ [Step反馈注入] 步级实时修正                           │
│   injectStepAfterVariants():                             │
│   ├─ editNotPrecededByLsp → "先查调用方"                 │
│   ├─ searchWithoutFollowUpEdit → "找到引用点了"          │
│   └─ verifyFailed → "不准降低标准"                       │
│                                                          │
└─ [注入器状态收集] Phase 22.2                            │
    collectInjectorFacts()                                 │
    每步结束后收集所有变体的注入状态 → 结构化 flat facts   │
    → 作为下回合 composeContextMessages 的输入              │
```

---

## 核心机制详述

### 1. ResNet 残差注意力调度（Phase 9）

**文件：** `turn/index.ts` L1484-1501 + `variant-registry.ts`

**公式：**

```
R = W × D^Δs
  R < T → 跳过（注意力残差还够，不要打扰模型）
  R ≈ T → 短文本 sparse（刚刚越线，轻轻提醒）
  R ≫ T → 完整文本 full（注意力用完了，必须注入）
```

**设计意图：** 注意力是有限的。如果某个提醒刚注入过（Δs 小），R = W × D^1 可能还低于阈值，此时不触发——避免在模型还在关注该领域时重复打扰。随着步数增加（Δs 大），R 衰减到低于阈值，此时模型注意力已从该领域移走，需要重新注入。

**与 Attention Budget 的协作：** ResNet 决定"是否应该触发"（注意力维度），Budget 决定"是否有预算承载"（资源维度）。两者是 AND 关系——都通过才能注入。

### 2. 行为观察降级（Phase 15）

**文件：** `turn/index.ts` L1601

**机制：** 每个注入提醒注入后，系统在后续步骤中检测模型是否"注意到了"该提醒。检测方式：
- Guard Engine 验证工具调用行为是否合规
- 编辑前是否查了 LSP（`step_after_edit` 变体依赖）
- 搜索后是否跟了编辑（`step_after_search` 变体依赖）
- 验证失败后是否修复（`step_after_verify_fail` 变体依赖）

已观察到的行为 → 重置同变体的跨回合违规计数，降低后续注入强度。

### 3. VariantScheduler 配额调度（Phase 22.3）

**文件：** `injection/manage.ts`

**机制：** 每个变体有配额上限（per-turn 最大注入次数）。超配额后自动 skip，防止单变体注入风暴。整个对话维护每个变体的注入计数。

### 4. InjectBudget 回合级预算

**文件：** `injectors/budget.ts`

**多级预算：**

| 级别 | perTurnMax | perStepMax | 适用场景 |
|------|-----------|-----------|---------|
| S | 800 | 250 | 毒性/安全/强制约束 |
| A | 600 | 200 | 核心行为规则 |
| B | 500 | 150 | 质量提醒/意图提醒 |
| C | 300 | 100 | 信息性提醒/MOC 维护 |
| D | 200 | 80 | 观察性/统计类 |

**衰减机制：**
- `stepNorm`: 步号越大 perStep 上限越紧
- `degradationFactor`: variant 越多总预算越低（边际收益递减）

### 5. Guard Engine 行为验证

**文件：** `turn/guard-engine.ts`

在工具调用后运行，验证模型行为是否违反约束。验证失败路径：
```
违例 → 注入违例提醒 → 模型得到纠正 → 重试 → 再次违例 → escalate
```

### 6. 质量检测器

**文件：** `detectors/quality.ts` + `detectors/intent.ts`

- Quality Detector: 检测输出是否偏离质量标准 → 注入 quality_escalate_ 变体（穿透预算）
- Intent Detector: 检测用户意图是否变化

### 7. Confabulation Detection（反事实检测）

在 afterStep 中运行，基于工具调用签名和上下文快照检测模型是否编造了工具输出。`confidence ≥ 3` 时设置 `confabulationBlocked = true`，阻止后续基于错误前提的推理。

### 8. Step 反馈注入（步级实时修正）

**文件：** `turn/index.ts` L1640-1657

每步结束后根据工具调用模式注入对应提醒：

| 模式 | 触发条件 | 注入文本 |
|------|---------|---------|
| `step_after_edit` | 编辑了代码文件但本步未查 LSP | 首次："编辑完成。在继续前先用 LSP.references"；重复："编辑前必须先查 LSP.references 找调用方" |
| `step_after_search` | 搜索到结果但本步未编辑 | "找到引用点了。设计好改动方案后再编辑。" |
| `step_after_verify_fail` | 验证失败 | "验证失败后必须修复根因重新跑完整验证，不准降低验证标准。" |

---

## 关键代码位置

| 机制 | 文件 | 行号 |
|------|------|------|
| ResNet 残差决策 | `turn/index.ts` | L1484-1501 |
| 短文本 sparse | `turn/index.ts` | L1498-1500 |
| 复读衰减 repeatDecay | `turn/index.ts` | L1478-1482 |
| 步级去重 | `turn/index.ts` | L1504-1513 |
| VariantScheduler 配额 | `turn/index.ts` | L1515-1523 |
| Budget 检查 | `turn/index.ts` | L1544-1552 |
| InjectBudget 实现 | `injectors/budget.ts` | 全部 |
| Guard Engine | `turn/guard-engine.ts` | 全部 |
| 反事实检测 | `turn/index.ts` | L1586-1598 |
| 行为观察重置 | `turn/index.ts` | L1601-1602 |
| Step 反馈注入 | `turn/index.ts` | L1640-1657 |
| 注入器状态收集 | `injectors/facts.ts` | 全部 |
| 质量检测器 | `detectors/quality.ts` | 全部 |
| 意图检测器 | `detectors/intent.ts` | 全部 |
| Variant 注册表 | `variant-registry.ts` | 全部 |

---

## 注意力管控 vs 上下文管理

| 维度 | 注意力管理 | 上下文管理 |
|------|-----------|-----------|
| 关注 | 模型"是否注意到"了信息 | 上下文窗口中有"哪些"信息 |
| 核心手段 | ResNet 残差调度、Budget、Quota | 注入、压缩、消息列表排序 |
| 检测维度 | 行为是否被观察、注意力是否衰减 | token 用量、窗口大小 |
| 事后/事前 | 事前调度 → 事后验证 | 事前注入 → 事后压缩 |
| 责任 | 模型没注意到 → 系统策略调整 | 模型没看到 → 是注入问题 |

---

## 已知问题

1. **注入位置盲区**：所有注入都在消息列表末尾追加，不考虑 U 形注意力曲线（开头和结尾注意力高、中间低）。ResNet 控制"是否触发"但不控制"插在哪里"
2. **全量压缩即遗忘**：LLM 摘要后，之前注入的所有提醒丢失，模型注意力被重置
3. **feedback_positive 注入风暴**：单变体连续触发数十次但没有内容变化的降温机制（ResNet 的 decay 只按步数衰减，不按"内容是否重复"）
4. **无模型层注意力利用**：未利用 Attention Sink（~80% 注意力在起始 token）、Lost-in-the-Middle 等 Transformer 注意力特性做 prompt 优化

---

## 相关文件

- [[turn-control]] — 回合控制与 Attention Budget 定义
- [[injection-system]] — 注入系统总揽
- [[guard-engine]] — Guard Engine 行为验证
- [[API-REFERENCE]] — ResNet 变体注册表全表（L520-560）
- [[architecture-overview]] — 整体架构
- [[context-management]] — 上下文管理（互补模块）
