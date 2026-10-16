"""The `work` daemon: heartbeat, claim, pipeline and result (spec 9)."""

import http.client
import signal
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from importlib.metadata import version
from typing import Any

from pydantic import BaseModel, ValidationError

from yt_digest_node.cli import _langs, _positive, run
from yt_digest_node.contracts.node_claim_request import NodeClaimRequest
from yt_digest_node.contracts.node_claim_response import Job, NodeClaimResponse
from yt_digest_node.contracts.node_heartbeat_request import NodeHeartbeatRequest
from yt_digest_node.contracts.node_heartbeat_response import NodeHeartbeatResponse
from yt_digest_node.contracts.node_job_ack import NodeJobAck
from yt_digest_node.contracts.node_release_request import NodeReleaseRequest
from yt_digest_node.contracts.node_result_request import NodeResultRequest, Outcome
from yt_digest_node.contracts.transcript_result import TranscriptResult
from yt_digest_node.extract import make_extractor
from yt_digest_node.log import emit

REQUEST_TIMEOUT_SECONDS = 30
RETRY_DELAYS = (1, 2, 4)


class Unauthorized(Exception):
    """The Worker answered 401: the node's token is not accepted."""


@dataclass(frozen=True)
class Config:
    worker_url: str
    token: str
    claim_batch: int
    poll_seconds: float
    heartbeat_seconds: float
    langs: list[str]


def read_config(env: Mapping[str, str]) -> Config:
    """Read section 9's variables; raise ValueError when one is missing or invalid."""
    for name in ("WORKER_URL", "NODE_TOKEN"):
        if not env.get(name):
            raise ValueError(f"{name} is required")
    batch = _positive(env, "CLAIM_BATCH", 3)
    if batch > 10:
        raise ValueError("CLAIM_BATCH must be between 1 and 10")
    langs = _langs(env.get("TRANSCRIPT_LANGS", "fr,en"))
    if not langs:
        raise ValueError("no language given")
    _positive(env, "MAX_WORDS", 60000)
    _positive(env, "PAGE_WORDS", 12000)
    make_extractor(env, langs)
    return Config(
        worker_url=env["WORKER_URL"].rstrip("/"),
        token=env["NODE_TOKEN"],
        claim_batch=batch,
        poll_seconds=_positive(env, "POLL_SECONDS", 10),
        heartbeat_seconds=_positive(env, "HEARTBEAT_SECONDS", 60),
        langs=langs,
    )


class WorkerClient:
    """POSTs JSON to the Worker; logs one `worker.call` per request."""

    def __init__(self, config: Config, sleep: Callable[[float], None]) -> None:
        self._base = config.worker_url
        self._token = config.token
        self._sleep = sleep

    def _once(
        self, endpoint: str, body: str, video_id: str | None
    ) -> tuple[int, bytes]:
        request = urllib.request.Request(
            f"{self._base}/node/{endpoint}",
            data=body.encode(),
            method="POST",
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
            },
        )
        started = time.monotonic()
        status, payload = 0, b""
        try:
            with urllib.request.urlopen(
                request, timeout=REQUEST_TIMEOUT_SECONDS
            ) as response:
                status, payload = response.status, response.read()
        except urllib.error.HTTPError as error:
            status = error.code
            try:
                payload = error.read()
            except (OSError, http.client.HTTPException):
                payload = b""
        except (OSError, http.client.HTTPException):
            pass  # status 0: a network error
        ids = {} if video_id is None else {"video_id": video_id}
        emit(
            "worker.call",
            level="info" if 200 <= status < 300 else "warn",
            attrs={
                "endpoint": endpoint,
                "status": status,
                "duration_ms": round((time.monotonic() - started) * 1000),
            },
            **ids,
        )
        if status == 401:
            raise Unauthorized
        return status, payload

    def post(
        self,
        endpoint: str,
        body: BaseModel,
        model: type[BaseModel],
        video_id: str | None = None,
        retry: bool = False,
    ) -> BaseModel | None:
        """Return the validated response, or None on a failure (after the retries when `retry`)."""
        text = body.model_dump_json(exclude_none=endpoint != "result")
        delays = iter(RETRY_DELAYS if retry else ())
        while True:
            status, payload = self._once(endpoint, text, video_id)
            if status == 0 or status >= 500:
                delay = next(delays, None)
                if delay is not None:
                    self._sleep(delay)
                    continue
            if not 200 <= status < 300:
                return None
            try:
                return model.model_validate_json(payload)
            except ValidationError:
                return None


class Daemon:
    def __init__(
        self, config: Config, env: Mapping[str, str], sleep: Callable[[float], None]
    ) -> None:
        self._config = config
        self._env = env
        self._client = WorkerClient(config, sleep)
        self._stop = threading.Event()
        self._started = time.monotonic()
        self._next_heartbeat = 0.0
        self._in_progress = 0

    def stop(self, *_: Any) -> None:
        self._stop.set()

    def _heartbeat(self) -> bool:
        self._next_heartbeat = time.monotonic() + self._config.heartbeat_seconds
        body = NodeHeartbeatRequest(
            version=version("yt-digest-node"),
            uptime_s=int(time.monotonic() - self._started),
            jobs_in_progress=self._in_progress,
        )
        return self._client.post("heartbeat", body, NodeHeartbeatResponse) is not None

    def _claim(self) -> list[Job] | None:
        response = self._client.post(
            "claim",
            NodeClaimRequest(max_jobs=self._config.claim_batch),
            NodeClaimResponse,
        )
        return response.jobs if isinstance(response, NodeClaimResponse) else None

    def _transcribe(self, video_id: str) -> TranscriptResult | None:
        """The pipeline of lot 1; None when it raised."""
        started = time.monotonic()
        try:
            result, attrs = run(video_id, self._config.langs, self._env, None)
        except Exception:  # noqa: BLE001 - any pipeline failure is an `error` outcome
            result = None
            attrs = {"outcome": "error", "words": 0, "pages": 0}
        attrs["duration_ms"] = round((time.monotonic() - started) * 1000)
        emit(
            "fetch.transcript",
            level="info" if result else "error",
            attrs=attrs,
            video_id=video_id,
        )
        return result

    def _process(self, job: Job) -> None:
        result = self._transcribe(job.video_id)
        if result is None:
            request = NodeResultRequest(
                lease_id=job.lease_id, outcome=Outcome.error, transcript=None
            )
        else:
            request = NodeResultRequest(
                lease_id=job.lease_id,
                outcome=Outcome(result.status.value),
                transcript=result if result.status.value == "ok" else None,
            )
        self._client.post("result", request, NodeJobAck, job.video_id, retry=True)

    def _release(self, job: Job) -> None:
        self._client.post(
            "release",
            NodeReleaseRequest(lease_id=job.lease_id),
            NodeJobAck,
            job.video_id,
            retry=True,
        )

    def _heartbeat_if_due(self) -> None:
        if time.monotonic() >= self._next_heartbeat:
            self._heartbeat()

    def _idle(self) -> None:
        end = time.monotonic() + self._config.poll_seconds
        while not self._stop.is_set() and time.monotonic() < end:
            until_heartbeat = max(0.0, self._next_heartbeat - time.monotonic())
            self._stop.wait(min(end - time.monotonic(), until_heartbeat))
            self._heartbeat_if_due()

    def _handle(self, jobs: list[Job], once: bool) -> None:
        for index, job in enumerate(jobs):
            if self._stop.is_set():
                for left in jobs[index:]:
                    self._release(left)
                return
            self._in_progress = len(jobs) - index
            if not once:
                self._heartbeat_if_due()
            self._process(job)
        self._in_progress = 0

    def work(self, once: bool) -> int:
        emit("service.started", attrs={"version": version("yt-digest-node")})
        try:
            if not self._heartbeat() and once:
                return 1
            while not self._stop.is_set():
                jobs = self._claim()
                if jobs is None and once:
                    return 1
                if jobs:
                    self._handle(jobs, once)
                if once:
                    return 0
                if not jobs:
                    self._idle()
            return 0
        except Unauthorized:
            return 1


def work(
    env: Mapping[str, str],
    once: bool,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """Run the daemon; raise ValueError (exit 2) on a bad configuration."""
    config = read_config(env)
    daemon = Daemon(config, env, sleep)
    previous = {
        sig: signal.signal(sig, daemon.stop) for sig in (signal.SIGTERM, signal.SIGINT)
    }
    try:
        return daemon.work(once)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
