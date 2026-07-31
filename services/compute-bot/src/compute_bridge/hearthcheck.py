from __future__ import annotations

import argparse
import asyncio

from .config import load_config
from .hearth import HearthClient


async def _check(bot_config: str, models_config: str) -> int:
    config = load_config(bot_config, models_config)
    if not config.hearth or config.hearth.mode == "direct":
        print("HEARTH adapter mode is direct; private ingress check skipped.")
        return 0
    model = (
        config.models.get(config.irc.default_model.casefold())
        if config.irc.default_model
        else next(iter(config.models.values()), None)
    )
    if model is None:
        raise RuntimeError("no model is available for the HEARTH routing check")
    client = HearthClient(config.hearth)
    try:
        plan = await client.plan(model, "health")
    finally:
        await client.close()
    if plan.get("dispatch") is not False:
        raise RuntimeError("HEARTH plan unexpectedly dispatched work")
    if plan.get("model") != model.model_id:
        raise RuntimeError("HEARTH plan resolved a different model")
    print(
        f"HEARTH private ingress OK: mode={config.hearth.mode} "
        f"provider={plan.get('provider')} model={plan.get('model')}"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Check BotHerder's private HEARTH path")
    parser.add_argument("--bot-config", default="/etc/compute-bot/bot.toml")
    parser.add_argument("--models-config", default="/etc/compute-bot/models.toml")
    args = parser.parse_args()
    return asyncio.run(_check(args.bot_config, args.models_config))


if __name__ == "__main__":
    raise SystemExit(main())
