# Omen IRC

## 1. What this repository deploys

This repository deploys a lightweight IRC environment with Docker Compose:

- Ergo IRC server
- The Lounge private browser client and administrative fallback
- A one-time onboarding portal and public private-mode browser lobby
- One owner-scoped BotHerder IRC identity per community member
- HEARTH-backed canonical AI execution with durable jobs, global provider
  capacity, and immutable result artifacts
- An outbound-only remote-agent adapter for member-controlled model endpoints
- Persistent accounts, registered channels, message history, and Lounge state
- Linux/AM4 production operations and Windows/OMEN rollback operations

The current production host is AM4. Public native IRC is available through
Tailscale Funnel at `am4.tail8e749c.ts.net:8443`; users do not need Tailscale.
The previous OMEN deployment is retained as a stopped rollback copy.
The architecture pivots, lessons, and remaining reliability work are recorded
in [docs/RETROSPECTIVE.md](docs/RETROSPECTIVE.md).

Pinned official images:

- `ghcr.io/ergochat/ergo:v2.19.0`
- `ghcr.io/thelounge/thelounge:4.5.2`
- `python:3.14.5-slim-bookworm` as the BotHerder/adapter build base

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

The Lounge is the zero-install browser lobby at
`https://am4.tail8e749c.ts.net:10000/`. It remains in private mode: the
one-time portal creates a distinct Lounge login and preconfigured Ergo SASL
network for each invited member. There is no shared password.

Each member also receives a separately authenticated, owner-scoped BotHerder
session with their chosen IRC name. It can use operator-allow-listed AM4 models
and invite any number of outbound remote agents. See
[docs/COMMUNITY-ONBOARDING.md](docs/COMMUNITY-ONBOARDING.md) and
[docs/COMPUTE-BOT.md](docs/COMPUTE-BOT.md).

BotHerder is an IRC protocol adapter rather than an execution service. HEARTH
owns Request/Job/Invocation identity, provider routing, aggregate capacity,
usage, and full result artifacts. The reversible deployment modes and trust
boundary are documented in
[docs/HEARTH-EXECUTION.md](docs/HEARTH-EXECUTION.md).

A remote agent is any OpenAI-compatible endpoint the inviting member operates.
[docs/HERMES-AGENT.md](docs/HERMES-AGENT.md) covers connecting a
[Hermes Agent](https://github.com/NousResearch/hermes-agent), including the
security tradeoff of exposing an agent's API server to a chat channel.

## 5. Current access boundary

| Endpoint | Bind/path | Transport | Audience |
|---|---|---|---|
| Public IRC | `am4.tail8e749c.ts.net:8443` | Trusted TLS 1.3 through Tailscale Funnel | Internet; SASL account required |
| Join portal | `https://am4.tail8e749c.ts.net/join/` | Trusted HTTPS through Funnel | One-time token required |
| BotHerder guide | `https://am4.tail8e749c.ts.net/guide/` | Trusted HTTPS through Funnel | Public, read-only member documentation |
| Browser lobby | `https://am4.tail8e749c.ts.net:10000/` | Trusted HTTPS through Funnel | Personal Lounge login required |
| Funnel backend | `127.0.0.1:6668` on AM4 | Plain IRC plus PROXY v2 after TLS termination | Local tailscaled only |
| The Lounge backend | `127.0.0.1:9000` on AM4 | HTTP after local TLS termination | Local tailscaled only |
| Community portal backend | `127.0.0.1:9010` on AM4 | HTTP after local TLS termination | Loopback backend for `/join`, `/guide`, and internal Herder APIs |
| Internal Ergo | `ergo:6667` | Plain IRC | Compose network only |
| BotHerder IRC handoff | `127.0.0.1:6667` on AM4 | Plain IRC | Host-networked BotHerder only |
| Canonical execution | `omen.tail8e749c.ts.net:8443/mcp` from AM4 | Tailnet-only trusted HTTPS through Tailscale Serve | BotHerder's least-privilege HEARTH adapter |
| Seeded model | `127.0.0.1:8082/v1` from HEARTH over its declared AM4 Provider | HTTP plus Bearer authentication | Routed AM4-local inference; BotHerder direct rollback only |

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

The script detects AM4's Tailscale identity, creates protected IRC, registrar,
portal, and BotHerder secrets, renders configuration, builds pinned images,
provisions non-oper accounts, publishes the additive Funnel routes, starts the
services, waits for health, and runs validation. It is rerunnable.

Create a 24-hour one-time invitation from Windows:

```powershell
.\scripts\invite-community.ps1 -DisplayName "Sam"
```

The installed Codex skill is `$invite-irc-community`; its distributable source
is in [`skills/invite-irc-community`](skills/invite-irc-community).

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
sudo python3 /opt/omen-irc/scripts/acceptance-compute-bot-am4.py
sudo python3 /opt/omen-irc/scripts/acceptance-hearth-provenance-am4.py
sudo python3 /opt/omen-irc/scripts/acceptance-community-am4.py
sudo systemctl status omen-irc-am4
```

From Windows:

```powershell
Test-NetConnection am4.tail8e749c.ts.net -Port 8443
```

The deployed endpoint has also passed trusted TLS, SASL, registered-channel,
PROXY-client-address, restart, and history-replay checks.
Sanitized execution-control-plane evidence is in
[docs/evidence/HEARTH-EXECUTION.md](docs/evidence/HEARTH-EXECUTION.md).

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
- Steam/OpenID recovery binding is not implemented yet.
- History retention is 30 days.
- A user must save the generated password before leaving the redemption page;
  it is deliberately shown once.
- The first true off-tailnet acceptance test still requires a Quassel client on
  a non-Tailscale network.
- BotHerder uses host networking for Ergo, portal, remote-agent compatibility,
  and direct rollback. Its non-root, read-only container can therefore see AM4
  loopback listeners even though users can invoke only allow-listed models.
- HEARTH globally bounds Provider concurrency, but BotHerder's IRC traffic and
  rolling request limits remain per member.
- Per-Herder rate limits are in-memory and reset when the container restarts.
- Token metrics are reported only when a provider supplies them; the UI says
  `not reported` instead of inventing a zero.

## 12. Future direct-public-exposure work

If the deployment outgrows Funnel, direct public exposure requires a stable
public hostname, automatically renewed certificates, router and host-firewall
review, registration and abuse controls, rate-limit review, logging and
retention decisions, tested off-host restore, operator recovery, and a patching
process. The Lounge must remain private or gain a deliberately authenticated
HTTPS design.
