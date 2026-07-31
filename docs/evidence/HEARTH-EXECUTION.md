# HEARTH execution migration evidence

Sanitized evidence captured 2026-07-30/31. No prompt, completion body, password,
bearer key, caller key, or private artifact content is included.

## Revisions deployed

```text
commandcenter master: fda59351a6f74e9d9ab5bdec541f15a88af2eddd
irc master:           891b663b0e208d5387cf494e251f83060b8899b1
```

Both equal their respective `origin/master`. Commandcenter retained unrelated
uncommitted builder work; the execution commits did not stage or overwrite it.
The IRC worktree was clean.

## Automated suites

```text
HEARTH:    Ran 774 tests in 25.892s — OK
BotHerder: Ran 60 tests in 4.090s — OK
Container: Ran 60 tests in 0.552s — OK
```

Coverage includes event/schema validation, append/replay, projection rebuild,
artifact integrity, shared leases, idempotency, cancellation, restart recovery,
direct/delegated ownership, exact trusted-host policy, audit redaction, MCP
adapter behavior, and IRC projection boundaries.

## Private route

OMEN:

```text
https://omen.tail8e749c.ts.net:8443 (tailnet only)
|-- / proxy http://127.0.0.1:8710
```

The unrelated existing port-443 route remains Funnel-backed. Port 8443 is
explicitly reported as `tailnet only`. From AM4:

```text
GET /healthz → {"status":"ok"}
/etc/omen-irc/hearth-bot.env → root:root 0600
```

HEARTH remained bound only to `127.0.0.1:8710`.

## Shadow migration

BotHerder ran in `shadow` mode before cutover. The existing direct answer path
remained active while HEARTH received only a content-free plan. Six observed
entries resolved identically:

```text
provider=am4-moe model=gpt-oss-120b dispatch=False
```

No shadow call dispatched inference.

## Canonical live acceptance

The AM4 read-only check passed all nine controls:

```text
PASS healthy/no restart loop
PASS root-only secret files
PASS least-privilege container state
PASS private HEARTH plan path
PASS loopback-only IRC handoff
PASS unauthenticated model request rejected
PASS SASL registration
PASS no configured secret in BotHerder logs
PASS visible in #general
```

The canonical IRC suite then passed:

```text
authenticated IRC client connected
!models returned gpt-oss-120b
explicit !ask returned non-empty Model-View-Controller answer
bare !ask routed to default model
unauthenticated command received no response
long output chunked into 7 lines; largest message segment 175 bytes
rate-limit overflow returned throttle notice
no configured secret appeared in channel output
```

The final production mode is `hearth`.

## Provenance regression and fix

A human asked the completion whether HEARTH was in the loop. The model guessed
wrong because a language model cannot observe its transport. The permanent
focused acceptance now checks both deterministic and generated provenance:

```text
status: DereksBotHerder ... execution=hearth
ack:    working... (req d9b75302a01c via gpt-oss-120b through HEARTH)
answer: We used HEARTH for this request.
        For the live execution mode, check with !status.
PASS: deterministic acknowledgement and generated answer agree on HEARTH
```

`!status` and the acknowledgement are authoritative. Generated prose receives a
non-secret execution-context system message but remains explanatory.

## Execution Ledger and artifacts

At capture time:

```text
delegated BotHerder jobs:        11
succeeded:                       10
failed:                           1
result artifacts SHA-verified:   10
gateway delegated submissions:  11
latest prompt in audit preview:  null
latest prompt metadata visible:  yes
```

Latest successful canonical projection:

```text
request:    req_b2de6a87a5c740fcc58fbbcd8c3602c2
job:        job_ee0df8820dbe35a80bf5f83546b5f60a
invocation: inv_5aaf16fea3723399cce624eee47329ef
artifact:   art_f34913ddee55b8e4ee8ee6295be43805
principal:  irc_account/admin (authenticated)
source:     irc via botherder-am4
provider:   am4-moe
model:      gpt-oss-120b
usage:      211 input / 107 output tokens
status:     succeeded
```

Every result artifact was read through the integrity-verifying store. The one
failed Job is retained rather than hidden:

```text
reason: provider returned no visible output
usage:  156 input / 512 output tokens
```

The reasoning model exhausted the unchanged 512-token budget before visible
content on one long acceptance prompt. BotHerder stayed connected, the failure
was explicit, and subsequent requests succeeded. The earlier limits decision
left token budget unchanged; tuning it remains separate work.

Execution state footprint at capture:

```text
events.ndjson       65,303 bytes
projection.sqlite  155,648 bytes
coordination.sqlite 16,384 bytes
artifact objects     2,507 bytes
```

## Runtime footprint

```text
Ergo                 12.28 MiB
The Lounge           50.36 MiB
Community portal     13.49 MiB
BotHerder            53.39 MiB
HEARTH gateway       122.4 MiB working set
```

All four AM4 containers were healthy. The deployment was left running.

