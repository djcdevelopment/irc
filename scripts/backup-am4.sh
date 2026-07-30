#!/usr/bin/env bash
set -euo pipefail

project_dir="${OMEN_IRC_PROJECT_DIR:-/opt/omen-irc}"
compose_file="$project_dir/compose.am4.yaml"
destination="${OMEN_IRC_BACKUP_DIR:-/var/backups/omen-irc}"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    printf 'Run with sudo: sudo %s\n' "$0" >&2
    exit 1
fi

if docker compose version >/dev/null 2>&1; then
    compose=(docker compose)
else
    compose=()
    for candidate in /home/*/.docker/cli-plugins/docker-compose; do
        if [[ -x "$candidate" ]] && "$candidate" version >/dev/null 2>&1; then
            compose=("$candidate")
            break
        fi
    done
    if ((${#compose[@]} == 0)); then
        printf 'Docker Compose v2 is required\n' >&2
        exit 1
    fi
fi

install -d -m 0700 "$destination"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$destination/omen-irc-am4-$timestamp.tar.gz"
mapfile -t running_services < <(
    "${compose[@]}" -f "$compose_file" ps --services --filter status=running
)

restore_services() {
    if ((${#running_services[@]} > 0)); then
        "${compose[@]}" -f "$compose_file" up -d \
            --wait --wait-timeout 120 "${running_services[@]}" >/dev/null
    fi
}
trap restore_services EXIT

if ((${#running_services[@]} > 0)); then
    printf 'Stopping services for a consistent SQLite backup...\n'
    "${compose[@]}" -f "$compose_file" stop "${running_services[@]}" >/dev/null
fi

tar --create --gzip --file "$archive" --absolute-names \
    /opt/omen-irc \
    /etc/omen-irc \
    /var/lib/omen-irc
sha256sum "$archive" >"$archive.sha256"
chmod 0600 "$archive" "$archive.sha256"

printf 'Backup: %s\n' "$archive"
printf 'Checksum: %s\n' "$archive.sha256"
printf 'WARNING: The archive contains credentials and private chat history.\n'
