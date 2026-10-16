import json
import os
import subprocess
import sys
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest
from yt_digest_node.contracts.log_event import LogEvent
from yt_digest_node.contracts.transcript_result import TranscriptResult

VIDEO = "dQw4w9WgXcQ"
SECRET = "Bonjour à tous"
VTT = """WEBVTT

00:00:01.000 --> 00:00:03.000
Bonjour à tous

00:00:10.000 --> 00:00:12.000
Buy this great product now

00:00:20.000 --> 00:00:22.000
Merci et à bientôt
"""


@contextmanager
def sponsorblock(status: int, body: str = "") -> Iterator[str]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(status)
            self.end_headers()
            self.wfile.write(body.encode())

        def log_message(self, format: str, *args: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


def make_video(root: Path, files: dict[str, str]) -> None:
    folder = root / VIDEO
    folder.mkdir()
    for name, text in files.items():
        (folder / name).write_text(text, encoding="utf-8")


def command(
    tmp_path: Path, url: str, *args: str, **env: str
) -> subprocess.CompletedProcess[str]:
    environment = {
        **os.environ,
        "FETCHER_FAKE_YTDLP": "1",
        "FAKE_YTDLP_DIR": str(tmp_path),
        "SPONSORBLOCK_URL": url,
        **env,
    }
    return subprocess.run(
        [sys.executable, "-m", "yt_digest_node.cli", "transcript", *args],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )


def logs(process: subprocess.CompletedProcess[str]) -> list[LogEvent]:
    return [LogEvent.model_validate_json(line) for line in process.stderr.splitlines()]


def test_ok_with_sponsor_cuts(tmp_path: Path) -> None:
    make_video(tmp_path, {"meta.json": '{"duration": 100}', "fr.manual.vtt": VTT})
    body = json.dumps([{"segment": [9, 13]}])
    with sponsorblock(200, body) as url:
        process = command(tmp_path, url, VIDEO, "--request-id", "req-1")
    assert process.returncode == 0
    result = TranscriptResult.model_validate_json(process.stdout)
    assert result.status == "ok"
    assert (result.lang, result.source) == ("fr", "manual")
    assert result.pages == ["Bonjour à tous\n\nMerci et à bientôt"]
    assert result.word_count == 7
    assert not result.truncated
    assert result.sponsor_ratio == 0.04
    events = [(e.event.value, e.request_id) for e in logs(process)]
    assert events[0] == ("service.started", "req-1")
    assert events[-1] == ("fetch.transcript", "req-1")
    attrs = logs(process)[-1].attrs
    assert attrs["sponsorblock"] == "ok"
    assert attrs["words"] == 7
    assert attrs["pages"] == 1
    assert attrs["sponsor_ratio"] == 0.04


def test_logs_hold_no_transcript_text(tmp_path: Path) -> None:
    make_video(tmp_path, {"meta.json": '{"duration": 100}', "fr.manual.vtt": VTT})
    with sponsorblock(404) as url:
        process = command(tmp_path, url, VIDEO)
    assert process.returncode == 0
    assert "Bonjour" not in process.stderr
    assert "Merci" not in process.stderr
    assert "Bonjour" in process.stdout


def test_sponsorblock_error_gives_null_ratio(tmp_path: Path) -> None:
    make_video(tmp_path, {"meta.json": '{"duration": 100}', "fr.auto.vtt": VTT})
    with sponsorblock(500) as url:
        process = command(tmp_path, url, VIDEO)
    result = TranscriptResult.model_validate_json(process.stdout)
    assert (result.status, result.source, result.sponsor_ratio) == ("ok", "auto", None)
    assert logs(process)[-1].attrs["sponsorblock"] == "error"


def test_truncation_and_pages_from_environment(tmp_path: Path) -> None:
    make_video(tmp_path, {"meta.json": '{"duration": 100}', "fr.manual.vtt": VTT})
    with sponsorblock(404) as url:
        process = command(tmp_path, url, VIDEO, MAX_WORDS="4", PAGE_WORDS="2")
    result = TranscriptResult.model_validate_json(process.stdout)
    assert result.truncated
    assert result.word_count == 4
    assert result.pages == ["Bonjour à\n\n[…]", "à bientôt"]


def test_langs_option_overrides_environment(tmp_path: Path) -> None:
    make_video(
        tmp_path,
        {"meta.json": '{"duration": 100}', "fr.manual.vtt": VTT, "en.manual.vtt": VTT},
    )
    with sponsorblock(404) as url:
        process = command(tmp_path, url, VIDEO, "--langs", "en,fr")
    assert TranscriptResult.model_validate_json(process.stdout).lang == "en"


def test_no_transcript(tmp_path: Path) -> None:
    make_video(tmp_path, {"meta.json": '{"duration": 100}', "de.manual.vtt": VTT})
    with sponsorblock(404) as url:
        process = command(tmp_path, url, VIDEO)
    assert process.returncode == 0
    result = TranscriptResult.model_validate_json(process.stdout)
    assert result == TranscriptResult(
        video_id=VIDEO,
        status="no_transcript",  # type: ignore[arg-type]
        lang=None,
        source=None,
        word_count=0,
        truncated=False,
        sponsor_ratio=None,
        pages=[],
    )
    assert logs(process)[-1].attrs["outcome"] == "no_transcript"


@pytest.mark.parametrize("status", ["unavailable", "blocked"])
def test_failures_from_meta(tmp_path: Path, status: str) -> None:
    make_video(tmp_path, {"meta.json": json.dumps({"duration": 1, "status": status})})
    process = command(tmp_path, "http://127.0.0.1:9", VIDEO)
    assert process.returncode == 0
    result = TranscriptResult.model_validate_json(process.stdout)
    assert result.status == status
    assert logs(process)[-1].attrs["outcome"] == status


def test_missing_video_is_unavailable(tmp_path: Path) -> None:
    process = command(tmp_path, "http://127.0.0.1:9", VIDEO)
    assert TranscriptResult.model_validate_json(process.stdout).status == "unavailable"


@pytest.mark.parametrize("video_id", ["short", "dQw4w9WgXc!", "dQw4w9WgXcQQ"])
def test_invalid_video_id_exits_2(tmp_path: Path, video_id: str) -> None:
    process = command(tmp_path, "http://127.0.0.1:9", video_id)
    assert process.returncode == 2
    assert process.stdout == ""


def test_bad_configuration_exits_2(tmp_path: Path) -> None:
    process = command(tmp_path, "http://127.0.0.1:9", VIDEO, MAX_WORDS="many")
    assert process.returncode == 2
    assert process.stdout == ""
