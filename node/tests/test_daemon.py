import json
import os
import signal
import subprocess
import sys
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from yt_digest_node import daemon
from yt_digest_node.contracts.log_event import LogEvent

TOKEN = "ytd_node_secret-token-value-0123456789abcdefghi"
OK_ID = "okVideo0001"
EMPTY_ID = "noTrans0001"
BAD_ID = "badVideo001"
VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nhello brave world\n"

Reply = tuple[int, dict[str, Any]]


class FakeWorker:
    """Records every request; `replies` maps an endpoint to a function of the call count."""

    def __init__(self, jobs: list[str]) -> None:
        self.jobs = jobs
        self.requests: list[tuple[str, dict[str, Any], str]] = []
        self.replies: dict[str, Callable[[int, dict[str, Any]], Reply]] = {}
        self.on_request: Callable[[str], None] = lambda endpoint: None
        self.counts: dict[str, int] = {}
        self.sleeps: list[float] = []

    def default(self, endpoint: str, body: dict[str, Any]) -> Reply:
        if endpoint == "heartbeat":
            return 200, {
                "node_id": "n1",
                "state": "healthy",
                "hourly_budget": 60,
                "directive": "run",
            }
        if endpoint == "claim":
            return 200, {
                "jobs": [
                    {
                        "video_id": video_id,
                        "lease_id": f"lease-{video_id}-0123456789",
                        "lease_expires_at": "2026-10-16T07:00:01.123Z",
                    }
                    for video_id in self.jobs
                ]
            }
        video_id = body["lease_id"].split("-")[1]
        return 200, {
            "video_id": video_id,
            "status": "queued" if endpoint == "release" else "done",
        }

    def handle(self, endpoint: str, body: dict[str, Any], auth: str) -> Reply:
        self.requests.append((endpoint, body, auth))
        count = self.counts[endpoint] = self.counts.get(endpoint, 0) + 1
        self.on_request(endpoint)
        reply = self.replies.get(endpoint)
        return reply(count, body) if reply else self.default(endpoint, body)

    def calls(self, endpoint: str) -> list[dict[str, Any]]:
        return [body for name, body, _ in self.requests if name == endpoint]


@contextmanager
def serve(worker: FakeWorker) -> Iterator[str]:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers["Content-Length"])
            body = json.loads(self.rfile.read(length))
            endpoint = self.path.removeprefix("/node/")
            status, payload = worker.handle(
                endpoint, body, self.headers["Authorization"]
            )
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, format: str, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def videos(tmp_path: Path) -> Path:
    for video_id, files in {
        OK_ID: {"meta.json": '{"duration": 100}', "en.manual.vtt": VTT},
        EMPTY_ID: {"meta.json": '{"duration": 100}'},
    }.items():
        folder = tmp_path / video_id
        folder.mkdir()
        for name, text in files.items():
            (folder / name).write_text(text, encoding="utf-8")
    return tmp_path


def environment(url: str, videos: Path, **extra: str) -> dict[str, str]:
    return {
        **os.environ,
        "WORKER_URL": url,
        "NODE_TOKEN": TOKEN,
        "FETCHER_FAKE_YTDLP": "1",
        "FAKE_YTDLP_DIR": str(videos),
        "SPONSORBLOCK_URL": "http://127.0.0.1:9",
        **extra,
    }


def log_lines(text: str) -> list[LogEvent]:
    return [LogEvent.model_validate_json(line) for line in text.splitlines()]


def run_once(
    worker: FakeWorker, videos: Path, capsys: pytest.CaptureFixture[str]
) -> tuple[int, str]:
    sleeps: list[float] = []
    with serve(worker) as url:
        code = daemon.work(environment(url, videos), once=True, sleep=sleeps.append)
    worker.sleeps = sleeps
    return code, capsys.readouterr().err


def test_once_heartbeat_claim_and_one_result_per_job(
    videos: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    worker = FakeWorker([OK_ID, EMPTY_ID, "missing0001"])
    code, err = run_once(worker, videos, capsys)
    assert code == 0
    assert [name for name, _, _ in worker.requests] == [
        "heartbeat",
        "claim",
        "result",
        "result",
        "result",
    ]
    assert {auth for _, _, auth in worker.requests} == {f"Bearer {TOKEN}"}
    heartbeat = worker.calls("heartbeat")[0]
    assert set(heartbeat) == {"version", "uptime_s", "jobs_in_progress"}
    assert worker.calls("claim") == [{"max_jobs": 3}]
    ok, empty, missing = worker.calls("result")
    assert ok["outcome"] == "ok"
    assert ok["lease_id"] == f"lease-{OK_ID}-0123456789"
    assert ok["transcript"]["video_id"] == OK_ID
    assert ok["transcript"]["pages"] == ["hello brave world"]
    assert (empty["outcome"], empty["transcript"]) == ("no_transcript", None)
    assert (missing["outcome"], missing["transcript"]) == ("unavailable", None)
    events = log_lines(err)
    assert events[0].event.value == "service.started"
    calls = [e.attrs["endpoint"] for e in events if e.event.value == "worker.call"]
    assert calls == ["heartbeat", "claim", "result", "result", "result"]
    assert [e.event.value for e in events].count("fetch.transcript") == 3
    assert "hello brave world" not in err


def test_claim_batch_is_sent(videos: Path, capsys: pytest.CaptureFixture[str]) -> None:
    worker = FakeWorker([])
    with serve(worker) as url:
        code = daemon.work(environment(url, videos, CLAIM_BATCH="7"), once=True)
    assert code == 0
    assert worker.calls("claim") == [{"max_jobs": 7}]
    assert worker.calls("result") == []


def test_pipeline_exception_sends_error(
    videos: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def boom(*args: Any) -> Any:
        raise RuntimeError("boom")

    monkeypatch.setattr(daemon, "run", boom)
    worker = FakeWorker([OK_ID])
    with serve(worker) as url:
        code = daemon.work(environment(url, videos), once=True)
    assert code == 0
    (result,) = worker.calls("result")
    assert (result["outcome"], result["transcript"]) == ("error", None)
    assert "boom" not in capsys.readouterr().err


def test_result_503_is_retried_then_succeeds(
    videos: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    worker = FakeWorker([OK_ID])
    worker.replies["result"] = lambda count, body: (
        (503, {"error": {"code": "storage_error", "message": "x"}})
        if count < 3
        else worker.default("result", body)
    )
    code, err = run_once(worker, videos, capsys)
    assert code == 0
    assert len(worker.calls("result")) == 3
    assert worker.sleeps == [1, 2]
    statuses = [
        e.attrs["status"]
        for e in log_lines(err)
        if e.event.value == "worker.call" and e.attrs["endpoint"] == "result"
    ]
    assert statuses == [503, 503, 200]


def test_result_is_retried_three_times_at_most(
    videos: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    worker = FakeWorker([OK_ID, EMPTY_ID])
    worker.replies["result"] = lambda count, body: (503, {})
    code, _ = run_once(worker, videos, capsys)
    assert code == 0
    assert len(worker.calls("result")) == 8  # 4 attempts for each of the two jobs
    assert worker.sleeps == [1, 2, 4, 1, 2, 4]


def test_result_409_is_not_retried(
    videos: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    worker = FakeWorker([OK_ID, EMPTY_ID])
    worker.replies["result"] = lambda count, body: (
        (409, {"error": {"code": "stale_lease", "message": "x"}})
        if count == 1
        else worker.default("result", body)
    )
    code, _ = run_once(worker, videos, capsys)
    assert code == 0
    assert len(worker.calls("result")) == 2
    assert worker.sleeps == []


@pytest.mark.parametrize("endpoint", ["heartbeat", "claim"])
@pytest.mark.parametrize("status", [500, 403])
def test_failed_heartbeat_or_claim_exits_1(
    videos: Path, capsys: pytest.CaptureFixture[str], endpoint: str, status: int
) -> None:
    worker = FakeWorker([OK_ID])
    worker.replies[endpoint] = lambda count, body: (status, {})
    code, _ = run_once(worker, videos, capsys)
    assert code == 1
    assert worker.calls("result") == []
    if endpoint == "heartbeat":
        assert worker.calls("claim") == []


def test_unreachable_worker_exits_1(
    videos: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code = daemon.work(environment("http://127.0.0.1:9", videos), once=True)
    assert code == 1
    events = log_lines(capsys.readouterr().err)
    assert events[-1].attrs["status"] == 0


def test_invalid_claim_response_exits_1(
    videos: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    worker = FakeWorker([OK_ID])
    worker.replies["claim"] = lambda count, body: (200, {"jobs": [{"video_id": "x"}]})
    code, _ = run_once(worker, videos, capsys)
    assert code == 1


def test_401_exits_1(videos: Path, capsys: pytest.CaptureFixture[str]) -> None:
    worker = FakeWorker([OK_ID, EMPTY_ID])
    worker.replies["result"] = lambda count, body: (401, {})
    code, _ = run_once(worker, videos, capsys)
    assert code == 1
    assert len(worker.calls("result")) == 1


@pytest.mark.parametrize("missing", ["WORKER_URL", "NODE_TOKEN"])
def test_missing_variable_exits_2_without_request(videos: Path, missing: str) -> None:
    worker = FakeWorker([OK_ID])
    with serve(worker) as url:
        env = environment(url, videos)
        del env[missing]
        process = subprocess.run(
            [sys.executable, "-m", "yt_digest_node.cli", "work", "--once"],
            env=env,
            check=False,
            capture_output=True,
            text=True,
        )
    assert process.returncode == 2
    assert worker.requests == []
    assert process.stderr == ""


@pytest.mark.parametrize("batch", ["0", "11", "many"])
def test_bad_claim_batch_exits_2(videos: Path, batch: str) -> None:
    with pytest.raises(ValueError, match="CLAIM_BATCH"):
        daemon.work(
            environment("http://127.0.0.1:9", videos, CLAIM_BATCH=batch), once=True
        )


def test_sigterm_releases_unstarted_jobs_and_exits_0(videos: Path) -> None:
    worker = FakeWorker([OK_ID, EMPTY_ID, "missing0001"])
    first_result = threading.Event()
    proceed = threading.Event()

    def hold(endpoint: str) -> None:
        if endpoint == "result" and not first_result.is_set():
            first_result.set()
            assert proceed.wait(10)

    worker.on_request = hold
    with serve(worker) as url:
        process = subprocess.Popen(
            [sys.executable, "-m", "yt_digest_node.cli", "work"],
            env=environment(url, videos),
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            assert first_result.wait(20)
            process.send_signal(signal.SIGTERM)
            proceed.set()
            _, err = process.communicate(timeout=20)
        finally:
            proceed.set()
            process.kill()
    assert process.returncode == 0
    names = [name for name, _, _ in worker.requests]
    assert names == ["heartbeat", "claim", "result", "release", "release"]
    assert [b["lease_id"] for b in worker.calls("release")] == [
        f"lease-{EMPTY_ID}-0123456789",
        "lease-missing0001-0123456789",
    ]
    assert worker.calls("result")[0]["outcome"] == "ok"
    assert TOKEN not in err
    events = log_lines(err)
    assert events[0].event.value == "service.started"


def test_loop_polls_again_after_empty_claim(videos: Path) -> None:
    worker = FakeWorker([])
    seen = threading.Event()

    def count(endpoint: str) -> None:
        if worker.counts.get("claim", 0) >= 2:
            seen.set()

    worker.on_request = count
    with serve(worker) as url:
        process = subprocess.Popen(
            [sys.executable, "-m", "yt_digest_node.cli", "work"],
            env=environment(url, videos, POLL_SECONDS="1"),
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            assert seen.wait(20)
            process.send_signal(signal.SIGINT)
            _, err = process.communicate(timeout=20)
        finally:
            process.kill()
    assert process.returncode == 0
    assert worker.counts["heartbeat"] == 1
    assert TOKEN not in err


def test_stderr_holds_only_log_lines_and_never_the_token(videos: Path) -> None:
    worker = FakeWorker([OK_ID, EMPTY_ID])
    worker.replies["result"] = lambda count, body: (409, {})
    with serve(worker) as url:
        process = subprocess.run(
            [sys.executable, "-m", "yt_digest_node.cli", "work", "--once"],
            env=environment(url, videos),
            check=False,
            capture_output=True,
            text=True,
        )
    assert process.returncode == 0
    assert process.stderr
    assert all(
        isinstance(json.loads(line), dict) for line in process.stderr.splitlines()
    )
    log_lines(process.stderr)
    assert TOKEN not in process.stderr
    assert "ytd_node_" not in process.stderr
