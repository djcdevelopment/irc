from __future__ import annotations

import re


TRUNCATION_MARKER = "… (truncated)"


def format_bytes(count: int) -> str:
    if count < 1024:
        return f"{count}B"
    kib = count / 1024
    if kib < 1024:
        return f"{kib:.1f}KiB"
    return f"{kib / 1024:.1f}MiB"


def truncation_marker(total_bytes: int) -> str:
    """Marker naming the full result size, so a reader can judge what was lost."""
    return f"… (truncated; full result {format_bytes(total_bytes)})"


def _utf8_prefix(value: str, maximum_bytes: int) -> str:
    if maximum_bytes <= 0:
        return ""
    encoded = value.encode("utf-8")
    if len(encoded) <= maximum_bytes:
        return value
    return encoded[:maximum_bytes].decode("utf-8", errors="ignore")


def _normalize(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n").replace("\t", "    ")
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", value).strip()


def chunk_completion(
    content: str,
    *,
    max_payload_bytes: int,
    max_output_bytes: int,
    max_lines: int,
) -> list[str]:
    normalized = _normalize(content)
    if not normalized:
        return []

    total_bytes = len(normalized.encode("utf-8"))
    marker = truncation_marker(total_bytes)
    marker_bytes = len(marker.encode("utf-8"))
    truncated = total_bytes > max_output_bytes
    byte_budget = max_output_bytes - marker_bytes if truncated else max_output_bytes
    clipped = _utf8_prefix(normalized, max(1, byte_budget))

    chunks: list[str] = []
    logical_lines = clipped.split("\n")
    for line_index, logical_line in enumerate(logical_lines):
        remaining = logical_line.strip()
        if not remaining:
            continue
        while remaining:
            if len(chunks) >= max_lines:
                truncated = True
                break
            piece = _utf8_prefix(remaining, max_payload_bytes)
            if not piece:
                truncated = True
                break
            chunks.append(piece)
            remaining = remaining[len(piece) :].lstrip()
        if len(chunks) >= max_lines and (
            remaining or line_index < len(logical_lines) - 1
        ):
            truncated = True
            break

    if truncated:
        if len(chunks) < max_lines:
            chunks.append(marker)
        elif chunks:
            chunks[-1] = marker
        else:
            chunks = [marker]
    return chunks[:max_lines]
