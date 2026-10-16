"""SponsorBlock client and sponsor ratio (spec 5.3)."""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Literal

from yt_digest_node.log import emit

TIMEOUT_SECONDS = 10
CATEGORIES = '["sponsor","selfpromo","interaction"]'

State = Literal["ok", "none", "error"]
Segments = list[tuple[float, float]]


@dataclass(frozen=True)
class SponsorBlockResult:
    segments: Segments
    state: State


def _parse(body: bytes) -> Segments:
    return [
        (float(item["segment"][0]), float(item["segment"][1]))
        for item in json.loads(body)
    ]


def fetch_segments(
    base_url: str,
    video_id: str,
    request_id: str | None = None,
    timeout: float = TIMEOUT_SECONDS,
) -> SponsorBlockResult:
    """Call SponsorBlock once; any failure gives no segments and the state `error`."""
    query = urllib.parse.urlencode({"videoID": video_id, "categories": CATEGORIES})
    url = f"{base_url.rstrip('/')}/api/skipSegments?{query}"
    started = time.monotonic()
    status = 0
    segments: Segments = []
    state: State = "error"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            status = response.status
            if status == 200:
                segments = _parse(response.read())
                state = "ok"
    except urllib.error.HTTPError as error:
        status = error.code
        if status == 404:
            state = "none"
    except (OSError, ValueError, KeyError, IndexError, TypeError):
        segments = []
        state = "error"
    fields = {"request_id": request_id} if request_id is not None else {}
    emit(
        "sponsorblock.call",
        video_id=video_id,
        attrs={
            "status": status,
            "segments": len(segments),
            "duration_ms": round((time.monotonic() - started) * 1000),
        },
        **fields,
    )
    return SponsorBlockResult(segments, state)


def sponsor_ratio(segments: Segments, duration: float) -> float:
    """Length of the union of the segments clipped to [0, duration], over the duration, 3 decimals."""
    if duration <= 0:
        return 0.0
    clipped = sorted(
        (max(start, 0.0), min(end, duration))
        for start, end in segments
        if min(end, duration) > max(start, 0.0)
    )
    covered = 0.0
    reach = 0.0
    for start, end in clipped:
        start = max(start, reach)
        if end > start:
            covered += end - start
            reach = end
    return round(covered / duration, 3)
