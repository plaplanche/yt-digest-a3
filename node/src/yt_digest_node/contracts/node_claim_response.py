# Generated from contracts/node-claim-response.schema.json by scripts/contracts.sh. Do not edit.

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field


class Job(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    video_id: Annotated[str, Field(pattern="^[A-Za-z0-9_-]{11}$")]
    lease_id: Annotated[str, Field(min_length=16)]
    lease_expires_at: Annotated[
        str, Field(pattern="^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$")
    ]


class NodeClaimResponse(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    jobs: list[Job]
