#!/bin/sh
# check-all.sh — 运行所有启用的 guards
#
# 使用：./scripts/guards/check-all.sh [--quiet]
#   默认：全部通过 exit 0，有 error exit 2
#   --quiet：只输出失败信息

set -e
cd "$(dirname "$0")/../.."

# 加载开关配表
if [ -f scripts/guards/config.sh ]; then
  . scripts/guards/config.sh
fi

QUIET=false
for arg in "$@"; do
  [ "$arg" = "--quiet" ] && QUIET=true
done

ERRORS=0
WARNS=0
HEADER=""
ERROR_OUTPUT=""
WARN_OUTPUT=""

for guard in scripts/guards/guard-*.sh; do
  [ "$guard" = "scripts/guards/check-all.sh" ] && continue

  GUARD_NAME=$(basename "$guard" ".sh" | tr '-' '_')

  # 检查开关（默认启用）
  eval "ENABLED=\${GUARD_ENABLED_${GUARD_NAME}:-true}"
  [ "$ENABLED" != "true" ] && {
    [ "$QUIET" = false ] && HEADER="${HEADER}[skip] $GUARD_NAME (disabled)\n"
    continue
  }

  set +e
  GUARD_OUTPUT=$(GUARD_PROJECT_DIR="$(pwd)" GUARD_QUIET="$QUIET" sh "$guard" 2>&1)
  EXIT_CODE=$?
  set -e

  if [ "$EXIT_CODE" -eq 2 ]; then
    ERRORS=$((ERRORS + 1))
    ERROR_OUTPUT="${ERROR_OUTPUT}--- $GUARD_NAME (ERROR) ---\n$GUARD_OUTPUT\n"
  elif [ "$EXIT_CODE" -eq 1 ]; then
    WARNS=$((WARNS + 1))
    if [ "$QUIET" = false ]; then
      WARN_OUTPUT="${WARN_OUTPUT}--- $GUARD_NAME (WARN) ---\n$GUARD_OUTPUT\n"
    fi
  fi
done

# 输出结果
if [ "$QUIET" = false ] && [ -n "$HEADER" ]; then
  printf "%b" "$HEADER"
fi

if [ $ERRORS -gt 0 ]; then
  echo ""
  printf "%b" "$ERROR_OUTPUT"
  echo "=============================="
  echo "🔴 防踩坑检查发现 $ERRORS 个错误, $WARNS 个警告"
  echo "=============================="
  exit 2
fi

if [ $WARNS -gt 0 ]; then
  printf "%b" "$WARN_OUTPUT"
  echo ""
  echo "⚠️  防踩坑检查通过，但有 $WARNS 个警告"
  exit 0
fi

[ "$QUIET" = false ] && echo "✅ 全部 guard 通过"
exit 0
