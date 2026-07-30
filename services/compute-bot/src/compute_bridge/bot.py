from __future__ import annotations

import asyncio
import base64
import logging
import random
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from .config import AppConfig, ModelConfig
from .metrics import MetricsStore
from .models import ModelClient, ModelError
from .output import chunk_completion
from .portal import CommunityPortalClient, PortalError
from .protocol import IRCMessage, parse_irc_line
from .rate_limit import SlidingWindowRateLimiter


LOGGER = logging.getLogger("bot_herder")
REQUIRED_CAPABILITIES = {"sasl", "account-tag", "message-tags"}
AGENT_PROTOCOL = "HERDER/1"


class IRCConnectionError(RuntimeError):
    pass


@dataclass
class PendingAgentRequest:
    request_id: str
    target: str
    requester_nick: str
    requester_account: str
    agent_account: str
    started: float
    timeout_task: asyncio.Task[None] | None = None
    parts: dict[int, str] = field(default_factory=dict)
    total_parts: int | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None


class BotHerder:
    """One IRC identity and one owner's private compute/agent control plane."""

    def __init__(
        self,
        config: AppConfig,
        *,
        metrics: MetricsStore | None = None,
        portal: CommunityPortalClient | None = None,
    ) -> None:
        self.config = config
        self.metrics = metrics
        self.portal = portal
        self.model_client = ModelClient()
        self.rate_limiter = SlidingWindowRateLimiter(
            config.limits.requests_per_minute
        )
        self.semaphore = asyncio.Semaphore(config.limits.max_concurrent_requests)
        self.writer: asyncio.StreamWriter | None = None
        self.registered = False
        self.stop_event = asyncio.Event()
        self.pending_count = 0
        self.request_tasks: set[asyncio.Task[None]] = set()
        self.agent_requests: dict[str, PendingAgentRequest] = {}
        self.channels_to_join = {channel for channel in config.irc.channels}
        self._send_lock = asyncio.Lock()
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._capabilities: set[str] = set()
        self._cap_requested = False
        self._sasl_started = False
        self._connected_monotonic: float | None = None
        self._agents_cache: tuple[float, list[dict]] = (0, [])
        if self.metrics:
            self.metrics.register_herder(
                self.config.irc.account, self.config.irc.owner_account
            )

    async def run(self) -> None:
        delay = self.config.irc.reconnect_initial_seconds
        try:
            while not self.stop_event.is_set():
                try:
                    await self._connection_session()
                    delay = self.config.irc.reconnect_initial_seconds
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    if not self.stop_event.is_set():
                        LOGGER.warning(
                            "irc_disconnected herder=%s error_type=%s "
                            "retry_seconds=%.1f",
                            self.config.irc.account,
                            type(exc).__name__,
                            delay,
                        )
                finally:
                    await self._disconnect()
                if self.stop_event.is_set():
                    break
                sleep_for = delay + random.uniform(0, min(1, delay / 4))
                try:
                    await asyncio.wait_for(self.stop_event.wait(), timeout=sleep_for)
                except TimeoutError:
                    pass
                delay = min(delay * 2, self.config.irc.reconnect_max_seconds)
        finally:
            for task in list(self.request_tasks):
                task.cancel()
            for pending in self.agent_requests.values():
                if pending.timeout_task:
                    pending.timeout_task.cancel()
            tasks = list(self.request_tasks) + [
                pending.timeout_task
                for pending in self.agent_requests.values()
                if pending.timeout_task
            ]
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            self.agent_requests.clear()
            await self.model_client.close()

    async def stop(self) -> None:
        self.stop_event.set()
        if self.writer:
            self.writer.close()

    async def _connection_session(self) -> None:
        LOGGER.info(
            "irc_connecting herder=%s server=%s port=%d",
            self.config.irc.account,
            self.config.irc.server,
            self.config.irc.port,
        )
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(self.config.irc.server, self.config.irc.port),
            timeout=10,
        )
        self.writer = writer
        self.registered = False
        self._capabilities.clear()
        self._cap_requested = False
        self._sasl_started = False
        await self._send_raw("CAP LS 302")
        await self._send_raw(f"NICK {self.config.irc.nick}")
        await self._send_raw(
            f"USER {self.config.irc.account} 0 * :Private community BotHerder"
        )

        while not self.stop_event.is_set():
            raw = await asyncio.wait_for(reader.readline(), timeout=300)
            if not raw:
                raise IRCConnectionError("server closed the connection")
            if len(raw) > 8192:
                raise IRCConnectionError("oversized IRC frame")
            try:
                message = parse_irc_line(raw.decode("utf-8", errors="replace"))
            except ValueError:
                LOGGER.warning("irc_parse_error herder=%s", self.config.irc.account)
                continue
            await self._handle_message(message)

    async def _disconnect(self) -> None:
        self.registered = False
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            await asyncio.gather(self._heartbeat_task, return_exceptions=True)
            self._heartbeat_task = None
        if self.writer:
            self.writer.close()
            try:
                await self.writer.wait_closed()
            except Exception:
                pass
            self.writer = None

    async def _handle_message(self, message: IRCMessage) -> None:
        if message.command == "PING":
            token = message.params[-1] if message.params else ""
            await self._send_raw(f"PONG :{token}")
            return
        if message.command == "ERROR":
            raise IRCConnectionError("IRC ERROR")
        if message.command == "CAP":
            await self._handle_cap(message)
            return
        if message.command == "AUTHENTICATE" and message.params == ("+",):
            await self._send_sasl_payload()
            return
        if message.command in {"904", "905", "906", "907"}:
            raise IRCConnectionError("SASL authentication failed")
        if message.command == "903":
            await self._send_raw("CAP END")
            return
        if message.command == "001":
            await self._on_registered()
            return
        if message.command == "INVITE":
            await self._handle_invite(message)
            return
        if message.command == "PRIVMSG":
            await self._handle_privmsg(message)

    async def _handle_cap(self, message: IRCMessage) -> None:
        if len(message.params) < 2:
            return
        subcommand = message.params[1].upper()
        if subcommand == "LS":
            capabilities = message.params[-1].split()
            self._capabilities.update(item.split("=", 1)[0] for item in capabilities)
            continuation = len(message.params) >= 4 and message.params[-2] == "*"
            if not continuation and not self._cap_requested:
                missing = REQUIRED_CAPABILITIES - self._capabilities
                if missing:
                    raise IRCConnectionError(
                        f"server lacks required IRC capability count={len(missing)}"
                    )
                requested = " ".join(sorted(REQUIRED_CAPABILITIES | {"server-time"}))
                self._cap_requested = True
                await self._send_raw(f"CAP REQ :{requested}")
        elif subcommand == "ACK":
            acknowledged = set(message.params[-1].split())
            if REQUIRED_CAPABILITIES <= acknowledged and not self._sasl_started:
                self._sasl_started = True
                await self._send_raw("AUTHENTICATE PLAIN")
        elif subcommand == "NAK":
            raise IRCConnectionError("server rejected required capabilities")

    async def _send_sasl_payload(self) -> None:
        raw = (
            b"\0"
            + self.config.irc.account.encode("utf-8")
            + b"\0"
            + self.config.irc.password.encode("utf-8")
        )
        payload = base64.b64encode(raw).decode("ascii")
        if len(payload) > 400:
            raise IRCConnectionError("SASL payload exceeds one IRC frame")
        await self._send_raw(f"AUTHENTICATE {payload}")

    async def _on_registered(self) -> None:
        self.registered = True
        self._connected_monotonic = time.monotonic()
        LOGGER.info(
            "irc_registered account=%s nick=%s owner=%s",
            self.config.irc.account,
            self.config.irc.nick,
            self.config.irc.owner_account,
        )
        if self.metrics:
            self.metrics.connected(self.config.irc.account)
        for channel in sorted(self.channels_to_join, key=str.casefold):
            await self._send_raw(f"JOIN {channel}")
        self._touch_heartbeat()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def _handle_invite(self, message: IRCMessage) -> None:
        account = message.tags.get("account")
        if not account or account == "*" or len(message.params) < 2:
            return
        invited_nick, channel = message.params[0], message.params[1]
        if invited_nick.casefold() != self.config.irc.nick.casefold():
            return
        if not channel.startswith("#") or any(char in channel for char in "\r\n ,:"):
            return
        self.channels_to_join.add(channel)
        await self._send_raw(f"JOIN {channel}")
        LOGGER.info(
            "channel_invited herder=%s channel=%s inviter_account=%s",
            self.config.irc.account,
            channel,
            account,
        )

    async def _handle_privmsg(self, message: IRCMessage) -> None:
        if not self.registered or len(message.params) < 2:
            return
        target, text = message.params[0], message.params[1]
        account = message.tags.get("account")
        if not account or account == "*":
            return
        nick = message.nick or account

        if target.casefold() == self.config.irc.nick.casefold():
            if text.startswith(f"{AGENT_PROTOCOL} "):
                await self._handle_agent_protocol(account, text)
            elif account.casefold() == self.config.irc.owner_account.casefold():
                await self._handle_owner_command(nick, text.strip())
            return

        if not target.startswith("#"):
            return
        addressed = self._addressed_command(text)
        if addressed is None:
            return
        if (
            self.config.irc.access_mode == "owner"
            and account.casefold() != self.config.irc.owner_account.casefold()
        ):
            return

        command, _, rest = addressed.partition(" ")
        command = command.casefold().lstrip("!")
        if command == "help":
            await self._reply(
                target,
                f"{nick}: {self.config.irc.nick}: models | ask <model-or-agent> "
                "<prompt> | status",
            )
        elif command == "models":
            await self._list_models(target, nick)
        elif command == "ask":
            await self._start_request(target, nick, account, rest)
        elif command == "status":
            await self._status(target, nick)

    def _addressed_command(self, text: str) -> str | None:
        clean = text.strip()
        nick = self.config.irc.nick
        for delimiter in (":", ","):
            prefix = f"{nick}{delimiter}"
            if clean[: len(prefix)].casefold() == prefix.casefold():
                return clean[len(prefix) :].strip()
        return None

    async def _handle_owner_command(self, nick: str, text: str) -> None:
        command, _, rest = text.partition(" ")
        command = command.casefold().lstrip("!")
        if command in {"", "help"}:
            await self._reply(
                nick,
                "admin: status | usage | agents | invite <agent-name> | "
                "revoke <agent-account>",
            )
        elif command == "status":
            await self._status(nick, None)
        elif command == "usage":
            await self._usage(nick)
        elif command == "agents":
            await self._list_agents(nick)
        elif command == "invite":
            await self._invite_agent(nick, rest.strip())
        elif command == "revoke":
            await self._revoke_agent(nick, rest.strip())
        else:
            await self._reply(nick, "unknown admin command; send 'help'")

    async def _status(self, target: str, nick: str | None) -> None:
        if self._connected_monotonic is None:
            uptime = "not connected"
        else:
            seconds = max(0, int(time.monotonic() - self._connected_monotonic))
            hours, remainder = divmod(seconds, 3600)
            minutes, seconds = divmod(remainder, 60)
            uptime = f"{hours}h {minutes}m {seconds}s"
        prefix = f"{nick}: " if nick else ""
        await self._reply(
            target,
            f"{prefix}{self.config.irc.nick} online {uptime}; "
            f"pending={self.pending_count}; owner={self.config.irc.owner_account}",
        )

    async def _usage(self, target: str) -> None:
        if not self.metrics:
            await self._reply(target, "usage metrics are not available")
            return
        summary = self.metrics.summary(self.config.irc.account)
        if summary.total_tokens is None:
            token_text = "tokens=not reported by providers"
        else:
            token_text = (
                f"tokens={summary.total_tokens} "
                f"(prompt={summary.prompt_tokens}, completion={summary.completion_tokens})"
            )
        await self._reply(
            target,
            f"today: requests={summary.requests_today}, "
            f"successful={summary.successful_today}, {token_text}",
        )

    async def _get_agents(self, *, refresh: bool = False) -> list[dict]:
        cached_at, cached = self._agents_cache
        if not refresh and time.monotonic() - cached_at < 10:
            return cached
        if not self.portal:
            return []
        agents = await self.portal.agents(
            self.config.irc.owner_account, self.config.irc.account
        )
        self._agents_cache = (time.monotonic(), agents)
        return agents

    async def _list_agents(self, target: str) -> None:
        if not self.portal:
            await self._reply(target, "remote-agent registry is not configured")
            return
        try:
            agents = await self._get_agents(refresh=True)
        except PortalError as exc:
            await self._reply(target, str(exc))
            return
        if not agents:
            await self._reply(target, "no remote agents yet; use invite <name>")
            return
        for agent in agents[:15]:
            last_seen = (
                self.metrics.agent_last_seen(agent["account"])
                if self.metrics
                else None
            )
            seen = last_seen or "not seen online"
            await self._reply(
                target,
                f"{agent['display_name']} ({agent['account']}) "
                f"state={agent['state']}; last_seen={seen}",
            )
        if len(agents) > 15:
            await self._reply(target, f"... {len(agents) - 15} more agents")

    async def _invite_agent(self, target: str, name: str) -> None:
        if not name:
            await self._reply(target, "usage: invite <agent-name>")
            return
        if not self.portal:
            await self._reply(target, "remote-agent registry is not configured")
            return
        try:
            value = await self.portal.invite_agent(
                self.config.irc.owner_account, self.config.irc.account, name
            )
        except PortalError as exc:
            await self._reply(target, str(exc))
            return
        await self._reply(
            target,
            f"one-time agent setup link (24h): {value['url']} "
            f"account={value['agent_account']}",
        )

    async def _revoke_agent(self, target: str, account: str) -> None:
        if not account:
            await self._reply(target, "usage: revoke <agent-account>")
            return
        if not self.portal:
            await self._reply(target, "remote-agent registry is not configured")
            return
        try:
            value = await self.portal.revoke_agent(
                self.config.irc.owner_account, self.config.irc.account, account
            )
            self._agents_cache = (0, [])
        except PortalError as exc:
            await self._reply(target, str(exc))
            return
        await self._reply(
            target, f"revoked remote agent {value['account']}; future SASL is blocked"
        )

    async def _list_models(self, target: str, nick: str) -> None:
        for model in self.config.models.values():
            await self._reply(target, f"{nick}: {model.name} - {model.description}")
        try:
            agents = await self._get_agents()
        except PortalError:
            agents = []
        for agent in agents[:10]:
            if agent["state"] == "active":
                await self._reply(
                    target,
                    f"{nick}: {agent['display_name']} - owner's remote agent",
                )

    async def _start_request(
        self, target: str, nick: str, account: str, arguments: str
    ) -> None:
        provider_name, separator, prompt = arguments.strip().partition(" ")
        if not separator or not provider_name or not prompt.strip():
            await self._reply(
                target,
                f"{nick}: usage: {self.config.irc.nick}: ask "
                "<model-or-agent> <prompt>",
            )
            return

        decision = self.rate_limiter.check(account)
        if not decision.allowed:
            await self._reply(
                target,
                f"{nick}: rate limit reached; retry in about "
                f"{decision.retry_after_seconds}s",
            )
            return
        prompt = prompt.strip()
        if len(prompt.encode("utf-8")) > self.config.limits.max_prompt_bytes:
            await self._reply(
                target,
                f"{nick}: prompt exceeds the "
                f"{self.config.limits.max_prompt_bytes}-byte limit",
            )
            return
        if self.pending_count >= self.config.limits.max_pending_requests:
            await self._reply(target, f"{nick}: request queue is full; try again later")
            return

        model = self.config.models.get(provider_name.casefold())
        if model is not None:
            await self._start_local_request(target, nick, account, model, prompt)
            return
        try:
            agents = await self._get_agents()
        except PortalError:
            agents = []
        agent = next(
            (
                item
                for item in agents
                if item["state"] == "active"
                and provider_name.casefold()
                in {
                    item["account"].casefold(),
                    item["display_name"].casefold(),
                }
            ),
            None,
        )
        if agent is None:
            await self._reply(
                target,
                f"{nick}: unknown model or agent {provider_name!r}; "
                f"ask {self.config.irc.nick} for models",
            )
            return
        await self._start_agent_request(target, nick, account, agent, prompt)

    async def _start_local_request(
        self,
        target: str,
        nick: str,
        account: str,
        model: ModelConfig,
        prompt: str,
    ) -> None:
        self.pending_count += 1
        await self._reply(target, f"{nick}: working...")
        task = asyncio.create_task(
            self._run_local_request(target, nick, account, model, prompt)
        )
        self.request_tasks.add(task)
        task.add_done_callback(self.request_tasks.discard)

    async def _run_local_request(
        self,
        target: str,
        nick: str,
        account: str,
        model: ModelConfig,
        prompt: str,
    ) -> None:
        request_id = uuid.uuid4().hex[:12]
        started = time.monotonic()
        if self.metrics:
            self.metrics.start_request(
                request_id, self.config.irc.account, account, model.name
            )
        LOGGER.info(
            "request_started request_id=%s herder=%s account=%s provider=%s "
            "max_tokens=%d",
            request_id,
            self.config.irc.account,
            account,
            model.name,
            model.effective_max_tokens,
        )
        status = "error"
        output_lines = 0
        try:
            async with self.semaphore:
                completion = await self.model_client.complete(model, prompt)
            chunks = chunk_completion(
                completion,
                max_payload_bytes=self.config.limits.irc_payload_bytes,
                max_output_bytes=self.config.limits.max_output_bytes,
                max_lines=self.config.limits.max_output_lines,
            )
            if not chunks:
                raise ModelError("empty normalized completion")
            for chunk in chunks:
                await self._reply(target, f"{nick}: {chunk}")
            status = "ok"
            output_lines = len(chunks)
            LOGGER.info(
                "request_completed request_id=%s herder=%s account=%s "
                "provider=%s duration_ms=%d output_lines=%d",
                request_id,
                self.config.irc.account,
                account,
                model.name,
                int((time.monotonic() - started) * 1000),
                len(chunks),
            )
        except ModelError as exc:
            await self._reply(target, f"{nick}: {exc.public_message}; try again later")
            LOGGER.warning(
                "request_failed request_id=%s herder=%s provider=%s error_type=%s",
                request_id,
                self.config.irc.account,
                model.name,
                type(exc).__name__,
            )
        except asyncio.CancelledError:
            status = "cancelled"
            raise
        except Exception as exc:
            await self._reply(target, f"{nick}: the request failed; try again later")
            LOGGER.exception(
                "request_internal_error request_id=%s herder=%s "
                "provider=%s error_type=%s",
                request_id,
                self.config.irc.account,
                model.name,
                type(exc).__name__,
            )
        finally:
            self.pending_count -= 1
            if self.metrics:
                self.metrics.finish_request(
                    request_id,
                    duration_ms=int((time.monotonic() - started) * 1000),
                    status=status,
                    output_lines=output_lines,
                )

    async def _start_agent_request(
        self,
        target: str,
        nick: str,
        account: str,
        agent: dict,
        prompt: str,
    ) -> None:
        request_id = uuid.uuid4().hex[:12]
        pending = PendingAgentRequest(
            request_id=request_id,
            target=target,
            requester_nick=nick,
            requester_account=account,
            agent_account=agent["account"],
            started=time.monotonic(),
        )
        self.agent_requests[request_id] = pending
        self.pending_count += 1
        if self.metrics:
            self.metrics.start_request(
                request_id,
                self.config.irc.account,
                account,
                f"agent:{agent['account']}",
            )
        await self._reply(target, f"{nick}: working...")
        encoded = base64.urlsafe_b64encode(prompt.encode("utf-8")).decode("ascii")
        pieces = [encoded[index : index + 260] for index in range(0, len(encoded), 260)]
        try:
            for index, piece in enumerate(pieces, start=1):
                await self._reply(
                    agent["account"],
                    f"{AGENT_PROTOCOL} REQUEST {request_id} "
                    f"{index}/{len(pieces)} {piece}",
                )
        except Exception:
            await self._finish_agent_request(
                pending, status="error", public_error="remote agent is unreachable"
            )
            return
        pending.timeout_task = asyncio.create_task(
            self._agent_timeout(request_id)
        )

    async def _agent_timeout(self, request_id: str) -> None:
        await asyncio.sleep(self.config.community.agent_timeout_seconds)
        pending = self.agent_requests.get(request_id)
        if pending:
            await self._finish_agent_request(
                pending,
                status="timeout",
                public_error="remote agent timed out; try again later",
            )

    async def _handle_agent_protocol(self, account: str, text: str) -> None:
        try:
            agents = await self._get_agents()
        except PortalError:
            return
        active_accounts = {
            item["account"].casefold()
            for item in agents
            if item["state"] == "active"
        }
        if account.casefold() not in active_accounts:
            return
        if self.metrics:
            self.metrics.agent_seen(account, self.config.irc.account)

        pieces = text.split(" ")
        if len(pieces) < 2 or pieces[0] != AGENT_PROTOCOL:
            return
        operation = pieces[1].upper()
        if operation == "HELLO":
            return
        if len(pieces) < 3:
            return
        request_id = pieces[2]
        pending = self.agent_requests.get(request_id)
        if not pending or account.casefold() != pending.agent_account.casefold():
            return
        if operation == "USAGE" and len(pieces) == 6:
            values = pieces[3:6]
            if all(value.isdigit() for value in values):
                pending.prompt_tokens, pending.completion_tokens, pending.total_tokens = (
                    int(value) for value in values
                )
            return
        if operation == "ERROR":
            await self._finish_agent_request(
                pending,
                status="error",
                public_error="remote agent reported an error; try again later",
            )
            return
        if operation != "RESPONSE" or len(pieces) < 5:
            return
        sequence, encoded = pieces[3], pieces[4]
        try:
            index_text, total_text = sequence.split("/", 1)
            index, total = int(index_text), int(total_text)
        except (ValueError, TypeError):
            return
        if total < 1 or total > 256 or index < 1 or index > total:
            return
        if pending.total_parts not in {None, total}:
            return
        pending.total_parts = total
        pending.parts[index] = encoded
        if len(pending.parts) != total:
            return
        try:
            joined = "".join(pending.parts[index] for index in range(1, total + 1))
            content = base64.urlsafe_b64decode(
                joined + "=" * (-len(joined) % 4)
            ).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            await self._finish_agent_request(
                pending,
                status="error",
                public_error="remote agent returned an invalid response",
            )
            return
        chunks = chunk_completion(
            content,
            max_payload_bytes=self.config.limits.irc_payload_bytes,
            max_output_bytes=self.config.limits.max_output_bytes,
            max_lines=self.config.limits.max_output_lines,
        )
        if not chunks:
            await self._finish_agent_request(
                pending,
                status="error",
                public_error="remote agent returned no content",
            )
            return
        for chunk in chunks:
            await self._reply(
                pending.target, f"{pending.requester_nick}: {chunk}"
            )
        await self._finish_agent_request(
            pending, status="ok", output_lines=len(chunks)
        )

    async def _finish_agent_request(
        self,
        pending: PendingAgentRequest,
        *,
        status: str,
        output_lines: int = 0,
        public_error: str | None = None,
    ) -> None:
        if self.agent_requests.pop(pending.request_id, None) is None:
            return
        self.pending_count -= 1
        current = asyncio.current_task()
        if pending.timeout_task and pending.timeout_task is not current:
            pending.timeout_task.cancel()
        if public_error:
            await self._reply(
                pending.target,
                f"{pending.requester_nick}: {public_error}",
            )
        duration_ms = int((time.monotonic() - pending.started) * 1000)
        if self.metrics:
            self.metrics.finish_request(
                pending.request_id,
                duration_ms=duration_ms,
                status=status,
                output_lines=output_lines,
                prompt_tokens=pending.prompt_tokens,
                completion_tokens=pending.completion_tokens,
                total_tokens=pending.total_tokens,
            )
        LOGGER.info(
            "agent_request_finished request_id=%s herder=%s agent=%s "
            "status=%s duration_ms=%d output_lines=%d",
            pending.request_id,
            self.config.irc.account,
            pending.agent_account,
            status,
            duration_ms,
            output_lines,
        )

    async def _reply(self, target: str, text: str) -> None:
        clean = text.replace("\r", " ").replace("\n", " ").replace("\0", " ")
        maximum = 510 - len(f"PRIVMSG {target} :".encode("utf-8"))
        encoded = clean.encode("utf-8")
        if len(encoded) > maximum:
            clean = encoded[:maximum].decode("utf-8", errors="ignore")
        try:
            await self._send_raw(f"PRIVMSG {target} :{clean}")
        except (ConnectionError, IRCConnectionError):
            LOGGER.warning(
                "irc_reply_dropped herder=%s reason=disconnected",
                self.config.irc.account,
            )

    async def _send_raw(self, line: str) -> None:
        if "\r" in line or "\n" in line or "\0" in line:
            raise ValueError("outgoing IRC line contains a control character")
        writer = self.writer
        if writer is None or writer.is_closing():
            raise IRCConnectionError("IRC writer is unavailable")
        payload = (line + "\r\n").encode("utf-8")
        if len(payload) > 512:
            raise ValueError("outgoing IRC line exceeds 512 bytes")
        async with self._send_lock:
            writer.write(payload)
            await writer.drain()

    def _touch_heartbeat(self) -> None:
        path = Path(self.config.health.heartbeat_path)
        path.touch(exist_ok=True)

    async def _heartbeat_loop(self) -> None:
        while self.registered and not self.stop_event.is_set():
            self._touch_heartbeat()
            await asyncio.sleep(self.config.health.heartbeat_interval_seconds)


# Compatibility for Phase 1 imports. User-facing naming is BotHerder.
ComputeBridgeBot = BotHerder
