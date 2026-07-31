#!/usr/bin/env bash
set -euo pipefail

project_dir="${OMEN_IRC_PROJECT_DIR:-/opt/omen-irc}"
compose_file="$project_dir/compose.am4.yaml"
bot_env_file="${OMEN_IRC_CONFIG_DIR:-/etc/omen-irc}/compute-bot.env"
bootstrap_file="${OMEN_IRC_CONFIG_DIR:-/etc/omen-irc}/bootstrap.json"
community_env_file="${OMEN_IRC_CONFIG_DIR:-/etc/omen-irc}/community.env"
herder_env_file="${OMEN_IRC_CONFIG_DIR:-/etc/omen-irc}/bot-herder.env"
hearth_env_file="${OMEN_IRC_CONFIG_DIR:-/etc/omen-irc}/hearth-bot.env"

pass_count=0

pass() {
    pass_count=$((pass_count + 1))
    printf 'PASS: %s\n' "$1"
}

fail() {
    printf 'FAIL: %s\n' "$1" >&2
    exit 1
}

resolve_compose() {
    if docker compose version >/dev/null 2>&1; then
        compose=(docker compose)
        return
    fi
    local candidate
    for candidate in /home/*/.docker/cli-plugins/docker-compose; do
        if [[ -x "$candidate" ]] && "$candidate" version >/dev/null 2>&1; then
            compose=("$candidate")
            return
        fi
    done
    fail "Docker Compose v2 is required"
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] ||
    fail "Run with sudo: sudo $0"
[[ -r "$bot_env_file" ]] || fail "Missing $bot_env_file"
[[ -r "$bootstrap_file" ]] || fail "Missing $bootstrap_file"
[[ -r "$community_env_file" ]] || fail "Missing $community_env_file"
[[ -r "$herder_env_file" ]] || fail "Missing $herder_env_file"
[[ -r "$hearth_env_file" ]] || fail "Missing $hearth_env_file"
declare -a compose
resolve_compose

bot_id="$("${compose[@]}" -f "$compose_file" ps -q bot-herder)"
[[ -n "$bot_id" ]] || fail "bot-herder container is absent"
state="$(docker inspect --format '{{.State.Status}}' "$bot_id")"
health="$(docker inspect --format '{{.State.Health.Status}}' "$bot_id")"
restarts="$(docker inspect --format '{{.RestartCount}}' "$bot_id")"
[[ "$state" == running && "$health" == healthy ]] ||
    fail "bot-herder state=$state health=$health"
((restarts < 3)) || fail "bot-herder has restarted $restarts times"
pass "BotHerder is running, healthy, and not restart-looping"

owner_mode="$(stat --format '%U:%G %a' "$bot_env_file")"
[[ "$owner_mode" == "root:root 600" ]] ||
    fail "$bot_env_file permissions are $owner_mode"
herder_owner_mode="$(stat --format '%U:%G %a' "$herder_env_file")"
[[ "$herder_owner_mode" == "root:root 600" ]] ||
    fail "$herder_env_file permissions are $herder_owner_mode"
hearth_owner_mode="$(stat --format '%U:%G %a' "$hearth_env_file")"
[[ "$hearth_owner_mode" == "root:root 600" ]] ||
    fail "$hearth_env_file permissions are $hearth_owner_mode"
pass "BotHerder secret files are root-only"

if ! python3 - "$bot_id" <<'PY'
import json
import subprocess
import sys

details = json.loads(
    subprocess.check_output(["docker", "inspect", sys.argv[1]], text=True)
)[0]
environment_names = {
    value.split("=", 1)[0] for value in details["Config"]["Env"]
}
forbidden = {
    "COMMUNITY_ADMIN_TOKEN",
    "COMMUNITY_CREDENTIAL_KEY",
    "COMMUNITY_REGISTRAR_PASSWORD",
    "COMMUNITY_REGISTRAR_OPER_PASSWORD",
}
if environment_names & forbidden:
    raise SystemExit(1)
mounts = {mount["Destination"]: mount for mount in details["Mounts"]}
if mounts["/var/lib/bot-herder/members"]["RW"]:
    raise SystemExit(1)
if not mounts["/var/lib/bot-herder"]["RW"]:
    raise SystemExit(1)
PY
then
    fail "BotHerder has excess portal secrets or unsafe state mounts"
fi
pass "BotHerder has least-privilege secrets and read-only member records"

if ! "${compose[@]}" -f "$compose_file" exec -T bot-herder \
    python -m compute_bridge.hearthcheck; then
    fail "BotHerder cannot reach the private HEARTH execution path"
fi
pass "BotHerder's configured HEARTH mode and private ingress are healthy"

ss -lnt | grep -Eq '127\.0\.0\.1:6667[[:space:]]' ||
    fail "BotHerder IRC handoff is not listening on 127.0.0.1:6667"
if ss -lnt | grep -Eq '(^|[[:space:]])(\*|0\.0\.0\.0|\[::\]):6667[[:space:]]'; then
    fail "IRC port 6667 is bound to a broad host interface"
fi
pass "BotHerder IRC handoff is loopback-only"

unauthorized_status="$(
    curl --silent --show-error --max-time 5 \
        --output /dev/null --write-out '%{http_code}' \
        --header 'Content-Type: application/json' \
        --data '{}' \
        http://127.0.0.1:8082/v1/chat/completions
)"
[[ "$unauthorized_status" == 401 || "$unauthorized_status" == 403 ]] ||
    fail "Model endpoint does not enforce bearer authentication"
pass "Model chat endpoint rejects unauthenticated requests"

primary_nick="$(
    sed -n 's/^account *= *"\([^"]*\)".*/\1/p' \
        "$project_dir/config/compute-bot/bot.toml" | head -n 1
)"
primary_nick="${primary_nick:-DereksBotHerder}"

logs="$("${compose[@]}" -f "$compose_file" logs --no-color bot-herder)"
grep -q "irc_registered account=$primary_nick" <<<"$logs" ||
    fail "$primary_nick has no sanitized IRC registration event"
pass "$primary_nick SASL-registered with Ergo"

if ! python3 - "$bot_env_file" "$community_env_file" "$herder_env_file" \
    "$hearth_env_file" \
    "$bootstrap_file" \
    <(printf '%s' "$logs") <<'PY'
import json
import pathlib
import sys

env_path = pathlib.Path(sys.argv[1])
community_path = pathlib.Path(sys.argv[2])
herder_path = pathlib.Path(sys.argv[3])
hearth_path = pathlib.Path(sys.argv[4])
bootstrap_path = pathlib.Path(sys.argv[5])
log_text = pathlib.Path(sys.argv[6]).read_text(encoding="utf-8")
secrets = []
for path in (env_path, community_path, herder_path, hearth_path):
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            name, value = line.split("=", 1)
            if any(marker in name for marker in ("PASSWORD", "TOKEN", "KEY")):
                secrets.append(value)
with bootstrap_path.open(encoding="utf-8") as handle:
    bootstrap = json.load(handle)
secrets.extend(
    str(value)
    for key, value in bootstrap.items()
    if "password" in key.lower()
)
raise SystemExit(1 if any(secret and secret in log_text for secret in secrets) else 0)
PY
then
    fail "A protected secret appears in BotHerder logs"
fi
pass "No configured IRC/model/operator secret appears in BotHerder logs"

mapfile -t admin_credentials < <(
    python3 - "$bootstrap_file" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
print(value["AdminAccount"])
print(value["AdminPassword"])
PY
)
admin_account="${admin_credentials[0]}"
admin_password="${admin_credentials[1]}"
payload="$(printf '\0%s\0%s' "$admin_account" "$admin_password" | base64 -w0)"
membership="$(
    {
        printf 'CAP LS 302\r\n'
        printf 'NICK %s\r\n' "$admin_account"
        printf 'USER check 0 * :BotHerder membership check\r\n'
        printf 'CAP REQ :sasl account-tag message-tags\r\n'
        printf 'AUTHENTICATE PLAIN\r\n'
        printf 'AUTHENTICATE %s\r\n' "$payload"
        printf 'CAP END\r\n'
        sleep 1
        printf 'JOIN #general\r\n'
        printf 'NAMES #general\r\n'
        sleep 1
        printf 'QUIT :Membership check complete\r\n'
    } |
        timeout 20 "${compose[@]}" -f "$compose_file" exec -T ergo \
            nc 127.0.0.1 6667 || true
)"
grep -q ' 903 ' <<<"$membership" ||
    fail "Admin SASL probe failed"
grep -qi "$primary_nick" <<<"$membership" ||
    fail "$primary_nick is not visible in #general"
pass "$primary_nick appears in #general"

printf '\n%d BotHerder checks passed.\n' "$pass_count"
