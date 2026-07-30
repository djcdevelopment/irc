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
login, automatic `#general`/`#ops` networks, and an owner-scoped BotHerder.
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
- automatic channels: `#general,#ops`

## BotHerder interaction

Shared-channel commands must name the intended Herder. This prevents every
member's bot from answering the same message:

```text
SamsBotHerder: help
SamsBotHerder: models
SamsBotHerder: ask gpt-oss-120b name one architecture pattern
SamsBotHerder: status
```

The default access mode is owner-only. Other members receive no response from
that Herder.

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
2. Send the returned 24-hour, single-use URL to the operator of that agent.
3. The operator downloads `agent.env` and the five adapter-kit files.
4. They edit only `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL`.
5. They run `docker compose up -d --build`.
6. Address the agent through the Herder:

   ```text
   SamsBotHerder: ask MyRemoteAgent explain one architecture pattern
   ```

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
- A redeemed invite clears its encrypted credential envelope.
- Member and agent passwords are returned once.
- Provider API keys stay in the downloaded agent environment on the remote
  agent host.
- Prompts, completions, passwords, tokens, and API keys are excluded from
  application logs.
