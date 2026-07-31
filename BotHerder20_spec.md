You are implementing BotHerder 2.0: an IRC/Quassel ingress and projection adapter for Hearth.

This is not a generic IRC bot rewrite and not a second orchestration system.

The architectural correction is:

- Hearth is the gateway, control plane, router, manifest, policy boundary, usage ledger, and execution coordinator.
- IRC/Quassel is one durable human-facing path into Hearth.
- BotHerder 2.0 translates authenticated IRC activity into canonical Hearth requests and projects Hearth events back into IRC.
- The existing direct gpt-oss-120b path must remain operational during migration, but it should ultimately become one Hearth capability rather than a model client owned by ComputeBot.

Do not create a parallel job system, model registry, artifact store, policy engine, usage ledger, or worker scheduler inside the IRC bot.

Begin by reading the repository and documenting the current implementation before changing code. Locate and inspect:

- the current ComputeBot/BotHerder implementation
- bot startup and supervisor lifecycle
- IRC authentication and account resolution
- command parsing
- model registry and direct llama.cpp client
- per-session request queues and semaphores
- HERDER/1 request and response framing
- display chunking and outbound IRC pacing
- remote-agent adapter
- Hearth request, manifest, capability, invocation, artifact, and usage-accounting contracts
- existing Claude Code integration into Hearth
- tests, acceptance scripts, deployment configuration, and operational documentation

Do not assume the current names or abstractions are correct. Record verified facts, unresolved questions, and any mismatch between this brief and the repository.

Produce an implementation plan before editing code. Then implement in reviewable vertical slices.

## Target architecture

The intended request path is:

IRC user
→ authenticated IRC account and channel context
→ BotHerder 2.0 IRC adapter
→ canonical Hearth ingress request
→ Hearth authorization, routing, accounting, and execution
→ Hearth lifecycle and artifact events
→ BotHerder IRC projection
→ original IRC channel or private conversation

Other clients should converge on the same Hearth boundary:

Claude Code ─┐
IRC/Quassel ─┼→ Hearth → models, agents, tools, repos, workers, services
CLI/API ─────┤
future UIs ──┘

The IRC adapter should remain replaceable. Hearth must not depend on IRC-specific message syntax internally.

## Required architectural boundaries

BotHerder 2.0 owns only:

- IRC connection lifecycle
- IRC capability negotiation
- authenticated IRC identity and channel context extraction
- command discovery and parsing
- conversion into canonical Hearth ingress requests
- subscription to Hearth lifecycle events
- concise IRC rendering
- IRC output pacing, truncation, and artifact-link projection
- correlation between an IRC request and its originating conversation
- operator-facing compatibility commands during migration

Hearth owns:

- canonical request and invocation IDs
- capability discovery
- model and agent selection
- worker routing
- execution orchestration
- global concurrency and budgets
- policy and authorization
- approval state
- retries and cancellation semantics
- usage and cost accounting
- provenance and delegation history
- canonical job lifecycle
- artifacts and digests
- the append-only manifest or event record

BotHerder must not maintain a competing canonical copy of these concerns. It may keep ephemeral correlation and delivery state required to reconnect Hearth events to IRC conversations.

## First deliverable: current-state map

Before implementation, add or update an architecture note containing:

1. Current IRC request path.
2. Current direct gpt-oss-120b execution path.
3. Current HERDER/1 behavior.
4. Current local and remote-agent response paths.
5. Existing Hearth ingress contracts.
6. Existing Hearth manifest and accounting behavior.
7. Existing model and capability discovery.
8. State currently duplicated between ComputeBot and Hearth.
9. Security boundaries and authenticated identity sources.
10. Migration hazards and compatibility requirements.

Include a diagram of the current path and the proposed path.

Do not begin by renaming ComputeBot. First separate responsibilities.

## Canonical Hearth ingress request

Reuse an existing Hearth request contract if one already exists and is suitable. Extend it minimally rather than inventing an IRC-only replacement.

The canonical request must be transport-neutral and contain enough source context for policy, accounting, correlation, and response projection.

A representative shape is:

{
  "request_id": "req_...",
  "submitted_at": "UTC timestamp",
  "source": {
    "transport": "irc",
    "network": "local-network-name",
    "server": "irc-server-id",
    "conversation_type": "channel or private",
    "conversation_id": "#ops",
    "message_id": "transport-derived id when available",
    "reply_target": "#ops"
  },
  "principal": {
    "type": "human",
    "id": "irc-account:derek",
    "display_name": "Derek",
    "authenticated": true,
    "nick": "current-nick"
  },
  "intent": {
    "capability": "llm.chat",
    "arguments": {
      "prompt": "..."
    },
    "routing_hints": {
      "model": null,
      "worker": null,
      "agent": null
    }
  },
  "context": {
    "channel": "#ops",
    "thread": null,
    "repo": null,
    "branch": null
  },
  "delivery": {
    "mode": "summary-and-artifact",
    "stream_progress": true,
    "maximum_inline_bytes": 6144
  }
}

Use the repository’s established naming and identifier conventions where they exist.

IRC nick alone must not be treated as durable identity. Prefer the authenticated IRC account, certificate identity, or another verified account binding. Preserve the current nick only as display metadata.

Unidentified users must be rejected, restricted to explicitly public/read-only capabilities, or handled according to an existing Hearth policy. Do not silently promote a nickname to a trusted principal.

## Hearth capability model

The existing direct gpt-oss-120b behavior should become a Hearth capability.

At minimum expose:

- capability name: llm.chat
- implementation/provider identity
- available models
- streaming support
- context/output limits
- concurrency information where Hearth already models it
- health and availability
- routing attributes
- policy requirements

The default IRC user experience should not require selecting infrastructure:

!ask explain the difference between these two implementations

Hearth should choose the model or worker.

Preserve an explicit operator override where authorized:

!ask --model=gpt-oss-120b "review this design"
!ask --worker=am4 "run this locally"

Treat these as routing hints or privileged constraints evaluated by Hearth, not as commands that bypass Hearth and call a backend directly.

During migration, the old syntax must continue to work:

!ask gpt-oss-120b <prompt>

Translate it internally to:

capability = llm.chat
routing_hints.model = gpt-oss-120b

Do not maintain a separate execution path indefinitely.

## Command surface

Implement command discovery from Hearth capabilities rather than hardcoding an aspirational command list into the bot.

The initial command set should include:

!help
!help <command>
!capabilities
!models
!agents
!ask
!jobs
!job <job-id>
!cancel <job-id>
!status
!artifact <artifact-id>
!approve <approval-id>
!reject <approval-id>

Only expose richer commands when Hearth has a real capability behind them:

!review
!build
!test
!research
!deploy

A command appearing in !help is a product promise. Do not advertise placeholders.

For each command, define:

- syntax
- examples
- required Hearth capability
- required authorization
- synchronous acknowledgement behavior
- asynchronous event behavior
- failure rendering
- artifact behavior
- private-message versus channel behavior

Command discovery should make the system usable without external documentation.

Example:

!help review

ReviewBot: review
Usage: !review repo=<name> [branch=<branch>] [depth=quick|full]
Capability: repo.review
Approval: not required for read-only review
Output: channel summary plus Markdown artifact
Routing: selected by Hearth

## Job lifecycle

BotHerder must use Hearth’s canonical lifecycle. Do not invent an IRC-local lifecycle unless Hearth currently lacks one; if it lacks one, implement the lifecycle in Hearth first.

The minimum states should cover:

- accepted
- queued
- dispatched
- running
- waiting_for_input
- waiting_for_approval
- succeeded
- failed
- cancelled
- rejected
- expired

The IRC projection should be concise and avoid flooding:

ComputeBot: accepted job=job_123 capability=llm.chat
ComputeBot: job=job_123 running worker=am4 model=gpt-oss-120b
ComputeBot: job=job_123 complete duration=18.4s
ComputeBot: summary: ...
ComputeBot: artifact=art_456 result.md size=12.8KiB sha256=...

Do not emit every internal token, tool call, or state transition into public channels by default.

Support configurable projection policies by channel or capability:

- acknowledgement only
- major state changes
- periodic progress
- completion only
- verbose operator mode

The full canonical history remains in Hearth.

## Streaming and large-output behavior

IRC is a control surface, not a bulk transport.

Preserve safe short-response behavior, but large results must become Hearth artifacts.

Define an inline output threshold. Above that threshold:

1. Store the full response through Hearth’s artifact mechanism.
2. Generate or select a concise summary.
3. Post the summary and artifact reference to IRC.
4. Record the artifact digest and relationship to the invocation.
5. Never silently discard the full result.

The IRC adapter may truncate only the projection. It must not truncate the canonical Hearth result.

Resolve or explicitly document the existing remote-agent 4500-byte truncation. Do not claim end-to-end large-result preservation until every active path preserves the full result or converts it to an artifact.

Preserve IRC line-size safety, payload boundary handling, Unicode byte accounting, output pacing, and PONG priority.

## Session and context behavior

Define how IRC context maps into Hearth.

At minimum:

- channel messages create channel-scoped source context
- private messages create private source context
- replies remain bound to the originating channel or private conversation
- channel membership does not automatically grant Hearth capability authorization
- IRC operator status may be an input to policy but must not be the sole durable authorization source unless explicitly designed that way
- bot reconnects must not lose canonical jobs
- delayed job completions must still route to the correct conversation
- duplicate IRC delivery must not duplicate Hearth execution

Use idempotency keys or a transport message fingerprint where practical.

Do not send private results into a public channel after reconnect or correlation loss. Fail closed and expose the result through authorized Hearth retrieval.

## Manifest, usage, and provenance

Every IRC-originated invocation must flow through the same Hearth accounting and manifest path used by Claude Code integration.

The resulting record should allow an operator to determine:

- who initiated the request
- through which ingress
- from which channel or private conversation
- which capability was requested
- which model, agent, worker, and tools were selected
- what policy decision was made
- whether approval was required
- what resources were consumed
- what artifacts were produced
- whether delegation occurred
- final status and duration
- where the result was projected

Do not create an IRC-specific usage ledger except as a derived view.

Add ingress metadata such as:

ingress.transport = irc
ingress.adapter = botherder
ingress.network = ...
ingress.conversation = ...
ingress.principal = ...

Ensure secrets, raw credentials, SASL data, private keys, and credential-like IRC tags are never written to the manifest.

## Global capacity and scheduling

Remove direct per-session ownership of backend capacity where it bypasses Hearth.

The current model endpoint is shared. Hearth must enforce global capacity across all ingress paths, including:

- IRC
- Claude Code
- local CLI
- scheduled workflows
- remote agents
- any future UI

A per-IRC-session semaphore is not sufficient.

Reuse or implement a Hearth-level scheduler, semaphore, lease, or model-client pool that enforces:

- global concurrency
- per-capability concurrency
- per-model concurrency
- per-principal quotas where required
- queue depth
- deadlines
- cancellation
- retry budgets
- tool-call or token budgets

The IRC adapter may apply an additional anti-abuse rate limit, but it must not be the only capacity control.

## Approval behavior

Approval commands must resolve to Hearth approval records.

Example:

ComputeBot: approval required approval=apr_123
Action: deploy service=gateway environment=production
Requested by: irc-account:derek
Expires: 15 minutes
Use: !approve apr_123 or !reject apr_123

An approval must bind to the exact action digest, parameters, artifact or commit SHA, principal, and expiration.

Do not let a broad IRC command authorize a changed action.

Authorization must still be evaluated by Hearth when the approval decision is submitted.

## Compatibility strategy

Keep the existing ComputeBot available while the Hearth path is introduced.

Implement an explicit compatibility layer:

Legacy command
→ canonical command parse
→ Hearth ingress request
→ Hearth execution
→ legacy-compatible IRC rendering

Use a feature flag or configuration mode such as:

execution_backend = "direct"
execution_backend = "hearth"
execution_backend = "shadow"

Shadow mode should submit through the existing direct path while independently validating that Hearth would select an equivalent capability, policy decision, and routing outcome. Do not execute the same expensive request twice unless explicitly configured for testing.

Capture mismatches in diagnostic events.

Provide a rollback path to the direct backend until the Hearth path passes acceptance criteria.

## Implementation sequence

Milestone 0 — verified architecture

- Map current ComputeBot and Hearth contracts.
- Add current/proposed diagrams.
- Record open decisions.
- Identify exact ownership of jobs, artifacts, policy, routing, and accounting.
- Produce an implementation plan before code changes.

Milestone 1 — Hearth capability wrapper for the existing model

- Register gpt-oss-120b behind Hearth as llm.chat.
- Reuse the existing llama.cpp endpoint.
- Preserve current model settings and behavior.
- Ensure the invocation appears in the Hearth manifest.
- Add unit and integration tests independent of IRC.

Milestone 2 — canonical IRC ingress adapter

- Convert authenticated IRC commands into Hearth requests.
- Preserve source and principal context.
- Add idempotency and correlation.
- Return immediate accepted/rejected acknowledgements.
- Keep direct execution available behind a feature flag.

Milestone 3 — lifecycle projection

- Subscribe to Hearth lifecycle events.
- Project accepted, running, approval, failure, completion, and artifact events into IRC.
- Add pacing and PONG prioritization.
- Verify reconnect behavior and delayed completion routing.

Milestone 4 — compatibility migration

- Route existing !ask syntax through Hearth.
- Preserve !ask <model> <prompt>.
- Compare output and failure behavior against the direct path.
- Remove direct model calls from the normal Hearth mode.
- Keep rollback configuration.

Milestone 5 — capability discovery

- Generate !capabilities, !models, !agents, and !help from Hearth.
- Do not advertise unimplemented capabilities.
- Add policy-aware discovery so users do not see commands they cannot invoke unless deliberate.

Milestone 6 — artifacts and large output

- Store full results in Hearth.
- Project summaries and artifact references into IRC.
- Remove silent truncation from canonical paths.
- Test Markdown, JSON, logs, patches, and binary artifact metadata.

Milestone 7 — richer operations

Expose real Hearth-backed capabilities one at a time:

- repo.review
- repo.build
- repo.test
- research.run
- deployment.execute
- system.status
- artifact.fetch

Each capability requires its own contract, authorization policy, tests, help text, and acceptance scenario.

Milestone 8 — approval and operator workflows

- Wire !approve and !reject to Hearth.
- Bind approvals to action digests.
- Test expiration, replay, changed inputs, unauthorized approvers, and channel/privacy behavior.

Milestone 9 — retirement and naming

Only after the direct model path is no longer the primary implementation:

- decide whether ComputeBot becomes BotHerder
- preserve nick aliases if operationally useful
- update service names, configuration, docs, dashboards, and deployment assets
- remove obsolete model-client ownership from the IRC service
- retain a documented rollback or migration note

Do not begin with a cosmetic rename.

## Required tests

Add focused tests for:

- authenticated account to Hearth principal mapping
- unauthenticated users
- channel versus private-message source context
- legacy !ask syntax translation
- explicit model routing hints
- default Hearth routing
- duplicate command idempotency
- lifecycle event projection
- delayed completion after reconnect
- output pacing and PONG priority
- Unicode and maximum IRC payload boundaries
- artifact fallback
- remote-agent large-result preservation
- cancellation
- approval binding and replay prevention
- policy denial
- Hearth unavailable
- model unavailable
- queue full
- worker failure
- malformed Hearth events
- stale correlation state
- global capacity across multiple IRC sessions
- usage manifest parity with Claude Code integration

Use the existing repository test and acceptance infrastructure. Extend it rather than creating an unrelated harness.

## Acceptance scenarios

At minimum demonstrate these end-to-end:

Scenario A — backward-compatible chat

User sends:

!ask gpt-oss-120b explain what this service does

Expected:

- authenticated IRC identity resolved
- request submitted to Hearth
- llm.chat selected with the requested model hint
- usage recorded in the Hearth manifest
- concise lifecycle projected to IRC
- final response delivered
- no direct model call owned by ComputeBot in Hearth mode

Scenario B — automatic routing

User sends:

!ask explain this stack trace

Expected:

- no model required in command
- Hearth selects an eligible model or agent
- routing decision recorded
- result returned to the originating conversation

Scenario C — large result

User requests a repository review.

Expected:

- full review stored as a Hearth artifact
- IRC receives a concise summary
- artifact ID, type, size, and digest are shown
- no silent canonical truncation

Scenario D — approval

User requests a protected deployment.

Expected:

- Hearth pauses in waiting_for_approval
- IRC displays the exact proposed action
- authorized user approves by approval ID
- approval is bound to the action digest
- deployment resumes
- changed parameters require a new approval

Scenario E — shared capacity

Two or more IRC sessions plus another Hearth ingress submit model work concurrently.

Expected:

- global Hearth capacity remains within configured backend slots
- excess work queues predictably
- no per-session multiplication bypasses the global limit
- queue and completion state remain visible

Scenario F — failure and recovery

Hearth or the model backend becomes unavailable.

Expected:

- command receives a bounded failure or queued status
- no duplicate execution after reconnect
- canonical job state remains in Hearth
- IRC adapter recovers without losing completed results

## Documentation requirements

Update or add:

- architecture diagram
- IRC ingress contract
- command reference
- capability discovery behavior
- identity and authorization mapping
- lifecycle projection rules
- artifact behavior
- migration and rollback procedure
- operational runbook
- troubleshooting guide
- security considerations
- acceptance test instructions

Document verified current behavior separately from intended future behavior.

## Non-goals

Do not:

- turn IRC messages into the canonical database
- implement a second Hearth inside ComputeBot
- make free-form bot prose the machine protocol
- duplicate the model registry
- duplicate usage accounting
- duplicate policy decisions
- expose placeholder commands
- require users to know worker topology for normal use
- stream arbitrarily large results through IRC
- treat nicknames as durable authenticated identities
- remove the direct path before the Hearth path is proven
- rename the service before responsibility migration is complete

## Final deliverables

Provide:

1. Verified current-state architecture note.
2. Proposed architecture and decision record.
3. Incremental implementation with tests.
4. Hearth llm.chat capability wrapping the existing gpt-oss-120b endpoint.
5. Working IRC-to-Hearth request path.
6. Hearth lifecycle-to-IRC projection.
7. Backward-compatible !ask behavior.
8. Capability-driven help and discovery.
9. Artifact fallback for large output.
10. Global Hearth-level capacity enforcement or a clearly isolated prerequisite patch.
11. Migration, rollback, and operational documentation.
12. Final test and acceptance evidence.

Leave changes uncommitted unless repository instructions explicitly require commits. Report:

- files changed
- contracts added or modified
- tests run and results
- verified acceptance scenarios
- unresolved risks
- deferred milestones
- any mismatch between this brief and the actual Hearth architecture

The governing principle is:

BotHerder 2.0 is the IRC ingress and projection adapter for Hearth. Hearth remains the single gateway, capability router, policy boundary, usage manifest, execution coordinator, and canonical record.