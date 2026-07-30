#!/usr/bin/env bash
set -euo pipefail

config_dir="${OMEN_IRC_CONFIG_DIR:-/etc/omen-irc}"
community_env_file="$config_dir/community.env"

die() {
    printf 'ERROR: %s\n' "$1" >&2
    exit 1
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] ||
    die "Run with sudo: sudo $0"
[[ -r "$community_env_file" ]] || die "Missing $community_env_file"

command_name="${1:-}"
shift || true

case "$command_name" in
    invite-member)
        encoded_name="${1:-}"
        [[ -n "$encoded_name" ]] || die "Usage: $0 invite-member DISPLAY_NAME_BASE64"
        COMMUNITY_ENV_FILE="$community_env_file" \
        DISPLAY_NAME_BASE64="$encoded_name" \
        python3 - <<'PY'
import base64
import json
import os
import pathlib
import urllib.error
import urllib.request

values = {}
for line in pathlib.Path(os.environ["COMMUNITY_ENV_FILE"]).read_text(
    encoding="utf-8"
).splitlines():
    name, separator, value = line.partition("=")
    if separator:
        values[name] = value
display_name = base64.b64decode(
    os.environ["DISPLAY_NAME_BASE64"], validate=True
).decode("utf-8")
payload = json.dumps(
    {"display_name": display_name, "expires_hours": 24}
).encode("utf-8")
request = urllib.request.Request(
    "http://127.0.0.1:9010/api/admin/invites",
    data=payload,
    headers={
        "Authorization": f"Bearer {values['COMMUNITY_ADMIN_TOKEN']}",
        "Content-Type": "application/json",
    },
)
try:
    with urllib.request.urlopen(request, timeout=15) as response:
        value = json.load(response)
except urllib.error.HTTPError as error:
    raise SystemExit(error.read().decode("utf-8", errors="replace"))
print(value["url"])
print(f"Expires: {value['expires_at']}")
PY
        ;;
    status)
        curl --silent --show-error --fail \
            http://127.0.0.1:9010/health
        printf '\n'
        ;;
    offboard-member)
        encoded_owner="${1:-}"
        encoded_herder="${2:-}"
        [[ -n "$encoded_owner" && -n "$encoded_herder" ]] ||
            die "Usage: $0 offboard-member OWNER_BASE64 HERDER_BASE64"
        COMMUNITY_ENV_FILE="$community_env_file" \
        OWNER_BASE64="$encoded_owner" \
        HERDER_BASE64="$encoded_herder" \
        python3 - <<'PY'
import base64
import json
import os
import pathlib
import urllib.request

values = {}
for line in pathlib.Path(os.environ["COMMUNITY_ENV_FILE"]).read_text(
    encoding="utf-8"
).splitlines():
    name, separator, value = line.partition("=")
    if separator:
        values[name] = value
payload = json.dumps(
    {
        "owner_account": base64.b64decode(
            os.environ["OWNER_BASE64"], validate=True
        ).decode("utf-8"),
        "herder_account": base64.b64decode(
            os.environ["HERDER_BASE64"], validate=True
        ).decode("utf-8"),
    }
).encode("utf-8")
request = urllib.request.Request(
    "http://127.0.0.1:9010/api/admin/members/offboard",
    data=payload,
    headers={
        "Authorization": f"Bearer {values['COMMUNITY_ADMIN_TOKEN']}",
        "Content-Type": "application/json",
    },
)
with urllib.request.urlopen(request, timeout=60) as response:
    result = json.load(response)
print(
    f"Offboarded {result['owner_account']} and "
    f"{result['herder_account']}; suspended agents: "
    f"{result['suspended_agents']}"
)
PY
        ;;
    *)
        die "Usage: $0 {invite-member DISPLAY_NAME_BASE64|offboard-member OWNER_BASE64 HERDER_BASE64|status}"
        ;;
esac
