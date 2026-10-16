import json
from typing import Any

import pytest
from yt_digest_node.log import emit


def test_emit_writes_one_json_line_on_stderr(
    capsys: pytest.CaptureFixture[str],
) -> None:
    emit("service.started", attrs={"version": "0.1.0"}, request_id="r1")
    captured = capsys.readouterr()
    assert captured.out == ""
    line = json.loads(captured.err)
    assert line["event"] == "service.started"
    assert line["service"] == "node"
    assert line["level"] == "info"
    assert line["request_id"] == "r1"
    assert line["attrs"] == {"version": "0.1.0"}
    assert "video_id" not in line


def test_emit_rejects_event_outside_the_catalogue() -> None:
    with pytest.raises(ValueError):
        emit("unknown.event")


@pytest.mark.parametrize("fields", [{"extra": 1}, {"ts": "x"}, {"service": "worker"}])
def test_emit_rejects_unknown_or_reserved_fields(fields: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        emit("service.started", **fields)


def test_emit_rejects_bad_level() -> None:
    with pytest.raises(ValueError):
        emit("service.started", level="loud")
