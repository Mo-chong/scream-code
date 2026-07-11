#!/bin/sh
# guard-bundle-stale.sh — 检查 scream-code bundle 是否过期
#
# 检测逻辑：
#   1. 找到 dist/main.mjs
#   2. 从中解析出 app-*.mjs bundle 文件名
#   3. 用 find -newer 检查 agent-core/src 和 scream-code/src 的 .ts 源码
#   4. 任何源码比 bundle 新 → exit 2
#
# 退出码：0=通过  1=警告  2=错误

set -e
cd "$(dirname "$0")/../.."

DIST="apps/scream-code/dist"
MAIN="$DIST/main.mjs"

if [ ! -f "$MAIN" ]; then
  echo "🔴 [guard] 入口文件 main.mjs 不存在。请先构建入口包。"
  exit 2
fi

# 从 main.mjs 中解析 bundle 文件名（支持 import() 和 import from）
BUNDLE=$(grep "import.*app-.*\.mjs" "$MAIN" 2>/dev/null | sed "s/.*[\"']\(.*\)[\"'].*/\1/")
BUNDLE_PATH="$DIST/$BUNDLE"

if [ ! -f "$BUNDLE_PATH" ]; then
  echo "🔴 [guard] bundle $BUNDLE 不存在。请先构建："
  echo "    node node_modules/tsdown/dist/run.mjs --config apps/scream-code/tsdown.config.ts"
  exit 2
fi

# 检查源文件是否有真实改动（用 git diff，不用 find -newer）
# Git on Windows 的 checkout/merge/stash 会覆写所有文件 mtime，
# 导致 find -newer 假阳性拦截 commit。git diff 只比较内容变更。
SRC_CHANGED=$(git diff HEAD --name-only -- packages/agent-core/src apps/scream-code/src 2>/dev/null | grep '\.ts$' | head -10)

if [ -n "$SRC_CHANGED" ]; then
  echo "🔴 [guard] 以下源文件有未构建的变更，但 bundle 未更新："
  echo "$SRC_CHANGED" | sed 's/^/  /'
  echo ""
  echo "使用 scream-dev 自动重建："
  echo "  ./bin/scream-dev"
  echo ""
  echo "或手动重建："
  echo "  node node_modules/tsdown/dist/run.mjs --config apps/scream-code/tsdown.config.ts"
  exit 2
fi

echo "✅ [guard] bundle 为最新（$BUNDLE）"
exit 0
