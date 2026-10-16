#!/usr/bin/env bash
# Generates TypeScript types and Pydantic models from contracts/*.schema.json.
# With --check, regenerates into a temporary directory and exits 1 naming the stale files.
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-generate}"
case "$mode" in
  generate | --check) ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

ts_dir=worker/src/contracts
py_dir=node/src/yt_digest_node/contracts
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/ts" "$out/py"

uv sync --project node --locked --quiet
[[ -d worker/node_modules ]] || npm ci --prefix worker --silent

# Name of the generated type of a schema: its title.
type_name() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["title"])' "$1"; }

for schema in contracts/*.schema.json; do
  name="$(basename "$schema" .schema.json)"
  module="${name//-/_}"
  # A $ref to a sibling schema resolves to that schema's generated type, never to a second definition.
  # shellcheck disable=SC2016
  refs="$(grep -oE '"\$ref": *"[a-z-]+\.schema\.json"' "$schema" | sed -E 's/.*"([a-z-]+)\.schema\.json"/\1/' | sort -u || true)"
  ts_input="$schema"
  if [[ -n "$refs" ]]; then
    ts_input="$out/$name.ts-input.json"
    cp "$schema" "$ts_input"
    for ref in $refs; do
      sed -i -E "s/\{\"\\\$ref\": *\"$ref\.schema\.json\"\}/{\"tsType\": \"$(type_name "contracts/$ref.schema.json")\"}/" "$ts_input"
    done
  fi
  {
    echo "// Generated from $schema by scripts/contracts.sh. Do not edit."
    for ref in $refs; do
      echo "import type { $(type_name "contracts/$ref.schema.json") } from \"./$ref\";"
    done
    npm exec --prefix worker --silent -- json2ts --input "$ts_input" \
      --bannerComment ''
  } >"$out/ts/$name.ts"
  codegen=(uv run --project node datamodel-codegen --input "$schema" --input-file-type jsonschema
    --output-model-type pydantic_v2.BaseModel --use-subclass-enum --use-annotated --field-constraints --formatters ruff-format --target-python-version 3.12
    --disable-timestamp --custom-file-header "# Generated from $schema by scripts/contracts.sh. Do not edit.")
  if [[ -z "$refs" ]]; then
    "${codegen[@]}" --output "$out/py/$module.py"
  else
    # A schema with a $ref is generated as a package; keep its main module and import the referenced types.
    "${codegen[@]}" --output "$out/pkg-$module"
    cp "$out/pkg-$module/__init__.py" "$out/py/$module.py"
    for ref in $refs; do
      ref_module="${ref//-/_}"
      ref_type="$(type_name "contracts/$ref.schema.json")"
      sed -i -E "s/^from \. import $ref_module\$/from .$ref_module import $ref_type/; s/\b$ref_module\.Schema\b/$ref_type/g" "$out/py/$module.py"
    done
  fi
done
touch "$out/py/__init__.py"

# The generated files are formatted with the repository's own tools so that lint accepts them.
uv run --project node ruff check --quiet --fix --select I "$out/py"
uv run --project node ruff format --quiet "$out/py"

if [[ "$mode" == "--check" ]]; then
  stale=()
  for f in "$out"/ts/*; do
    [[ -f "$ts_dir/$(basename "$f")" ]] && cmp -s "$f" "$ts_dir/$(basename "$f")" || stale+=("$ts_dir/$(basename "$f")")
  done
  for f in "$out"/py/*; do
    [[ -f "$py_dir/$(basename "$f")" ]] && cmp -s "$f" "$py_dir/$(basename "$f")" || stale+=("$py_dir/$(basename "$f")")
  done
  for f in "$ts_dir"/*.ts "$py_dir"/*.py; do
    [[ -f "$f" ]] || continue
    case "$f" in
      "$ts_dir"/*) [[ -f "$out/ts/$(basename "$f")" ]] || stale+=("$f") ;;
      *) [[ -f "$out/py/$(basename "$f")" ]] || stale+=("$f") ;;
    esac
  done
  if ((${#stale[@]})); then
    echo "stale generated files (run ./scripts/contracts.sh):" >&2
    printf '  %s\n' "${stale[@]}" >&2
    exit 1
  fi
  echo "generated contracts are up to date"
else
  rm -rf "$ts_dir" "$py_dir"
  mkdir -p "$ts_dir" "$py_dir"
  cp "$out"/ts/* "$ts_dir"/
  cp "$out"/py/* "$py_dir"/
fi
