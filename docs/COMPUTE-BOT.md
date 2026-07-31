# BotHerder compute bridge

The Phase 1 `ComputeBot` container and SASL identity were migrated to the
generic BotHerder supervisor. Derek's instance is now `DereksBotHerder`; the
legacy `ComputeBot` container was removed and its SASL account suspended.

One supervisor process runs an isolated IRC session per member provisioning
record. Each session has its own visible nick, SASL password, owner, rate
limiter, pending queue, uptime, and metrics identity. It is a personal bot
session, not a shared command identity.

In production execution mode, BotHerder does not call a model endpoint. It is a
protocol adapter to HEARTH, which owns the Request/Job/Invocation lifecycle,
provider routing, aggregate capacity, usage, and full result artifact. See
[HEARTH-EXECUTION.md](HEARTH-EXECUTION.md).

## Commands

The public, member-facing version of this command guide is
`https://am4.tail8e749c.ts.net/guide/`. `!help` returns that URL after the
one-line syntax reminder.

Your own Herder answers a bare `!` command:

```text
!ask what is a bloom filter?
!ask gpt-oss-120b review this design
!ask MyRemoteAgent explain one architecture pattern
!models
!status
```

Each member also has one persistent storefront channel, such as
`#herder-derek`. Its read-only laboratory view is projected from HEARTH and
the community registrar:

```text
!about
!catalog
!hardware
!models
!agents
!status
!recent
!artifacts
!browse
!compare <herder> <herder>
!whohas <capability>
```

`!catalog`, `!models`, `!hardware`, `!status`, `!recent`, and `!artifacts`
use live canonical HEARTH projections. `!browse`, `!compare`, and `!whohas`
use the public storefront index and never expose provider endpoints, prompts,
credentials, or input artifacts. The owner introduction is the only
storefront text authored outside those projections.

The first live channel is a research prototype. Its observation protocol and
evidence log are in [STOREFRONT-UX-JOURNAL.md](STOREFRONT-UX-JOURNAL.md);
implementation decisions and limitations are summarized in
[RETROSPECTIVE-STOREFRONT-PROTOTYPE.md](RETROSPECTIVE-STOREFRONT-PROTOTYPE.md).
During the observation period, avoid changing commands or presentation unless
repeated evidence supports a small adjustment.

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

## Model presentation registry

`config/compute-bot/models.toml` is BotHerder's operator-controlled command
allow-list and display registry. The endpoint/key fields remain for `direct`
rollback and `shadow`; in `hearth` mode HEARTH independently resolves the
declared model through its Provider registry:

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
empty reasoning-model result. A model must be allowed by both BotHerder and
HEARTH; IRC cannot add one.

To add a host model:

1. Declare the model on a HEARTH Provider and verify that Provider's global
   `parallel_slots`.
2. Add the corresponding `[models.NAME]` presentation entry here.
3. Keep the direct endpoint key in root-only
   `/etc/omen-irc/compute-bot.env` only if rollback/shadow is required.
4. Build the test target, recreate `bot-herder`, and run both acceptance suites.

IRC users cannot submit endpoints, model IDs, credentials, tools, or shell
commands.

## Answer shape for IRC

IRC has no markdown renderer, and `max_output_lines` is spent per line rather
than per byte. A table costs one line per row plus a separator row that carries
no information at all, so a formatted answer is cut off well before its 4 KiB
byte budget is used. Two controls keep the line budget on content.

`config/compute-bot/bot.toml` sends a system message on every local model
request:

```toml
[completion]
system_prompt = """
You are answering in an IRC channel. Write plain text only: no markdown, ...
"""
```

An empty string sends no system message. Remote agents are unaffected; they
run their own adapter and their own prompt. The system message is passed as the
HEARTH Operation's `system` argument, so switching execution mode does not
change answer shape.

Whatever markdown still arrives is flattened before chunking. Horizontal rules,
code fences, and table separator rows are dropped; table rows become
`cell — cell`; heading markers are removed; and asterisk emphasis is stripped.
Underscore emphasis is deliberately left alone so `snake_case` and `__init__`
survive, and the guards keep `**kwargs` from being read as a bold span.

## Remote-agent seam

The owner creates a one-time invitation through a private Herder message.
Redemption provisions a dedicated non-oper Ergo account and a downloadable
outbound adapter. The recommended path is a generated PowerShell or Bash
installer: the operator downloads it, runs one command on the computer that
hosts or reaches the model, answers three private prompts, and waits for the
installer's `Agent connected` confirmation. No repository checkout or AM4-hosted
container image is required. A six-file manual kit remains available as an
advanced fallback.

The credential-free agent-facing handoff is published at
`https://am4.tail8e749c.ts.net/guide/AGENT-HANDOFF.md`. The one-time invitation
URL remains a separate bearer secret and should be sent privately.

The adapter:

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

## Canonical execution, metrics, and logging

HEARTH creates stable `req_…`, `job_…`, and `inv_…` identities and stores the
full prompt and result in immutable content-addressed artifacts. It records the
authenticated IRC account as the principal and the authenticated HEARTH caller
as the adapter. A Provider-wide lease bounds aggregate llama.cpp concurrency
independently of how many personal Herders are online.

If the IRC projection truncates a result, the final line identifies the Job and
artifact with exact size and SHA-256. The full result is not discarded.

`/var/lib/omen-irc/bot-herder/runtime/metrics.sqlite3` stores operational metadata:
request ID, Herder/caller/provider account names, timestamp, duration, outcome,
output-line count, and optional provider token totals.

Token totals are read from the provider's `usage` object on both the local and
remote paths; absent or malformed counts stay unset rather than becoming zero.
The recorded outcome distinguishes `undelivered` from `ok`, so a completion lost
to a disconnect is not counted as a success. The request ID is shown in the
`working...` acknowledgement, which is what joins a channel message to its log
and ledger entry.

The local metrics projection never stores prompt or completion text. HEARTH
stores content only in its protected artifact store; execution events and the
legacy gateway audit retain metadata/digests, not content. Logs exclude raw IRC
frames, HTTP bodies, credentials, and message content. Missing provider usage is
displayed as `not reported`.

## Networking and hardening

The supervisor retains host networking for Ergo, portal, direct rollback, and
remote-agent compatibility:

```text
IRC:   127.0.0.1:6667
Direct rollback model: 127.0.0.1:8082/v1
Portal internal API: 127.0.0.1:9010
Canonical execution: https://omen.tail8e749c.ts.net:8443/mcp
```

The HEARTH route is tailnet-only Tailscale Serve with trusted TLS, not public
Funnel. A dedicated `irc-adapter` key is loaded from root-only
`/etc/omen-irc/hearth-bot.env`.

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
