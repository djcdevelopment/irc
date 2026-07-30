# Community onboarding acceptance evidence

Validated on AM4 on 2026-07-30. Secrets, one-time URLs, account passwords,
operator credentials, prompts, and completions are intentionally omitted.

## 1. Service and persistence checks

```text
$ sudo /opt/omen-irc/scripts/check-am4.sh --require-funnel
PASS: 19 checks passed

$ sudo /opt/omen-irc/scripts/check-am4.sh --require-funnel --persistence
PASS: 20 checks passed
PASS: account, registered channel, and history survived restart
```

All four Compose services were healthy: Ergo, The Lounge, community portal,
and BotHerder supervisor. Host publications were confined to loopback at
6667, 6668, 9000, and 9010.

## 2. One-time member onboarding

The administrator skill path generated a 24-hour, single-use HTTPS URL:

```text
$ .\scripts\invite-community.ps1 -DisplayName "Onboarding Acceptance"
Invitation URL: [omitted]
Expires UTC: [omitted]
```

Redeeming it through the public portal created a disposable member, their
chosen personal Herder, and a persistent private-mode Lounge profile. The
generated password was returned once and did not appear in logs. The profile
contained:

```text
host=ergo
port=6667
sasl=plain
channels=#general,#ops
```

Public trusted-TLS SASL login succeeded. The dynamically started Herder
answered its owner-scoped `status` command, and `usage` reported unavailable
provider token counts as `not reported`.

## 3. Local model and abuse controls

```text
$ sudo python3 /opt/omen-irc/scripts/acceptance-compute-bot-am4.py
PASS: authenticated acceptance session
PASS: seeded gpt-oss-120b model listed
PASS: non-empty gpt-oss-120b completion with 512-token floor
PASS: unknown model returned a friendly error
PASS: unauthenticated command produced no response
PASS: long output used 9 IRC-safe lines
PASS: largest non-tag IRC segment was 434 bytes
PASS: per-account rate limit returned a throttle notice
PASS: no configured secret appeared in channel output or logs
```

The final live run used `#bot-collab-test` so automated traffic did not flood
`#general`. The local and containerized BotHerder suites passed 25/25 tests,
including the 360-byte UTF-8 and worst-case IRC framing boundaries.

## 4. Personal remote agent

The community acceptance suite creates disposable identities and removes them
in a `finally` cleanup path:

```text
$ sudo python3 /opt/omen-irc/scripts/acceptance-community-am4.py
PASS: BotHerder created a private one-time agent invitation
PASS: redemption returned a dedicated non-oper SASL identity
PASS: outbound trusted-TLS adapter connected without an inbound port
PASS: addressed ask completed through remote compatible endpoint
PASS: provider-reported usage reached owner ledger
PASS: owner agent listing and revocation succeeded
```

The adapter used a temporary OpenAI-compatible endpoint. The provider key
remained on the adapter host; it was never uploaded to the portal or Herder.
The suite's cleanup path then offboarded the disposable owner, Herder, agent,
Lounge profile, and portal records.

## 5. Least privilege

```text
$ sudo /opt/omen-irc/scripts/check-compute-bot-am4.sh
PASS: BotHerder secret files are root-only
PASS: BotHerder has least-privilege secrets and read-only member records
PASS: BotHerder IRC handoff is loopback-only
PASS: model endpoint rejects unauthenticated requests
PASS: no configured IRC/model/operator secret appears in BotHerder logs
```

The BotHerder environment excludes registrar, operator, invite-admin, and
credential-encryption secrets. Its member-record mount is read-only; only the
separate metrics runtime directory is writable.

## 6. Migration

The legacy stateless `ComputeBot` container was removed. Its SASL identity was
suspended, and the primary owner-scoped session is now:

```text
owner=admin
herder=DereksBotHerder
```
