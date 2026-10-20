#!/usr/bin/env bash
# Reject native browser dialogs in the frontend. WKWebView's dialog-plugin
# shim turns confirm() into an async Promise, so a truthiness guard never waits.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

set +e
matches="$(grep -R -n -E \
  --include='*.ts' --include='*.tsx' \
  -e 'window\.(confirm|alert|prompt)' \
  -e '(^|[^.[:alnum:]_])(confirm|alert|prompt)[[:space:]]*\(' \
  frontend/src)"
status=$?
set -e

if [ "$status" -eq 0 ]; then
  printf '%s\n' "$matches" >&2
  echo "FAIL: native confirm/alert/prompt usage found in frontend/src" >&2
  exit 1
fi
if [ "$status" -ne 1 ]; then
  echo "FAIL: grep failed with status $status" >&2
  exit 1
fi

echo "OK: no window.confirm/window.alert/window.prompt or bare confirm/alert/prompt calls in frontend/src"
