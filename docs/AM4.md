# AM4 public deployment

AM4 is the zero-incremental-cost production host. Tailscale Funnel provides the
public, trusted TLS endpoint without router port forwarding or a public cloud
VM:

```text
am4.tail8e749c.ts.net:8443
```

Quassel connects with TLS and normal certificate verification enabled. Users do
not need Tailscale. Funnel terminates TLS and sends PROXY protocol v2 to Ergo's
loopback-only backend so Ergo can retain the original client address.

## Layout

| Path | Purpose |
|---|---|
| `/opt/omen-irc` | Compose file, readable templates, scripts, and MOTD |
| `/etc/omen-irc` | Generated Ergo configuration and root-only IRC/bot secrets |
| `/var/lib/omen-irc/ergo` | Accounts, channels, history |
| `/var/lib/omen-irc/thelounge` | The Lounge users and browser-client state |
| `/var/lib/omen-irc/community` | One-time invitation registry and encrypted retry envelopes |
| `/var/lib/omen-irc/bot-herder/members` | Read-only-at-runtime per-member Herder records |
| `/var/lib/omen-irc/bot-herder/runtime` | BotHerder operational metrics |
| `/var/backups/omen-irc` | Timestamped, sensitive backup archives |

The public endpoint is:

```text
Tailscale Funnel TLS :8443
  -> PROXY v2 plaintext on 127.0.0.1:6668
  -> Ergo container listener :6668
```

The Lounge reaches `ergo:6667` only over the private Compose network. Its web UI
is bound to `127.0.0.1:9000` and published with trusted HTTPS at:

```text
https://am4.tail8e749c.ts.net:10000/
```

The one-time portal is bound to `127.0.0.1:9010` and additively published at
`https://am4.tail8e749c.ts.net/join/`. AM4's gallery remains at `/`.

BotHerder uses host networking so it can reach both
`127.0.0.1:6667` (the loopback-only Ergo publication) and the existing
`127.0.0.1:8082/v1` model endpoint without a Docker-subnet UFW exception.
This does not change the public Funnel path.

## Install or rerun

From AM4:

```bash
sudo /opt/omen-irc/scripts/bootstrap-am4.sh
sudo /opt/omen-irc/scripts/check-am4.sh --require-funnel
sudo python3 /opt/omen-irc/scripts/acceptance-compute-bot-am4.py
sudo python3 /opt/omen-irc/scripts/acceptance-community-am4.py
```

Bootstrap is rerunnable. It reuses existing secrets and databases.

Provision or repair community onboarding and BotHerder with:

```bash
sudo /opt/omen-irc/scripts/provision-compute-bot-am4.sh
sudo /opt/omen-irc/scripts/check-compute-bot-am4.sh
```

Enable only the additive IRC Funnel entry:

```bash
sudo tailscale funnel --bg --yes \
  --proxy-protocol=2 \
  --tls-terminated-tcp=8443 \
  tcp://127.0.0.1:6668
```

Never use `tailscale funnel reset`; AM4's existing HTTPS Funnel on port 443
serves the image gallery.

The additive browser publications are:

```bash
sudo tailscale funnel --bg --yes --https=10000 \
  http://127.0.0.1:9000
sudo tailscale funnel --bg --yes --set-path=/join \
  http://127.0.0.1:9010
```

## Service management

The optional systemd wrapper is installed as `omen-irc-am4.service`:

```bash
sudo systemctl status omen-irc-am4
sudo systemctl restart omen-irc-am4
sudo journalctl -u omen-irc-am4
```

Container logs remain available directly:

```bash
cd /opt/omen-irc
sudo /home/derek/.docker/cli-plugins/docker-compose -f compose.am4.yaml ps
sudo /home/derek/.docker/cli-plugins/docker-compose \
  -f compose.am4.yaml logs --tail 100
```

Create an invitation; redemption creates the Lounge profile automatically:

```powershell
.\scripts\invite-community.ps1 -DisplayName "Alice"
```

## Backup and restore

Create a consistent backup:

```bash
sudo /opt/omen-irc/scripts/backup-am4.sh
```

To restore, stop the stack, verify the archive checksum, move the current three
deployment directories to a dated recovery location, and extract the archive
as root because it contains absolute paths. Start the stack and run:

```bash
sudo /opt/omen-irc/scripts/check-am4.sh --require-funnel --persistence
```

Keep the OMEN deployment stopped but intact until the AM4 restore has also been
tested from a second host.
