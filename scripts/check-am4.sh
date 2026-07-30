#!/usr/bin/env bash
set -euo pipefail

project_dir="${OMEN_IRC_PROJECT_DIR:-/opt/omen-irc}"
compose_file="$project_dir/compose.am4.yaml"
require_funnel=false
persistence=false

for argument in "$@"; do
    case "$argument" in
        --require-funnel) require_funnel=true ;;
        --persistence) persistence=true ;;
        *) printf 'Unknown option: %s\n' "$argument" >&2; exit 2 ;;
    esac
done

pass_count=0
warn_count=0

pass() {
    pass_count=$((pass_count + 1))
    printf 'PASS: %s\n' "$1"
}

warn() {
    warn_count=$((warn_count + 1))
    printf 'WARN: %s\n' "$1"
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

[[ -f "$compose_file" ]] || fail "Missing $compose_file"
declare -a compose
resolve_compose
"${compose[@]}" -f "$compose_file" config --quiet
pass "Compose configuration is valid"

for service in ergo thelounge community-portal bot-herder; do
    container_id="$("${compose[@]}" -f "$compose_file" ps -q "$service")"
    [[ -n "$container_id" ]] || fail "$service container is absent"
    state="$(docker inspect --format '{{.State.Status}}' "$container_id")"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"
    restarts="$(docker inspect --format '{{.RestartCount}}' "$container_id")"
    [[ "$state" == running ]] || fail "$service is $state"
    [[ "$health" == healthy ]] || fail "$service health is $health"
    ((restarts < 3)) || fail "$service has restarted $restarts times"
    pass "$service is running, healthy, and not restart-looping"
done

for directory in \
    /var/lib/omen-irc/ergo \
    /var/lib/omen-irc/thelounge \
    /var/lib/omen-irc/community \
    /var/lib/omen-irc/bot-herder; do
    [[ -d "$directory" ]] || fail "Missing persistent directory $directory"
    pass "Persistent directory exists: $directory"
done
[[ -s /var/lib/omen-irc/ergo/ircd.db ]] || fail "Ergo account database is absent"
[[ -s /var/lib/omen-irc/ergo/ergo_history.db ]] || fail "Ergo history database is absent"
pass "Ergo account and history databases exist"

ss -lnt | grep -Eq '127\.0\.0\.1:6668[[:space:]]' ||
    fail "Funnel backend is not listening on 127.0.0.1:6668"
ss -lnt | grep -Eq '127\.0\.0\.1:6667[[:space:]]' ||
    fail "BotHerder IRC handoff is not listening on 127.0.0.1:6667"
ss -lnt | grep -Eq '127\.0\.0\.1:9000[[:space:]]' ||
    fail "The Lounge is not listening on 127.0.0.1:9000"
ss -lnt | grep -Eq '127\.0\.0\.1:9010[[:space:]]' ||
    fail "Join portal is not listening on 127.0.0.1:9010"
if ss -lnt | grep -Eq '(^|[[:space:]])(\*|0\.0\.0\.0|\[::\]):(6667|6668|6697|9000|9010)[[:space:]]'; then
    fail "An IRC/Lounge port is bound to a broad host interface"
fi
pass "Host ports 6667, 6668, 9000, and 9010 are loopback-only"

irc_response="$(
    {
        printf 'NICK HealthProbe\r\n'
        printf 'USER health 0 * :AM4 health probe\r\n'
        printf 'QUIT :done\r\n'
    } |
        timeout 10 "${compose[@]}" -f "$compose_file" exec -T ergo \
            nc 127.0.0.1 6667 || true
)"
grep -Eq ' (001|NOTICE) ' <<<"$irc_response" ||
    fail "Ergo did not return a valid IRC response"
pass "Ergo responds over IRC protocol"

curl --fail --silent --show-error --max-time 5 http://127.0.0.1:9000/ >/dev/null
pass "The Lounge responds over HTTP on loopback"
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:9010/health >/dev/null
pass "The one-time join portal responds over HTTP on loopback"

if ! python3 - /etc/omen-irc/bootstrap.json \
    /var/lib/omen-irc/thelounge/users <<'PY'
import hmac
import json
import pathlib
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    bootstrap = json.load(handle)
account = bootstrap["AdminAccount"]
password = bootstrap["AdminPassword"]
profile_path = pathlib.Path(sys.argv[2], f"{account}.json")
with profile_path.open(encoding="utf-8") as handle:
    profile = json.load(handle)
networks = profile.get("networks", [])
if len(networks) != 1:
    raise SystemExit(1)
network = networks[0]
expected = {
    "host": "ergo",
    "port": 6667,
    "sasl": "plain",
    "saslAccount": account,
}
if any(network.get(key) != value for key, value in expected.items()):
    raise SystemExit(1)
if not hmac.compare_digest(network.get("saslPassword", ""), password):
    raise SystemExit(1)
PY
then
    fail "The initial admin has no matching private Lounge profile"
fi
pass "The initial admin has a preconfigured matching Lounge profile"

"${compose[@]}" -f "$compose_file" exec -T thelounge \
    node -e 'require("dns").lookup("ergo",(e,a)=>{if(e)process.exit(1);console.log(a)})' \
    >/dev/null
pass "The Lounge resolves the internal Ergo service hostname"

funnel_status="$(tailscale funnel status)"
if grep -Eq '8443|tls-terminated-tcp' <<<"$funnel_status"; then
    pass "Tailscale Funnel has an IRC entry on port 8443"
elif [[ "$require_funnel" == true ]]; then
    fail "Tailscale Funnel does not show the IRC port 8443"
else
    warn "Funnel 8443 is not enabled yet"
fi
if grep -q '10000' <<<"$funnel_status" && grep -q '/join' <<<"$funnel_status"; then
    pass "Tailscale Funnel publishes the browser lobby and /join"
elif [[ "$require_funnel" == true ]]; then
    fail "Tailscale Funnel does not show both lobby port 10000 and /join"
else
    warn "Funnel browser paths are not enabled yet"
fi

if [[ "$persistence" == true ]]; then
    secrets_file=/etc/omen-irc/bootstrap.json
    [[ -r "$secrets_file" ]] || fail "Cannot read persistence-test credentials"
    mapfile -t credentials < <(
        python3 - "$secrets_file" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
print(data["AdminAccount"])
print(data["AdminPassword"])
PY
    )
    account="${credentials[0]}"
    password="${credentials[1]}"
    payload="$(printf '\0%s\0%s' "$account" "$password" | base64 -w0)"

    authenticated_probe() {
        local marker="${1:-}"
        {
            printf 'CAP LS 302\r\n'
            printf 'NICK %s\r\n' "$account"
            printf 'USER persistence 0 * :Persistence probe\r\n'
            printf 'CAP REQ :sasl draft/chathistory\r\n'
            printf 'AUTHENTICATE PLAIN\r\n'
            printf 'AUTHENTICATE %s\r\n' "$payload"
            printf 'CAP END\r\n'
            sleep 1
            printf 'JOIN #ops\r\n'
            printf 'PRIVMSG NickServ :INFO %s\r\n' "$account"
            printf 'PRIVMSG ChanServ :INFO #general\r\n'
            printf 'PRIVMSG ChanServ :INFO #ops\r\n'
            [[ -z "$marker" ]] || printf 'PRIVMSG #ops :%s\r\n' "$marker"
            sleep 1
            printf 'CHATHISTORY LATEST #ops * 100\r\n'
            sleep 1
            printf 'QUIT :Persistence probe complete\r\n'
        } |
            timeout 25 "${compose[@]}" -f "$compose_file" exec -T ergo \
                nc 127.0.0.1 6667 || true
    }

    marker="AM4-PERSISTENCE-$(date -u +%Y%m%dT%H%M%SZ)"
    before="$(authenticated_probe "$marker")"
    grep -q ' 900 ' <<<"$before" || fail "Admin SASL authentication failed before restart"
    grep -q '#general' <<<"$before" || fail "#general registration was not found"
    grep -q '#ops' <<<"$before" || fail "#ops registration was not found"

    "${compose[@]}" -f "$compose_file" restart >/dev/null
    deadline=$((SECONDS + 120))
    while ((SECONDS < deadline)); do
        health="$(
            "${compose[@]}" -f "$compose_file" ps --format json 2>/dev/null |
                grep -c '"Health":"healthy"' || true
        )"
        [[ "$health" -ge 4 ]] && break
        sleep 3
    done
    [[ "${health:-0}" -ge 4 ]] || fail "Services did not recover after restart"

    after="$(authenticated_probe)"
    grep -q ' 900 ' <<<"$after" || fail "Admin SASL authentication failed after restart"
    grep -q "$marker" <<<"$after" || fail "The pre-restart history marker was not replayed"
    pass "Account, registered channels, and message history survived restart"
fi

"$project_dir/scripts/check-compute-bot-am4.sh"
pass "BotHerder-specific validation passed"

printf '\n%d checks passed' "$pass_count"
if ((warn_count > 0)); then
    printf '; %d warning(s)' "$warn_count"
fi
printf '.\n'
