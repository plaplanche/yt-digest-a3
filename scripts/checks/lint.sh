#!/usr/bin/env bash
# Python, TypeScript and shell lint.
set -euo pipefail
cd "$(dirname "$0")/../.."

uv sync --project node --locked
uv run --project node ruff check node
uv run --project node ruff format --check node
uv run --project node mypy --strict node/src node/tests

npm ci --prefix worker
npm run --prefix worker typecheck
npm run --prefix worker lint

mapfile -t shell_files < <(find scripts -name '*.sh' | sort)
uvx --from shellcheck-py shellcheck "${shell_files[@]}"
