# BotHerder through HEARTH

BotHerder is an IRC protocol adapter. HEARTH owns execution.

```text
authenticated IRC account
  → personal BotHerder
  → private HTTPS MCP on OMEN
  → HEARTH Operation scheduler
  → global Provider lease
  → existing backend router
  → AM4 gpt-oss-120b
  → immutable result artifact
  → bounded IRC projection
```

## Modes

`config/compute-bot/bot.toml` has one migration switch:

```toml
[hearth]
mode = "direct" # direct | shadow | hearth
endpoint = "https://omen.tail8e749c.ts.net:8443/mcp"
api_key_env = "HEARTH_API_KEY"
operation = "llm.chat"
```

- `direct` is the prior AM4-local provider call and the rollback.
- `shadow` returns the direct answer and sends only model, byte count, and
  desired policy to `plan_execution`. HEARTH does not receive the prompt and
  does not dispatch a second completion.
- `hearth` submits the prompt once to HEARTH and retrieves the canonical result
  artifact. The configured local endpoint key is no longer required by the
  BotHerder container in this mode.

The `[completion]` system prompt is sent through either execution path, so the
plain-text IRC answer shape does not change during migration.

In `hearth` mode the deterministic acknowledgement says `through HEARTH`, and
`!status` is the authoritative live mode. The completion also receives a
non-secret execution-context system message so it does not invent a direct
endpoint topology when asked how it was invoked. Treat generated prose as an
explanation, not an operational probe; use `!status` for the fact.

## Identity and authorization

BotHerder forwards the IRCv3 `account` tag that Ergo attached after SASL. It
does not delegate a nick, user-supplied tag, or message prefix.

HEARTH records:

```text
principal.type = irc_account
principal.id = <authenticated Ergo account>
source.transport = irc
source.adapter = botherder-am4
```

`source.adapter` comes from the authenticated HEARTH caller registry and cannot
be chosen in the tool request. The dedicated `irc-adapter` profile grants only
execution and status capabilities. Job reads, cancellation, watches, and
artifact retrieval are owner-scoped.

## Secrets and private transport

The HEARTH caller key exists only in:

```text
OMEN: HEARTH caller registry (operator-protected)
AM4:  /etc/omen-irc/hearth-bot.env (root:root, 0600)
```

It is never stored in TOML, Compose, the repository, channel output, or logs.
`compose.am4.yaml` loads the root-only file.

The MCP endpoint is Tailscale **Serve**, not Funnel. It is reachable by tailnet
members only and uses a trusted certificate for OMEN's MagicDNS hostname.
Port 8443 on OMEN forwards to the existing loopback gateway on 8710; no second
gateway or reverse proxy is introduced.

## Execution and artifacts

One user command creates:

```text
Request → Job → Invocation
```

A retry or fallback gets a new Invocation under the same Job. Global capacity
is leased at the HEARTH Provider endpoint; four configured `am4-moe` slots were
verified against llama.cpp's live `/slots` endpoint before deployment.

Prompts and full results are immutable artifacts. Lifecycle events contain
metadata and digests, not content. The legacy HEARTH tool-call audit also
redacts the prompt to byte count and SHA-256. If an IRC response is truncated,
BotHerder adds:

```text
job=job_… artifact=art_… size=… sha256=…
```

IRC stays the control surface. The artifact store carries bulk output.

## Rollout

On OMEN:

```powershell
cd C:\work\commandcenter
.\hearth\tools\configure-private-ingress.ps1
.\hearth\tools\provision-irc-adapter.ps1
```

Restart the HEARTH gateway, then on AM4:

```bash
cd /opt/omen-irc
sudo docker build --target test \
  -t omen-irc-bot-herder:test services/compute-bot
sudo docker compose -f compose.am4.yaml up -d --build bot-herder
sudo scripts/check-compute-bot-am4.sh
```

Roll through `shadow`, inspect `hearth_shadow_plan` log entries, then use
`hearth`. `!status` reports the active execution mode.

## Rollback

Set:

```toml
mode = "direct"
```

Recreate `bot-herder`. No ledger migration or state deletion is needed. Do not
delete the Execution Ledger during rollback; it remains historical evidence.

## Acceptance

Verify:

1. `!status` reports `execution=hearth`.
2. `!ask gpt-oss-120b name one software architecture pattern` returns a
   non-empty answer.
3. The corresponding HEARTH Job records the IRC account principal and
   `botherder-am4` adapter.
4. A full result artifact exists and passes its SHA-256 check.
5. Prompt text and both caller/provider secrets are absent from gateway and
   BotHerder logs.
6. `tailscale serve status` shows the OMEN 8443 route as private Serve, not
   Funnel.
7. Switching to `direct` and back is one config change plus container recreate.
