# Security posture

## Current trust boundary

Native IRC is intentionally public at `am4.tail8e749c.ts.net:8443`, but the
service itself remains private-by-account:

- Tailscale Funnel terminates publicly trusted TLS.
- Ergo requires SASL for every normal connection.
- Public account registration is disabled.
- Accounts are created by an IRC operator.
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
| 6668/TCP | `127.0.0.1` on AM4 | Plain after local TLS termination; PROXY v2 required | Funnel → Ergo |
| 6667/TCP | Compose network only | Plain internal transport | The Lounge → Ergo and local recovery |
| 9000/TCP | `127.0.0.1` on AM4 | HTTP | The Lounge via operator SSH tunnel |
| 6697/TCP | Not published on AM4 | Not used | Retained only by the stopped OMEN rollback |

The Ergo log warns that its container listener 6668 is plaintext because it
cannot see Docker's host-loopback restriction. Compose and host socket checks
confirm the listener is reachable only through `127.0.0.1:6668`.

## Secrets and sensitive state

On AM4:

- `/etc/omen-irc/bootstrap.json` contains initial account/operator passwords.
- `/etc/omen-irc/ircd.yaml` contains the operator bcrypt hash.
- `/var/lib/omen-irc/ergo` contains account/channel databases and history.
- `/var/lib/omen-irc/thelounge` contains Lounge credentials and browser history.
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

Self-registration is disabled. An authenticated operator creates a distinct
personal account for each person:

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

## The Lounge

The Lounge is not public. Operators reach it with:

```text
ssh -L 9000:127.0.0.1:9000 am4
```

This avoids adding a second public web authentication surface. No default user
or shared password exists.

## Current tradeoffs

- Funnel is a beta service with bandwidth limits and a restricted public port
  set.
- TLS is terminated before Ergo; the final hop is plaintext over host loopback
  and the Docker bridge.
- Port 8443 is less conventional for IRC than 6697.
- Funnel availability depends on tailscaled and Tailscale's ingress service.
- The first non-tailnet Quassel acceptance test remains manual.

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
