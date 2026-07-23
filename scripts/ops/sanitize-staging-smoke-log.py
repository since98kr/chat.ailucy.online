#!/usr/bin/env python3
"""Create a shareable staging smoke log without credentials or host-private paths."""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path


REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"(?i)(authorization\s*:\s*bearer\s+)[^\s]+"),
        r"\1<redacted>",
    ),
    (
        re.compile(r"(?i)(cf-access-authenticated-user-email\s*:\s*)[^\s]+"),
        r"\1<redacted-email>",
    ),
    (
        re.compile(r"\bgh[pousr]_[A-Za-z0-9_]+\b"),
        "<redacted-github-token>",
    ),
    (
        re.compile(r"\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b"),
        "<redacted-token>",
    ),
    (
        re.compile(
            r"(?i)\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)=([^\s]+)"
        ),
        r"\1=<redacted>",
    ),
    (
        re.compile(
            r"(?i)([\"']?(?:token|secret|password|api[_-]?key|authorization|cookie)[\"']?\s*[:=]\s*[\"']?)([^\"'\s,}]+)"
        ),
        r"\1<redacted>",
    ),
    (
        re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE),
        "<redacted-email>",
    ),
    (
        re.compile(
            r"(?<![A-Za-z0-9:])/(?:home|opt|tmp|srv|var/lib)(?:/[^\s\"'<>]+)+"
        ),
        "<redacted-path>",
    ),
)


def sanitize(text: str) -> str:
    result = text
    for pattern, replacement in REDACTIONS:
        result = pattern.sub(replacement, result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()

    source = args.source.resolve(strict=True)
    if not source.is_file() or source.is_symlink():
        raise SystemExit("source must be a regular non-symlink file")

    destination = args.destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.parent.chmod(0o700)

    payload = sanitize(source.read_text(encoding="utf-8", errors="replace"))
    tmp = destination.with_name(f".{destination.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(payload, encoding="utf-8")
        tmp.chmod(0o600)
        os.replace(tmp, destination)
    finally:
        tmp.unlink(missing_ok=True)

    destination.chmod(0o600)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
