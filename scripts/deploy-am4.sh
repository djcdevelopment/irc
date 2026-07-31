#!/usr/bin/env bash
# Copy this working tree to AM4.
#
# Run from the workstation (Git Bash), not from AM4.
#
# Sends exactly the files git tracks plus new files that are not ignored. That
# excludes .env, .secrets/, backups/, and the generated config/ergo/ircd.yaml,
# so host-side secrets and generated state are never shipped and never
# overwritten. It does not delete anything on the host.
set -euo pipefail

host="${AM4_HOST:-am4}"
target="${OMEN_IRC_PROJECT_DIR:-/opt/omen-irc}"
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$project_dir"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
    printf 'deploy-am4: not a git working tree: %s\n' "$project_dir" >&2
    exit 1
fi

manifest="$(git ls-files --cached --others --exclude-standard)"
if [ -z "$manifest" ]; then
    printf 'deploy-am4: nothing to send\n' >&2
    exit 1
fi

leaked="$(printf '%s\n' "$manifest" \
    | grep -iE '(^|/)\.env$|(^|/)\.secrets/|(^|/)backups/|ircd\.yaml$' || true)"
if [ -n "$leaked" ]; then
    printf 'deploy-am4: refusing to send host secrets:\n%s\n' "$leaked" >&2
    exit 1
fi

printf 'deploy-am4: sending %s files to %s:%s\n' \
    "$(printf '%s\n' "$manifest" | wc -l | tr -d ' ')" "$host" "$target"

git ls-files --cached --others --exclude-standard -z \
    | tar --null --files-from=- -czf - \
    | ssh "$host" "sudo tar -xzf - -C '$target'"

printf 'deploy-am4: transfer complete\n\n'
cat <<EOF
Now, on ${host}:

  sudo docker build --target test -t omen-irc-bot-herder:test ${target}/services/compute-bot
  sudo ${target}/scripts/bootstrap-am4.sh
  sudo ${target}/scripts/check-compute-bot-am4.sh
  sudo python3 ${target}/scripts/acceptance-compute-bot-am4.py
EOF
