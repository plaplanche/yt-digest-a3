2026-10-16: Python build backend is hatchling and the `node` package is pinned to Python 3.12 only (`>=3.12,<3.13`), the simplest setup matching the spec.
2026-10-16: The `contracts` check skips with a message while `scripts/contracts.sh` does not exist, as the ticket asks.
2026-10-16: ESLint uses the flat config with `typescript-eslint` recommended rules; `mypy --strict` runs on `node/src` and `node/tests`.
