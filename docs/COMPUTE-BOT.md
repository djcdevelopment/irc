# BotHerder compute bridge

The Phase 1 `ComputeBot` container and SASL identity were migrated to the
generic BotHerder supervisor. Derek's instance is now `DereksBotHerder`; the
legacy `ComputeBot` container was removed and its SASL account suspended.

One supervisor process runs an isolated IRC session per member provisioning
record. Each session has its own visible nick, SASL password, owner, rate
limiter, pending queue, uptime, and metrics identity. It is a personal bot
session, not a shared command identity.

## Commands

In a shared channel, explicitly address the Herder:

```text
DereksBotHerder: help
DereksBotHerder: models
DereksBotHerder: ask gpt-oss-120b <prompt>
DereksBotHerder: status
```

An unaddressed `!ask` is ignored. The default member configuration also ignores
commands from authenticated accounts other than its owner. Unauthenticated
messages are always ignored based on the server-supplied IRCv3 `account` tag.

Owner-only private commands:

```text
status
usage
agents
invite <agent-name>
revoke <agent-account>
```

## Local model registry

`config/compute-bot/models.toml` is the operator-controlled allow-list. The
seeded endpoint is AM4-local:

```toml
[models.gpt-oss-120b]
model_id = "gpt-oss-120b"
endpoint = "http://127.0.0.1:8082/v1"
api_key_env = "GPT_OSS_120B_API_KEY"
max_tokens = 512
min_max_tokens = 512
timeout_seconds = 120
description = "Local 120B reasoning model on AM4"
```

The effective output budget is never below `min_max_tokens`, preventing an
empty reasoning-model result.

To add a host model:

1. Add a `[models.NAME]` table with an `/v1` base URL.
2. Add its `api_key_env` value to root-only
   `/etc/omen-irc/compute-bot.env`.
3. Build the test target.
4. Recreate `bot-herder`.
5. Run both acceptance suites.

IRC users cannot submit endpoints, model IDs, credentials, tools, or shell
commands.

## Remote-agent seam

The owner creates a one-time invitation through a private Herder message.
Redemption provisions a dedicated non-oper Ergo account and a downloadable
outbound adapter. The adapter:

- verifies the public IRC certificate;
- authenticates with SASL PLAIN;
- accepts requests only from its registered Herder account tag;
- calls one operator-configured OpenAI-compatible endpoint;
- keeps the provider key on the remote host;
- returns chunked content and provider usage through `HERDER/1`; and
- reconnects with exponential backoff.

The transport caps both request and response fragments. BotHerder applies the
same 4 KiB/15-line public output ceiling to local and remote completions.

## Abuse and resilience controls

Defaults per Herder:

- owner-only access;
- six requests per rolling minute;
- 2 KiB prompt;
- two concurrent and sixteen pending requests;
- 120-second timeout;
- 15 output messages / 4 KiB;
- 360-byte completion chunks, boundary-tested against the IRC 512-byte frame;
- allow-listed local models and registered active agents only.

Endpoint errors, disconnects, timeouts, invalid fragments, and empty responses
produce a short public error and do not terminate the IRC session.

## Metrics and logging

`/var/lib/omen-irc/bot-herder/runtime/metrics.sqlite3` stores operational metadata:
request ID, Herder/caller/provider account names, timestamp, duration, outcome,
output-line count, and optional provider token totals.

It never stores prompt or completion text. Logs exclude raw IRC frames, HTTP
bodies, credentials, and message content. Missing provider usage is displayed
as `not reported`.

## Networking and hardening

The supervisor uses host networking only because the seeded AM4 model binds
host loopback:

```text
IRC:   127.0.0.1:6667
Model: 127.0.0.1:8082/v1
Portal internal API: 127.0.0.1:9010
```

The container runs as UID/GID 1000 with a read-only root filesystem, small
tmpfs, no capabilities, `no-new-privileges`, and CPU/memory/PID limits. Member
provisioning records are mounted read-only; a separate runtime bind contains
only the metrics database. The container receives only its model key, own SASL
password, and portal internal token.

## Validate

```bash
sudo docker build --target test \
  -t omen-irc-bot-herder:test /opt/omen-irc/services/compute-bot
sudo /opt/omen-irc/scripts/check-compute-bot-am4.sh
sudo python3 /opt/omen-irc/scripts/acceptance-compute-bot-am4.py
sudo python3 /opt/omen-irc/scripts/acceptance-community-am4.py
```

The second acceptance suite provisions a disposable member, personal Herder,
and remote agent, exercises them, then offboards the test member automatically.

Future throughput, queue, multiline, remote-fragment, and artifact work is
tracked in [COMPUTE-BOT-LIMITS-TODO.md](COMPUTE-BOT-LIMITS-TODO.md). Parser
maxima are not operating recommendations.
