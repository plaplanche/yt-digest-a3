2026-10-16: Python build backend is hatchling and the `node` package is pinned to Python 3.12 only (`>=3.12,<3.13`), the simplest setup matching the spec.
2026-10-16: The `contracts` check skips with a message while `scripts/contracts.sh` does not exist, as the ticket asks.
2026-10-16: ESLint uses the flat config with `typescript-eslint` recommended rules; `mypy --strict` runs on `node/src` and `node/tests`.
2026-10-16: Generation uses `json-schema-to-typescript` (npm, worker dev dependency) and `datamodel-code-generator` (uv, node dev dependency); generated Python is import-sorted and formatted by the repository's ruff so that lint accepts it.
2026-10-16: `scripts/contracts.sh` runs `npm ci` only when `worker/node_modules` is missing, so the check does not wipe dependencies under a running test.
2026-10-16: `attrs` of a log event is a free object in the schema; the catalogue (the `event` enum) is what the loggers enforce. The TypeScript logger reads its runtime catalogue from `contracts/log-event.schema.json`, and writes its line with `console.error`.
2026-10-16: `pydantic` is a runtime dependency of the node package, as the generated models need it.
2026-10-16: A cue is "kept" (5.4 step 5) when at least one of its lines survives steps 3 and 4; the paragraph gap is measured in whole milliseconds so that 2.0 s starts a paragraph despite float rounding.
2026-10-16: SponsorBlock segments enter `clean_cues` as a list of `(start, end)` float pairs, and the result is a list of paragraph strings, so that truncation and pages can follow without re-splitting.
2026-10-16: SponsorBlock uses the standard library `urllib`; the log line carries the HTTP status (0 on a network error), and a 200 body that is not the expected JSON counts as `error` with no segments.
