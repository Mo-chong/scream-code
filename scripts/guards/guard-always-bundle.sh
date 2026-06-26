#!/bin/sh
# guard-always-bundle.sh — 检查入口包是否已构建
#
# 检测逻辑：
#   检查 apps/scream-code/dist/ 目录是否存在
#
# 退出码：0=通过  1=警告  2=错误

set -e
cd "$(dirname "$0")/../.."

if [ ! -d "apps/scream-code/dist" ]; then
  echo "🔴 [guard] 入口包 apps/scream-code 尚未构建。"
  echo "    只 build 中间包（agent-core/memory）不够，必须 build 入口包。"
  echo "    修复：cd apps/scream-code && node ../../node_modules/tsdown/dist/run.mjs --config tsdown.config.ts"
  exit 2
fi

exit 0
