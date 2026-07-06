# 审查：系统模块协调诊断与缓存优先级的统一架构方案 (v3.2)

> 一句话结论：**方案框架合理，但与当前代码处于严重脱节状态（2/8 优化已实施，文档仍标注「待执行」），路径引用多处错误，3 个核心优化子项无测试覆盖。**

---

## 1. DOCUMENT↔CODE 偏差（P0 — 执行前必须先修复）

| 偏差 | 方案说法 | 代码实际 | 影响 |
|------|---------|---------|------|
| **优化 A** — A 级注入位置 | `near_head` → `head`（Phase 1 待执行） | **✅ 已部署** `'head'` (injection/position-strategy.ts:29) | 照做会重读文件浪费时间 |
| **优化 B** — feedback/post 位置 | `near_head` → `tail`（Phase 1-2 待执行） | **✅ 已部署** `'tail'` (injection/position-strategy.ts:36-38) | 同上 |
| **路径 1** — position-strategy.ts | `src/agent/attention/position-strategy.ts` | **`src/agent/injection/position-strategy.ts`** | `attention/` 目录不存在 |
| **路径 2** — context/full.ts | `src/agent/context/full.ts` | 文件存在但方案中无 projector.ts 引用 | `context/` 包含 projector.ts，方案未提及 |

**根因**：方案文档在 Phase26 实现完成后编写的，但作者未重新读代码确认部署状态。

---

## 2. 优化路线图实际状态矩阵

方案列出 8 项优化（A-H）分 3 阶段。**当前实际状态**：

| 优化 | 方案声称阶段 | 代码实际状态 | 测试覆盖 |
|------|------------|------------|---------|
| **A** A→head 上移 | Phase 1（待执行） | **✅ DONE** | ✅ position-strategy.test.ts |
| **B** feedback→tail 降级 | Phase 1-2（待执行） | **✅ DONE** | ✅ position-strategy.test.ts |
| **C** compact 模式精简 | Phase 1（待执行） | **❌ 未实现** | ❌ |
| **D** reminder 降噪 | Phase 2（待执行） | **❌ 未实现** | ❌ |
| **E** AuditLogWriter 整合 | Phase 2（待执行） | **✅ DONE** (turn/index.ts:1722-1738) | ✅ 验收报告确认 |
| **F** 专家调用区分 | Phase 2-3（待执行） | **❌ 未实现** — injection/manager.ts 无 agent type 判别 | ❌ |
| **G** contentHash 去重 | Phase 2（待执行） | **❌ 未实现** — injection/ 无 content hash 逻辑 | ❌ |
| **H** cooldown 窗口 | Phase 3（待执行） | **❌ 未实现** — injection/ 无 cooldown 逻辑 | ❌ |

**影响**：如果按方案顺序执行 Phase 1，会先做 C 而跳过已做完的 A/B，导致"回头看"的浪费。

---

## 3. 逻辑问题

### 3.1 路径引用错误（P1）

方案 5.1、5.2、3.1 节多处引用 `attention/position-strategy.ts`。代码在 `injection/`。LSP references 和 Grep 都无法用错误路径定位代码。

**修复**：全文替换 `attention/position-strategy.ts` → `injection/position-strategy.ts`

### 3.2 诊断闭环缺失（P2）

Section 2 定义"系统模块协调诊断"机制，但：
- 未定义**回检触发器** — 谁触发诊断？什么条件下触发？
- 未定义**基准值** — 优化前缓存命中率、注入密度基线是多少？
- 未定义**退化告警阈值** — 优化后指标倒退多少算需要回滚？

**建议**：补充诊断闭环 → 基线记录 → 定期验证 → 退化告警 → 回滚/修复

### 3.3 GrowthPredictor 精度风险（P2）

`predictor.ts:22-31` 使用最近 5 轮简单平均预测增长率。方案 4.2 未讨论：
- 突发 Spikes 场景（如大段工具输出）导致预测值飙高
- 间隔时间不统一（网络延迟、思考时间）未归一化
- `safetyFactor = 1.2` 硬编码无来源依据

**建议**：考虑 EMA（指数移动平均）替代简单平均，`safetyFactor` 移至配置

### 3.4 没有回滚路径（P2）

方案列了 8 项优化，但没有任何一项定义了回滚条件或回滚步骤。一旦 C/D/F/G/H 中的某一步导致缓存命中率下降，没有恢复计划。

### 3.5 totalInjectedTokens 潜在重复计数（P3）

方案 4.1 建议在 `getContextState()` 中加 `totalInjectedTokens`。`injector.ts` 已通过 `totalWeight`（L128+）计算注入量。新增字段可能与已有数据重复。

### 3.6 position-strategy.ts 没有 variant 校验（P3）

`injection/position-strategy.ts:27-38` 通过字符串匹配 variant 分配位置。如果注入时传入了未在映射表中的 variant，`decidePosition` 返回 `'tail'`（fallback），但没有任何告警或日志。新增 variant 时很容易忘记更新映射表。

---

## 4. 优化建议

### 4.1 立即修复（执行方案前）
1. **更新状态**：Section 5 优化路线图 — A 和 B 标记 ✅ DONE，文案从"待执行"改为"已实施"
2. **修路径**：全文 `attention/position-strategy.ts` → `injection/position-strategy.ts`
3. **补 git 版本锚点**：在方案末尾加一行记录写完时已验证的 commit hash

### 4.2 执行优化前推荐做的
4. **维基线度量**：执行 C/D/F/G 前，先用 AuditLogWriter 记录当前缓存命中率/注入密度作为基线
5. **给每个优化加回滚开关**：配置化的 boolean flag，关闭后恢复旧行为
6. **priority 排序调整**：建议 C → F → G → H → D（从收益/风险比出发，compact 模式收益最大且风险最低）

### 4.3 GrowthPredictor 改进
7. 用 EMA 替代简单平均
8. 按时间间隔归一化 token 增长率
9. `safetyFactor` 从硬编码改为可配置参数

---

## 5. 结论

| 维度 | 评分 | 理由 |
|------|------|------|
| 架构合理性 | **8/10** | 分层优先级模型合理，AuditLogWriter+GrowthPredictor 设计清晰 |
| 文档准确度 | **3/10** | 2/8 优化已做文档仍标待执行，路径引用错，严重误导执行者 |
| 可执行性 | **6/10** | 步骤定义清晰，但无基线/回滚/诊断闭环 |
| 风险覆盖 | **4/10** | 无退化检测、无回滚路径、无 variant 校验 |

**总评**：方案设计框架 OK，但在实际执行前必须修复文档-代码脱节问题。建议花 30 分钟更新方案状态和路径引用，然后按 C→F→G→H→D 顺序执行剩余 5 项优化。