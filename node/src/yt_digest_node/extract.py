"""Extractors and track choice (spec 5.2)."""

import json
import random
import time
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol, get_args

Failure = Literal["unavailable", "blocked"]
Kind = Literal["manual", "auto"]

DEFAULT_DELAY = "2-5"
TIMEOUT_SECONDS = 30


@dataclass(frozen=True)
class Track:
    lang: str
    kind: Kind
    text: str


@dataclass(frozen=True)
class Extraction:
    duration: float
    tracks: tuple[Track, ...]


class Extractor(Protocol):
    def extract(self, video_id: str) -> Extraction | Failure: ...


def choose_track(tracks: tuple[Track, ...], langs: list[str]) -> Track | None:
    """Manual tracks in the order of the languages, then auto tracks in the same order."""
    for kind in ("manual", "auto"):
        for lang in langs:
            for track in tracks:
                if track.kind == kind and track.lang == lang:
                    return track
    return None


class FakeExtractor:
    """Reads `<directory>/<video_id>/` (meta.json and `<lang>.<manual|auto>.vtt` files)."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory

    def extract(self, video_id: str) -> Extraction | Failure:
        folder = self.directory / video_id
        if not folder.is_dir():
            return "unavailable"
        meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
        status = meta.get("status")
        if status in ("unavailable", "blocked"):
            return "blocked" if status == "blocked" else "unavailable"
        tracks: list[Track] = []
        for path in sorted(folder.glob("*.vtt")):
            lang, kind, _ = path.name.rsplit(".", 2)
            for known in get_args(Kind):
                if kind == known:
                    tracks.append(Track(lang, known, path.read_text(encoding="utf-8")))
        return Extraction(float(meta["duration"]), tuple(tracks))


class YoutubeDL(Protocol):
    def extract_info(self, url: str, download: bool = ...) -> Mapping[str, Any]: ...


def parse_delay(value: str) -> tuple[float, float]:
    """`3` or `2-5` (seconds) into a (low, high) range."""
    low, _, high = value.partition("-")
    return float(low), float(high or low)


def ytdlp_options() -> dict[str, Any]:
    return {
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitlesformat": "vtt",
        "quiet": True,
        "no_warnings": True,
    }


def _default_factory(options: dict[str, Any]) -> YoutubeDL:
    from yt_dlp import YoutubeDL as RealYoutubeDL  # type: ignore[import-untyped, unused-ignore]

    return RealYoutubeDL(options)  # type: ignore[no-any-return, unused-ignore]


def _download_text(url: str) -> str:
    with urllib.request.urlopen(url, timeout=TIMEOUT_SECONDS) as response:
        return bytes(response.read()).decode("utf-8")


def _map_error(message: str) -> Failure | None:
    lowered = message.lower()
    if "not a bot" in lowered:
        return "blocked"
    for marker in (
        "private video",
        "confirm your age",
        "age-restricted",
        "unavailable",
        "removed",
    ):
        if marker in lowered:
            return "unavailable"
    return None


class YtDlpExtractor:
    """yt-dlp as a library; only the tracks in `langs` are downloaded."""

    def __init__(
        self,
        langs: list[str],
        delay: tuple[float, float] = (2, 5),
        factory: Callable[[dict[str, Any]], YoutubeDL] = _default_factory,
        download: Callable[[str], str] = _download_text,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.langs = langs
        self.delay = delay
        self.factory = factory
        self.download = download
        self.sleep = sleep

    def _pause(self) -> None:
        self.sleep(random.uniform(*self.delay))

    def _track(self, entries: list[Mapping[str, Any]]) -> str | None:
        for entry in entries:
            if entry.get("ext") == "vtt" and entry.get("url"):
                self._pause()
                return self.download(str(entry["url"]))
        return None

    def extract(self, video_id: str) -> Extraction | Failure:
        self._pause()
        try:
            info = self.factory(ytdlp_options()).extract_info(
                f"https://www.youtube.com/watch?v={video_id}", download=False
            )
        except Exception as error:
            failure = _map_error(str(error))
            if failure is None:
                raise
            return failure
        tracks: list[Track] = []
        sources: tuple[tuple[Kind, str], ...] = (
            ("manual", "subtitles"),
            ("auto", "automatic_captions"),
        )
        for kind, key in sources:
            available: Mapping[str, list[Mapping[str, Any]]] = info.get(key) or {}
            for lang in self.langs:
                text = self._track(list(available.get(lang, [])))
                if text is not None:
                    tracks.append(Track(lang, kind, text))
        return Extraction(float(info.get("duration") or 0), tuple(tracks))


def make_extractor(env: Mapping[str, str], langs: list[str]) -> Extractor:
    """The fake extractor when `FETCHER_FAKE_YTDLP=1`, yt-dlp otherwise."""
    if env.get("FETCHER_FAKE_YTDLP") == "1":
        directory = env.get("FAKE_YTDLP_DIR")
        if not directory:
            raise ValueError("FAKE_YTDLP_DIR is required when FETCHER_FAKE_YTDLP=1")
        return FakeExtractor(Path(directory))
    return YtDlpExtractor(
        langs, parse_delay(env.get("YT_DELAY_SECONDS", DEFAULT_DELAY))
    )
