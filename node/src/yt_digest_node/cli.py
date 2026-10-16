"""The `yt-digest-node` command (spec 5)."""

import argparse
import os
import re
import sys
import time
from collections.abc import Mapping, Sequence
from importlib.metadata import version
from typing import Any

from yt_digest_node.clean import clean_cues, parse_vtt
from yt_digest_node.contracts.transcript_result import TranscriptResult
from yt_digest_node.extract import Extraction, choose_track, make_extractor
from yt_digest_node.log import emit
from yt_digest_node.paginate import paginate, truncate, words_in
from yt_digest_node.sponsorblock import (
    SponsorBlockResult,
    fetch_segments,
    sponsor_ratio,
)

VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")


def _video_id(value: str) -> str:
    if not VIDEO_ID.fullmatch(value):
        raise argparse.ArgumentTypeError(f"invalid video id: {value!r}")
    return value


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="yt-digest-node")
    commands = parser.add_subparsers(dest="command", required=True)
    transcript = commands.add_parser("transcript")
    transcript.add_argument("video_id", type=_video_id)
    transcript.add_argument("--langs")
    transcript.add_argument("--request-id")
    return parser


def _positive(env: Mapping[str, str], name: str, default: int) -> int:
    try:
        value = int(env.get(name, default))
    except ValueError:
        value = 0
    if value < 1:
        raise ValueError(f"{name} must be a positive integer")
    return value


def _langs(value: str) -> list[str]:
    return [lang.strip() for lang in value.split(",") if lang.strip()]


def _result(video_id: str, status: str, **fields: Any) -> TranscriptResult:
    return TranscriptResult.model_validate(
        {
            "video_id": video_id,
            "status": status,
            "lang": None,
            "source": None,
            "word_count": 0,
            "truncated": False,
            "sponsor_ratio": None,
            "pages": [],
            **fields,
        }
    )


def run(
    video_id: str, langs: list[str], env: Mapping[str, str], request_id: str | None
) -> tuple[TranscriptResult, dict[str, Any]]:
    """The whole pipeline; returns the result and the `attrs` of its log line."""
    max_words = _positive(env, "MAX_WORDS", 60000)
    page_words = _positive(env, "PAGE_WORDS", 12000)
    extracted = make_extractor(env, langs).extract(video_id)
    track = None
    if isinstance(extracted, Extraction):
        track = choose_track(extracted.tracks, langs)
    if not isinstance(extracted, Extraction) or track is None:
        status = extracted if isinstance(extracted, str) else "no_transcript"
        return _result(video_id, status), {"outcome": status, "words": 0, "pages": 0}
    sponsor: SponsorBlockResult = fetch_segments(
        env.get("SPONSORBLOCK_URL", "https://sponsor.ajay.app"), video_id, request_id
    )
    paragraphs = clean_cues(parse_vtt(track.text), sponsor.segments)
    paragraphs, truncated = truncate(paragraphs, max_words)
    pages = paginate(paragraphs, page_words)
    words = sum(words_in(p) for p in paragraphs)
    ratio = (
        None
        if sponsor.state == "error"
        else sponsor_ratio(sponsor.segments, extracted.duration)
    )
    result = _result(
        video_id,
        "ok",
        lang=track.lang,
        source=track.kind,
        word_count=words,
        truncated=truncated,
        sponsor_ratio=ratio,
        pages=pages,
    )
    attrs: dict[str, Any] = {
        "outcome": "ok",
        "source": track.kind,
        "words": words,
        "pages": len(pages),
        "sponsorblock": sponsor.state,
    }
    if ratio is not None:
        attrs["sponsor_ratio"] = ratio
    return result, attrs


def main(
    argv: Sequence[str] | None = None, env: Mapping[str, str] | None = None
) -> int:
    env = os.environ if env is None else env
    args = _parser().parse_args(argv)  # exits with 2 on a bad argument
    try:
        langs = _langs(
            args.langs
            if args.langs is not None
            else env.get("TRANSCRIPT_LANGS", "fr,en")
        )
        if not langs:
            raise ValueError("no language given")
        started = time.monotonic()
        ids: dict[str, Any] = {"video_id": args.video_id}
        if args.request_id is not None:
            ids["request_id"] = args.request_id
        emit("service.started", attrs={"version": version("yt-digest-node")}, **ids)
        result, attrs = run(args.video_id, langs, env, args.request_id)
    except ValueError as error:
        print(f"yt-digest-node: error: {error}", file=sys.stderr)
        return 2
    attrs["duration_ms"] = round((time.monotonic() - started) * 1000)
    emit("fetch.transcript", attrs=attrs, **ids)
    print(result.model_dump_json())
    return 0


if __name__ == "__main__":
    sys.exit(main())
