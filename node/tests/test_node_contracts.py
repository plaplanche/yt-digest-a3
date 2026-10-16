from typing import Any

import pytest
from pydantic import BaseModel, ValidationError
from yt_digest_node.contracts import node_result_request, transcript_result
from yt_digest_node.contracts.error import ErrorBody
from yt_digest_node.contracts.node_claim_request import NodeClaimRequest
from yt_digest_node.contracts.node_claim_response import NodeClaimResponse
from yt_digest_node.contracts.node_heartbeat_request import NodeHeartbeatRequest
from yt_digest_node.contracts.node_heartbeat_response import NodeHeartbeatResponse
from yt_digest_node.contracts.node_job_ack import NodeJobAck
from yt_digest_node.contracts.node_release_request import NodeReleaseRequest
from yt_digest_node.contracts.node_result_request import NodeResultRequest

TRANSCRIPT: dict[str, Any] = {
    "video_id": "dQw4w9WgXcQ",
    "status": "ok",
    "lang": "en",
    "source": "manual",
    "word_count": 3,
    "truncated": False,
    "sponsor_ratio": None,
    "pages": ["one two three"],
}
HEARTBEAT: dict[str, Any] = {"version": "0.1.0", "uptime_s": 12, "jobs_in_progress": 0}
RESULT: dict[str, Any] = {"lease_id": "l1", "outcome": "ok", "transcript": TRANSCRIPT}

VALID: list[tuple[type[BaseModel], dict[str, Any]]] = [
    (NodeHeartbeatRequest, HEARTBEAT),
    (
        NodeHeartbeatRequest,
        {
            **HEARTBEAT,
            "last_success_at": "2026-10-16T07:00:01.123Z",
            "last_blocked_at": None,
            "disk_free_ratio": 0.5,
            "cpu_temp_c": 41.5,
        },
    ),
    (
        NodeHeartbeatResponse,
        {"node_id": "n1", "state": "healthy", "hourly_budget": 5, "directive": "run"},
    ),
    (NodeClaimRequest, {}),
    (NodeClaimRequest, {"max_jobs": 10}),
    (NodeClaimResponse, {"jobs": []}),
    (
        NodeClaimResponse,
        {
            "jobs": [
                {
                    "video_id": "dQw4w9WgXcQ",
                    "lease_id": "0123456789abcdef",
                    "lease_expires_at": "2026-10-16T07:00:01.123Z",
                }
            ]
        },
    ),
    (NodeResultRequest, RESULT),
    (NodeResultRequest, {**RESULT, "outcome": "error", "transcript": None}),
    (NodeReleaseRequest, {"lease_id": "l1"}),
    (NodeJobAck, {"video_id": "dQw4w9WgXcQ", "status": "done"}),
    (ErrorBody, {"error": {"code": "stale_lease", "message": "no such lease"}}),
]

INVALID: list[tuple[type[BaseModel], dict[str, Any]]] = [
    (NodeHeartbeatRequest, {**HEARTBEAT, "extra": 1}),
    (NodeHeartbeatRequest, {"uptime_s": 1, "jobs_in_progress": 0}),
    (NodeHeartbeatRequest, {**HEARTBEAT, "version": ""}),
    (NodeHeartbeatRequest, {**HEARTBEAT, "uptime_s": -1}),
    (NodeHeartbeatRequest, {**HEARTBEAT, "disk_free_ratio": 1.1}),
    (NodeHeartbeatRequest, {**HEARTBEAT, "last_success_at": "yesterday"}),
    (
        NodeHeartbeatResponse,
        {"node_id": "n1", "state": "sick", "hourly_budget": 5, "directive": "run"},
    ),
    (NodeClaimRequest, {"extra": 1}),
    (NodeClaimRequest, {"max_jobs": 0}),
    (NodeClaimRequest, {"max_jobs": 11}),
    (NodeClaimResponse, {"jobs": [{"video_id": "dQw4w9WgXcQ", "lease_id": "short"}]}),
    (NodeResultRequest, {**RESULT, "extra": 1}),
    (NodeResultRequest, {**RESULT, "outcome": "weird"}),
    (NodeResultRequest, {**RESULT, "transcript": {**TRANSCRIPT, "extra": 1}}),
    (NodeResultRequest, {**RESULT, "transcript": {**TRANSCRIPT, "video_id": "x"}}),
    (NodeResultRequest, {"lease_id": "l1", "outcome": "error"}),
    (NodeReleaseRequest, {"lease_id": ""}),
    (NodeJobAck, {"video_id": "dQw4w9WgXcQ", "status": "failed"}),
    (ErrorBody, {"error": {"code": "x"}}),
    (ErrorBody, {"error": {"code": "x", "message": "y", "extra": 1}}),
]


@pytest.mark.parametrize(("model", "instance"), VALID)
def test_valid_instance_is_accepted(
    model: type[BaseModel], instance: dict[str, Any]
) -> None:
    model.model_validate(instance)


@pytest.mark.parametrize(("model", "instance"), INVALID)
def test_invalid_instance_is_rejected(
    model: type[BaseModel], instance: dict[str, Any]
) -> None:
    with pytest.raises(ValidationError):
        model.model_validate(instance)


def test_result_request_uses_the_generated_transcript_result_type() -> None:
    request = NodeResultRequest.model_validate(RESULT)
    assert isinstance(request.transcript, transcript_result.TranscriptResult)
    annotation = NodeResultRequest.model_fields["transcript"].annotation
    assert annotation == transcript_result.TranscriptResult | None
    assert not hasattr(node_result_request, "Schema")
