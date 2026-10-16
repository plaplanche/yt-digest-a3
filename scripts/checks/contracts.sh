#!/usr/bin/env bash
# Generated contracts are up to date; nothing to check until scripts/contracts.sh exists.
set -euo pipefail
cd "$(dirname "$0")/../.."

if [[ -x scripts/contracts.sh ]]; then
  ./scripts/contracts.sh --check
else
  echo "scripts/contracts.sh does not exist yet: nothing to check"
fi
