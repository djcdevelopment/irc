#!/usr/bin/env python3
"""Outbound IRC adapter for one OpenAI-compatible remote agent."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import ssl
import time
from collections import defaultdict

import httpx


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s agent_adapter %(message)s",
)
LOG = logging.getLogger("agent_adapter")
PROTOCOL = "HERDER/1"
MAX_FRAGMENTS = 64
FRAGMENT_TTL_SECONDS = 300
MAX_PARTIAL_REQUESTS = 32


def format_bytes(count: int) -> str:
    if count < 1024:
        return f"{count}B"
    kib = count / 1024
    if kib < 1024:
        return f"{kib:.1f}KiB"
    return f"{kib / 1024:.1f}MiB"


def required(name: str) -> str:
    value = os.environ.get(name, "")
    if not value or any(character in value for character in "\r\n\0"):
        raise RuntimeError(f"required environment variable is invalid: {name}")
    return value


class Adapter:
    def __init__(self) -> None:
        self.server = required("IRC_SERVER")
        self.port = int(os.environ.get("IRC_PORT", "8443"))
        self.account = required("IRC_ACCOUNT")
        self.nick = os.environ.get("IRC_NICK", self.account)
        self.password = required("IRC_PASSWORD")
        self.herder = required("HERDER_ACCOUNT")
        self.owner = required("OWNER_ACCOUNT")
        self.endpoint = required("OPENAI_BASE_URL").rstrip("/")
        self.api_key = required("OPENAI_API_KEY")
        self.model = required("OPENAI_MODEL")
        self.max_tokens = max(64, int(os.environ.get("OPENAI_MAX_TOKENS", "512")))
        self.description = os.environ.get("AGENT_DESCRIPTION", self.account)[:120]
        self.use_tls = os.environ.get("IRC_TLS", "true").lower() == "true"
        self.timeout_seconds = max(
            5, int(os.environ.get("OPENAI_TIMEOUT_SECONDS", "120"))
        )
        # Keep below the provider's own concurrency cap so a burst queues here
        # instead of coming back as HTTP 429.
        self.semaphore = asyncio.Semaphore(
            max(1, int(os.environ.get("OPENAI_MAX_CONCURRENT_REQUESTS", "2")))
        )
        self.writer: asyncio.StreamWriter | None = None
        self.fragments: dict[str, dict[int, str]] = defaultdict(dict)
        self.fragment_totals: dict[str, int] = {}
        self.fragment_seen: dict[str, float] = {}
        self.client = httpx.AsyncClient(
            base_url=self.endpoint,
            headers={"Authorization": f"Bearer {self.api_key}"},
            timeout=httpx.Timeout(self.timeout_seconds),
        )

    def prune_fragments(self, now: float) -> None:
        """Incomplete requests would otherwise accumulate for the process
        lifetime, since nothing else ever removes them."""
        stale = [
            key
            for key, seen in self.fragment_seen.items()
            if now - seen > FRAGMENT_TTL_SECONDS
        ]
        for key in stale:
            self.fragments.pop(key, None)
            self.fragment_totals.pop(key, None)
            self.fragment_seen.pop(key, None)
        if stale:
            LOG.warning("fragments_expired count=%d", len(stale))

    async def send(self, line: str) -> None:
        if not self.writer or any(character in line for character in "\r\n\0"):
            raise RuntimeError("IRC connection is unavailable")
        payload = (line + "\r\n").encode()
        if len(payload) > 512:
            raise RuntimeError("outgoing IRC frame is too large")
        self.writer.write(payload)
        await self.writer.drain()

    async def run(self) -> None:
        delay = 2
        while True:
            try:
                await self.session()
                delay = 2
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                LOG.warning("disconnected error_type=%s retry_seconds=%d", type(exc).__name__, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)

    async def session(self) -> None:
        context = ssl.create_default_context() if self.use_tls else None
        reader, self.writer = await asyncio.open_connection(
            self.server,
            self.port,
            ssl=context,
            server_hostname=self.server if context else None,
        )
        await self.send("CAP LS 302")
        await self.send(f"NICK {self.nick}")
        await self.send(f"USER {self.account} 0 * :Remote BotHerder agent")
        registered = False
        capabilities_requested = False
        sasl_started = False
        hello_at = 0.0
        while True:
            raw = await asyncio.wait_for(reader.readline(), timeout=300)
            if not raw:
                raise ConnectionError("server closed the connection")
            line = raw.decode(errors="replace").rstrip("\r\n")
            if line.startswith("PING "):
                await self.send(f"PONG {line[5:]}")
                continue
            command, params, tags, prefix = self.parse(line)
            if (
                command == "CAP"
                and len(params) >= 2
                and params[1].upper() == "LS"
                and not (len(params) >= 4 and params[-2] == "*")
                and not capabilities_requested
            ):
                capabilities_requested = True
                await self.send("CAP REQ :sasl account-tag message-tags server-time")
            elif (
                command == "CAP"
                and len(params) >= 2
                and params[1].upper() == "ACK"
                and not sasl_started
            ):
                sasl_started = True
                await self.send("AUTHENTICATE PLAIN")
            elif command == "AUTHENTICATE" and params == ["+"]:
                payload = base64.b64encode(
                    b"\0" + self.account.encode() + b"\0" + self.password.encode()
                ).decode()
                await self.send(f"AUTHENTICATE {payload}")
            elif command == "903":
                await self.send("CAP END")
            elif command in {"904", "905", "906", "907"}:
                raise RuntimeError("SASL authentication failed")
            elif command == "001":
                registered = True
                await self.send("JOIN #general")
                await self.hello()
                hello_at = time.monotonic()
                LOG.info("connected account=%s herder=%s", self.account, self.herder)
            elif command == "PRIVMSG" and registered:
                await self.handle_privmsg(params, tags, prefix)
            if registered and time.monotonic() - hello_at > 30:
                await self.hello()
                hello_at = time.monotonic()

    @staticmethod
    def parse(line: str):
        tags = {}
        if line.startswith("@"):
            tag_text, _, line = line.partition(" ")
            for item in tag_text[1:].split(";"):
                key, _, value = item.partition("=")
                tags[key] = value
        prefix = ""
        if line.startswith(":"):
            prefix, _, line = line[1:].partition(" ")
        middle, separator, trailing = line.partition(" :")
        parts = middle.split()
        command = parts.pop(0).upper() if parts else ""
        if separator:
            parts.append(trailing)
        return command, parts, tags, prefix

    async def hello(self) -> None:
        encoded = base64.urlsafe_b64encode(self.description.encode()).decode().rstrip("=")
        await self.send(f"PRIVMSG {self.herder} :{PROTOCOL} HELLO {encoded}")

    async def handle_privmsg(self, params, tags, prefix) -> None:
        if len(params) < 2 or params[0].casefold() != self.nick.casefold():
            return
        if tags.get("account", "").casefold() != self.herder.casefold():
            return
        pieces = params[1].split(" ", 4)
        if len(pieces) != 5 or pieces[:2] != [PROTOCOL, "REQUEST"]:
            return
        request_id, part_text, payload = pieces[2:]
        now = time.monotonic()
        self.prune_fragments(now)
        try:
            part, total = (int(value) for value in part_text.split("/", 1))
        except ValueError:
            return
        if not (1 <= part <= total):
            return
        if total > MAX_FRAGMENTS:
            # Say so rather than dropping silently and letting the Herder wait
            # out its timeout.
            await self.send(
                f"PRIVMSG {self.herder} :{PROTOCOL} ERROR {request_id} too_large"
            )
            return
        if (
            request_id not in self.fragments
            and len(self.fragments) >= MAX_PARTIAL_REQUESTS
        ):
            await self.send(
                f"PRIVMSG {self.herder} :{PROTOCOL} ERROR {request_id} busy"
            )
            return
        self.fragments[request_id][part] = payload
        self.fragment_totals[request_id] = total
        self.fragment_seen[request_id] = now
        if len(self.fragments[request_id]) == total:
            encoded = "".join(self.fragments.pop(request_id)[index] for index in range(1, total + 1))
            self.fragment_totals.pop(request_id, None)
            self.fragment_seen.pop(request_id, None)
            prompt = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode()
            asyncio.create_task(self.complete(request_id, prompt))

    async def complete(self, request_id: str, prompt: str) -> None:
        started = time.monotonic()
        try:
            async with self.semaphore:
                response = await self.client.post(
                    "chat/completions",
                    json={
                        "model": self.model,
                        "messages": [{"role": "user", "content": prompt}],
                        "max_tokens": self.max_tokens,
                    },
                )
            response.raise_for_status()
            value = response.json()
            content = value["choices"][0]["message"]["content"].strip()
            if not content:
                raise ValueError("empty completion")
            usage = value.get("usage") or {}
            maximum_bytes = 4_500
            content_bytes = content.encode("utf-8")
            total_bytes = len(content_bytes)
            if total_bytes > maximum_bytes:
                marker = (
                    "\n... (truncated by remote adapter; full result "
                    f"{format_bytes(total_bytes)})"
                )
                content = (
                    content_bytes[: maximum_bytes - len(marker.encode())]
                    .decode("utf-8", errors="ignore")
                    + marker
                )
            # Sent after truncation so the usage frame and the delivered content
            # are emitted from the same finalized result.
            await self.send(
                f"PRIVMSG {self.herder} :{PROTOCOL} USAGE {request_id} "
                f"{int(usage.get('prompt_tokens') or 0)} "
                f"{int(usage.get('completion_tokens') or 0)} "
                f"{int(usage.get('total_tokens') or 0)}"
            )
            encoded = base64.urlsafe_b64encode(content.encode()).decode().rstrip("=")
            pieces = [encoded[index:index + 260] for index in range(0, len(encoded), 260)]
            for index, piece in enumerate(pieces, 1):
                await self.send(
                    f"PRIVMSG {self.herder} :{PROTOCOL} RESPONSE {request_id} "
                    f"{index}/{len(pieces)} {piece}"
                )
            LOG.info(
                "request_completed request_id=%s duration_ms=%d output_chunks=%d",
                request_id,
                int((time.monotonic() - started) * 1000),
                len(pieces),
            )
        except Exception as exc:
            reason = self.error_reason(exc)
            await self.send(
                f"PRIVMSG {self.herder} :{PROTOCOL} ERROR {request_id} {reason}"
            )
            LOG.warning(
                "request_failed request_id=%s error_type=%s reason=%s",
                request_id,
                type(exc).__name__,
                reason,
            )

    @staticmethod
    def error_reason(exc: Exception) -> str:
        """Map a failure to an allow-listed HERDER/1 reason the Herder can
        render. Anything unrecognized stays generic rather than leaking
        provider internals into a channel."""
        if isinstance(exc, httpx.TimeoutException):
            return "timeout"
        if isinstance(exc, httpx.HTTPStatusError):
            status = exc.response.status_code
            if status == 429:
                return "busy"
            if status in {401, 403, 400, 404, 422}:
                return "rejected"
            if status >= 500:
                return "unavailable"
            return "failed"
        if isinstance(exc, httpx.HTTPError):
            return "unavailable"
        return "failed"


asyncio.run(Adapter().run())
