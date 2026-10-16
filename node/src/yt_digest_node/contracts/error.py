# Generated from contracts/error.schema.json by scripts/contracts.sh. Do not edit.

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class Error(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    code: str
    message: str


class ErrorBody(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
    )
    error: Error
