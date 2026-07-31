from __future__ import annotations

import os
import re
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Mapping
from urllib.parse import urlparse


class ConfigError(ValueError):
    """Raised when operator configuration is invalid."""


@dataclass(frozen=True)
class IRCConfig:
    server: str
    port: int
    nick: str
    account: str
    password_env: str
    password: str = field(repr=False)
    owner_account: str
    access_mode: str
    channels: tuple[str, ...]
    reconnect_initial_seconds: float
    reconnect_max_seconds: float
    default_model: str = ""


@dataclass(frozen=True)
class LimitsConfig:
    requests_per_minute: int
    max_prompt_bytes: int
    max_output_bytes: int
    max_output_lines: int
    irc_payload_bytes: int
    max_concurrent_requests: int
    max_pending_requests: int


@dataclass(frozen=True)
class HealthConfig:
    heartbeat_path: str
    heartbeat_interval_seconds: float


@dataclass(frozen=True)
class CommunityConfig:
    portal_url: str
    internal_token_env: str
    internal_token: str = field(repr=False)
    agent_timeout_seconds: float
    guide_url: str = ""


@dataclass(frozen=True)
class HearthConfig:
    mode: str
    endpoint: str
    api_key_env: str
    api_key: str = field(repr=False)
    operation: str = "llm.chat"
    request_timeout_seconds: float = 1250
    watch_seconds: float = 10


@dataclass(frozen=True)
class StorefrontConfig:
    channel: str = ""
    about: str = ""
    color: bool = True


@dataclass(frozen=True)
class ModelConfig:
    name: str
    model_id: str
    endpoint: str
    api_key_env: str
    api_key: str = field(repr=False)
    max_tokens: int
    min_max_tokens: int
    description: str
    timeout_seconds: float

    @property
    def effective_max_tokens(self) -> int:
        return max(self.max_tokens, self.min_max_tokens)


@dataclass(frozen=True)
class AppConfig:
    irc: IRCConfig
    limits: LimitsConfig
    health: HealthConfig
    community: CommunityConfig
    models: Mapping[str, ModelConfig]
    log_level: str
    hearth: HearthConfig | None = None
    system_prompt: str = ""
    storefront: StorefrontConfig = field(default_factory=StorefrontConfig)

    @property
    def secrets(self) -> tuple[str, ...]:
        return tuple(value for value in (
            self.irc.password,
            self.community.internal_token,
            self.hearth.api_key if self.hearth else "",
            *(model.api_key for model in self.models.values()),
        ) if value)


def _read_toml(path: str | Path) -> dict:
    try:
        with Path(path).open("rb") as handle:
            return tomllib.load(handle)
    except FileNotFoundError as exc:
        raise ConfigError(f"configuration file not found: {path}") from exc
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"invalid TOML in {path}: {exc}") from exc


def _required_string(table: dict, key: str, context: str) -> str:
    value = table.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{context}.{key} must be a non-empty string")
    if "\r" in value or "\n" in value or "\0" in value:
        raise ConfigError(f"{context}.{key} contains a forbidden control character")
    return value.strip()


def _optional_text(table: dict, key: str, context: str) -> str:
    value = table.get(key, "")
    if not isinstance(value, str):
        raise ConfigError(f"{context}.{key} must be a string")
    return value.strip()


def _integer(
    table: dict,
    key: str,
    context: str,
    *,
    default: int | None = None,
    minimum: int = 1,
    maximum: int | None = None,
) -> int:
    value = table.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError(f"{context}.{key} must be an integer")
    if value < minimum or (maximum is not None and value > maximum):
        suffix = f" through {maximum}" if maximum is not None else " or greater"
        raise ConfigError(f"{context}.{key} must be {minimum}{suffix}")
    return value


def _number(
    table: dict,
    key: str,
    context: str,
    *,
    default: float,
    minimum: float,
) -> float:
    value = table.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < minimum:
        raise ConfigError(f"{context}.{key} must be a number >= {minimum}")
    return float(value)


def _load_irc(raw: dict, environ: Mapping[str, str]) -> IRCConfig:
    table = raw.get("irc")
    if not isinstance(table, dict):
        raise ConfigError("bot configuration requires an [irc] table")

    server = _required_string(table, "server", "irc")
    port = _integer(table, "port", "irc", minimum=1, maximum=65535)
    nick = _required_string(table, "nick", "irc")
    account = _required_string(table, "account", "irc")
    password_env = _required_string(table, "password_env", "irc")
    password = environ.get(password_env, "")
    if not password:
        raise ConfigError(f"required IRC secret environment variable is unset: {password_env}")
    if not re.fullmatch(r"[A-Za-z0-9\[\]{}\\`_^|\-]+", nick):
        raise ConfigError("irc.nick contains unsupported characters")
    owner_account = _required_string(table, "owner_account", "irc")
    access_mode = table.get("access_mode", "owner")
    if access_mode not in {"owner", "authenticated"}:
        raise ConfigError("irc.access_mode must be owner or authenticated")

    raw_channels = table.get("channels")
    if not isinstance(raw_channels, list) or not raw_channels:
        raise ConfigError("irc.channels must contain at least one channel")
    channels: list[str] = []
    for value in raw_channels:
        if not isinstance(value, str) or not re.fullmatch(r"#[^\x00\x07\r\n ,:]{1,80}", value):
            raise ConfigError(f"invalid IRC channel: {value!r}")
        if value.lower() not in {item.lower() for item in channels}:
            channels.append(value)

    return IRCConfig(
        server=server,
        port=port,
        nick=nick,
        account=account,
        password_env=password_env,
        password=password,
        owner_account=owner_account,
        access_mode=access_mode,
        default_model=_optional_text(table, "default_model", "irc"),
        channels=tuple(channels),
        reconnect_initial_seconds=_number(
            table, "reconnect_initial_seconds", "irc", default=2, minimum=0.25
        ),
        reconnect_max_seconds=_number(
            table, "reconnect_max_seconds", "irc", default=60, minimum=1
        ),
    )


def _load_limits(raw: dict) -> LimitsConfig:
    table = raw.get("limits", {})
    if not isinstance(table, dict):
        raise ConfigError("[limits] must be a table")
    return LimitsConfig(
        requests_per_minute=_integer(
            table, "requests_per_minute", "limits", default=6, maximum=120
        ),
        max_prompt_bytes=_integer(
            table, "max_prompt_bytes", "limits", default=2048, maximum=65536
        ),
        max_output_bytes=_integer(
            table, "max_output_bytes", "limits", default=4096, maximum=65536
        ),
        max_output_lines=_integer(
            table, "max_output_lines", "limits", default=15, maximum=100
        ),
        # 360 is the boundary-tested value; the default matches the deployed
        # config so an omitted key cannot silently pick an untested size.
        irc_payload_bytes=_integer(
            table,
            "irc_payload_bytes",
            "limits",
            default=360,
            minimum=128,
            maximum=430,
        ),
        max_concurrent_requests=_integer(
            table, "max_concurrent_requests", "limits", default=2, maximum=16
        ),
        max_pending_requests=_integer(
            table, "max_pending_requests", "limits", default=16, maximum=256
        ),
    )


def _load_health(raw: dict) -> HealthConfig:
    table = raw.get("health", {})
    if not isinstance(table, dict):
        raise ConfigError("[health] must be a table")
    path = table.get("heartbeat_path", "/tmp/compute-bot-heartbeat")
    if not isinstance(path, str) or not path.startswith("/") or "\0" in path:
        raise ConfigError("health.heartbeat_path must be an absolute path")
    return HealthConfig(
        heartbeat_path=path,
        heartbeat_interval_seconds=_number(
            table, "heartbeat_interval_seconds", "health", default=15, minimum=2
        ),
    )


def _load_community(raw: dict, environ: Mapping[str, str]) -> CommunityConfig:
    table = raw.get("community")
    if not isinstance(table, dict):
        raise ConfigError("bot configuration requires a [community] table")
    portal_url = _required_string(table, "portal_url", "community").rstrip("/")
    parsed = urlparse(portal_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ConfigError("community.portal_url must be an HTTP(S) URL")
    internal_token_env = _required_string(
        table, "internal_token_env", "community"
    )
    internal_token = environ.get(internal_token_env, "")
    if not internal_token:
        raise ConfigError(
            "required community secret environment variable is unset: "
            f"{internal_token_env}"
        )
    guide_url = _optional_text(table, "guide_url", "community").rstrip("/")
    if guide_url:
        guide = urlparse(guide_url)
        if (
            guide.scheme not in {"http", "https"}
            or not guide.hostname
            or guide.username
            or guide.password
            or guide.query
            or guide.fragment
        ):
            raise ConfigError("community.guide_url must be a public HTTP(S) URL")
        if guide.scheme != "https" and guide.hostname not in {
            "127.0.0.1",
            "localhost",
            "::1",
        }:
            raise ConfigError("non-loopback community.guide_url must use HTTPS")
    return CommunityConfig(
        portal_url=portal_url,
        internal_token_env=internal_token_env,
        internal_token=internal_token,
        agent_timeout_seconds=_number(
            table, "agent_timeout_seconds", "community", default=120, minimum=5
        ),
        guide_url=f"{guide_url}/" if guide_url else "",
    )


def _load_hearth(raw: dict, environ: Mapping[str, str]) -> HearthConfig:
    table = raw.get("hearth", {})
    if not isinstance(table, dict):
        raise ConfigError("[hearth] must be a table")
    mode = table.get("mode", "direct")
    if mode not in {"direct", "shadow", "hearth"}:
        raise ConfigError("hearth.mode must be direct, shadow, or hearth")
    endpoint = str(table.get("endpoint", "")).strip().rstrip("/")
    api_key_env = str(table.get("api_key_env", "HEARTH_API_KEY")).strip()
    api_key = environ.get(api_key_env, "") if api_key_env else ""
    if mode in {"shadow", "hearth"}:
        parsed = urlparse(endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ConfigError("hearth.endpoint must be an HTTP(S) MCP URL")
        if parsed.path.rstrip("/") != "/mcp":
            raise ConfigError("hearth.endpoint must end in /mcp")
        if parsed.scheme != "https" and parsed.hostname not in {
            "127.0.0.1",
            "localhost",
            "::1",
        }:
            raise ConfigError("non-loopback HEARTH endpoints must use HTTPS")
        if not api_key:
            raise ConfigError(
                f"required HEARTH secret environment variable is unset: {api_key_env}"
            )
    operation = str(table.get("operation", "llm.chat")).strip()
    if not operation or any(char in operation for char in "\r\n\0"):
        raise ConfigError("hearth.operation must be a non-empty string")
    return HearthConfig(
        mode=mode,
        endpoint=endpoint,
        api_key_env=api_key_env,
        api_key=api_key,
        operation=operation,
        request_timeout_seconds=_number(
            table, "request_timeout_seconds", "hearth", default=1250, minimum=5
        ),
        watch_seconds=_number(
            table, "watch_seconds", "hearth", default=10, minimum=0.25
        ),
    )


def _load_system_prompt(raw: dict) -> str:
    table = raw.get("completion", {})
    if not isinstance(table, dict):
        raise ConfigError("[completion] must be a table")
    value = table.get("system_prompt", "")
    if not isinstance(value, str):
        raise ConfigError("completion.system_prompt must be a string")
    prompt = value.strip()
    if "\0" in prompt:
        raise ConfigError("completion.system_prompt contains a forbidden control character")
    if len(prompt.encode("utf-8")) > 2048:
        raise ConfigError("completion.system_prompt is too long")
    return prompt


def _load_storefront(raw: dict) -> StorefrontConfig:
    table = raw.get("storefront", {})
    if not isinstance(table, dict):
        raise ConfigError("[storefront] must be a table")
    channel = table.get("channel", "")
    about = table.get("about", "")
    if not isinstance(channel, str) or (channel and not re.fullmatch(r"#[^\x00\x07\r\n ,:]{1,63}", channel)):
        raise ConfigError("storefront.channel must be an IRC channel or empty")
    if not isinstance(about, str) or any(char in about for char in "\r\n\0"):
        raise ConfigError("storefront.about contains a forbidden control character")
    if len(about.encode("utf-8")) > 1000:
        raise ConfigError("storefront.about is too long")
    color = table.get("color", True)
    if not isinstance(color, bool):
        raise ConfigError("storefront.color must be true or false")
    return StorefrontConfig(channel=channel, about=about.strip(), color=color)


def _load_models(
    raw: dict, environ: Mapping[str, str], *, require_api_keys: bool = True
) -> Mapping[str, ModelConfig]:
    tables = raw.get("models")
    if not isinstance(tables, dict) or not tables:
        raise ConfigError("models configuration requires at least one [models.NAME] table")

    result: dict[str, ModelConfig] = {}
    for name, table in tables.items():
        context = f"models.{name}"
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", name):
            raise ConfigError(f"invalid model registry name: {name!r}")
        if not isinstance(table, dict):
            raise ConfigError(f"{context} must be a table")

        endpoint = _required_string(table, "endpoint", context).rstrip("/")
        parsed = urlparse(endpoint)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.query
            or parsed.fragment
            or not parsed.path.endswith("/v1")
        ):
            raise ConfigError(f"{context}.endpoint must be an HTTP(S) base URL ending in /v1")

        api_key_env = _required_string(table, "api_key_env", context)
        api_key = environ.get(api_key_env, "")
        if require_api_keys and not api_key:
            raise ConfigError(f"required model secret environment variable is unset: {api_key_env}")
        description = _required_string(table, "description", context)
        if len(description.encode("utf-8")) > 300:
            raise ConfigError(f"{context}.description is too long")

        model_id = table.get("model_id", name)
        if not isinstance(model_id, str) or not model_id.strip() or any(
            char in model_id for char in "\r\n\0"
        ):
            raise ConfigError(f"{context}.model_id must be a non-empty string")

        result[name] = ModelConfig(
            name=name,
            model_id=model_id.strip(),
            endpoint=endpoint,
            api_key_env=api_key_env,
            api_key=api_key,
            max_tokens=_integer(table, "max_tokens", context, default=512, maximum=131072),
            min_max_tokens=_integer(
                table, "min_max_tokens", context, default=1, maximum=131072
            ),
            description=description,
            timeout_seconds=_number(
                table, "timeout_seconds", context, default=120, minimum=1
            ),
        )
    return MappingProxyType(result)


def load_config(
    bot_path: str | Path,
    models_path: str | Path,
    environ: Mapping[str, str] | None = None,
) -> AppConfig:
    environment = os.environ if environ is None else environ
    bot_raw = _read_toml(bot_path)
    models_raw = _read_toml(models_path)
    logging_table = bot_raw.get("logging", {})
    if not isinstance(logging_table, dict):
        raise ConfigError("[logging] must be a table")
    log_level = logging_table.get("level", "INFO")
    if log_level not in {"DEBUG", "INFO", "WARNING", "ERROR"}:
        raise ConfigError("logging.level must be DEBUG, INFO, WARNING, or ERROR")
    hearth = _load_hearth(bot_raw, environment)
    return AppConfig(
        irc=_load_irc(bot_raw, environment),
        limits=_load_limits(bot_raw),
        health=_load_health(bot_raw),
        community=_load_community(bot_raw, environment),
        models=_load_models(
            models_raw,
            environment,
            require_api_keys=hearth.mode in {"direct", "shadow"},
        ),
        log_level=log_level,
        hearth=hearth,
        system_prompt=_load_system_prompt(bot_raw),
        storefront=_load_storefront(bot_raw),
    )
