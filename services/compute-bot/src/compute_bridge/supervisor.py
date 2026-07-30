from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import replace
from pathlib import Path

from .bot import BotHerder
from .config import AppConfig
from .metrics import MetricsStore
from .portal import CommunityPortalClient


LOGGER = logging.getLogger("bot_herder.supervisor")
ACCOUNT_PATTERN = re.compile(r"[A-Za-z0-9\[\]{}\\`_^|\-]{1,32}")


class HerderSupervisor:
    """Runs one independent IRC BotHerder session per provisioned member."""

    def __init__(
        self,
        base_config: AppConfig,
        *,
        members_dir: str | Path,
        metrics_path: str | Path,
        scan_seconds: float = 2,
    ) -> None:
        self.base_config = base_config
        self.members_dir = Path(members_dir)
        self.members_dir.mkdir(parents=True, exist_ok=True)
        self.metrics = MetricsStore(metrics_path)
        self.portal = CommunityPortalClient(
            base_config.community.portal_url,
            base_config.community.internal_token,
        )
        self.scan_seconds = scan_seconds
        self.stop_event = asyncio.Event()
        self.bots: dict[str, BotHerder] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.signatures: dict[str, tuple[int, int]] = {}

    async def run(self) -> None:
        await self._start_bot("primary", self.base_config)
        try:
            while not self.stop_event.is_set():
                await self._reconcile()
                try:
                    await asyncio.wait_for(
                        self.stop_event.wait(), timeout=self.scan_seconds
                    )
                except TimeoutError:
                    pass
        finally:
            await self._stop_all()
            await self.portal.close()
            self.metrics.close()

    async def stop(self) -> None:
        self.stop_event.set()
        await asyncio.gather(
            *(bot.stop() for bot in list(self.bots.values())),
            return_exceptions=True,
        )

    async def _start_bot(self, key: str, config: AppConfig) -> None:
        if key in self.bots:
            return
        bot = BotHerder(config, metrics=self.metrics, portal=self.portal)
        self.bots[key] = bot
        task = asyncio.create_task(bot.run(), name=f"herder:{config.irc.account}")
        self.tasks[key] = task
        LOGGER.info(
            "herder_started account=%s owner=%s source=%s",
            config.irc.account,
            config.irc.owner_account,
            key,
        )

    async def _stop_bot(self, key: str) -> None:
        bot = self.bots.pop(key, None)
        task = self.tasks.pop(key, None)
        self.signatures.pop(key, None)
        if bot:
            await bot.stop()
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if bot:
            LOGGER.info(
                "herder_stopped account=%s source=%s", bot.config.irc.account, key
            )

    async def _stop_all(self) -> None:
        await asyncio.gather(
            *(bot.stop() for bot in list(self.bots.values())),
            return_exceptions=True,
        )
        for task in self.tasks.values():
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        self.bots.clear()
        self.tasks.clear()
        self.signatures.clear()

    async def _reconcile(self) -> None:
        paths = {str(path.resolve()): path for path in self.members_dir.glob("*.json")}
        current_keys = set(paths)
        for key in set(self.bots) - {"primary"} - current_keys:
            await self._stop_bot(key)

        primary_account = self.base_config.irc.account.casefold()
        for key, path in paths.items():
            try:
                stat = path.stat()
                signature = (stat.st_mtime_ns, stat.st_size)
                if self.signatures.get(key) == signature:
                    continue
                config = self._member_config(path)
                if config.irc.account.casefold() == primary_account:
                    LOGGER.warning(
                        "member_ignored reason=duplicates_primary file=%s",
                        path.name,
                    )
                    self.signatures[key] = signature
                    continue
                if key in self.bots:
                    await self._stop_bot(key)
                await self._start_bot(key, config)
                self.signatures[key] = signature
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                LOGGER.warning(
                    "member_invalid file=%s error_type=%s",
                    path.name,
                    type(exc).__name__,
                )

    def _member_config(self, path: Path) -> AppConfig:
        value = json.loads(path.read_text(encoding="utf-8"))
        if value.get("schema_version") != 1:
            raise ValueError("unsupported member schema")
        account = self._account(value.get("account"), "account")
        nick = self._account(value.get("nick"), "nick")
        owner = self._account(value.get("owner_account"), "owner_account")
        password = value.get("irc_password")
        if not isinstance(password, str) or not password or any(
            char in password for char in "\r\n\0"
        ):
            raise ValueError("invalid member password")
        channels = value.get("channels")
        if not isinstance(channels, list) or not channels:
            raise ValueError("member channels are required")
        normalized_channels: list[str] = []
        for channel in channels:
            if (
                not isinstance(channel, str)
                or not channel.startswith("#")
                or any(char in channel for char in "\r\n\0 ,:")
            ):
                raise ValueError("invalid member channel")
            normalized_channels.append(channel)
        access_mode = value.get("access_mode", "owner")
        if access_mode not in {"owner", "authenticated"}:
            raise ValueError("invalid access mode")
        irc = replace(
            self.base_config.irc,
            nick=nick,
            account=account,
            password_env="PROVISIONED_MEMBER_FILE",
            password=password,
            owner_account=owner,
            access_mode=access_mode,
            channels=tuple(normalized_channels),
        )
        health = replace(
            self.base_config.health,
            heartbeat_path=f"/tmp/bot-herder-{account.casefold()}",
        )
        return replace(self.base_config, irc=irc, health=health)

    @staticmethod
    def _account(value: object, field: str) -> str:
        if not isinstance(value, str) or not ACCOUNT_PATTERN.fullmatch(value):
            raise ValueError(f"invalid {field}")
        return value
