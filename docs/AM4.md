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
| `/etc/omen-irc` | Generated Ergo configuration and bootstrap secrets |
| `/var/lib/omen-irc/ergo` | Accounts, channels, history |
| `/var/lib/omen-irc/thelounge` | The Lounge users and browser-client state |
| `/var/backups/omen-irc` | Timestamped, sensitive backup archives |

The public endpoint is:

```text
Tailscale Funnel TLS :8443
  -> PROXY v2 plaintext on 127.0.0.1:6668
  -> Ergo container listener :6668
```

The Lounge reaches `ergo:6667` only over the private Compose network. Its web UI
is bound to `127.0.0.1:9000`; use an operator SSH tunnel:

```text
ssh -L 9000:127.0.0.1:9000 am4
```

Then browse to `http://127.0.0.1:9000`.

## Install or rerun

From AM4:

```bash
sudo /opt/omen-irc/scripts/bootstrap-am4.sh
sudo /opt/omen-irc/scripts/check-am4.sh --require-funnel
```

Bootstrap is rerunnable. It reuses existing secrets and databases.

Enable only the additive IRC Funnel entry:

```bash
sudo tailscale funnel --bg --yes \
  --proxy-protocol=2 \
  --tls-terminated-tcp=8443 \
  tcp://127.0.0.1:6668
```

Never use `tailscale funnel reset`; AM4's existing HTTPS Funnel on port 443
serves the image gallery.

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

Add a personal Lounge user without creating a shared password:

```bash
cd /opt/omen-irc
sudo /home/derek/.docker/cli-plugins/docker-compose \
  -f compose.am4.yaml exec thelounge thelounge add alice
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
