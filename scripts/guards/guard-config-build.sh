#!/bin/sh
# guard-config-build.sh — 检查 .yaml 配置文件的修改是否已 build
#
# 检测逻辑：
#   1. 找到 dist/main.mjs 并解析 bundle 路径
#   2. 搜索 apps/scream-code/src/ 下的 .yaml 文件
#   3. 比较每个 .yaml 与 bundle 的 mtime
#   4. 配置文件比 bundle 新 → exit 2
#
# 退出码：0=通过  1=警告  2=错误

set -e
cd "$(dirname "$0")/../.."

DIST="apps/scream-code/dist"
MAIN="$DIST/main.mjs"

if [ ! -f "$MAIN" ]; then
  echo "🔴 [guard] bundle 未构建（main.mjs 不存在），配置检查跳过。"
  exit 2
fi

BUNDLE=$(grep "import.*app-.*\.mjs" "$MAIN" 2>/dev/null | sed "s/.*[\"']\(.*\)[\"'].*/\1/")
BUNDLE_PATH="$DIST/$BUNDLE"

if [ ! -f "$BUNDLE_PATH" ]; then
  echo "🔴 [guard] bundle 文件不存在（$BUNDLE），配置检查跳过。"
  exit 2
fi

# 搜索 .yaml 配置文件，比较 mtime
CONFIG_FILES=$(find apps/scream-code/src -name '*.yaml' 2>/dev/null | head -10)
if [ -z "$CONFIG_FILES" ]; then
  exit 0  # 无配置文件可检查
fi

for cfg in $CONFIG_FILES; do
  if [ "$cfg" -nt "$BUNDLE_PATH" ] 2>/dev/null; then
    echo "🔴 [guard] 配置文件 $cfg 比 bundle 更新。"
    echo "    配置文件的修改必须重建 bundle 才能生效。"
    echo "    重建：node node_modules/tsdown/dist/run.mjs --config apps/scream-code/tsdown.config.ts"
    exit 2
  fi
done

exit 0
