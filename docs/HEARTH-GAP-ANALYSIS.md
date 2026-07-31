# HEARTH gap analysis — closed for BotHerder execution

This was the Milestone 0 map for moving BotHerder from an execution service to
an IRC ingress and projection adapter. The original 2026-07-30 review correctly
found that HEARTH had routing and a strong audit spine but lacked a durable
execution control plane.

The migration was not implemented by bypassing those gaps. The missing control
plane was added to `C:\work\commandcenter\hearth`, then BotHerder was integrated
behind a reversible `direct` / `shadow` / `hearth` switch.

## Current state

| Original gap | Current implementation |
|---|---|
| Canonical identities | Stable `req_…`, `job_…`, `inv_…`, `art_…`, and `evt_…` identifiers |
| Durable job lifecycle | Append-only `hearth-execution-event.v1` Execution Ledger plus rebuildable SQLite current-state projection |
| Cancellation | Owned-job cancellation with queued and running behavior; running provider calls are cooperatively discarded, not force-killed |
| Lifecycle events | Supported cursor/long-poll `watch_execution` contract |
| Result artifacts | Immutable content-addressed input and output artifacts with size, media type, and SHA-256 |
| Per-user principal | Trusted adapter delegation of the server-authenticated IRC account |
| Global capacity | Cross-process SQLite leases bounded by each provider's verified `parallel_slots` |
| One execution path | Gateway `local_generate`, direct MCP callers, and BotHerder terminate at the same scheduler/router/provider pipeline |
| Operations vocabulary | Invocable Operations are separate from Providers, execution policy, evidence-derived capabilities, and historical capacity |

Approval event names are reserved, but a human approval workflow is not claimed
or required for the current `llm.chat` operation.

## Canonical ownership

HEARTH is now the system of record for:

- desired Operation and policy;
- Request, Job, and Invocation identity;
- current and historical lifecycle;
- Provider routing and global endpoint capacity;
- input/output artifact integrity;
- token usage and route provenance; and
- delegated downstream principal attribution.

BotHerder remains responsible for:

- accepting only server-authenticated IRC accounts;
- its per-member abuse and channel-traffic limits;
- local model/agent presentation and command syntax;
- lifecycle acknowledgement; and
- rendering a bounded IRC projection plus artifact reference.

It does not call the AM4 model endpoint in `hearth` mode.

## Transport choice

AM4 reaches the existing OMEN gateway through tailnet-only Tailscale Serve at:

```text
https://omen.tail8e749c.ts.net:8443/mcp
```

This route is not a Funnel and is not public. Tailscale supplies private
reachability, MagicDNS, and trusted TLS; `X-Hearth-Key` authenticates a dedicated
least-privilege `irc-adapter` profile. The gateway stamps that authenticated
caller as the source adapter, so BotHerder cannot spoof its own provenance.

## Remaining boundaries

- Cancellation cannot interrupt an already-blocking provider socket.
- The lifecycle channel is long polling, not server push.
- Inline artifact retrieval is text-only and capped at 1 MiB.
- IRC prompts still fit in one message; multiline input is future work.
- Remote HERDER/1 agents retain their separate approximately 4.5 KiB response
  ceiling and do not yet use HEARTH artifacts.
- BotHerder's local allow-list remains a presentation/abuse boundary even
  though HEARTH independently validates the model against declared Providers.

The implementation and operator procedure are in
[HEARTH-EXECUTION.md](HEARTH-EXECUTION.md). Limit-specific follow-up remains in
[COMPUTE-BOT-LIMITS-TODO.md](COMPUTE-BOT-LIMITS-TODO.md).
