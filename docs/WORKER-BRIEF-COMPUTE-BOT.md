# Worker Brief — IRC Compute-Bridge Bot (Phase 1)

> Historical implementation brief. It records the original Phase 1 target,
> not the current production topology. The deployed system uses one
> owner-scoped BotHerder per member, public trusted TLS through Tailscale
> Funnel on port 8443, a one-time onboarding portal, and outbound remote-agent
> adapters. See [COMPUTE-BOT.md](COMPUTE-BOT.md) and
> [COMMUNITY-ONBOARDING.md](COMMUNITY-ONBOARDING.md).

## Objective
Add a bot to the AM4 IRC network that lets **authenticated** members run local LLM
inference from chat. The bot is the bridge between the IRC social layer and the local
model endpoints. It is thin by design: it enforces an allow-list and rate limits and
delegates the actual inference to already-running OpenAI-compatible endpoints on the
same host.

## Environment (self-contained — do not assume anything not stated here)
- **Host:** AM4 (Ubuntu). Runs BOTH the IRC stack and the model endpoints — everything
  is local to this box; no cross-machine calls are needed for Phase 1.
- **IRC stack (already deployed):** Ergo IRC server + The Lounge web client, Docker
  Compose. Exposed publicly via Caddy + public-IP funnel (HTTPS). **Registration is
  closed** — accounts are operator-provisioned; auth is **SASL PLAIN**. Channels:
  `#general`, `#ops`. Ergo's internal (in-compose) plaintext port is `ergo:6667`; the
  TLS host port is `6697`.
- **Model endpoints (already running, local, OpenAI-compatible):**
  - **PRIMARY:** model id `gpt-oss-120b` at `http://127.0.0.1:8082/v1`, bearer-key auth
    (key supplied via env — see Secrets; it is the existing :8082 endpoint key).
    ⚠ **This is a reasoning model**: it spends output budget on hidden reasoning, so a
    request with a small `max_tokens` returns **empty** visible content. Always send a
    generous `max_tokens` (**≥512**).
  - The registry MUST be extensible: the operator will add more models (e.g. single-card
    tenants on `:8080`/`:8081`, oxen on `:8090`) by editing config — **no code change**.

## Deliverable (Phase 1 ONLY)
A **Python IRC bot**, packaged as a **new service in the existing docker-compose stack**,
on the same internal Docker network as Ergo. Connect to `ergo:6667` (plaintext, internal
only — no TLS/cert handling needed inside the compose network).

### Commands (respond in `#general` and any channel the bot is invited to)
- `!help` — one-line usage.
- `!models` — list allow-listed models as `name — short description`.
- `!ask <model> <prompt>` — call that model's endpoint and post the completion back.
  Acknowledge with a brief "working…"; tolerate multi-second latency without blocking
  other users' commands (async/threaded).

### Config (operator-editable, no code changes)
- **Models registry** (TOML or YAML): each entry = `name`, `endpoint` (…/v1),
  `api_key_env` (name of the env var holding the bearer key), default `max_tokens`,
  `description`. Ship it **seeded with the `gpt-oss-120b` entry** (max_tokens 512).
- **Bot/IRC config:** server host (`ergo`), port (`6667`), bot nick, SASL account +
  password (from env/secret), list of channels to join.

### Constraints & security (REQUIRED — the network is now publicly funneled)
- **Authenticated-only:** the bot MUST ignore commands from users not logged in to a
  SASL account (check the sender's IRCv3 `account`). Unauthenticated → no response. This
  is the primary abuse gate now that the login is public.
- **Allow-list only:** only registry models are callable; unknown model → friendly
  error, never a crash.
- **Per-account rate limit:** cap requests/minute per account (configurable; default
  ~6/min); over-limit → a polite throttle notice.
- **Input caps:** max prompt length; reject or truncate over-long prompts.
- **Reasoning-model floor:** enforce the configured `max_tokens` (≥512 for
  `gpt-oss-120b`) so replies are never empty.
- **Output handling:** IRC lines cap ~512 bytes — chunk long completions into multiple
  lines with a sane overall cap (e.g. ~15 lines / ~4 KB then `…(truncated)`), or post to
  a paste service and link it. Never flood the channel.
- **Timeouts & resilience:** per-request model timeout (e.g. 120 s) with a clear timeout
  message; auto-reconnect to IRC on disconnect; a down or erroring endpoint yields a
  graceful error, never a crash.
- **Secrets:** API keys and the bot's SASL password come from env/secret files —
  **never** hardcoded, logged, or echoed to a channel. Scrub logs of message content and
  credentials.

### Provisioning
- Provision a **dedicated, non-oper SASL account** for the bot (same operator-provisioned
  mechanism as existing accounts). The bot authenticates with it.

## Acceptance criteria (all must pass, with evidence attached)
1. `docker compose up` starts the bot service; it connects to Ergo via SASL and appears
   in `#general`'s nick list.
2. `!models` returns the seeded registry (at least `gpt-oss-120b`).
3. `!ask gpt-oss-120b "name one software architecture pattern"` returns a **non-empty**
   completion within timeout, correctly chunked (proves the reasoning-token floor).
4. `!ask <unknown-model> …` → friendly error; bot stays up.
5. A command from an **unauthenticated** user → **no response**.
6. Exceeding the per-account rate limit → throttle notice.
7. A long completion is chunked or paste-linked, not flooded or hard-truncated.
8. Killing the model endpoint mid-request → graceful error, bot stays connected;
   restarting the endpoint → next `!ask` works.
9. No secret appears in any log line or channel message.

## Out of scope (do NOT build now — leave extension points only)
- Routing through the HEARTH gateway / caller-profiles (Phase 2).
- Scheduling / tenancy windows for models that need the B70 cards (Phase 2).
- "Lend a remote agent / API key" provider registry (Phase 3).
The **models-registry abstraction is the seam** for all three — keep it clean, but
implement only Phase 1.

## Deliver
- Bot source + Dockerfile + the new compose service + seeded config.
- A short README: adding a model, setting secrets, provisioning the bot account, running,
  and the rate-limit/allow-list knobs.
- Evidence for each acceptance criterion (command + output transcript).
