#!/usr/bin/env bash
# Playwright end-to-end tests against the local stack.
set -euo pipefail
cd "$(dirname "$0")/../.."

npm ci --prefix e2e

projects=(--project=api --project=browser)
if [[ -n "${CI:-}" ]]; then
  (cd e2e && npx playwright install --with-deps chromium)
elif ! (cd e2e && timeout 120 npx playwright install chromium); then
  echo "e2e: chromium unavailable, browser project skipped"
  projects=(--project=api)
fi

status=0
LEASE_SECONDS=2 ./scripts/stack.sh up || status=$?
if ((status == 0)); then
  (cd e2e && npx playwright test "${projects[@]}") || status=$?
fi
./scripts/stack.sh down

if ((status != 0)); then
  mkdir -p ci-artifacts
  cp -R .stack/logs ci-artifacts/ 2>/dev/null || true
  cp -R e2e/playwright-report ci-artifacts/ 2>/dev/null || true
fi
exit "$status"
