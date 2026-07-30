from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import sys

from .config import ConfigError, load_config
from .supervisor import HerderSupervisor


class SecretRedactionFilter(logging.Filter):
    def __init__(self, secrets: tuple[str, ...]) -> None:
        super().__init__()
        self._secrets = tuple(value for value in secrets if value)

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        for secret in self._secrets:
            message = message.replace(secret, "<redacted>")
        record.msg = message
        record.args = ()
        return True


async def _run(
    bot_config: str,
    models_config: str,
    members_dir: str,
    metrics_path: str,
) -> int:
    try:
        config = load_config(bot_config, models_config)
    except ConfigError as exc:
        print(f"configuration error: {exc}", file=sys.stderr)
        return 2

    handler = logging.StreamHandler()
    handler.addFilter(SecretRedactionFilter(config.secrets))
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(config.log_level)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)

    supervisor = HerderSupervisor(
        config,
        members_dir=members_dir,
        metrics_path=metrics_path,
    )
    loop = asyncio.get_running_loop()
    for signal_name in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(
                signal_name, lambda: asyncio.create_task(supervisor.stop())
            )
        except NotImplementedError:
            pass
    await supervisor.run()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Authenticated IRC compute bridge")
    parser.add_argument(
        "--bot-config",
        default="/etc/compute-bot/bot.toml",
    )
    parser.add_argument(
        "--models-config",
        default="/etc/compute-bot/models.toml",
    )
    parser.add_argument(
        "--members-dir",
        default="/var/lib/bot-herder/members",
    )
    parser.add_argument(
        "--metrics-path",
        default="/var/lib/bot-herder/metrics.sqlite3",
    )
    arguments = parser.parse_args()
    try:
        return asyncio.run(
            _run(
                arguments.bot_config,
                arguments.models_config,
                arguments.members_dir,
                arguments.metrics_path,
            )
        )
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
