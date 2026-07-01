---
tags: [type/changelog, status/final, domain/system]
---

# Scream Code 版本更新记录

> 记录上游 LIUTod/scream-code 各版本的新功能、修复和 API 变更，以及二开 fork (Mo-chong/scream-code) 的本地定制改动。
> 当前本地版本：v0.7.6（合并于 2026-06-30）

---

## v0.7.6 — 子 Agent 模型绑定（2026-06-30 合并）

### 新功能
- `/model diy subagent bindings` — 运行时为不同子 agent 指定不同模型（如 `/model agent=diy planner=gpt-4`）
  - 路径：`packages/agent-core/src/session/subagent-host.ts`
  - API：新增 `setSubagentModelBindings` hook，将 /model diy 配置路由到子 agent 创建路径
- `per-subagent usage display` — TUI 中实时显示每个子 agent 的 token 用量
- `delegation prompt tuning` — 子 agent 委派 prompt 优化，上下文传递更精准

### 修复
- fix(tui): wire /model diy bindings to subagent spawn path
- fix(tui): /tasks 卡死修复
- fix(tui): plan mode 提示重设计
- fix(tui): 呼吸时序同步
- README 多处更新（章节标题调整 + 功能补充）

### 二开兼容
- 合并冲突 12 个，其中 10 个已自动/手动解决
- `alwaysBundle` 配置完好，本地注入系统/配额调度不受影响
- 踩坑 #39-#41 记录在 `SYSTEM/pitfalls.md`

---

## v0.7.5 — 持久化与交互增强

### 新功能
- `fusion-plan 持久化` — Plan 策略跨会话保留
  - 路径：`apps/scream-code/src/tui/utils/fusion-plan.ts`
  - API：`SCREAM_FUSIONPLAN_TIMEOUT_SECONDS` 环境变量（30..3600s）
- `/like 命令` — 快速记录用户偏好/人设偏好
  - 路径：`apps/scream-code/src/tui/commands/like.ts`
- `FusionPlanStatus` 实时组件 — TUI 中计划状态实时显示

### 修复
- fix(fusion-plan): timeout 可配置
- fix(fusion-plan): 进程树清理（`taskkill /T` on Windows / `kill(-pgid)` on POSIX）
- fix(profile): 保留子 agent role instructions 同时注入用户偏好
- fix(update): 优先用 fresh npm 版本检查而非缓存
- fix(startup): 在 loading splash 内预取更新检查
- fix(fusion-plan): 移除 --yolo 冲突

---

## v0.7.4 — TUI 大版本优化

### 新功能
- **状态机优化与风暴守护者** — TUI 状态流转更稳定，异常风暴自动防护
- **model thinking level 同步** — think level 在 TUI 中实时显示 effort 标签
- **gradient sheen + ping-pong breathing** — 加载动画升级：渐变色呼吸光效
- **gradient subtitle/prompt + logo-prompt 间距** — UI 美化
- **render batching + container caching** — TUI 渲染批处理减少重绘

### 依赖
- bump `pi-tui` to 0.80.2 + migrate patches

---

## v0.7.3 — 安全与防死循环

### 新功能
- **noop-loop-guard** — 防止无操作死循环
  - 路径：`packages/agent-core/src/tools/builtin/file/noop-loop-guard.ts`
  - 机制：检测到连续 noop 步骤时自动终止循环，防止无限占用量化窗口
- **secret obfuscation** — 日志/输出中对敏感信息自动掩码
  - 路径：`packages/agent-core/src/agent/secrets.ts`
  - 机制：通过正则匹配 API Key、Token 等敏感模式，替换为 `***`

### 依赖
- bump 各类依赖版本

---

## v0.7.2 — 二开 fork 基点

上次成功合并上游的版本，也是本二开 fork (Mo-chong/scream-code) 的主要分叉点。
