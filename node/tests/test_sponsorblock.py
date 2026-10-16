import json
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from yt_digest_node.clean import Cue, clean_cues
from yt_digest_node.sponsorblock import fetch_segments, sponsor_ratio

VIDEO = "dQw4w9WgXcQ"


@contextmanager
def serve(status: int, body: bytes = b"") -> Iterator[tuple[str, list[str]]]:
    paths: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            paths.append(self.path)
            self.send_response(status)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", paths
    finally:
        server.shutdown()
        server.server_close()


def log_line(capsys: pytest.CaptureFixture[str]) -> dict[str, Any]:
    line: dict[str, Any] = json.loads(capsys.readouterr().err)
    return line


def test_200_returns_segments(capsys: pytest.CaptureFixture[str]) -> None:
    body = json.dumps(
        [{"segment": [1.5, 4], "category": "sponsor"}, {"segment": [10, 12.25]}]
    ).encode()
    with serve(200, body) as (url, paths):
        result = fetch_segments(url, VIDEO, request_id="r1")
    assert result.state == "ok"
    assert result.segments == [(1.5, 4.0), (10.0, 12.25)]
    request = urlparse(paths[0])
    assert request.path == "/api/skipSegments"
    query = parse_qs(request.query)
    assert query["videoID"] == [VIDEO]
    assert json.loads(query["categories"][0]) == ["sponsor", "selfpromo", "interaction"]
    line = log_line(capsys)
    assert line["event"] == "sponsorblock.call"
    assert line["video_id"] == VIDEO
    assert line["request_id"] == "r1"
    assert line["attrs"]["status"] == 200
    assert line["attrs"]["segments"] == 2
    assert line["attrs"]["duration_ms"] >= 0


def test_404_means_no_segments(capsys: pytest.CaptureFixture[str]) -> None:
    with serve(404, b"Not Found") as (url, _):
        result = fetch_segments(url, VIDEO)
    assert (result.state, result.segments) == ("none", [])
    line = log_line(capsys)
    assert line["attrs"]["status"] == 404
    assert line["attrs"]["segments"] == 0
    assert "request_id" not in line


def test_500_is_an_error(capsys: pytest.CaptureFixture[str]) -> None:
    with serve(500) as (url, _):
        result = fetch_segments(url, VIDEO)
    assert (result.state, result.segments) == ("error", [])
    line = log_line(capsys)
    assert line["attrs"]["status"] == 500
    assert line["attrs"]["segments"] == 0


def test_connection_refused_is_an_error(capsys: pytest.CaptureFixture[str]) -> None:
    with serve(200) as (url, _):
        pass  # the server is closed: nothing listens on this port any more
    result = fetch_segments(url, VIDEO)
    assert (result.state, result.segments) == ("error", [])
    line = log_line(capsys)
    assert line["attrs"]["status"] == 0
    assert line["attrs"]["segments"] == 0


def test_malformed_200_is_an_error(capsys: pytest.CaptureFixture[str]) -> None:
    with serve(200, b"not json") as (url, _):
        result = fetch_segments(url, VIDEO)
    assert (result.state, result.segments) == ("error", [])
    assert log_line(capsys)["attrs"]["segments"] == 0


def test_midpoint_rule_at_both_edges() -> None:
    # one cue with midpoint 3.0
    cues = [Cue(2.0, 4.0, ("x",))]
    assert clean_cues(cues, [(3.0, 5.0)]) == []  # start inclusive
    assert clean_cues(cues, [(1.0, 3.0)]) == ["x"]  # end exclusive
    assert clean_cues(cues, [(3.5, 5.0)]) == [
        "x"
    ]  # cue overlaps but midpoint is outside


def test_ratio_without_segment_is_zero() -> None:
    assert sponsor_ratio([], 100) == 0


def test_ratio_unites_overlapping_segments() -> None:
    assert sponsor_ratio([(10, 30), (20, 40), (60, 70)], 100) == 0.4
    assert sponsor_ratio([(10, 20), (10, 20)], 100) == 0.1


def test_ratio_clips_to_the_duration() -> None:
    assert sponsor_ratio([(90, 150)], 100) == 0.1
    assert sponsor_ratio([(120, 150)], 100) == 0
    assert sponsor_ratio([(-5, 10)], 100) == 0.1


def test_ratio_rounds_to_three_decimals() -> None:
    assert sponsor_ratio([(0, 1)], 3) == 0.333
    assert sponsor_ratio([(0, 2)], 3) == 0.667


def test_ratio_with_a_zero_duration() -> None:
    assert sponsor_ratio([(0, 5)], 0) == 0
