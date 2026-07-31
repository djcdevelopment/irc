#!/usr/bin/env bash
set -euo pipefail

project_dir="${OMEN_IRC_PROJECT_DIR:-/opt/omen-irc}"
compose_file="$project_dir/compose.am4.yaml"
config_dir="${OMEN_IRC_CONFIG_DIR:-/etc/omen-irc}"
state_dir="${OMEN_IRC_STATE_DIR:-/var/lib/omen-irc}"
bootstrap_file="$config_dir/bootstrap.json"
bot_env_file="$config_dir/compute-bot.env"
community_env_file="$config_dir/community.env"
herder_env_file="$config_dir/bot-herder.env"
ircd_config="$config_dir/ircd.yaml"
ergo_image="ghcr.io/ergochat/ergo:v2.19.0"
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

step() {
    printf '\n==> %s\n' "$1"
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
    die "Docker Compose v2 is required"
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] ||
    die "Run with sudo: sudo $0"
for command in docker python3 tailscale curl; do
    command -v "$command" >/dev/null || die "$command is required"
done
[[ -f "$compose_file" ]] || die "Missing $compose_file"
[[ -r "$bootstrap_file" ]] || die "Missing $bootstrap_file"
[[ -r "$bot_env_file" ]] || die "Missing $bot_env_file"
declare -a compose
resolve_compose

tailscale_hostname="$(
    tailscale status --json |
        python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
)"
[[ "$tailscale_hostname" == *.ts.net ]] ||
    die "MagicDNS hostname detection failed"

install -d -m 0700 "$config_dir"
install -d -o 1000 -g 1000 -m 0700 \
    "$state_dir/community" \
    "$state_dir/bot-herder" \
    "$state_dir/bot-herder/members" \
    "$state_dir/bot-herder/runtime"

step "Creating or reusing protected community secrets"
COMMUNITY_ENV_FILE="$community_env_file" \
HERDER_ENV_FILE="$herder_env_file" \
TAILSCALE_HOSTNAME="$tailscale_hostname" \
python3 - <<'PY'
import os
import pathlib
import re
import secrets
import tempfile

destination = pathlib.Path(os.environ["COMMUNITY_ENV_FILE"])
values = {}
if destination.exists():
    for line in destination.read_text(encoding="utf-8").splitlines():
        if not line or line.lstrip().startswith("#"):
            continue
        name, separator, value = line.partition("=")
        if separator:
            values[name] = value

generated = {
    "COMMUNITY_REGISTRAR_PASSWORD": secrets.token_urlsafe(32),
    "COMMUNITY_REGISTRAR_OPER_PASSWORD": secrets.token_urlsafe(32),
    "COMMUNITY_ADMIN_TOKEN": secrets.token_urlsafe(32),
    "COMMUNITY_INTERNAL_TOKEN": secrets.token_urlsafe(32),
    "COMMUNITY_CREDENTIAL_KEY": secrets.token_urlsafe(32),
}
for name, value in generated.items():
    values.setdefault(name, value)

hostname = os.environ["TAILSCALE_HOSTNAME"]
fixed = {
    "COMMUNITY_PUBLIC_BASE": f"https://{hostname}/join",
    "COMMUNITY_LOUNGE_URL": f"https://{hostname}:10000/",
    "COMMUNITY_IRC_PUBLIC_HOST": hostname,
    "COMMUNITY_IRC_PUBLIC_PORT": "8443",
    "COMMUNITY_IRC_SERVER": "ergo",
    "COMMUNITY_IRC_PORT": "6667",
    "COMMUNITY_REGISTRAR_ACCOUNT": "CommunityRegistrar",
    "COMMUNITY_REGISTRAR_OPER_NAME": "community-registrar",
}
values.update(fixed)
# The primary companion may be renamed by the operator; preserve an existing
# value instead of forcing the historical default back.
values.setdefault("COMMUNITY_PRIMARY_HERDER", "DereksBotHerder")

ordered = [
    "COMMUNITY_PUBLIC_BASE",
    "COMMUNITY_LOUNGE_URL",
    "COMMUNITY_IRC_PUBLIC_HOST",
    "COMMUNITY_IRC_PUBLIC_PORT",
    "COMMUNITY_IRC_SERVER",
    "COMMUNITY_IRC_PORT",
    "COMMUNITY_REGISTRAR_ACCOUNT",
    "COMMUNITY_REGISTRAR_PASSWORD",
    "COMMUNITY_REGISTRAR_OPER_NAME",
    "COMMUNITY_REGISTRAR_OPER_PASSWORD",
    "COMMUNITY_PRIMARY_HERDER",
    "COMMUNITY_ADMIN_TOKEN",
    "COMMUNITY_INTERNAL_TOKEN",
    "COMMUNITY_CREDENTIAL_KEY",
]
safe_value = re.compile(r"^[A-Za-z0-9._~+/:=-]+$")
for name in ordered:
    if not safe_value.fullmatch(values[name]):
        raise SystemExit(f"{name} contains characters unsafe for a Compose env file")

fd, temporary_name = tempfile.mkstemp(
    prefix=".community.", dir=str(destination.parent), text=True
)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        for name in ordered:
            handle.write(f"{name}={values[name]}\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary_name, destination)
finally:
    try:
        os.unlink(temporary_name)
    except FileNotFoundError:
        pass

# Give the BotHerder supervisor only the one portal credential it needs.
herder_destination = pathlib.Path(os.environ["HERDER_ENV_FILE"])
fd, temporary_name = tempfile.mkstemp(
    prefix=".bot-herder.", dir=str(herder_destination.parent), text=True
)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(f"COMMUNITY_INTERNAL_TOKEN={values['COMMUNITY_INTERNAL_TOKEN']}\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary_name, herder_destination)
finally:
    try:
        os.unlink(temporary_name)
    except FileNotFoundError:
        pass
PY
chown root:root "$community_env_file" "$herder_env_file"
chmod 0600 "$community_env_file" "$herder_env_file"

if [[ "$secrets_only" == true ]]; then
    printf 'Protected community secrets are ready in %s and %s.\n' \
        "$community_env_file" "$herder_env_file"
    exit 0
fi

legacy_metrics="$state_dir/bot-herder/metrics.sqlite3"
runtime_dir="$state_dir/bot-herder/runtime"
if [[ -e "$legacy_metrics" && ! -e "$runtime_dir/metrics.sqlite3" ]]; then
    step "Moving BotHerder metrics into the isolated runtime directory"
    "${compose[@]}" -f "$compose_file" stop bot-herder >/dev/null 2>&1 || true
    for legacy_file in \
        "$legacy_metrics" \
        "$legacy_metrics-wal" \
        "$legacy_metrics-shm"; do
        if [[ -e "$legacy_file" ]]; then
            mv -- "$legacy_file" "$runtime_dir/$(basename "$legacy_file")"
        fi
    done
fi
chown -R 1000:1000 "$runtime_dir"
chmod 0700 "$runtime_dir"

[[ -r "$ircd_config" ]] || die "Missing rendered Ergo configuration"
registrar_oper_password="$(
    sed -n 's/^COMMUNITY_REGISTRAR_OPER_PASSWORD=//p' "$community_env_file"
)"
registrar_hash="$(
    printf '%s\n' "$registrar_oper_password" |
        docker run --rm -i --entrypoint /ircd-bin/ergo \
            "$ergo_image" genpasswd --quiet |
        tail -n 1
)"
[[ "$registrar_hash" == '$2'* ]] || die "Ergo did not return a registrar hash"

step "Ensuring the least-privileged Ergo registrar exists"
IRCD_CONFIG="$ircd_config" REGISTRAR_HASH="$registrar_hash" python3 - <<'PY'
import os
import pathlib
import tempfile

destination = pathlib.Path(os.environ["IRCD_CONFIG"])
text = destination.read_text(encoding="utf-8")
if "    community-registrar:\n" in text:
    class_start = text.index("    account-registrar:\n")
    class_end = text.index("    server-admin:\n", class_start)
    class_text = text[class_start:class_end]
    if "            - ban\n" not in class_text:
        class_text = class_text.replace(
            "            - accreg\n",
            "            - accreg\n            - ban\n",
            1,
        )
        text = text[:class_start] + class_text + text[class_end:]
        fd, temporary_name = tempfile.mkstemp(
            prefix=".ircd.", dir=str(destination.parent), text=True
        )
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, destination)
        finally:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass
    raise SystemExit(0)
class_block = """oper-classes:
    # Internal onboarding only: account registration and suspension.
    account-registrar:
        title: Community Account Registrar
        capabilities:
            - accreg
            - ban
"""
oper_block = f"""opers:
    community-registrar:
        class: account-registrar
        hidden: true
        whois-line: is the automated community account registrar
        password: "{os.environ['REGISTRAR_HASH']}"
"""
if text.count("oper-classes:\n") != 1 or text.count("opers:\n") != 1:
    raise SystemExit("Ergo config shape is not safe for automatic registrar insertion")
text = text.replace("oper-classes:\n", class_block, 1)
text = text.replace("opers:\n", oper_block, 1)
fd, temporary_name = tempfile.mkstemp(
    prefix=".ircd.", dir=str(destination.parent), text=True
)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary_name, destination)
finally:
    try:
        os.unlink(temporary_name)
    except FileNotFoundError:
        pass
PY

"${compose[@]}" -f "$compose_file" up -d ergo thelounge
"${compose[@]}" -f "$compose_file" restart ergo

mapfile -t operator_credentials < <(
    python3 - "$bootstrap_file" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
print(value["OperUsername"])
print(value["OperPassword"])
PY
)
oper_username="${operator_credentials[0]}"
oper_password="${operator_credentials[1]}"
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
registrar_password="$(
    sed -n 's/^COMMUNITY_REGISTRAR_PASSWORD=//p' "$community_env_file"
)"
herder_password="$(
    sed -n 's/^IRC_BOT_PASSWORD=//p' "$bot_env_file"
)"

irc_session() {
    local delay="${1:-0.45}"
    shift
    {
        local command
        for command in "$@"; do
            printf '%s\r\n' "$command"
            sleep "$delay"
        done
    } |
        timeout 35 "${compose[@]}" -f "$compose_file" exec -T ergo \
            nc 127.0.0.1 6667 || true
}

register_account() {
    local account="$1"
    local password="$2"
    local output
    output="$(
        irc_session 0.45 \
            "NICK CommunityBootstrap" \
            "USER bootstrap 0 * :Community account bootstrap" \
            "OPER $oper_username $oper_password" \
            "PRIVMSG NickServ :SAREGISTER $account $password" \
            "QUIT :Community provisioning complete"
    )"
    if grep -Eq 'Successfully registered account' <<<"$output"; then
        printf 'Created Ergo account %s.\n' "$account"
    elif grep -Eqi 'already exists|already registered|name reserved' <<<"$output"; then
        printf 'Ergo account %s already exists; preserved it.\n' "$account"
    else
        die "Ergo did not confirm registration for $account"
    fi
}

primary_herder="$(
    sed -n 's/^COMMUNITY_PRIMARY_HERDER=//p' "$community_env_file"
)"
primary_herder="${primary_herder:-DereksBotHerder}"

register_account "CommunityRegistrar" "$registrar_password"
register_account "$primary_herder" "$herder_password"

step "Registering Derek's storefront channel"
sasl_plain="$(printf '\0%s\0%s' "$admin_account" "$admin_password" | base64 -w0)"
storefront_setup="$(
    irc_session 0.45 \
        "CAP LS 302" \
        "NICK $admin_account" \
        "USER bootstrap 0 * :Storefront channel registration" \
        "CAP REQ :sasl" \
        "AUTHENTICATE PLAIN" \
        "AUTHENTICATE $sasl_plain" \
        "CAP END" \
        "JOIN #herder-derek" \
        "PRIVMSG ChanServ :REGISTER #herder-derek" \
        "PRIVMSG ChanServ :AMODE #herder-derek +o $primary_herder" \
        "PRIVMSG ChanServ :INFO #herder-derek" \
        "QUIT :Storefront registration complete"
)"
grep -Eq 'registered|already registered|already exists' <<<"$storefront_setup" ||
    die "Derek's storefront channel was not registered"

step "Building and starting the portal and BotHerder supervisor"
"${compose[@]}" -f "$compose_file" config --quiet
"${compose[@]}" -f "$compose_file" build community-portal bot-herder
"${compose[@]}" -f "$compose_file" up -d community-portal bot-herder

deadline=$((SECONDS + 150))
portal_health=""
herder_health=""
while ((SECONDS < deadline)); do
    portal_id="$("${compose[@]}" -f "$compose_file" ps -q community-portal)"
    herder_id="$("${compose[@]}" -f "$compose_file" ps -q bot-herder)"
    portal_health="$(
        docker inspect --format \
            '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
            "$portal_id" 2>/dev/null || true
    )"
    herder_health="$(
        docker inspect --format \
            '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
            "$herder_id" 2>/dev/null || true
    )"
    [[ "$portal_health" == healthy && "$herder_health" == healthy ]] && break
    sleep 3
done
if [[ "$portal_health" != healthy || "$herder_health" != healthy ]]; then
    "${compose[@]}" -f "$compose_file" logs --tail 100 \
        community-portal bot-herder >&2
    die "Community services did not become healthy"
fi

step "Registering Derek's migrated BotHerder ownership"
admin_token="$(sed -n 's/^COMMUNITY_ADMIN_TOKEN=//p' "$community_env_file")"
PRIMARY_HERDER="$primary_herder" python3 - "$bootstrap_file" <<'PY' |
import json
import os
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    bootstrap = json.load(handle)
print(json.dumps({
    "owner_account": bootstrap["AdminAccount"],
    "account_password": bootstrap["AdminPassword"],
    "herder_account": os.environ["PRIMARY_HERDER"],
    "display_name": "Derek",
}))
PY
    curl --silent --show-error --fail-with-body \
        --header "Authorization: Bearer $admin_token" \
        --header "Content-Type: application/json" \
        --data-binary @- \
        http://127.0.0.1:9010/api/admin/members >/dev/null

step "Granting storefront channel operator to member Herders"
# One-shot repair: channels provisioned before the AMODE grant existed leave
# their Herder unable to keep the storefront topic current. Idempotent; the
# grant is a no-op when it is already present.
registrar_sasl="$(printf '\0%s\0%s' "CommunityRegistrar" "$registrar_password" | base64 -w0)"
for member_file in /var/lib/omen-irc/bot-herder/members/*.json; do
    [[ -e "$member_file" ]] || continue
    member_amode="$(python3 - "$member_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    member = json.load(handle)
channel = member.get("storefront_channel") or (
    member["channels"][-1] if len(member.get("channels", [])) > 2 else ""
)
if channel and channel.lower() not in {"#general", "#ops"}:
    print(f"{channel} {member['account']}")
PY
)"
    [[ -n "$member_amode" ]] || continue
    irc_session 0.45 \
        "CAP LS 302" \
        "NICK CommunityRegistrar" \
        "USER registrar 0 * :Storefront operator repair" \
        "CAP REQ :sasl" \
        "AUTHENTICATE PLAIN" \
        "AUTHENTICATE $registrar_sasl" \
        "CAP END" \
        "PRIVMSG ChanServ :AMODE ${member_amode% *} +o ${member_amode#* }" \
        "QUIT :Storefront operator repair complete" >/dev/null ||
        printf 'Note: AMODE grant unconfirmed for %s\n' "$member_amode"
done

# The primary companion has no member file; its storefront channel comes from
# the portal profile. Grant it channel operator there too (idempotent, and a
# no-op while the profile still points at the legacy admin-founded channel).
internal_token="$(sed -n 's/^COMMUNITY_INTERNAL_TOKEN=//p' "$community_env_file")"
primary_channel="$(
    curl --silent --max-time 10 \
        --header "Authorization: Bearer $internal_token" \
        http://127.0.0.1:9010/api/internal/storefronts |
        PRIMARY_HERDER="$primary_herder" python3 -c '
import json
import os
import sys

primary = os.environ["PRIMARY_HERDER"].casefold()
for entry in json.load(sys.stdin).get("storefronts", []):
    if str(entry.get("herder_account", "")).casefold() == primary:
        print(entry.get("channel", ""))
        break
' || true
)"
if [[ -n "$primary_channel" ]]; then
    irc_session 0.45 \
        "CAP LS 302" \
        "NICK CommunityRegistrar" \
        "USER registrar 0 * :Storefront operator repair" \
        "CAP REQ :sasl" \
        "AUTHENTICATE PLAIN" \
        "AUTHENTICATE $registrar_sasl" \
        "CAP END" \
        "PRIVMSG ChanServ :AMODE $primary_channel +o $primary_herder" \
        "QUIT :Storefront operator repair complete" >/dev/null ||
        printf 'Note: AMODE grant unconfirmed for %s %s\n' \
            "$primary_channel" "$primary_herder"
fi

step "Publishing the browser lobby, join path, and member guide"
tailscale funnel --bg --yes --https=10000 http://127.0.0.1:9000 >/dev/null
tailscale funnel --bg --yes --set-path=/join http://127.0.0.1:9010 >/dev/null
# Funnel strips the public mount prefix. Pin the backend path so /guide does
# not fall through to the invitation document served at the portal root.
tailscale funnel --bg --yes --set-path=/guide \
    http://127.0.0.1:9010/guide >/dev/null
# Personal AI Storefronts: /lab/<slug> pages, same backend-path pin.
tailscale funnel --bg --yes --set-path=/lab \
    http://127.0.0.1:9010/lab >/dev/null

old_container="$(
    docker ps -aq --filter 'label=com.docker.compose.project=omen-irc-am4' \
        --filter 'label=com.docker.compose.service=compute-bot' | head -n 1
)"
if [[ -n "$old_container" ]]; then
    docker rm -f "$old_container" >/dev/null
    printf 'Removed the stateless legacy ComputeBot container.\n'
fi

legacy_marker="$state_dir/community/compute-bot-migrated"
if [[ ! -e "$legacy_marker" ]]; then
    migration="$(
        irc_session 0.45 \
            "NICK LegacyBotMigration" \
            "USER migration 0 * :Legacy bot migration" \
            "OPER $oper_username $oper_password" \
            "PRIVMSG NickServ :SUSPEND ADD ComputeBot renamed-to-DereksBotHerder" \
            "QUIT :Legacy bot migration complete"
    )"
    if grep -Eqi 'Successfully suspended account ComputeBot|already suspended|No such account' \
        <<<"$migration"; then
        install -o 1000 -g 1000 -m 0600 /dev/null "$legacy_marker"
        printf 'Disabled the legacy ComputeBot SASL identity.\n'
    else
        die "Could not disable the legacy ComputeBot SASL identity"
    fi
fi

printf '\nCommunity onboarding is ready.\n'
printf 'Browser lobby: https://%s:10000/\n' "$tailscale_hostname"
printf 'Join portal: https://%s/join/\n' "$tailscale_hostname"
printf 'BotHerder guide: https://%s/guide/\n' "$tailscale_hostname"
printf 'Primary BotHerder: %s (owner: admin)\n' "$primary_herder"
printf 'Secrets remain in %s, %s, and %s (root-only).\n' \
    "$bot_env_file" "$community_env_file" "$herder_env_file"
