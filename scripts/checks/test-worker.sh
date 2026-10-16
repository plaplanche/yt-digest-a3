#!/usr/bin/env bash
# TypeScript tests.
set -euo pipefail
cd "$(dirname "$0")/../.."

npm ci --prefix worker
npm test --prefix worker
