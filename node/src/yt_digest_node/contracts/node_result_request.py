# Generated from contracts/node-result-request.schema.json by scripts/contracts.sh. Do not edit.

from __future__ import annotations

from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from .transcript_result import TranscriptResult


class Outcome(StrEnum):
    ok = "ok"
    no_transcript = "no_transcript"
    unavailable = "unavailable"
    blocked = "blocked"
    error = "error"


class NodeResultRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    lease_id: Annotated[str, Field(min_length=1)]
    outcome: Outcome
    transcript: TranscriptResult | None
