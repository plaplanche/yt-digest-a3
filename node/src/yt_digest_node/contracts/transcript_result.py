# Generated from contracts/transcript-result.schema.json by scripts/contracts.sh. Do not edit.

from __future__ import annotations

from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field


class Status(StrEnum):
    ok = "ok"
    no_transcript = "no_transcript"
    unavailable = "unavailable"
    blocked = "blocked"


class Source(StrEnum):
    manual = "manual"
    auto = "auto"


class TranscriptResult(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    video_id: Annotated[str, Field(pattern="^[A-Za-z0-9_-]{11}$")]
    status: Status
    lang: str | None
    source: Source | None
    word_count: Annotated[int, Field(ge=0)]
    truncated: bool
    sponsor_ratio: Annotated[float | None, Field(ge=0.0, le=1.0)]
    pages: list[str]
