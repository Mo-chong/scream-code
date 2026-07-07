<format>
本文件使用 compact notation。key: value — 定义 | A → B → C — 流程
A / B / C — 三者任一 | val1 | val2 | val3 — 枚举
(条件) 动作 — 条件执行 | indent — 嵌套 | [P0][P1][P2] — 优先级
无连接词。每段独立解读，不依赖上下文顺序。
</format>

# Phase26 — 缓存感知架构与审查日志系统

Phase26 Phase26-cache-aware. 横跨 injection / compaction / usage / ltod 四个子系统的优化。目的：DeepSeek KV Cache 兼容性 + 缓存效率可观测 + 动态自适应压缩阈值。

两个缺口：P2 TUI 命中率展示（未实现）| P1 recordRound 集成缺口（已修复 2026-07-04）

## 核心数据流

LLM 响应 → openai-common.extractUsage (解析 prompt_cache_hit/miss) → TokenUsage (cacheHitTokens?/cacheMissTokens?) → handleAfterStep → computeCacheMetrics → buildAuditEntry → AuditLogWriter.write → workspace/cache-audit.ndjson

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
| AuditLogEntry | interface | turn / model / ts / cache / compacted / alerts |
| ALERT_RULES | const[] | check: hitRatio<0.2 → 告警 | hitRatio>0.8 → 静默 |
| computeCacheMetrics | (usage) → CacheMetrics | hitTokens+missTokens>0 才算，否则 hitRatio=0 |
| AuditLogWriter | class | init → write 每轮 ndjson | flush | destroy |
| buildAuditEntry | (turn,model,metrics,compacted,compactedTokens) → AuditLogEntry | 检查 ALERT_RULES | 加时间戳 |

AuditLogWriter.init(): try/catch 吞错误 — 不阻塞流程 | write(): stream 为空则静默丢弃

### turn/index.ts 集成

turn/index.ts:1722-1732 (审计日志块):
- 条件: this._lastUsage && (cacheHitTokens !== undefined || cacheMissTokens !== undefined)
- 动作: computeCacheMetrics → buildAuditEntry → auditLogger.write → lastCompactedTokens 重置

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

## P2 — 未实现

TUI usage-panel 缓存命中率展示。格式: `⚡ usage: 12.4K in / 1.2K out | 缓存命中率: 66%`

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