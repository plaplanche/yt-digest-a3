# Generated from contracts/node-release-request.schema.json by scripts/contracts.sh. Do not edit.

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field


class NodeReleaseRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    lease_id: Annotated[str, Field(min_length=1)]
