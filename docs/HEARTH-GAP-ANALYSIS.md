# HEARTH gap analysis

`BotHerder20_spec.md` proposes making BotHerder a thin IRC ingress and
projection adapter, with HEARTH owning canonical requests, job lifecycle,
routing, policy, capacity, artifacts, approvals, and the usage manifest.

This note records what HEARTH actually provides today, verified by reading
`C:\work\commandcenter\hearth` (47 tools across 15 provider modules, live on
`127.0.0.1:8710`). It is the spec's Milestone 0 current-state map for the HEARTH
side, and it exists so the verification is not repeated.

**Conclusion: the migration cannot proceed as written.** Most of what the brief
assigns to HEARTH does not exist there yet. The work is not "wire BotHerder to
HEARTH"; it is "build a control plane inside HEARTH, then wire BotHerder to it."
The spec anticipates this — "if it lacks one, implement the lifecycle in Hearth
first" — but budgets it as an aside.

Verified as of 2026-07-30. Re-check before relying on it.

## What the brief assumes, and what exists

| Brief requirement | HEARTH today |
|---|---|
| Canonical request and invocation IDs | **Absent.** No `req_` or `inv_` identifier anywhere. Four unrelated ID schemes coexist: a bare uuid4 per ledger row, `hearth-<slug>-<hex>` plan IDs, `br-<date>-<hex>` build receipts, and `obs-...` observation IDs. |
| Canonical job lifecycle | **Absent.** `submit_task` writes a file to a conductor inbox over SSH. `task_status` reports `done` based on whether `result.json` exists. There are no states between submitted and finished. |
| Cancellation | **Absent** everywhere in the tool surface. |
| Subscribable lifecycle events | **Absent.** No SSE, webhook, pub/sub, or watch API. Every tool is synchronous request/response. |
| Artifact store for results | **Absent for results.** An artifact mechanism exists but is wired only to capacity-observation evidence. Ledger `sha256` digests are one-way fingerprints — there is no fetch-by-digest, and only a 400-character preview is retained. |
| Per-user principal | **Absent by design.** One key equals one caller equals one profile. The `hearth-event.v1` schema freezes `caller` at exactly three keys with `additionalProperties: false`, so per-nick attribution has nowhere to live. |
| Global capacity enforcement | **Absent.** No semaphore, admission control, or rate limiting. |
| Approval gating | **Absent.** Nothing pauses for human approval. |

## What HEARTH does have, and does well

These are the parts worth extending rather than replacing.

**Authorization.** A caller resolves through a profile to a capability set to a
tool. Every tool maps to exactly one capability, and the gateway *refuses to
start* if any mounted tool is unmapped. A null profile denies everything rather
than defaulting open. Policy lives in git.

**The ledger.** Append-only NDJSON with a SQLite offset index, one event per
tool call, written in a `finally` block so failures are recorded too. It carries
caller, tool, argument and result digests, duration, token counts, backend,
model, and the routing reason. Over 20,000 events. There is no update or delete
API. This is a sound audit spine.

**Backend routing.** Backends are declared with endpoint, API flavour, models,
tags, and occupancy. Selection is layered — pinned endpoint, pinned name, tag
match, pool default, an overflow ladder — and fails closed with a structured
refusal rather than silently picking something. The chosen path is recorded as a
reason code.

**The build-request lane.** The one real state machine in the door, and a good
model for any "did it actually finish" contract: closing as `done` requires
every acceptance criterion to carry both a passed status and non-empty evidence.

**Ingress precedent.** A Tailscale Funnel and Caddy path already fronts the door
for cloud callers, stamping a fixed key. An IRC adapter fronting HEARTH would be
the same shape.

## Two vocabulary mismatches

Both matter because the brief builds commands on them.

**"Capability" means something different here.** `query_capabilities` returns an
*evidence-derived assay* — what the lab has been shown able to do, with
confidence scores, evidence watermarks, qualified resource combinations, and
observation IDs backing each claim. A representative entry is
`capability:task_kind=offload-generate|backend=gcp-gemini`. It is a belief about
demonstrated ability, not an invocable service registry. The brief's
`!capabilities` command cannot be rendered from it, and `llm.chat` has no
counterpart there.

**"Capacity" is history, not headroom.** `query_capacity` returns buckets of
observed success rate and duration percentiles projected from the ledger. It
answers how a bucket has behaved, not whether there is room right now. Occupancy
probes exist for two backends and are advisory routing input; a `Lease` type
exists but reserves nothing and blocks nothing.

## What an IRC adapter would face today

- **No subscription.** An adapter must poll `task_status`, or tail the
  append-only ledger with a cursor — which is what HEARTH's own projection
  adapter does, so the pattern is proven, but it is not a supported API.
- **No correlation field.** The only per-call channel is the optional,
  free-form MCP `_meta.task_id`, which reaches the ledger as `task_id`. Adding a
  real field means amending a schema that declares `additionalProperties: false`
  and has a hand-written validator mirror to update in lockstep.
- **No per-user attribution.** The adapter would be a single caller. Every IRC
  user's work would be indistinguishable in the manifest — which defeats the
  brief's own accounting requirements.
- **No admission control.** An IRC channel is a far noisier ingress than a
  single Claude Code session, and nothing would stop it saturating the door.

## Prerequisites before Milestone 1

In rough dependency order:

1. A canonical request object with a stable ID, and a correlation field that is
   not a repurposed free-form string.
2. Real job states, persisted on the HEARTH side rather than inferred from a
   remote filesystem.
3. Cancellation.
4. A subscribable event channel, or a documented and supported cursor-tailing
   contract.
5. An artifact store for results, addressable and fetchable. The existing
   capacity-observation artifact machinery is the right shape to copy.
6. A sub-principal or on-behalf-of concept, which requires amending the frozen
   `caller` object.
7. Global admission control. The `Lease` type is the natural extension point.
8. Approval records bound to an action digest, if Milestone 8 is wanted.

Items 1 through 5 are prerequisites for a useful IRC ingress. Items 6 and 7 are
prerequisites for a *safe* one.

## Consequence for this repository

BotHerder currently owns a model registry, a usage ledger, per-session
concurrency control, and request IDs. The brief calls this duplication, and it
is — but the alternative does not exist yet. Until the prerequisites above are
met, that state should stay where it is, and improvements should be made in
place rather than in anticipation of a move.

See [COMPUTE-BOT-LIMITS-TODO.md](COMPUTE-BOT-LIMITS-TODO.md) for the in-place
work, whose Gate B and Gate C items are independent of any HEARTH decision.
