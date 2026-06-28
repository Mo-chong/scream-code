#!/usr/bin/env bash
# scripts/build-dev.sh — 一次性构建 scream-code 开发版
#
# 设计目标：
# - 绕过 pnpm lifecycle（prepare 脚本依赖 node PATH），直调 tsdown
# - 自动处理 agent-core → scream-code(alwaysBundle) 两段构建链
# - 零环境依赖（硬编码 node 完整路径）
#
# 背景：上游 LIUTod/scream-code 发 npm 编译包，
#       二开 fork 用 alwaysBundle 强制从源码打包 @scream-* 包。
#       改 agent-core 源码后必须重建两个包才生效。
#       详情见 SYSTEM/pitfalls.md > 构建卡在 prepare 脚本
set -euo pipefail

NODE="/c/Program Files/nodejs/node.exe"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "╔═══════════════════════════════════════════╗"
echo "║  Scream Code 开发构建                     ║"
echo "║  两段编译链：agent-core → scream-code    ║"
echo "╚═══════════════════════════════════════════╝"
echo ""

# === [1/2] 构建 agent-core ===
echo "━━━ [1/2] 构建 @scream-code/agent-core ━━━"
cd "$SCRIPT_DIR/packages/agent-core"
"$NODE" ../../node_modules/tsdown/dist/run.mjs
echo "✅ agent-core 构建完成"
echo ""

# === [2/2] 构建 scream-code（alwaysBundle 打包）===
echo "━━━ [2/2] 构建 scream-code（alwaysBundle → 最终产物）━━━"
cd "$SCRIPT_DIR/apps/scream-code"
"$NODE" ../../node_modules/tsdown/dist/run.mjs
echo "✅ scream-code 构建完成"
echo ""

echo "╔═══════════════════════════════════════════╗"
echo "║  🎉 全部构建完成                          ║"
echo "║  重启 scream 加载新代码                   ║"
echo "╚═══════════════════════════════════════════╝"
