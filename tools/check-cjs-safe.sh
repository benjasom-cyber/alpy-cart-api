#!/bin/sh
# Vercel compiles api/*.js to CommonJS (this project has no "type": "module"),
# so anything ESM-only becomes a SyntaxError at cold start — and a syntax error
# in one imported file takes down the whole /api/support function, every action
# with it. `node --check` does NOT catch this: it happily parses the file as an
# ES module. This does.
#
# Run before every push that touches api/.
fail=0
for pat in 'import\.meta' 'await import\(.*\)\s*$'; do
  hits=$(grep -rnE "$pat" api/ | grep -v '^\s*\*' | grep -vE '^[^:]+:[0-9]+:\s*(\*|//)')
  if [ -n "$hits" ]; then
    echo "ESM-only construct in a CommonJS build:"
    echo "$hits"
    fail=1
  fi
done
[ "$fail" = 0 ] && echo "api/ is CommonJS-safe"
exit $fail
