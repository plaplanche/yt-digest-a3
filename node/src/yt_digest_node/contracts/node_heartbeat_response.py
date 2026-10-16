# Generated from contracts/node-heartbeat-response.schema.json by scripts/contracts.sh. Do not edit.

from __future__ import annotations

from enum import StrEnum
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field


class State(StrEnum):
    healthy = "healthy"
    degraded = "degraded"
    quarantined = "quarantined"
    offline = "offline"
    disabled = "disabled"


class Directive(StrEnum):
    run = "run"
    pause = "pause"
    drain = "drain"


class NodeHeartbeatResponse(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    node_id: str
    state: State
    hourly_budget: Annotated[int, Field(ge=0)]
    directive: Directive
