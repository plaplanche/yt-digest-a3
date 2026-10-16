# Generated from contracts/node-claim-request.schema.json by scripts/contracts.sh. Do not edit.

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field


class NodeClaimRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    max_jobs: Annotated[int | None, Field(ge=1, le=10)] = None
