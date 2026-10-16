# Generated from contracts/log-event.schema.json by scripts/contracts.sh. Do not edit.

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field


class Level(StrEnum):
    debug = "debug"
    info = "info"
    warn = "warn"
    error = "error"


class Service(StrEnum):
    node = "node"
    worker = "worker"


class Event(StrEnum):
    service_started = "service.started"
    fetch_transcript = "fetch.transcript"
    sponsorblock_call = "sponsorblock.call"


class LogEvent(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    ts: Annotated[
        str, Field(pattern="^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$")
    ]
    level: Level
    service: Service
    event: Annotated[Event, Field(title="LogEventName")]
    request_id: str | None = None
    video_id: str | None = None
    attrs: dict[str, Any]
