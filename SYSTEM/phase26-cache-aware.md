<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->

<format>
本文件使用 compact notation。key: value — 定义 | A → B → C — 流程
A / B / C — 三者任一 | val1 | val2 | val3 — 枚举
(条件) 动作 — 条件执行 | indent — 嵌套 | [P0][P1][P2] — 优先级
无连接词。每段独立解读，不依赖上下文顺序。
</format>

# Phase26 — 缓存感知架构与审查日志系统

Phase26 Phase26-cache-aware. 横跨 injection / compaction / usage / ltod 四个子系统的优化。目的：DeepSeek KV Cache 兼容性 + 缓存效率可观测 + 动态自适应压缩阈值。

两个缺口：P1 缓存诊断（已实现 Phase29）| P1 recordRound 集成缺口（已修复 2026-07-04）

## 核心数据流

LLM 响应 → openai-common.extractUsage (解析 prompt_cache_hit/miss) → TokenUsage (cacheHitTokens?/cacheMissTokens?) → handleAfterStep → computeCacheMetrics → buildAuditEntry → AuditLogWriter.write → workspace/cache-audit-YYYY-MM-DD.ndjson

第二轮后：predictor.recordRound(totalInput) → GrowthPredictor (recentRounds) → strategy.shouldCompact (优先用 predictor，fallback triggerRatio)

## 模块依赖

audit-log → @scream-code/ltod (TokenUsage) | predictor → 纯 TS | strategy → predictor + message | turn/index → audit-log + strategy + full | openai-common → ltod/usage (TokenUsage)

## P0 — 核心修复

### position-strategy 注入位置修正

position-strategy.ts:29 / position-strategy.ts:37

WeightLevel:
- S: 'head' (不变)
- A: 'head' (从 'near_head' 改) — [P0] 原来在 Math.floor(length/3)，破坏 2/3 缓存前缀
- feedback_ / post_ / step_after_: 'tail' (从 'near_head' 改) — [P0] 高频变化类放末尾，不影响公共前缀
- B / C / D: 'tail' (不变)

缓存破坏范围缩小 ~55%。对任何有前缀缓存的模型都有效。

### DeepSeek 缓存字段解析

openai-common.ts:242-254

LLM 响应 usage 对象:
- prompt_cache_hit_tokens: number (DeepSeek 独有) → cacheHitTokens?: number
- prompt_cache_miss_tokens: number (DeepSeek 独有) → cacheMissTokens?: number

不检查模型名。任何返回这两个字段的 API 自动识别。没有字段不走此逻辑，不报错。

## P1 — 缓存审计日志

### audit-log.ts (新增文件，163 行)

| 导出 | 类型 | 用途 |
|------|------|------|
| CacheMetrics | interface | hitRatio / hitTokens / missTokens / totalInput |
| AuditLogEntry | interface | sessionId / turn / model / ts / totalInput / cacheHit / cacheMiss / hitRatio / compacted / compactedTokens / alerts / injected |
| ALERT_RULES | const[] | check: hitRatio<0.2 → 告警 | hitRatio<0.3 → 低警告 | hitRatio>0.8 → 静默 |
| computeCacheMetrics | (usage) → CacheMetrics | hitTokens+missTokens>0 才算，否则 hitRatio=0 |
| AuditLogWriter | class | init → write 每轮 ndjson 按日轮转 | flush | destroy |
| buildAuditEntry | (turn,model,sessionId,metrics,compacted,compactedTokens,injectedVariants?) → AuditLogEntry | 检查 ALERT_RULES | 加时间戳 |

AuditLogWriter.init(): try/catch 吞错误 — 不阻塞流程 | write(): stream 为空则静默丢弃

### turn/index.ts 集成

turn/index.ts:1722-1732 (审计日志块):
- 条件: this._lastUsage（移除 cacheHitTokens/missTokens 非空限制，?? 0 兜底）
- 动作: computeCacheMetrics → buildAuditEntry(..., injectedNames) → auditLogger.write → lastCompactedTokens 重置

turn/index.ts:1733-1738 (predictor 块):
- 条件: this._lastUsage (不限模型)
- 动作: strategy.recordRound(totalInput) — 通用 token 投喂

### full.ts 跟踪

full.ts:70: lastCompactedTokens = 0 (class field)
full.ts:432: this.lastCompactedTokens = tokensBefore - tokensAfter (applyCompaction 成功后)

handleAfterStep 读此值 → 写入审计日志 → 重置为 0。

## P1 — 动态自适应阈值

### predictor.ts (新增文件，38 行)

GrowthPredictor:
- recordRound(tokensUsed): number — 记录到 recentRounds (max 10)
- predictNextGrowth(): number — 最近 5 轮平均增长 × 1.2 安全系数 | <2 轮返回 0
- shouldCompact(currentUsage, maxSize): boolean — currentUsage + predictedGrowth > maxSize × 0.85

### strategy.ts 集成

CompactionStrategy 接口: recordRound(tokensUsed): void (新增方法签名)
DefaultCompactionStrategy:
- recordRound: 委托 this.predictor.recordRound
- shouldCompact: 优先用 predictor | predictor 返回 false → fallback triggerRatio(0.75)

### keepRecentMessages 调优

micro.ts:20: keepRecentMessages: 30 (从 20 改)

## P1 — 缓存诊断日志（Phase29）

### AuditLogEntry.injected 字段

audit-log.ts:17: `injected: string[]` — 本轮注入成功的变体名列表，空数组表示无注入。

数据流: dispatch() 末尾保存 `_lastInjectResults` → getLastInjectResults() 暴露 → turn/index.ts afterStep 读取 → buildAuditEntry(..., injectedNames) → ndjson

每行记录示例:
```json
{"turn":5,"injected":["guard_feedback_rule_3","post_verify_pass"],"cacheMiss":438,"hitRatio":0.997}
```

**文件头部**（每次创建新日期文件自动写入）:
```
# cache-audit — 缓存命中审计
# 用途: 诊断注入/compaction 对 KV 缓存的影响 | sessionId 按对话查 | injected 列出本轮注入变体 | hitRatio<0.3 查 alerts
# 查: grep "injected" cache-audit-*.ndjson 找出有注入的轮次
# fields: turn,model,sessionId,ts,totalInput,cacheHit,cacheMiss,hitRatio,compacted,compactedTokens,alerts,injected
```

### 缓存事故分析流程

1. `grep '"injected":\\[.*\\]' cache-audit-*.ndjson` — 找出所有有注入的轮次
2. `grep injected cache-audit-$DATE.ndjson | cut -d',' -f1,6,7,14` — 按模型/缓存率/注入分类
3. 对比同 turn 的 cacheMiss 变化判断注入影响

### 已知注入破坏等级

| 注入位置 | 变体等级 | 缓存破坏范围 | 备注 |
|---------|---------|------------|------|
| AFTER_SYSTEM(head) | S/A | 系统性提示群后全部 | 已从 near_head 修正到 head，保留 protected |
| tail | B/C/D/feedback_/post_ | ~200-300 tokens | 高频低影响，B/C 有缓存感知路由跳过 |

## P2 — 已实现（Phase29）

TUI footer 第二行缓存命中率展示: `ScreamCode\ZHU    ⚡ 单：96.9% ┃ 总：96.8%`
- AppState 字段: cacheHitTokens / cacheMissTokens / lastStepCacheHit / lastStepCacheMiss
- footer.ts: pickCacheColor() — ≥90% 绿 / 80-89.9% 黄 / <80% 红
- 左端灰色显示启动目录（末两层）

## 已修复缺口

2026-07-04: recordRound 集成缺口 — strategy.ts:58-60 定义委托，但 turn/index.ts handleAfterStep 未调用。全项目 .recordRound( 搜索仅 1 匹配（定义自身）。修复: turn/index.ts:1733-1738 加 this.strategy.recordRound(totalInput)。(P1，不影响运行时安全)

## 测试

cache-audit.test.ts (5 tests): computeCacheMetrics 全 miss / 全 hit / 空 / 混合 / 零总量
predictor.test.ts (6 tests): GrowthPredictor 空历史 / 单点 / 稳定 / 突增 / shouldCompact / 无历史 fallback
strategy-threshold.test.ts (4 tests): DefaultCompactionStrategy triggerRatio / 预测器优先 / 预测器否决 / 平坦

## 数据流全链路

用户输入 → messages → injection (position-strategy) → context build → LLM API → openai-common extractUsage → TokenUsage (含 cacheHit/cacheMiss) → turn afterStep → {
  [cache字段存在] computeCacheMetrics → buildAuditEntry → AuditLogWriter.write(ndjson)
  [通用] strategy.recordRound(totalInput) → GrowthPredictor 更新历史
} → (full compaction 触发时) lastCompactedTokens = tokensBefore - tokensAfter