import json
from typing import Any

import pytest
from pydantic import ValidationError
from yt_digest_node.contracts.log_event import Event, LogEvent
from yt_digest_node.contracts.transcript_result import TranscriptResult

RESULT: dict[str, Any] = {
    "video_id": "dQw4w9WgXcQ",
    "status": "ok",
    "lang": "en",
    "source": "manual",
    "word_count": 3,
    "truncated": False,
    "sponsor_ratio": 0.5,
    "pages": ["one two three"],
}
LOG: dict[str, Any] = {
    "ts": "2026-10-16T10:00:00.123Z",
    "level": "info",
    "service": "node",
    "event": "service.started",
    "attrs": {"version": "0.1.0"},
}


def test_valid_result_is_accepted() -> None:
    assert TranscriptResult.model_validate(RESULT).status == "ok"


def test_result_with_null_fields_is_accepted() -> None:
    empty = {**RESULT, "status": "no_transcript", "lang": None, "source": None}
    empty |= {"sponsor_ratio": None, "word_count": 0, "pages": []}
    assert TranscriptResult.model_validate(empty).source is None


@pytest.mark.parametrize(
    "change",
    [
        {"extra": 1},
        {"video_id": "short"},
        {"video_id": "bad id/chars"},
        {"status": "weird"},
        {"source": "other"},
        {"word_count": -1},
        {"sponsor_ratio": 1.5},
    ],
)
def test_invalid_result_is_rejected(change: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        TranscriptResult.model_validate({**RESULT, **change})


def test_valid_log_line_is_accepted() -> None:
    assert LogEvent.model_validate_json(json.dumps(LOG)).event is Event.service_started


@pytest.mark.parametrize(
    "change",
    [{"event": "unknown.event"}, {"extra": 1}, {"level": "loud"}, {"ts": "yesterday"}],
)
def test_invalid_log_line_is_rejected(change: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        LogEvent.model_validate({**LOG, **change})
