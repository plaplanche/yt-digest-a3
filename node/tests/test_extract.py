from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from yt_digest_node.extract import (
    Extraction,
    FakeExtractor,
    Track,
    YtDlpExtractor,
    choose_track,
    make_extractor,
    parse_delay,
)

VIDEO = "dQw4w9WgXcQ"


def make_video(root: Path, files: Mapping[str, str]) -> None:
    folder = root / VIDEO
    folder.mkdir()
    for name, text in files.items():
        (folder / name).write_text(text, encoding="utf-8")


def test_missing_directory_is_unavailable(tmp_path: Path) -> None:
    assert FakeExtractor(tmp_path).extract(VIDEO) == "unavailable"


@pytest.mark.parametrize("status", ["blocked", "unavailable"])
def test_meta_status_is_returned(tmp_path: Path, status: str) -> None:
    make_video(tmp_path, {"meta.json": f'{{"duration": 10, "status": "{status}"}}'})
    assert FakeExtractor(tmp_path).extract(VIDEO) == status


def test_fake_reads_duration_and_tracks(tmp_path: Path) -> None:
    make_video(
        tmp_path,
        {
            "meta.json": '{"duration": 90}',
            "fr.auto.vtt": "A",
            "en.manual.vtt": "B",
            "notes.txt": "x",
        },
    )
    result = FakeExtractor(tmp_path).extract(VIDEO)
    assert isinstance(result, Extraction)
    assert result.duration == 90
    assert set(result.tracks) == {Track("fr", "auto", "A"), Track("en", "manual", "B")}


def test_manual_track_beats_earlier_language_auto(tmp_path: Path) -> None:
    make_video(
        tmp_path,
        {"meta.json": '{"duration": 1}', "fr.auto.vtt": "A", "en.manual.vtt": "B"},
    )
    result = FakeExtractor(tmp_path).extract(VIDEO)
    assert isinstance(result, Extraction)
    assert choose_track(result.tracks, ["fr", "en"]) == Track("en", "manual", "B")


def test_auto_tracks_follow_language_order() -> None:
    tracks = (Track("en", "auto", "E"), Track("fr", "auto", "F"))
    assert choose_track(tracks, ["fr", "en"]) == Track("fr", "auto", "F")


def test_no_matching_track(tmp_path: Path) -> None:
    make_video(tmp_path, {"meta.json": '{"duration": 1}', "de.manual.vtt": "D"})
    result = FakeExtractor(tmp_path).extract(VIDEO)
    assert isinstance(result, Extraction)
    assert choose_track(result.tracks, ["fr", "en"]) is None


class StubYoutubeDL:
    def __init__(self, info: Mapping[str, Any] | Exception) -> None:
        self.info = info
        self.options: dict[str, Any] = {}
        self.urls: list[str] = []

    def factory(self, options: dict[str, Any]) -> "StubYoutubeDL":
        self.options = options
        return self

    def extract_info(self, url: str, download: bool = True) -> Mapping[str, Any]:
        self.urls.append(url)
        assert download is False
        if isinstance(self.info, Exception):
            raise self.info
        return self.info


def extractor(stub: StubYoutubeDL, sleeps: list[float]) -> YtDlpExtractor:
    return YtDlpExtractor(
        ["fr", "en"],
        delay=(2, 5),
        factory=stub.factory,
        download=lambda url: f"text of {url}",
        sleep=sleeps.append,
    )


def test_ytdlp_options_and_tracks() -> None:
    stub = StubYoutubeDL(
        {
            "duration": 120,
            "subtitles": {
                "en": [{"ext": "json3", "url": "u0"}, {"ext": "vtt", "url": "u1"}]
            },
            "automatic_captions": {
                "fr": [{"ext": "vtt", "url": "u2"}],
                "de": [{"ext": "vtt", "url": "u3"}],
            },
        }
    )
    sleeps: list[float] = []
    result = extractor(stub, sleeps).extract(VIDEO)
    assert stub.options["skip_download"] is True
    assert stub.options["writesubtitles"] is True
    assert stub.options["writeautomaticsub"] is True
    assert stub.options["subtitlesformat"] == "vtt"
    assert "cookiefile" not in stub.options and "cookiesfrombrowser" not in stub.options
    assert stub.urls == [f"https://www.youtube.com/watch?v={VIDEO}"]
    assert result == Extraction(
        120, (Track("en", "manual", "text of u1"), Track("fr", "auto", "text of u2"))
    )
    assert len(sleeps) == 3
    assert all(2 <= s <= 5 for s in sleeps)


@pytest.mark.parametrize(
    "message",
    [
        "ERROR: [youtube] x: Private video. Sign in if you've been granted access",
        "ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate",
        "ERROR: [youtube] x: Video unavailable. This video has been removed by the uploader",
    ],
)
def test_ytdlp_unavailable_errors(message: str) -> None:
    assert (
        extractor(StubYoutubeDL(Exception(message)), []).extract(VIDEO) == "unavailable"
    )


def test_ytdlp_bot_check_is_blocked() -> None:
    error = Exception("ERROR: [youtube] x: Sign in to confirm you’re not a bot")
    assert extractor(StubYoutubeDL(error), []).extract(VIDEO) == "blocked"


def test_ytdlp_unknown_error_is_raised() -> None:
    with pytest.raises(Exception, match="boom"):
        extractor(StubYoutubeDL(Exception("boom")), []).extract(VIDEO)


def test_parse_delay() -> None:
    assert parse_delay("2-5") == (2, 5)
    assert parse_delay("0") == (0, 0)


def test_make_extractor_fake(tmp_path: Path) -> None:
    env = {"FETCHER_FAKE_YTDLP": "1", "FAKE_YTDLP_DIR": str(tmp_path)}
    assert isinstance(make_extractor(env, ["en"]), FakeExtractor)
    with pytest.raises(ValueError):
        make_extractor({"FETCHER_FAKE_YTDLP": "1"}, ["en"])


def test_make_extractor_default_is_ytdlp_with_delay() -> None:
    result = make_extractor({"YT_DELAY_SECONDS": "1-2"}, ["en"])
    assert isinstance(result, YtDlpExtractor)
    assert result.delay == (1, 2)
