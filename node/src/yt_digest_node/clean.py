"""VTT parsing and transcript cleaning (spec 5.4, steps 1 to 5)."""

import html
import re
from dataclasses import dataclass

PARAGRAPH_GAP_MS = 2000

_TIMING = re.compile(
    r"^\s*(?P<start>(?:\d+:)?\d{1,2}:\d{2}\.\d{3})\s*-->\s*(?P<end>(?:\d+:)?\d{1,2}:\d{2}\.\d{3})"
)
_IGNORED_BLOCKS = re.compile(r"^(NOTE|STYLE|REGION)(\s|$)")
_TAG = re.compile(r"<[^>]*>")
_ANNOTATION = re.compile(r"\[[^\]]*\]")
_SPACES = re.compile(r"\s+")


@dataclass(frozen=True)
class Cue:
    start: float
    end: float
    lines: tuple[str, ...]


def _seconds(timestamp: str) -> float:
    *head, seconds = timestamp.split(":")
    total = 0
    for part in head:
        total = total * 60 + int(part)
    whole, millis = seconds.split(".")
    return (total * 60 + int(whole)) + int(millis) / 1000


def parse_vtt(text: str) -> list[Cue]:
    """Parse VTT text into cues, ignoring the header, NOTE/STYLE/REGION blocks and cue settings."""
    blocks = re.split(
        r"\n{2,}", text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    )
    cues: list[Cue] = []
    for block in blocks:
        lines = block.strip("\n").split("\n")
        if _IGNORED_BLOCKS.match(lines[0]) or lines[0].startswith("WEBVTT"):
            continue
        for index, line in enumerate(lines):
            match = _TIMING.match(line)
            if match:
                cues.append(
                    Cue(
                        _seconds(match["start"]),
                        _seconds(match["end"]),
                        tuple(lines[index + 1 :]),
                    )
                )
                break
    return cues


def _clean_line(line: str) -> str:
    line = html.unescape(_TAG.sub("", line))
    return _SPACES.sub(" ", _ANNOTATION.sub("", line)).strip()


def _in_segment(cue: Cue, segments: list[tuple[float, float]]) -> bool:
    midpoint = (cue.start + cue.end) / 2
    return any(start <= midpoint < end for start, end in segments)


def clean_cues(cues: list[Cue], segments: list[tuple[float, float]]) -> list[str]:
    """Return the paragraphs of clean text; `segments` are SponsorBlock (start, end) pairs."""
    paragraphs: list[list[str]] = []
    last_line: str | None = None
    previous_end: float | None = None
    for cue in cues:
        if _in_segment(cue, segments):
            continue
        kept: list[str] = []
        for line in map(_clean_line, cue.lines):
            if line and line != last_line:
                kept.append(line)
                last_line = line
        if not kept:
            continue
        gap_ms = (
            None if previous_end is None else round((cue.start - previous_end) * 1000)
        )
        if gap_ms is None or gap_ms >= PARAGRAPH_GAP_MS:
            paragraphs.append([])
        paragraphs[-1].extend(kept)
        previous_end = cue.end
    return [" ".join(lines) for lines in paragraphs]
