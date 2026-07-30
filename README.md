# Omen IRC

## 1. What this repository deploys

This repository deploys a lightweight IRC environment with Docker Compose:

- Ergo IRC server
- The Lounge private browser client and administrative fallback
- Persistent accounts, registered channels, message history, and Lounge state
- Linux/AM4 production operations and Windows/OMEN rollback operations

The current production host is AM4. Public native IRC is available through
Tailscale Funnel at `am4.tail8e749c.ts.net:8443`; users do not need Tailscale.
The previous OMEN deployment is retained as a stopped rollback copy.

Pinned official images:

- `ghcr.io/ergochat/ergo:v2.19.0`
- `ghcr.io/thelounge/thelounge:4.5.2`

## 2. Why Ergo

Ergo combines the IRC server, account services, SASL, nickname and channel
ownership, persistent SQLite history, always-on accounts, and multi-client
attachment. A traditional IRCd plus separate services and a bouncer would add
moving parts without adding value here.

## 3. Why Quassel connects directly to Ergo

There is no server-side Quassel Core. Use the **Quassel Monolithic /
Standalone** application, whose embedded local component connects directly to
Ergo at `am4.tail8e749c.ts.net:8443`.

The program named only **Quassel Client** can connect only to a separate Quassel
Core and cannot connect to an IRC server. See
[docs/QUASSEL.md](docs/QUASSEL.md).

## 4. What The Lounge adds

The Lounge is an optional browser client and administrative fallback. It runs
in private mode, stores each user's configuration persistently, and connects to
Ergo over the private Compose network. No default Lounge user or shared
password is created. Its UI is deliberately not public.

## 5. Current access boundary

| Endpoint | Bind/path | Transport | Audience |
|---|---|---|---|
| Public IRC | `am4.tail8e749c.ts.net:8443` | Trusted TLS 1.3 through Tailscale Funnel | Internet; SASL account required |
| Funnel backend | `127.0.0.1:6668` on AM4 | Plain IRC plus PROXY v2 after TLS termination | Local tailscaled only |
| The Lounge | `127.0.0.1:9000` on AM4 | HTTP | Operator SSH tunnel only |
| Internal Ergo | `ergo:6667` | Plain IRC | Compose network only |

There is no router port forwarding, public VM, Cloudflare configuration, or
publicly bound Docker TCP port for IRC. Registration is disabled, all normal
connections require SASL, and Funnel forwards original client addresses for
Ergo's rate limits.

The existing AM4 gallery continues to use the separate Funnel HTTPS route on
port 443.

## 6. Prerequisites

- AM4 with Docker Engine and Docker Compose v2
- Tailscale connected with Funnel permission
- Root/sudo access for protected configuration and state
- SSH from an operator workstation
- Quassel Monolithic/Standalone for Windows or macOS

OMEN rollback additionally requires Docker Desktop and PowerShell 5.1 or newer.

## 7. One-command bootstrap

With the repository installed at `/opt/omen-irc` on AM4:

```bash
sudo /opt/omen-irc/scripts/bootstrap-am4.sh
```

The script detects AM4's Tailscale identity, creates protected local secrets
when absent, renders configuration, pulls pinned images, starts the services,
waits for health, initializes a fresh database when needed, and runs validation.
It is safe to rerun and does not destroy existing state.

The additive Funnel command is:

```bash
sudo tailscale funnel --bg --yes \
  --proxy-protocol=2 \
  --tls-terminated-tcp=8443 \
  tcp://127.0.0.1:6668
```

Do not use `tailscale funnel reset`; it would also remove AM4's gallery route.

## 8. Quassel connection details

- Application: Quassel Monolithic / Standalone
- Server: `am4.tail8e749c.ts.net`
- Port: `8443`
- TLS/SSL: enabled
- Certificate verification: enabled; no private trust exception
- Nickname and SASL account: personal Ergo account (`admin` initially)
- SASL mechanism: PLAIN
- Automatic joins: `#general`, `#ops`
- Reconnect: enabled, 10-second delay, unlimited retries

Existing clients should remove or disable the old OMEN `6697`/`127.0.0.1`
entries to prevent cycling back to the rollback database.

## 9. Verification

On AM4:

```bash
sudo /opt/omen-irc/scripts/check-am4.sh --require-funnel
sudo /opt/omen-irc/scripts/check-am4.sh --require-funnel --persistence
sudo systemctl status omen-irc-am4
```

From Windows:

```powershell
Test-NetConnection am4.tail8e749c.ts.net -Port 8443
```

The deployed endpoint has also passed trusted TLS, SASL, registered-channel,
PROXY-client-address, restart, and history-replay checks.

## 10. Backup and restore

Create a consistent timestamped AM4 backup outside active runtime directories:

```bash
sudo /opt/omen-irc/scripts/backup-am4.sh
```

Backups and SHA-256 files are written to `/var/backups/omen-irc`. They contain
credentials and private history and must be protected as secrets. Restore
instructions are in [docs/AM4.md](docs/AM4.md) and
[docs/OPERATIONS.md](docs/OPERATIONS.md).

## 11. Known limitations

- Tailscale Funnel is a public beta service with non-configurable bandwidth
  limits and only selected public ports; IRC therefore uses 8443.
- The TLS-to-Ergo handoff is plaintext on AM4 loopback after Funnel terminates
  encryption.
- The Lounge is operator-only unless a future authenticated HTTPS publication
  is designed.
- History retention is 30 days.
- The Lounge has no user until an operator creates one interactively.
- The first true off-tailnet acceptance test still requires a Quassel client on
  a non-Tailscale network.

## 12. Future direct-public-exposure work

If the deployment outgrows Funnel, direct public exposure requires a stable
public hostname, automatically renewed certificates, router and host-firewall
review, registration and abuse controls, rate-limit review, logging and
retention decisions, tested off-host restore, operator recovery, and a patching
process. The Lounge must remain private or gain a deliberately authenticated
HTTPS design.
