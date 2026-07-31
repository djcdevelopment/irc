# Operations

AM4 is the current production host. The Windows/OMEN commands later in this
document are retained for rollback only.

## AM4 quick operations

```bash
# start and enable at boot
sudo systemctl enable --now omen-irc-am4

# stop, restart, status
sudo systemctl stop omen-irc-am4
sudo systemctl restart omen-irc-am4
sudo systemctl status omen-irc-am4

# Compose status and logs
cd /opt/omen-irc
sudo /home/derek/.docker/cli-plugins/docker-compose -f compose.am4.yaml ps
sudo /home/derek/.docker/cli-plugins/docker-compose -f compose.am4.yaml logs --tail 100

# configuration and service validation
sudo /opt/omen-irc/scripts/check-am4.sh --require-funnel
sudo /opt/omen-irc/scripts/check-am4.sh --require-funnel --persistence
sudo /opt/omen-irc/scripts/check-compute-bot-am4.sh
sudo python3 /opt/omen-irc/scripts/acceptance-community-am4.py
```

Create a one-time community invitation from Windows:

```powershell
.\scripts\invite-community.ps1 -DisplayName "Alice"
```

Redemption creates personal Ergo and Lounge accounts, an internal network, and
the member's chosen BotHerder. The browser lobby is
`https://am4.tail8e749c.ts.net:10000/`.

Provision or repair the portal and BotHerder supervisor:

```bash
sudo /opt/omen-irc/scripts/provision-compute-bot-am4.sh
sudo /opt/omen-irc/scripts/check-compute-bot-am4.sh
```

Run its live acceptance suite:

```bash
sudo python3 /opt/omen-irc/scripts/acceptance-compute-bot-am4.py
sudo python3 /opt/omen-irc/scripts/acceptance-hearth-provenance-am4.py
```

BotHerder execution is controlled by `[hearth].mode` in
`config/compute-bot/bot.toml`: `direct` is rollback, `shadow` performs a
content-free/no-dispatch route comparison, and `hearth` uses the canonical
execution lifecycle. `!status` reports the active mode.

Provision the private route and least-privilege adapter key on OMEN:

```powershell
cd C:\work\commandcenter
.\hearth\tools\configure-private-ingress.ps1
.\hearth\tools\provision-irc-adapter.ps1
```

The latter writes `/etc/omen-irc/hearth-bot.env` over SSH without printing the
key. Restart HEARTH after changing the trusted proxy hostname, then recreate
`bot-herder`. Verify `tailscale serve status` on OMEN says **Serve**, not
Funnel, for port 8443. Full procedure and rollback are in
[HEARTH-EXECUTION.md](HEARTH-EXECUTION.md).

The disruptive model stop/restart test is documented in
[COMPUTE-BOT.md](COMPUTE-BOT.md) and should run only during a maintenance
window.

Add or update models in `/opt/omen-irc/config/compute-bot/models.toml`, put
their named API-key variables in root-only
`/etc/omen-irc/compute-bot.env`, then recreate `bot-herder`. Model URLs and
keys are never supplied from IRC.

Create Ergo accounts and channels from an authenticated operator session:

```text
/OPER admin <operator-password>
/NS SAREGISTER alice <new-personal-password>
/JOIN #project
/CS REGISTER #project
```

The operator password is stored only in `/etc/omen-irc/bootstrap.json`.
The initial `admin` Lounge login uses `AdminAccount` and `AdminPassword` from
that file. `OperPassword` is not a Lounge or SASL credential. Community
provisioning verifies this profile on every rerun.

Back up AM4:

```bash
sudo /opt/omen-irc/scripts/backup-am4.sh
```

Backups are written to `/var/backups/omen-irc`, outside active runtime
directories, with SHA-256 files. See [AM4.md](AM4.md) for restore layout and
Funnel details.

Update pinned images only after reading both projects' release notes:

1. Run `backup-am4.sh`.
2. Change exact tags in `compose.am4.yaml`.
3. Run `docker compose pull` and `docker compose config --quiet`.
4. Recreate with `docker compose up -d --wait`.
5. Run the full persistence check.

For BotHerder, build its test target before recreating the runtime image:

```bash
sudo docker build --target test \
  -t omen-irc-bot-herder:test /opt/omen-irc/services/compute-bot
cd /opt/omen-irc
sudo /home/derek/.docker/cli-plugins/docker-compose \
  -f compose.am4.yaml up -d --build bot-herder
```

Rollback an image update by restoring the pre-update archive and exact old
tags. Do not point an older Ergo image at a database upgraded by a newer image
unless the release notes explicitly allow it.

Rotate an Ergo account password with:

```text
/NS PASSWD <old-password> <new-password>
```

Rotate the operator password by generating a new secret and bcrypt hash,
updating both root-only files under `/etc/omen-irc`, and restarting Ergo. Confirm
the new password works and the old one fails. Public TLS certificates are
managed by Funnel; no private certificate is stored by this stack on AM4.

Rotate the primary bot SASL password by changing `DereksBotHerder` through an
operator-controlled recovery session, atomically replacing
`IRC_BOT_PASSWORD` in `/etc/omen-irc/compute-bot.env`, and recreating
`bot-herder`.
Rotate a model key at its endpoint first, update the corresponding env
variable, recreate the bot, and verify that the old key fails. Do not print
either value.

Rotate the HEARTH adapter key from OMEN with
`hearth\tools\provision-irc-adapter.ps1`, then recreate `bot-herder`. Confirm
`check-compute-bot-am4.sh` can plan a no-dispatch execution and that neither old
nor new key appears in logs.

Disable only IRC publication without disturbing the gallery:

```bash
sudo tailscale funnel --tls-terminated-tcp=8443 off
```

Do not use `tailscale funnel reset`.

Disable browser onboarding independently:

```bash
sudo tailscale funnel --https=10000 off
sudo tailscale funnel --set-path=/join off
sudo tailscale funnel --set-path=/guide off
```

Remove containers and their private network without deleting state:

```bash
sudo systemctl stop omen-irc-am4
cd /opt/omen-irc
sudo /home/derek/.docker/cli-plugins/docker-compose -f compose.am4.yaml down
```

A full deletion is intentionally manual: first create and move an off-host
backup, disable only Funnel 8443, stop/disable the systemd unit, remove the
containers, and then explicitly remove `/opt/omen-irc`, `/etc/omen-irc`,
`/var/lib/omen-irc`, and `/var/backups/omen-irc`. This permanently destroys
credentials and history.

## OMEN rollback operations

Run these commands from the repository root in PowerShell. Do not run OMEN and
AM4 as simultaneous writable primaries; their SQLite databases do not
replicate.

## Start

```powershell
docker compose --env-file .env up -d
.\scripts\check.ps1
```

## Stop

```powershell
docker compose --env-file .env stop
```

This keeps containers, databases, certificates, history, and Lounge users.

## Restart

```powershell
docker compose --env-file .env restart
.\scripts\check.ps1
```

## Status

```powershell
docker compose --env-file .env ps
docker stats --no-stream
```

## Logs

```powershell
docker compose --env-file .env logs --tail 100
docker compose --env-file .env logs -f ergo
docker compose --env-file .env logs -f thelounge
```

The Ergo configuration excludes raw IRC user input/output, so account
passwords sent through SASL or service commands should not be logged.

## Configuration validation

```powershell
docker compose --env-file .env config --quiet
.\scripts\check.ps1
```

On a stopped stack, perform Ergo's full smoke validation:

```powershell
docker compose --env-file .env run --rm --no-deps ergo run --conf /ircd/ircd.yaml --quiet --smoke
```

After editing `config\ergo\ircd.yaml`, apply a reload:

```powershell
docker compose kill -s HUP ergo
docker compose logs --tail 50 ergo
```

If a setting is not reloadable, use `docker compose restart ergo`.

## Add a The Lounge user

No shared user is created. Add a personal user interactively:

```powershell
docker compose exec thelounge thelounge add alice
```

The prompt hides the password. After login, the user adds their personal Ergo
SASL account; the host, port, and TLS fields are locked to `ergo:6667`.

List, reset, or remove users:

```powershell
docker compose exec thelounge thelounge list
docker compose exec thelounge thelounge reset alice
docker compose exec thelounge thelounge remove alice
```

Removing a Lounge user does not delete all of their message logs automatically.
Review `data\thelounge` before claiming erasure.

## Create or approve an Ergo account

Registration is operator-controlled. From the initial authenticated `admin`
account in Quassel or The Lounge:

```text
/OPER admin <operator-password>
/NS SAREGISTER alice <new-personal-password>
```

Give the password to its owner through a separate trusted channel. On the new
account's first connection, run:

```text
/NS SET MULTICLIENT ON
/NS SET ALWAYS-ON TRUE
/NS SET AUTOREPLAY-MISSED ON
/NS SET AUTOREPLAY-LINES 100
/NS SET DM-HISTORY ON
/NS SET AUTO-AWAY ON
```

There is no approval queue because public registration is disabled.

## Register and transfer a channel

An authenticated user who creates and operates a channel can run:

```text
/JOIN #project
/CS REGISTER #project
```

An administrator can inspect and transfer registrations using:

```text
/CS INFO #project
/CS TRANSFER #project alice
```

`#general` and `#ops` are created and registered by bootstrap.

## Grant IRC operator access

Operator definitions are intentionally configuration-controlled.

1. Generate a distinct high-entropy password without placing it on a command
   line.
2. Hash it through `ghcr.io/ergochat/ergo:v2.19.0` using `ergo genpasswd`.
3. Add a new entry under `opers` in the ignored `config\ergo\ircd.yaml`.
4. Use `class: server-admin` only when full server control is intended.
5. Reload Ergo and test `/OPER newname password`.
6. Store the plaintext only in an access-controlled password manager.

Do not reuse the IRC account password as an operator password.

## Update images

1. Read both projects' release notes and configuration compatibility notes.
2. Back up the stack.
3. Change only the exact version tags in `compose.yaml`.
4. Pull and inspect versions:

```powershell
docker compose pull
docker compose run --rm --no-deps ergo --version
docker compose run --rm --no-deps thelounge --version
```

5. Validate and recreate:

```powershell
docker compose config --quiet
docker compose up -d
.\scripts\check.ps1 -Persistence
```

Do not replace pinned tags with `latest`.

## Roll back an update

Ergo database upgrades can be one-way even when the image tag is rolled back.
Use the pre-update backup:

1. Stop and remove the current containers without deleting bind mounts.
2. Restore the pre-update configuration and data.
3. Restore the old exact image tags.
4. Pull those tags and start.
5. Run the full persistence check.

Do not point an older image at a database already upgraded by a newer image
unless the release notes explicitly permit it.

## Back up persistent state

```powershell
.\scripts\backup.ps1
```

The script records running services, stops them for consistent SQLite files,
creates `backups\omen-irc-<UTC timestamp>.zip`, writes a manifest and SHA-256
file, and restores the previous running state.

To omit `.secrets` while still backing up databases and private TLS material:

```powershell
.\scripts\backup.ps1 -ExcludeSecrets
```

Both forms remain sensitive because `data\thelounge` may contain IRC network
credentials and `data\ergo` contains the TLS private key and chat history.

## Restore persistent state

1. Copy the selected archive and `.sha256` file to OMEN.
2. Verify the checksum:

```powershell
Get-FileHash -Algorithm SHA256 .\backups\omen-irc-<timestamp>.zip
```

3. Stop the stack:

```powershell
docker compose --env-file .env down
```

4. Move the current `.env`, `.secrets`, `config`, and `data` to a separate
   recovery directory; do not delete them until validation succeeds.
5. Extract the archive into the repository root.
6. Run `docker compose config --quiet`.
7. Start and validate:

```powershell
docker compose --env-file .env up -d
.\scripts\check.ps1 -Persistence
```

8. Confirm the manual Quassel test before deleting the recovery copy.

## Rotate secrets

### Ergo account password

While authenticated:

```text
/NS PASSWD <old-password> <new-password>
```

Update every Quassel and Lounge connection immediately. If rotating the initial
administrator account, update `AdminPassword` in `.secrets\bootstrap.json` so
automated authenticated checks continue to work.

### IRC operator password

Generate and hash a new password, replace `opers.admin.password` in the ignored
Ergo configuration, update only `OperPassword` in
`.secrets\bootstrap.json`, then reload Ergo. Test the new password and confirm
the old one fails before discarding recovery material.

### TLS certificate

Stop Ergo, move both `data\ergo\fullchain.pem` and
`data\ergo\privkey.pem` to a recovery directory, then run:

```powershell
docker compose run --rm --no-deps ergo mkcerts --conf /ircd/ircd.yaml --quiet
docker compose up -d ergo
.\scripts\check.ps1
```

Redistribute only the public certificate and fingerprint. Clients must replace
their old trust exception.

## Remove the stack without deleting data

```powershell
.\scripts\teardown.ps1
```

This removes containers and the Compose network while retaining all bind-mounted
state.

## Fully delete the stack and all local data

First make any required off-host backup, then:

```powershell
.\scripts\teardown.ps1 -Purge
```

The script requires typing `DELETE-OMEN-IRC`. For unattended deliberate
destruction, add `-Force`. Purge permanently removes the local environment,
credentials, generated configuration, databases, history, certificates,
Lounge users, and local backups.

## Manual acceptance test

1. Install Quassel Monolithic/Standalone on the first machine.
2. Connect to `omen.tail8e749c.ts.net:6697` with TLS and SASL.
3. Join `#general` and confirm `/CS INFO #general` shows it registered.
4. Send several uniquely identifiable messages.
5. Disconnect Quassel.
6. Add a personal Lounge user, configure the same Ergo SASL account, and send a
   message to `#general`.
7. Reconnect Quassel and confirm the missed message is replayed.
8. Install Quassel Monolithic on a second machine with the same Ergo account.
9. Confirm both clients remain connected with the same nickname.
10. Run `docker compose restart` on OMEN.
11. Reconnect and confirm account, `#general`, `#ops`, and message history.
12. Run `.\scripts\check.ps1 -Persistence` and retain its output with the
    operational record.
