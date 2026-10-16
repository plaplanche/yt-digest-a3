#!/usr/bin/env bash
# Python tests.
set -euo pipefail
cd "$(dirname "$0")/../.."

uv sync --project node --locked
uv run --project node pytest node/tests
