# MCP 服务器集成

> Scream Code 通过 MCP 协议连接第三方代码智能/搜索/文档工具。
> 所有 MCP 工具以 `mcp__<server>__<tool>` 命名，与内置工具无权重差别。

---

## 架构

```
mcp.json 配置文件                        运行时层                        MCP Server
                                                                  
~/.scream-code/mcp.json              McpConnectionManager          StdioClient → codegraph
  (用户级, 最低优先级)                  · connectAll()                (child_process spawn)
                                      · connectAndDiscoverTools()
父目录 .scream-code/mcp.json          · reconnect()/stopServer()          或
  (中间级, 继承)                                                    
                                      · shutdown()                  HttpClient → HTTP SSE
<cwd>/.scream-code/mcp.json                                        (streamable HTTP)
  (项目级, 最高优先级)        → ToolManager
                              · registerMcpServer() 
                              · 注册为 mcp__<server>__<tool> 格式
                              · 三种来源合并后字母序排列
```

### 关键代码路径

| 组件 | 文件路径 | 职责 |
|------|----------|------|
| MCP 配置 Schema | `packages/agent-core/src/config/schema.ts` | Zod schema: Stdio/HTTP 双 transport |
| Config Loader | `packages/agent-core/src/mcp/config-loader.ts` | `loadMcpServers()` 三层 merge |
| Connection Manager | `packages/agent-core/src/mcp/connection-manager.ts` | 并行连接，自动重连，OAuth |
| Stdio Transport | `packages/agent-core/src/mcp/client-stdio.ts` | 基于 child_process spawn |
| HTTP Transport | `packages/agent-core/src/mcp/client-http.ts` | 基于 StreamableHTTPClientTransport |
| Tool → Agent 注册 | `packages/agent-core/src/agent/tool/index.ts` | `registerMcpServer()` |
| TUI 管理面板 | `apps/scream-code/src/tui/commands/mcp.ts` | `/mcp` 命令 |

---

## MCP 配置层级

配置文件名为 `.scream-code/mcp.json`，三层覆盖，高层覆盖同名 server：

| 层级 | 位置 | 优先级 | 说明 |
|------|------|:------:|------|
| **用户级** | `~/.scream-code/mcp.json` | 低 | 对所有项目生效 |
| **父目录级** | 从 cwd 向上递归查找 `.scream-code/mcp.json` | 中 | 工作区级共享配置 |
| **项目级** | `项目根/.scream-code/mcp.json` | **最高** | 覆盖同名 server |

### 配置格式

```json
{
  "mcpServers": {
    "server-name": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"],
      "env": { "API_KEY": "${API_KEY}" },
      "cwd": "/path/to/workdir",
      "enabled": true,
      "startupTimeoutMs": 60000,
      "toolTimeoutMs": 30000,
      "enabledTools": ["tool1"],
      "disabledTools": ["tool3"]
    }
  }
}
```

支持 stdio 和 http 两种 transport。HTTP 模式支持 `bearerTokenEnvVar` 和 OAuth 授权。

---

## 工具类型与权重

ToolManager 管理三种来源的工具，**合并后按名称字母序排列，无权重差别**：

| 类别 | 来源 | 能否禁用 | 示例 |
|------|------|:--------:|------|
| **Builtin** | hard-coded 内置 | ❌ 不可禁用 | Read, Write, Edit, Grep, Bash, LSP, WebSearch, MemoryWrite… (31 个) |
| **User** | RPC 注册 | — | SDK/Plugin 注册的 |
| **MCP** | `mcp.json` 配置 | ✅ `"enabled": false` | `mcp__codegraph__context`, `mcp__anysearch__search` |

源码（`packages/agent-core/src/agent/tool/index.ts:680-697`）:
```typescript
get loopTools(): readonly ExecutableTool[] {
  const mcpNames = [...this.mcpTools.keys()].filter((name) => this.isMcpToolEnabled(name));
  return uniq([...this.enabledTools, ...mcpNames])
    .toSorted((a, b) => a.localeCompare(b))    // 仅按字母排序
    .map(...)  // user > mcp > builtin 依次查找
}
```

---

## 当前已配置的 MCP 服务器

| Server | transport | 用途 | 配置位置 |
|--------|-----------|------|----------|
| **context7** | stdio | 编程库/框架官方文档查询 | `~/.scream-code/mcp.json` |
| **anysearch** | http | 通用网络搜索 + 垂直领域搜索（学术/金融/法律等） | `~/.scream-code/mcp.json` |
| **codegraph** 🆕 | stdio | 代码知识图谱 — 调用链、影响域、符号查询 | `~/.scream-code/mcp.json` |

### codegraph 详情

| 属性 | 值 |
|------|-----|
| 包名 | `@colbymchenry/codegraph@1.1.0` (MIT) |
| 索引目录 | `D:\AI\ScreamCode` |
| 索引数据 | 1,018 files / 14,756 nodes / 56,747 edges / 53 MB |
| MCP 命令 | `codegraph serve --mcp` |
| GitHub | `colbymchenry/codegraph` (47.4k stars, MIT) |

#### codegraph 工具列表

| MCP 工具 | 作用 |
|----------|------|
| `codegraph_context` | 查询某个符号/区域的上下文（caller + callee + source） |
| `codegraph_explore` | 一键探索：符号源码 + 调用路径 |
| `codegraph_node` | 单个符号的源码 + 调用方/被调方跟踪 |
| `codegraph_callers` | 谁调用了此函数/方法 |
| `codegraph_callees` | 此函数/方法调用了谁 |
| `codegraph_impact` | 改动此符号的影响域分析 |
| `codegraph_query` | FTS5 全文搜索符号名 |
| `codegraph_files` | 索引中的项目文件结构 |

#### 安装记录

2026-06-24 安装流程：
1. `npm install -g @colbymchenry/codegraph` — 全局安装 CLI
2. `codegraph init D:\AI\ScreamCode` — 构建索引
3. `~/.scream-code/mcp.json` 添加 entry，`cwd` 指向 `D:\AI\ScreamCode`
4. `ZHU/.gitignore` 加 `.codegraph/` 防止 SQLite 数据库被 git 跟踪

重启 Scream Code 后自动生效（`McpConnectionManager.connectAll()`）。

---

## 注意事项

1. **MCP 启动是懒加载吗？** 不是。`connectAll()` 在**会话启动时**并行连接所有 enabled 的 MCP server，连接失败会标记为 error 状态但不会阻塞会话
2. **重启需要吗？** 已运行的会话需要重启才能加载新 MCP server
3. **工具发现**：Scream Code **没有自动发现机制**，MCP server 必须手动写入 `mcp.json`
4. **名称覆盖**：MCP 工具按 `mcp__<serverName>__<toolName>` 命名（`tool-naming.ts`），超 64 字符自动截断加 hash
5. **输出保护**：MCP 返回超过 100K 字符自动截断（`output.ts`）
