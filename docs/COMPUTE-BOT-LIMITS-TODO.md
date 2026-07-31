# BotHerder limits: tested boundary and future gates

This document separates the one low-risk payload adjustment from future
throughput and bulk-data work. Parser maxima in `config.py` are mechanical
ceilings, not operating recommendations.

## Gate A: IRC payload boundary (validated)

`irc_payload_bytes = 360` was boundary-tested and adopted on 2026-07-30, with
all other deployed limits unchanged:

```toml
[limits]
requests_per_minute = 6
max_prompt_bytes = 2048
max_output_bytes = 4096
max_output_lines = 15
irc_payload_bytes = 360
max_concurrent_requests = 2
max_pending_requests = 16
```

Automated boundary coverage proves:

- a 360-byte chunk containing multi-byte UTF-8 is not split or corrupted;
- a 32-character requester nickname and 64-character channel fit without
  `_reply` clipping the content;
- every emitted client-to-server IRC frame remains at or below 512 bytes; and
- `_send_raw` accepts an exact 512-byte frame and rejects 513 bytes.

The local and containerized suites passed 25 tests. Live acceptance through
Ergo produced a nine-line Unicode completion whose largest non-tag message
segment was 434 bytes. The live test also passed allow-list, authentication,
rate-limit, and secret-disclosure checks; the read-only AM4 check passed 8/8.
Acceptance traffic uses `#bot-collab-test` instead of `#general`.

IRCv3 message tags have their own size budget; the non-tag message segment
remains subject to 512 bytes and is measured separately. The acceptance
harness enforces both budgets. See the
[IRCv3 message-tags specification](https://ircv3.net/specs/extensions/message-tags.html).
No output-byte, line, RPM, concurrency, prompt, or pending-depth increase
belongs in Gate A.

## Gate B: required before throughput increases

Done on 2026-07-30:

- Rate-limit capacity is consumed only after prompt and provider validation, so
  a mistyped model name no longer costs a slot.
- HERDER/1 requests above the adapter's 64-fragment limit are rejected with an
  explicit `too_large` error instead of being dropped into a timeout.
- The adapter bounds its own concurrency (`OPENAI_MAX_CONCURRENT_REQUESTS`) and
  expires incomplete fragment buffers, which previously leaked.
- A delivery failure is recorded as `undelivered` rather than `ok`.

Future TODO:

- Add a supervisor-level global scheduler/semaphore and shared `ModelClient`.
- Verify the actual llama.cpp `--parallel` slot count on port 8082.
- Bound aggregate concurrency independently from per-Herder limits.
- Add PONG priority or paced output lines.
- Expose `queued_at`, queue position, estimated start, dispatch time, and
  execution deadline.
- Include `working`, errors, help, models, status, and agent listings in the
  practical 70–90-line-per-minute IRC budget.
- Reap inactive rate-limiter account entries.
- Ensure retries and reconnects cannot duplicate backend work.

Do not raise RPM, concurrency, or pending depth before this gate.

`community.agent_timeout_seconds` was raised from 120 to 660 on 2026-07-30 so
agentic remote agents can finish. This is a timeout, not a throughput increase,
so it does not breach the gate — but it lengthens the window in which pending
slots stay occupied, and it widens the window in which a completed result can be
lost to a reconnect. Both arguments for doing the artifact work in Gate C.

## Gate C: required before larger prompts or responses

Future TODO:

- Add IRC multiline or an explicit prompt-continuation protocol.
- Remove or redesign the adapter's approximately 4,500-byte result truncation.
- Define identical truncation behavior for local and remote execution.
- Fail fragmentation overflow explicitly instead of waiting for timeout.
- Add an access-controlled artifact store for bulk input and output.

For a large result, IRC should carry only completion state and a concise
summary. The artifact record should include its identifier, authorized
location, media type, exact size, SHA-256 digest, expiry, and retention policy.

```text
DereksBotHerder: job=184 complete
DereksBotHerder: summary: three concurrency defects found
DereksBotHerder: artifact=art_01K... media=text/markdown
DereksBotHerder: size=18.7KiB sha256=4f9c...
```

## Invariants

- Reserve framing/formatting overhead inside
  `max_output_lines * irc_payload_bytes`.
- Keep practical emitted traffic below the 70–90-line/minute operating budget,
  not Ergo's approximate 120-line/minute mechanical ceiling.
- Keep per-session concurrency at or below verified llama.cpp slots.
- Bound aggregate global concurrency separately.
- Treat higher `max_tokens` as both a size and service-time increase.
- Do not let retries or queued work silently multiply backend execution.
