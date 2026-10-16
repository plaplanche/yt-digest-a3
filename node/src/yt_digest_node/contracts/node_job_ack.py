# Generated from contracts/node-job-ack.schema.json by scripts/contracts.sh. Do not edit.

from __future__ import annotations

from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field


class Status(StrEnum):
    queued = "queued"
    leased = "leased"
    done = "done"
    failed_video = "failed_video"


class NodeJobAck(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    video_id: Annotated[str, Field(pattern="^[A-Za-z0-9_-]{11}$")]
    status: Status
