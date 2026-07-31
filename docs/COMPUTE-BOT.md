# BotHerder compute bridge

The Phase 1 `ComputeBot` container and SASL identity were migrated to the
generic BotHerder supervisor. Derek's instance is now `DereksBotHerder`; the
legacy `ComputeBot` container was removed and its SASL account suspended.

One supervisor process runs an isolated IRC session per member provisioning
record. Each session has its own visible nick, SASL password, owner, rate
limiter, pending queue, uptime, and metrics identity. It is a personal bot
session, not a shared command identity.

## Commands

Your own Herder answers a bare `!` command:

```text
!ask what is a bloom filter?
!ask gpt-oss-120b review this design
!ask MyRemoteAgent explain one architecture pattern
!models
!status
```

Naming a model or agent is optional. When the first word is not a known
provider, the whole line is the question and the configured `default_model`
answers it. The acknowledgement names whichever provider was chosen —
`working... (req 0b9660d1a495 via gpt-oss-120b)` — so a mistyped agent name is
visible rather than silently answered by the default model.

A bare `!` command is answered **only** by the Herder whose owner sent it, no
matter what `access_mode` says. That is what stops every member's Herder
replying to the same line in a shared channel.

To reach someone else's Herder, address it by nick:

```text
DereksBotHerder: ask what can you tell me about hofstadter?
```

Whether that is answered depends on the target Herder's `access_mode`:
`owner` accepts only its owner, `authenticated` accepts any authenticated
account. Unauthenticated messages are always ignored, based on the
server-supplied IRCv3 `account` tag.

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

Because the seam is any OpenAI-compatible endpoint, an agent framework that
serves one can join unchanged. See [HERMES-AGENT.md](HERMES-AGENT.md) for
Hermes Agent, which also documents why exposing an agent's API server to a chat
channel is a security decision and not only a configuration step.

## Abuse and resilience controls

Defaults per Herder:

- owner-only access;
- six requests per rolling minute;
- 2 KiB prompt;
- two concurrent and sixteen pending requests;
- 120-second local model timeout;
- 660-second remote-agent timeout, set above the adapter's own 600-second
  default so an agentic run reports the agent's specific error rather than this
  generic ceiling; a stuck request holds one pending slot for that long;
- 15 output messages / 4 KiB;
- 360-byte completion chunks, boundary-tested against the IRC 512-byte frame;
- allow-listed local models and registered active agents only.

Endpoint errors, disconnects, timeouts, invalid fragments, and empty responses
produce a short public error and do not terminate the IRC session.

## Metrics and logging

`/var/lib/omen-irc/bot-herder/runtime/metrics.sqlite3` stores operational metadata:
request ID, Herder/caller/provider account names, timestamp, duration, outcome,
output-line count, and optional provider token totals.

Token totals are read from the provider's `usage` object on both the local and
remote paths; absent or malformed counts stay unset rather than becoming zero.
The recorded outcome distinguishes `undelivered` from `ok`, so a completion lost
to a disconnect is not counted as a success. The request ID is shown in the
`working...` acknowledgement, which is what joins a channel message to its log
and ledger entry.

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
