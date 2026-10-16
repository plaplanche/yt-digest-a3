"""Structured logger: one JSON object per line on standard error, validated against the catalogue."""

import sys
from datetime import UTC, datetime
from typing import Any

from pydantic import ValidationError

from yt_digest_node.contracts.log_event import Event, Level, LogEvent, Service

_RESERVED = ("ts", "service")


def emit(event: Event | str, level: Level | str = "info", **fields: Any) -> None:
    """Write one log line; raise ValueError for an unknown event, level or field."""
    reserved = [name for name in _RESERVED if name in fields]
    if reserved:
        raise ValueError(f"log field set by the logger: {', '.join(reserved)}")
    ts = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    try:
        line = LogEvent.model_validate(
            {
                "ts": ts,
                "level": level,
                "service": Service.node,
                "event": event,
                "attrs": {},
                **fields,
            }
        )
    except ValidationError as error:
        raise ValueError(str(error)) from error
    print(line.model_dump_json(exclude_none=True), file=sys.stderr)
