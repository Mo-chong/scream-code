<!-- maintain: 系统说明书维护SOP → SYSTEM/系统说明书维护SOP.md -->
# SYSTEM/ 模块地图

> SYSTEM/ 目录的文件结构、模块归属和文件职责。AI 用于快速定位新功能归属哪个模块。
> 新增文档时请在此注册。

```
├─ 接口手册
│   └─ API-REFERENCE.md           — 函数签名/类型定义/调用关系/配置项

├─ 执行架构
│   ├─ turn-control.md            — 回合生命周期/收敛门/工具优先级
│   ├─ injection-system.md        — 注入/残差调度/阈值衰减
│   ├─ attention-management.md    — 注意力管理
│   ├─ guard-engine.md            — Guard触发时机/反事实检测
│   └─ prompt-assembly.md         — 模板渲染/AGENTS合并/注入链路

├─ AGENTS 架构
│   └─ agents-hierarchy.md         — 三层加载链(.git→projectRoot→dirs→collect→budget) + 四维评估 + 语言规范

├─ 上下文管理
│   ├─ context-management.md      — 四层架构总览(Archive/Micro/Full/Bash降噪)
│   ├─ compaction.md              — FullCompaction/MicroCompaction触发条件
│   └─ phase26-cache-aware.md     — DeepSeek KV缓存感知(注入位置/审计日志/自适应阈值)

├─ 记忆系统
│   ├─ memory-store.md            — SQLite+FTS5+vec0存储/混合评分/热冷升降
│   ├─ dream.md                   — Dream整理/保护标签/合并流程
│   └─ classifiers/               — 价值分类器(v0.8.5) + 类别标签推断

├─ MCP + 构建
│   └─ mcp-server.md              — MCP server配置/工具类型/权重

├─ CLI/TUI
│   └─ cli-tui.md                 — dispatch→scream-tui→dialog链路

├─ 拦截日志
│   └─ interception.md            — 环形缓冲区/W驱动采样/磁盘持久化

├─ 经验库
│   ├─ pitfalls.md                — 踩坑记录(构建链/FTS5/合并等)
│   ├─ CHANGELOG.md               — 版本变更日志
│   ├─ 系统说明书维护SOP.md       — AI更新文档的标准流程(SOP)
│   └─ 合并上游仓库SOP.md         — 二开合并上游的标准流程(SOP)

├─ 专题/Phase文档
│   ├─ Phase14-可执行优化.md       — afterStep分段/收敛条件数组化
│   ├─ Phase15-行为偏差拦截通道.md   — BEB通道/数据驱动配置
│   └─ architecture-overview.md   — 架构总览

├─ 索引
│   ├─ INDEX.md                   — SYSTEM/目录子索引(仅导航)
│   └─ MAP.md                     — 本文件，模块地图
```

## 新增文件流程

新建 SYSTEM/xxx.md 后必须：
1. 在本 MAP 中注册：找到对应模块子层级，追加一行
2. 在 `SYSTEM-INDEX.md` 的「索引表」加一行
3. 在 `SYSTEM/INDEX.md` 加路径引用
4. 更新 `SYSTEM-INDEX.md` 的「模块层级关系」图中对应分支