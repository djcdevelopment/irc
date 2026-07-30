#!/usr/bin/env bash
set -euo pipefail

project_dir="${OMEN_IRC_PROJECT_DIR:-/opt/omen-irc}"
state_dir="${OMEN_IRC_STATE_DIR:-/var/lib/omen-irc}"
config_dir="${OMEN_IRC_CONFIG_DIR:-/etc/omen-irc}"
compose_file="$project_dir/compose.am4.yaml"
secrets_file="$config_dir/bootstrap.json"
config_file="$config_dir/ircd.yaml"
ergo_image="ghcr.io/ergochat/ergo:v2.19.0"

step() {
    printf '\n==> %s\n' "$1"
}

die() {
    printf 'ERROR: %s\n' "$1" >&2
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
    die "Docker Compose v2 is required"
}

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    die "Run with sudo: sudo $0"
fi

for command in docker tailscale openssl python3; do
    command -v "$command" >/dev/null || die "$command is required"
done
declare -a compose
resolve_compose
docker info >/dev/null

[[ -f "$compose_file" ]] || die "Missing $compose_file"
[[ -f "$project_dir/config/ergo/ircd.am4.template.yaml" ]] ||
    die "Missing AM4 Ergo template"

step "Detecting AM4 Tailscale identity"
tailscale_ip="$(tailscale ip -4 | head -n 1)"
tailscale_hostname="$(
    tailscale status --json |
        python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
)"
[[ "$tailscale_ip" == 100.* ]] || die "Tailscale IPv4 detection failed"
[[ "$tailscale_hostname" == *.ts.net ]] || die "MagicDNS hostname detection failed"

step "Creating protected configuration and state directories"
install -d -m 0755 "$state_dir/ergo" "$state_dir/thelounge"
install -d -m 0700 "$config_dir"
install -d -m 0700 /var/backups/omen-irc

database_was_present=false
[[ -s "$state_dir/ergo/ircd.db" ]] && database_was_present=true

if [[ ! -s "$secrets_file" ]]; then
    step "Generating local operator and administrator secrets"
    umask 077
    python3 - "$secrets_file" <<'PY'
import json
import secrets
import sys
from datetime import datetime, timezone

def strong_secret():
    return secrets.token_urlsafe(32)

with open(sys.argv[1], "x", encoding="utf-8") as handle:
    json.dump(
        {
            "OperUsername": "admin",
            "OperPassword": strong_secret(),
            "AdminAccount": "admin",
            "AdminPassword": strong_secret(),
            "CreatedUtc": datetime.now(timezone.utc).isoformat(),
        },
        handle,
        indent=2,
    )
    handle.write("\n")
PY
fi
chmod 0600 "$secrets_file"

mapfile -t local_secrets < <(
    python3 - "$secrets_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
for key in ("OperUsername", "OperPassword", "AdminAccount", "AdminPassword"):
    item = value.get(key)
    if not item or "\n" in item:
        raise SystemExit(f"invalid {key}")
    print(item)
PY
)
[[ "${#local_secrets[@]}" -eq 4 ]] || die "Invalid $secrets_file"
oper_username="${local_secrets[0]}"
oper_password="${local_secrets[1]}"
admin_account="${local_secrets[2]}"
admin_password="${local_secrets[3]}"

step "Pulling pinned official images"
"${compose[@]}" -f "$compose_file" pull

if [[ ! -s "$config_file" ]]; then
    step "Rendering protected Ergo configuration"
    oper_hash="$(
        printf '%s\n' "$oper_password" |
            docker run --rm -i --entrypoint /ircd-bin/ergo \
                "$ergo_image" genpasswd --quiet |
            tail -n 1
    )"
    [[ "$oper_hash" == '$2'* ]] || die "Ergo did not return a bcrypt hash"
    rendered="$(<"$project_dir/config/ergo/ircd.am4.template.yaml")"
    rendered="${rendered//@@NETWORK_NAME@@/OmenPrivateIRC}"
    rendered="${rendered//@@SERVER_NAME@@/$tailscale_hostname}"
    rendered="${rendered//@@OPER_PASSWORD_HASH@@/$oper_hash}"
    umask 077
    printf '%s\n' "$rendered" >"$config_file"
fi
chmod 0600 "$config_file"

step "Setting container data ownership"
ergo_uid="$(
    docker run --rm --entrypoint sh "$ergo_image" -c 'id -u'
)"
lounge_uid="$(
    docker run --rm --entrypoint sh \
        ghcr.io/thelounge/thelounge:4.5.2 -c 'id -u'
)"
chown -R "$ergo_uid:$ergo_uid" "$state_dir/ergo"
chown -R "$lounge_uid:$lounge_uid" "$state_dir/thelounge"
find "$state_dir/ergo" -type d -exec chmod 0700 {} +
find "$state_dir/ergo" -type f -exec chmod 0600 {} +
find "$state_dir/thelounge" -type d -exec chmod 0700 {} +
find "$state_dir/thelounge" -type f -exec chmod 0600 {} +

step "Validating and starting the Compose stack"
"${compose[@]}" -f "$compose_file" config --quiet
"${compose[@]}" -f "$compose_file" up -d

deadline=$((SECONDS + 120))
while ((SECONDS < deadline)); do
    ergo_health="$(
        docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
            "$("${compose[@]}" -f "$compose_file" ps -q ergo)" 2>/dev/null || true
    )"
    lounge_health="$(
        docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
            "$("${compose[@]}" -f "$compose_file" ps -q thelounge)" 2>/dev/null || true
    )"
    [[ "$ergo_health" == healthy && "$lounge_health" == healthy ]] && break
    sleep 3
done
[[ "${ergo_health:-}" == healthy ]] || die "Ergo did not become healthy"
[[ "${lounge_health:-}" == healthy ]] || die "The Lounge did not become healthy"

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

if [[ "$database_was_present" == false ]]; then
    step "Creating the initial account and registered channels"
    registration="$(
        irc_session 0.5 \
            "NICK BootstrapOper" \
            "USER bootstrap 0 * :Bootstrap operator" \
            "OPER $oper_username $oper_password" \
            "PRIVMSG NickServ :SAREGISTER $admin_account $admin_password" \
            "QUIT :Bootstrap registration complete"
    )"
    grep -Eq 'Successfully registered account|Account already exists|Name reserved' \
        <<<"$registration" || die "Initial account registration failed"

    sasl_payload="$(
        printf '\0%s\0%s' "$admin_account" "$admin_password" | base64 -w0
    )"
    channel_setup="$(
        irc_session 0.45 \
            "CAP LS 302" \
            "NICK $admin_account" \
            "USER bootstrap 0 * :Bootstrap channel registration" \
            "CAP REQ :sasl" \
            "AUTHENTICATE PLAIN" \
            "AUTHENTICATE $sasl_payload" \
            "CAP END" \
            "OPER $oper_username $oper_password" \
            "PRIVMSG NickServ :SET MULTICLIENT ON" \
            "PRIVMSG NickServ :SET ALWAYS-ON TRUE" \
            "PRIVMSG NickServ :SET AUTOREPLAY-MISSED ON" \
            "PRIVMSG NickServ :SET AUTOREPLAY-LINES 100" \
            "PRIVMSG NickServ :SET DM-HISTORY ON" \
            "PRIVMSG NickServ :SET AUTO-AWAY ON" \
            "JOIN #general" \
            "PRIVMSG ChanServ :REGISTER #general" \
            "JOIN #ops" \
            "PRIVMSG ChanServ :REGISTER #ops" \
            "PRIVMSG #ops :Infrastructure channel initialized by AM4 bootstrap." \
            "QUIT :Bootstrap channel setup complete"
    )"
    grep -q '#general' <<<"$channel_setup" ||
        die "Initial channel setup failed"
fi

step "Running AM4 checks"
"$project_dir/scripts/check-am4.sh"

printf '\nAM4 private backend is ready.\n'
printf 'Public IRC after Funnel enablement: %s:8443 (TLS)\n' "$tailscale_hostname"
printf 'The Lounge (operator SSH tunnel): ssh -L 9000:127.0.0.1:9000 am4\n'
printf 'Secrets remain only in %s (mode 0600).\n' "$secrets_file"
