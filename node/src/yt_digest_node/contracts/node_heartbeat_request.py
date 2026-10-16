# Generated from contracts/node-heartbeat-request.schema.json by scripts/contracts.sh. Do not edit.

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, RootModel


class LastSuccessAt(RootModel[str]):
    root: Annotated[
        str, Field(pattern="^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$")
    ]


class LastBlockedAt(RootModel[str]):
    root: Annotated[
        str, Field(pattern="^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$")
    ]


class NodeHeartbeatRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    version: Annotated[str, Field(max_length=64, min_length=1)]
    uptime_s: Annotated[int, Field(ge=0)]
    jobs_in_progress: Annotated[int, Field(ge=0)]
    last_success_at: LastSuccessAt | None = None
    last_blocked_at: LastBlockedAt | None = None
    disk_free_ratio: Annotated[float | None, Field(ge=0.0, le=1.0)] = None
    cpu_temp_c: float | None = None
