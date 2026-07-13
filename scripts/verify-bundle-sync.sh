#!/bin/sh
# Verify bundle contains all expected symbols from source
BUNDLE=$(grep "import.*app-.*\.mjs" apps/scream-code/dist/main.mjs | sed "s/.*[\"']\(.*\)[\"'].*/\1/")
BUNDLE_PATH="apps/scream-code/dist/$BUNDLE"
FAIL=0
for sym in buildMaskContent KEY_PATTERN autoRecoverText protectedLimit; do
  count=$(grep -c "$sym" "$BUNDLE_PATH" 2>/dev/null || echo 0)
  if [ "$count" -eq 0 ]; then
    echo "❌ MISSING: $sym in bundle"
    FAIL=1
  fi
done
[ "$FAIL" -eq 0 ] && echo "✅ bundle sync verified ($BUNDLE)"
exit $FAIL
