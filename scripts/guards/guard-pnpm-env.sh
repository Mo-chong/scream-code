#!/bin/sh
# guard-pnpm-env.sh — 检查 pnpm build 的先决环境
#
# 检测逻辑：
#   1. node 是否在 PATH
#   2. git 是否在 PATH
#
# 退出码：0=通过  1=警告  2=错误

set -e

echo "[guard] 检查构建环境..."

# 检查 node
NODE_PATH=$(which node 2>/dev/null || echo "")
if [ -z "$NODE_PATH" ]; then
  echo "🔴 [guard] node 不在 PATH 中。"
  echo "    pnpm prepare 脚本在 cmd.exe 中运行时需要 node 在 PATH。"
  echo "    修复方法："
  echo "      export PATH=\"\$PATH:\$(dirname \$(which node 2>/dev/null))\""
  exit 2
fi

# 检查 git
GIT_PATH=$(which git 2>/dev/null || echo "")
if [ -z "$GIT_PATH" ]; then
  echo "⚠️  [guard] git 不在 PATH 中。"
  echo "    simple-git-hooks 在 pnpm prepare 时需要 git。"
  echo "    修复：scripts/prepare.mjs 已自动注入 git bin/ 和 mingw64/bin/"
  exit 1
fi

echo "✅ [guard] 构建环境完整（node=$(basename "$NODE_PATH") git=$(basename "$GIT_PATH")）"
exit 0
