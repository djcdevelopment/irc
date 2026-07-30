# ComputeBot Phase 1 acceptance evidence

> Historical acceptance record for the original single `ComputeBot`.
> Production subsequently migrated to owner-scoped BotHerders and suspended
> this legacy identity. Current evidence is in
> [COMMUNITY-ONBOARDING.md](COMMUNITY-ONBOARDING.md) and
> [COMPLETION-REPORT.md](COMPLETION-REPORT.md).

Acceptance was run on AM4 on 2026-07-30 UTC against the deployed
`omen-irc-compute-bot:1.0.0` image. Values below are sanitized; no prompt,
password, API key, Authorization header, or private IRC frame capture is
stored.

The test image executed 20 unit tests covering configuration validation,
reasoning-token floors, HTTP authentication and response handling, IRCv3
account parsing, authenticated channel invitations, unauthenticated silence,
rate limits, prompt limits,
non-blocking inference, UTF-8 chunking, and output caps:

```text
Ran 20 tests
OK
```

## Deployment and host validation

Command:

```bash
sudo /opt/omen-irc/scripts/check-am4.sh \
  --require-funnel --persistence
```

Selected output:

```text
PASS: ergo is running, healthy, and not restart-looping
PASS: thelounge is running, healthy, and not restart-looping
PASS: compute-bot is running, healthy, and not restart-looping
PASS: Host ports 6667, 6668, and 9000 are loopback-only; 6697 is not published
PASS: Tailscale Funnel has an IRC entry on port 8443
PASS: Account, registered channels, and message history survived restart
PASS: ComputeBot secret file is root-only
PASS: Model chat endpoint rejects unauthenticated requests
PASS: ComputeBot SASL-registered with Ergo
PASS: No configured IRC/model/operator secret appears in ComputeBot logs
PASS: ComputeBot appears in #general
14 checks passed.
```

After the check restarted the stack:

```text
compute-bot  omen-irc-compute-bot:1.0.0             healthy
ergo         ghcr.io/ergochat/ergo:v2.19.0          healthy
thelounge    ghcr.io/thelounge/thelounge:4.5.2      healthy
```

`ComputeBot` is absent from Ergo's operator configuration.

## Live command acceptance

Command:

```bash
sudo /opt/omen-irc/scripts/acceptance-compute-bot-am4.py
```

Sanitized transcript:

```text
PASS 1: authenticated acceptance client connected to Ergo
TRANSCRIPT models: admin: gpt-oss-120b — Local 120B reasoning model on AM4
PASS 2: !models returned the seeded allow-list
TRANSCRIPT ask-ack: admin: working…
TRANSCRIPT ask-result: admin: One well-known software architecture pattern is Model-View-Controller (MVC).
PASS 3: gpt-oss-120b returned a non-empty completion
TRANSCRIPT unknown: admin: unknown model 'no-such-model'; use !models
PASS 4: unknown model returned a friendly error
PASS 5: unauthenticated command received no bot response
PASS 7: long output was chunked into 10 safe IRC lines
TRANSCRIPT throttle: admin: rate limit reached; retry in about 26s
PASS 6: per-account rate limit produced a throttle notice
PASS 9: no configured secret appeared in captured channel output
```

The long-output assertion checks every complete server-to-client frame,
including Ergo's prefix and IRCv3 tags, is at most 512 bytes. It also checks the
completion contains no more than 15 bot output messages.

The unauthenticated test connects from inside the Ergo container through its
explicit localhost SASL exemption, joins `#general`, and sends a uniquely
marked `!ask`. The authenticated observer sees the command and confirms no
ComputeBot response during the acceptance window.

## Endpoint loss and recovery

The coordinated test submitted an inference request, waited for `working…`,
stopped the existing `b70-moe.service`, and retained the same IRC connection:

```text
TRANSCRIPT disruption-ack: admin: working…
TRANSCRIPT endpoint-down: admin: the model endpoint is unavailable; try again later
PASS 8a: endpoint loss returned a graceful error; bot stayed connected
```

The cleanup path restarted `b70-moe.service`. Readiness was required to return
HTTP 200, not merely accept TCP connections. The authoritative recovery check
was:

```bash
sudo /opt/omen-irc/scripts/acceptance-compute-bot-am4.py --recovery-only
```

Output:

```text
TRANSCRIPT recovery-result: admin: One widely used software architecture pattern is Model-View-Controller (MVC).
PASS 8b: restarted endpoint completed the next request
```

An earlier development version of the harness treated an endpoint error as a
completion after TCP opened but `/health` still returned 503. That result was
discarded. The checked-in harness now requires HTTP health 200 and explicitly
rejects all error-shaped recovery responses.

## Secret and exposure audit

The final audit compared the actual values from the two protected AM4 secret
files against ComputeBot logs, captured channel output, and readable files
under `/opt/omen-irc`. It reports only pass/fail and never prints a value:

```text
No configured IRC/model/operator secret appears in ComputeBot logs
PASS 9: no configured secret appeared in captured channel output
REPOSITORY_SECRET_SCAN=PASS
```

Listening sockets:

```text
127.0.0.1:6667  ComputeBot → Ergo
127.0.0.1:6668  Tailscale Funnel → Ergo
127.0.0.1:9000  operator SSH tunnel → The Lounge
```

No AM4 listener exists on host port 6697. Public IRC remains
`am4.tail8e749c.ts.net:8443`, and the gallery's existing Funnel HTTPS route
continues independently.

Approximate post-restart memory observed with `docker stats --no-stream`:

```text
Ergo        13.72 MiB
The Lounge  38.35 MiB
ComputeBot  27.14 MiB
```

## Acceptance matrix

| Criterion | Result |
|---|---|
| Compose starts bot; SASL joins `#general` | Pass |
| `!models` lists seeded model | Pass |
| Real 120B inference is non-empty at effective `max_tokens=512` | Pass |
| Unknown model is friendly and bot remains healthy | Pass |
| Unauthenticated user receives no response | Pass |
| Per-account rate limit produces throttle notice | Pass |
| Long response is safely chunked and capped | Pass |
| Endpoint loss is graceful; recovery request succeeds | Pass |
| No configured secret in logs, channel capture, or repository | Pass |
