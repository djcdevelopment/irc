# Security posture

## Current trust boundary

Native IRC is intentionally public at `am4.tail8e749c.ts.net:8443`, but the
service itself remains private-by-account:

- Tailscale Funnel terminates publicly trusted TLS.
- Ergo requires SASL for every normal connection.
- Public account registration is disabled.
- Accounts are created by a least-privileged internal registrar after a
  single-use invitation is redeemed.
- PROXY protocol v2 preserves the original client address for cloaking, limits,
  and abuse response.
- Docker publishes no IRC or Lounge port on a public AM4 interface.

The existing image-gallery Funnel continues independently on HTTPS port 443.
No router forwarding, public cloud VM, Cloudflare tunnel, or direct public IP
binding was added for IRC.

## Ports

| Port | Scope | Encryption | Purpose |
|---|---|---|---|
| 8443/TCP | Public Funnel endpoint | TLS; public CA certificate | Quassel and native IRC clients |
| 10000/TCP | Public Funnel endpoint | HTTPS; public CA certificate | Private-mode The Lounge login |
| 443 `/join` | Public Funnel path | HTTPS; public CA certificate | One-time onboarding portal |
| 6668/TCP | `127.0.0.1` on AM4 | Plain after local TLS termination; PROXY v2 required | Funnel → Ergo |
| 6667/TCP | Compose network plus `127.0.0.1` on AM4 | Plain internal transport | The Lounge, BotHerder, portal, and local recovery |
| 9000/TCP | `127.0.0.1` on AM4 | HTTP | Funnel backend for The Lounge |
| 9010/TCP | `127.0.0.1` on AM4 | HTTP | Funnel backend for `/join` and internal Herder API |
| 8082/TCP | Existing AM4 model listener; UFW-restricted | HTTP plus Bearer authentication | BotHerder and existing LAN tooling |
| 6697/TCP | Not published on AM4 | Not used | Retained only by the stopped OMEN rollback |

The Ergo log warns that its container listener 6668 is plaintext because it
cannot see Docker's host-loopback restriction. Compose and host socket checks
confirm the listener is reachable only through `127.0.0.1:6668`.

## Secrets and sensitive state

On AM4:

- `/etc/omen-irc/bootstrap.json` contains initial account/operator passwords.
- `/etc/omen-irc/compute-bot.env` contains the bot SASL password and model key.
- `/etc/omen-irc/community.env` contains registrar, portal, encryption, and
  internal API secrets.
- `/etc/omen-irc/bot-herder.env` contains only the portal internal token needed
  by the BotHerder supervisor.
- `/etc/omen-irc/ircd.yaml` contains the operator bcrypt hash.
- `/var/lib/omen-irc/ergo` contains account/channel databases and history.
- `/var/lib/omen-irc/thelounge` contains Lounge credentials and browser history.
- `/var/lib/omen-irc/community` contains hashed invites and membership state.
- `/var/lib/omen-irc/bot-herder` contains member Herder credentials and metrics.
- `/var/backups/omen-irc` contains complete sensitive archives.

Protected AM4 files are root-only or owned only by their container UID. The
repository ignores Windows secrets, generated config, runtime data, migration
staging, and backups. Never commit:

- `.env`, `.secrets/`, `.am4/`
- generated `config/ergo/ircd.yaml`
- `data/ergo/`, `data/thelounge/`
- any backup archive or checksum that reveals its name
- passwords, private keys, databases, or message history

## Registration and operators

Self-registration is disabled. An administrator generates a one-time invite;
the internal `community-registrar` oper can only register/suspend accounts
(`accreg` and `ban`). It cannot kill users, rehash Ergo, read history,
administer channels, or grant operator status.

```text
/OPER admin <operator-password>
/NS SAREGISTER alice <new-personal-password>
```

The IRC account and IRC operator passwords are separate. Granting channel
ownership does not require operator access. Only docker-exec sessions from
localhost are exempt from mandatory SASL so bootstrap and local recovery remain
possible; the public PROXY listener receives the original non-local address and
is not exempt.

## Certificates

Tailscale Funnel manages the public certificate and terminates TLS. Clients
validate `am4.tail8e749c.ts.net` normally. The deployed acceptance test observed
TLS 1.3 and a valid Let's Encrypt chain.

The old OMEN self-signed certificate is retained only in the rollback data.
Clients should remove its exception after switching to AM4. Do not copy its
private key to clients.

## The Lounge and onboarding portal

The public Lounge remains private-mode and has no shared login. The join portal
stores only invite hashes. A generated credential is AES-256-GCM encrypted
only while retrying an interrupted provisioning operation and is cleared at
redemption. Passwords are displayed once.

## BotHerder

Each BotHerder accepts commands only when Ergo attaches an authenticated IRCv3
account tag. Unauthenticated users receive no response. Model names and
endpoints are operator-controlled TOML; IRC users cannot provide a URL, API
key, shell command, or tool request.

The container runs as UID/GID 1000 with a read-only filesystem, a small tmpfs,
all capabilities dropped, `no-new-privileges`, and CPU/memory/PID limits.
Member records are mounted read-only; only its isolated metrics directory is
writable. Its environment does not contain the registrar, operator, invite
admin, or credential-encryption secrets. Logs exclude prompts, completions,
raw protocol lines, credentials, and HTTP bodies.

Host networking is a deliberate Phase 1 tradeoff: it avoids a changing Docker
subnet and a UFW exception, but lets this container reach other AM4 loopback
listeners. Keep the image minimal, registry URLs reviewed, and Docker
administration restricted.

## Current tradeoffs

- Funnel is a beta service with bandwidth limits and a restricted public port
  set.
- TLS is terminated before Ergo; the final hop is plaintext over host loopback
  and the Docker bridge.
- Port 8443 is less conventional for IRC than 6697.
- Funnel availability depends on tailscaled and Tailscale's ingress service.
- The first non-tailnet Quassel acceptance test remains manual.
- BotHerder rate-limit state is memory-only and resets on restart.
- Public Lounge credentials are only as safe as each member's password hygiene;
  future Steam/OpenID binding should add recovery, not replace Ergo SASL.
- The pre-existing 8082 launcher passes its bearer key through llama.cpp's
  `--api-key` argument. BotHerder stores its copy in a root-only env file, but
  the model launcher should migrate to `--api-key-file` in its owning baseline
  repository.

## Before direct public exposure

Replacing Funnel with router forwarding or a direct public address requires:

- A stable public hostname
- Automatically renewed trusted TLS certificates at Ergo or a reviewed proxy
- Router, host, Docker, and IPv6 firewall review
- Registration, moderation, and abuse controls
- Reassessed connection and message rate limits
- Logging, privacy, and retention decisions
- Tested off-host backup and restore
- Operator recovery and secret-rotation procedures
- A patching and vulnerability-response process
- A deliberate authenticated HTTPS design if The Lounge is exposed

Do not expose the loopback backend or The Lounge directly.
