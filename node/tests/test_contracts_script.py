import subprocess
from collections.abc import Iterator
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "contracts.sh"
SCHEMA = ROOT / "contracts" / "log-event.schema.json"
GENERATED = (
    ROOT / "node" / "src" / "yt_digest_node" / "contracts" / "transcript_result.py"
)


def check() -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [SCRIPT, "--check"], check=False, capture_output=True, text=True, cwd=ROOT
    )


@pytest.fixture
def restore() -> Iterator[None]:
    saved = {path: path.read_bytes() for path in (SCHEMA, GENERATED)}
    yield
    for path, content in saved.items():
        path.write_bytes(content)


def test_check_passes_when_up_to_date() -> None:
    assert check().returncode == 0


@pytest.mark.usefixtures("restore")
def test_check_names_a_generated_file_edited_by_hand() -> None:
    GENERATED.write_text(GENERATED.read_text() + "# edited\n")
    result = check()
    assert result.returncode == 1
    assert "node/src/yt_digest_node/contracts/transcript_result.py" in result.stderr


@pytest.mark.usefixtures("restore")
def test_check_names_files_when_a_schema_changes_without_regeneration() -> None:
    SCHEMA.write_text(
        SCHEMA.read_text().replace(
            '"sponsorblock.call"', '"sponsorblock.call", "extra.event"'
        )
    )
    result = check()
    assert result.returncode == 1
    assert "worker/src/contracts/log-event.ts" in result.stderr
    assert "node/src/yt_digest_node/contracts/log_event.py" in result.stderr
