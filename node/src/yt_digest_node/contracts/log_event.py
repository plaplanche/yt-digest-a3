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
    node_enrolled = "node.enrolled"
    node_revoked = "node.revoked"
    node_heartbeat = "node.heartbeat"
    job_enqueued = "job.enqueued"
    job_claimed = "job.claimed"
    job_completed = "job.completed"
    job_released = "job.released"
    job_lease_expired = "job.lease_expired"
    job_stale_result = "job.stale_result"
    job_validation_failed = "job.validation_failed"
    auth_bearer_rejected = "auth.bearer.rejected"
    auth_client_registered = "auth.client.registered"
    auth_oauth_completed = "auth.oauth.completed"
    auth_oauth_denied = "auth.oauth.denied"
    auth_token_issued = "auth.token.issued"
    auth_refresh_reuse_detected = "auth.refresh.reuse_detected"
    auth_origin_rejected = "auth.origin.rejected"
    mcp_tool_call = "mcp.tool.call"
    worker_call = "worker.call"


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
