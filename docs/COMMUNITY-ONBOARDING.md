# Community onboarding

## Administrator: invite a friend

Expected administrator time: under one minute.

```powershell
cd C:\work\irc
.\scripts\invite-community.ps1 -DisplayName "Sam"
```

The command returns a single-use link with a 24-hour UTC expiry. Send it
privately. The registrar token and operator credentials stay on AM4.

The same action is installed as the Codex skill `$invite-irc-community`.

## Friend: accept the invitation

Expected friend time: about two minutes in a browser, or another five minutes
to add Quassel.

1. Open the one-time URL.
2. Choose an IRC account name.
3. Choose the visible name of the personal BotHerder.
4. Optionally enter a display name.
5. Create the account and save the one-time password.
6. Click **Open the browser lobby** and log in with that account/password.
7. Send the proof command shown by the portal.

The completed outcome is a personal Ergo SASL identity, persistent Lounge
login, automatic `#general`/`#ops` channels, a persistent
`#herder-<display-name>` storefront, and an owner-scoped BotHerder. The
storefront channel name is derived by lowercasing the display name, replacing
non-alphanumeric runs with hyphens, and prefixing `#herder-`.
The same account password is used for Ergo SASL and the member's private Lounge
login; they are not separate credentials.
Steam/OpenID recovery binding is not implemented yet and is clearly labeled as
a future phase.

The same credential works in Quassel Monolithic/Standalone:

- host: `am4.tail8e749c.ts.net`
- port: `8443`
- TLS and certificate verification: enabled
- nickname and SASL account: the chosen IRC name
- SASL password: the one-time displayed password
- automatic channels: `#general,#ops,#herder-<display-name>`

The public member guide is available before or after login:

`https://am4.tail8e749c.ts.net/guide/`

A credential-free Markdown handoff for a member's coding agent is:

`https://am4.tail8e749c.ts.net/guide/AGENT-HANDOFF.md`

## BotHerder interaction

The same commands, examples, private controls, remote-agent setup, limits, and
troubleshooting steps are presented as a mobile-friendly webpage at
`https://am4.tail8e749c.ts.net/guide/`. The bot also returns this link from
`!help`.

The member's `#herder-<display-name>` channel is the persistent storefront for
read-only catalog, hardware, model, agent, status, recent-activity, and artifact
views. The complete storefront command list and its HEARTH projection boundary
are documented in [COMPUTE-BOT.md](COMPUTE-BOT.md).

Your own Herder answers bare `!` commands. You may also name the intended
Herder explicitly:

```text
!help
!models
!ask name one architecture pattern
!status
SamsBotHerder: help
SamsBotHerder: models
SamsBotHerder: ask gpt-oss-120b name one architecture pattern
SamsBotHerder: status
```

A bare command is answered only by the sender's personal Herder. The default
access mode is owner-only, so other members also receive no response when they
explicitly address that Herder.

Send private administrative commands with `/msg SamsBotHerder ...`:

```text
help
status
usage
agents
invite MyRemoteAgent
revoke sam-myremoteagent
```

`usage` reports request counts and provider token totals. If a provider did not
return usage, the result says `not reported`; it never fabricates zero.

## Add a remote agent

Expected owner time: about five to fifteen minutes.

1. Privately send `invite <agent-name>` to the personal BotHerder.
2. Open the returned 24-hour, single-use URL **on the computer that will run
   the agent**. That machine must host or reach the model endpoint and remain
   online.
3. Review the identity and click **Provision this agent**. The installer
   buttons appear on the resulting success page, not on the general guide.
4. Click **Download PowerShell installer** on Windows or **Download Bash
   installer** on macOS/Linux.
5. Open PowerShell or Terminal on that same computer. Copy the single command
   displayed directly below the button and run it.
6. The installer privately prompts for the OpenAI-compatible base URL, model
   ID, and provider key. It downloads the small kit, creates a private
   `~/OmenAgent/ACCOUNT` directory, validates and starts Compose, waits for IRC,
   and removes its credential-bearing downloaded copy after success.
7. Send the exact test message printed by the installer:

   ```text
   SamsBotHerder: ask MyRemoteAgent explain one architecture pattern
   ```

No repository checkout or Docker image download from AM4 is required. Docker
builds the small adapter locally from its pinned base image. For a model on the
same computer, use `http://host.docker.internal:PORT/v1`; container-local
`127.0.0.1` and `localhost` are incorrect.

The setup page retains the six-file manual process under an **Advanced**
disclosure, and the downloaded `RUNBOOK.md` contains the complete fallback.

The adapter opens outbound trusted-TLS IRC. No inbound port, router rule, VPN
membership, or provider-key upload is needed. Each agent gets its own non-oper
SASL identity. Registration count is unlimited; existing per-owner rate,
queue, timeout, prompt, and output caps remain the abuse boundary.

## Offboard a member

This suspends the member, their Herder, and active agent identities, then
removes the member's portal, Lounge, and dynamic-Herder state. The primary
`admin` / `DereksBotHerder` pair is protected from this command.

```powershell
$owner = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("Sam"))
$herder = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes("SamsBotHerder")
)
ssh am4 sudo /opt/omen-irc/scripts/community-admin.sh `
    offboard-member $owner $herder
```

Create a backup before offboarding a real member if their browser history may
be needed.

## Data and credentials

- Invite tokens are stored only as SHA-256 hashes.
- Generated credentials are encrypted with AES-256-GCM only while a failed
  provisioning attempt remains recoverable.
- After a rejected name, a retry uses the names from the new submission. A name
  whose IRC account the attempt already created keeps its password and stays
  fixed; the portal locks that field and says why.
- A redeemed invite clears its encrypted credential envelope.
- Member and agent passwords are returned once.
- Provider API keys stay in the downloaded agent environment on the remote
  agent host.
- Prompts, completions, passwords, tokens, and API keys are excluded from
  application logs.
