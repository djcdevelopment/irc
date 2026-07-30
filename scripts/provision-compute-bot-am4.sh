#!/usr/bin/env bash
# Compatibility entry point: secrets still use the historical filename, while
# the deployed IRC identity and service are now DereksBotHerder / bot-herder.
set -euo pipefail

project_dir="${OMEN_IRC_PROJECT_DIR:-/opt/omen-irc}"
config_dir="${OMEN_IRC_CONFIG_DIR:-/etc/omen-irc}"
bot_env_file="$config_dir/compute-bot.env"
secrets_only=false

for argument in "$@"; do
    case "$argument" in
        --secrets-only) secrets_only=true ;;
        *) printf 'Unknown option: %s\n' "$argument" >&2; exit 2 ;;
    esac
done

die() {
    printf 'ERROR: %s\n' "$1" >&2
    exit 1
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] ||
    die "Run with sudo: sudo $0"
command -v python3 >/dev/null || die "python3 is required"
install -d -m 0700 "$config_dir"

BOT_ENV_FILE="$bot_env_file" python3 - <<'PY'
import os
import pathlib
import re
import secrets
import tempfile

destination = pathlib.Path(os.environ["BOT_ENV_FILE"])
values = {}
if destination.exists():
    for line in destination.read_text(encoding="utf-8").splitlines():
        if not line or line.lstrip().startswith("#"):
            continue
        name, separator, value = line.partition("=")
        if separator:
            values[name] = value

values.setdefault("IRC_BOT_PASSWORD", secrets.token_urlsafe(32))
model_key = values.get("GPT_OSS_120B_API_KEY") or os.environ.get(
    "GPT_OSS_120B_API_KEY"
)

def key_from_running_server():
    for process in pathlib.Path("/proc").iterdir():
        if not process.name.isdigit():
            continue
        try:
            arguments = [
                item.decode("utf-8", errors="strict")
                for item in (process / "cmdline").read_bytes().split(b"\0")
                if item
            ]
        except (OSError, UnicodeError):
            continue
        if not arguments or "llama-server" not in pathlib.Path(arguments[0]).name:
            continue
        try:
            port_index = arguments.index("--port")
        except ValueError:
            continue
        if (
            port_index + 1 >= len(arguments)
            or arguments[port_index + 1] != "8082"
        ):
            continue
        if "--api-key" in arguments:
            index = arguments.index("--api-key")
            if index + 1 < len(arguments):
                return arguments[index + 1]
        if "--api-key-file" in arguments:
            index = arguments.index("--api-key-file")
            if index + 1 < len(arguments):
                return pathlib.Path(arguments[index + 1]).read_text(
                    encoding="utf-8"
                ).splitlines()[0]
    return None

if not model_key:
    model_key = key_from_running_server()
if not model_key:
    raise SystemExit(
        "No 8082 API key found. Set GPT_OSS_120B_API_KEY for this command."
    )
values["GPT_OSS_120B_API_KEY"] = model_key

safe_value = re.compile(r"^[A-Za-z0-9._~+/=-]+$")
for name in ("IRC_BOT_PASSWORD", "GPT_OSS_120B_API_KEY"):
    if not safe_value.fullmatch(values[name]):
        raise SystemExit(f"{name} contains unsafe env-file characters")

fd, temporary_name = tempfile.mkstemp(
    prefix=".bot-herder.", dir=str(destination.parent), text=True
)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(f"IRC_BOT_PASSWORD={values['IRC_BOT_PASSWORD']}\n")
        handle.write(
            f"GPT_OSS_120B_API_KEY={values['GPT_OSS_120B_API_KEY']}\n"
        )
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary_name, destination)
finally:
    try:
        os.unlink(temporary_name)
    except FileNotFoundError:
        pass
PY
chown root:root "$bot_env_file"
chmod 0600 "$bot_env_file"

if [[ "$secrets_only" == true ]]; then
    printf 'Protected BotHerder secrets are ready in %s.\n' "$bot_env_file"
    exit 0
fi

exec "$project_dir/scripts/provision-community-am4.sh"
