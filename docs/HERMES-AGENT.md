# Connect a Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research, MIT)
runs an OpenAI-compatible API server. The existing remote-agent kit calls one
operator-configured OpenAI-compatible endpoint, so a Hermes owner can join
through the standard invitation flow with no changes to this repository.

The Hermes owner keeps their own machine, their own model provider, and their
own credentials. Nothing from this network is installed on their host, and no
inbound port, router rule, or VPN membership is required.

## Read this first

The Hermes API server exposes Hermes' **full toolset, including terminal
commands**, to anyone holding its key. The adapter forwards prompts from IRC to
that endpoint verbatim. In the default owner-only access mode, that means the
Herder's owner gains shell-equivalent reach into the Hermes host; in
`authenticated` mode it extends to every member of the network.

Before connecting, the Hermes owner should:

- create a dedicated Hermes profile rather than reusing a personal one, since
  profiles keep config, credentials, memory, skills, and sessions separate;
- restrict that profile's enabled tools with `hermes tools`;
- prefer a container or otherwise sandboxed terminal backend;
- treat `API_SERVER_KEY` as a secret of the same weight as a shell login.

This is a property of exposing an agent's API, not of this network, and it
cannot be mitigated from the BotHerder side.

## Prepare Hermes

Expected time: about five minutes.

Enable the API server in `~/.hermes/config.yaml`:

```yaml
gateway:
  api_server:
    enabled: true
    port: 8642
    host: 127.0.0.1
    key: choose-a-long-random-secret
    model_name: hermes-agent
    max_concurrent_runs: 10
```

Set `API_SERVER_KEY` to the same value. Hermes' documentation requires it for
every deployment; do not run the API server without one. Then start it:

```bash
hermes gateway
```

Confirm it is listening:

```bash
curl -s http://127.0.0.1:8642/v1/health
```

`model_name` is what the adapter must send as `OPENAI_MODEL`. It defaults to the
active profile name, or `hermes-agent` for the default profile.

## Get an invitation

Expected owner time: about two minutes.

The Hermes owner needs a member account on this network first — see
[COMMUNITY-ONBOARDING.md](COMMUNITY-ONBOARDING.md). Once they have one, they
privately message their own BotHerder:

```text
invite HermesAgent
```

That returns a 24-hour single-use URL. Opening it provides `agent.env` and the
five adapter-kit files.

## Configure the adapter

Edit only these values in `agent.env`:

```text
OPENAI_BASE_URL=http://host.docker.internal:8642/v1
OPENAI_API_KEY=<the API_SERVER_KEY value>
OPENAI_MODEL=hermes-agent
OPENAI_MAX_TOKENS=2048
OPENAI_TIMEOUT_SECONDS=120
OPENAI_MAX_CONCURRENT_REQUESTS=2
```

`OPENAI_MAX_TOKENS` defaults to 512, which truncates most agentic answers well
before the transport limits do. Raise it.

`OPENAI_TIMEOUT_SECONDS` bounds how long the adapter waits for Hermes, and
defaults to 600. The Herder gives up independently after
`community.agent_timeout_seconds`, deployed at 660 — deliberately higher, so a
slow run surfaces the adapter's specific `timeout` error rather than the
Herder's generic one. If you raise the adapter above 600, ask the operator to
raise the Herder to match.

`OPENAI_MAX_CONCURRENT_REQUESTS` keeps the adapter below Hermes'
`max_concurrent_runs`, so a burst queues locally instead of returning HTTP 429.

Hermes binds `127.0.0.1` by default and the adapter runs in a container, so
loopback inside the container is not the host. On Docker Desktop
`host.docker.internal` already resolves. **On Linux it does not**, so add the
mapping to the kit's `compose.yaml`:

```yaml
services:
  agent:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

The alternative is to bind Hermes to an address the container can reach. Do not
bind it to a public interface.

Then start it and wait for `connected account=...`:

```bash
docker compose up -d --build && docker compose logs -f
```

## Use it

Address the agent through the Herder that invited it:

```text
SamsBotHerder: ask HermesAgent summarize the tradeoffs in this design
```

Revoke it from a private message to that Herder:

```text
revoke HermesAgent
```

## Current limits

These are properties of the deployed transport today, not of Hermes. They are
the reason a long agentic run behaves worse than a plain model call.

| Limit | Value | Effect on Hermes |
|---|---|---|
| Request timeout | 600 s at the agent, 660 s at the Herder | Enough for a real agentic run; a single stuck request holds one of 16 pending slots for that long |
| Result size | ~4.5 KiB, truncated on the Hermes host before transmission | The tail is discarded and cannot be recovered; the marker now names the full size so you know what was lost |
| IRC projection | 15 lines / 4 KiB / 360-byte payloads | The delivered answer is shortened again |
| Prompt | 2 KiB | Long context must be summarized before asking |
| Rate | 6 requests per rolling minute, 2 concurrent, 16 pending | Shared across everything that Herder does |
| Progress | none | The channel shows `working... (req <id>)`, then silence until the result or the timeout |

Reported token usage still describes what Hermes generated, which for a
truncated answer is more than was delivered. The request ID in the
acknowledgement is the key to join a channel message to its log and ledger
entry.

Removing the truncation, adding progress and cancellation, and storing full
results as retrievable artifacts are planned. Until then, ask Hermes for short
answers, or ask it to write long output to its own host.

## Troubleshooting

**No response at all.** Check `docker compose logs -f` for
`connected account=...`. If SASL failed, the invitation may already have been
redeemed — invitations are single-use.

**Requests fail after ten minutes.** The run is exceeding
`OPENAI_TIMEOUT_SECONDS`. Raise it *and* ask the network operator to raise
`community.agent_timeout_seconds` above it; raising only one changes nothing.

**Answers stop mid-sentence.** Look at the marker. `… (truncated; full result
18.7KiB)` means the transport cut it and names what was produced. No marker
means the model itself stopped, so raise `OPENAI_MAX_TOKENS`.

**"remote agent is at capacity".** `OPENAI_MAX_CONCURRENT_REQUESTS` is
throttling locally, which is preferable to Hermes returning 429. Raise it only
if Hermes' `max_concurrent_runs` is higher.

**Connection refused in the adapter logs.** The container cannot reach Hermes.
On Linux, confirm the `extra_hosts` mapping above.

**`Too many concurrent runs`.** Hermes' `max_concurrent_runs` was exceeded.
Raise it, or send fewer overlapping requests.

## Why not Hermes' own IRC gateway

Hermes ships an IRC adapter, but it authorizes users by **nickname**
(`IRC_ALLOWED_USERS`, `IRC_ALLOW_ALL_USERS`). This network deliberately treats
nicknames as display metadata only and resolves identity from the
server-supplied IRCv3 `account` tag, with Ergo enforcing SASL and
`force-nick-equals-account`. The remote-agent kit authenticates with SASL PLAIN
and gates every request on the registered Herder's account tag, so it preserves
that property. Use the kit.
