# Retrospective: BotHerder becomes a HEARTH adapter

## Outcome

The migration succeeded by changing the scope of the work. The first gap
analysis showed that wiring BotHerder to the old gateway would only relocate an
HTTP call; it would not create canonical jobs, global admission control,
artifacts, cancellation, or user attribution. We built those primitives in
HEARTH first, then made IRC an adapter.

The durable boundary is now clear:

- HEARTH is the system of record for AI execution.
- BotHerder is the IRC ingress and bounded projection.
- The existing backend router remains the only Provider-selection path.

## What went well

- Reading the implementation before accepting the proposed vocabulary exposed
  that evidence-derived capabilities and historical capacity were not an
  invocable service catalog or current headroom.
- Request, Job, and Invocation identities made retries and provenance explicit.
- Append-only events plus rebuildable projections fit HEARTH's existing ledger
  philosophy better than a mutable job database.
- A shared Provider lease fixed the dominant structural risk: aggregate load is
  no longer active sessions multiplied by each session's concurrency.
- Input and output artifacts made it unnecessary to keep increasing IRC line
  limits.
- `shadow` mode compares routing without paying for or accidentally duplicating
  a second inference.
- Tailscale Serve gave this two-host control lane trusted TLS and private
  reachability with no public ingress and no new reverse proxy.

## What changed during integration

`master` gained IRC answer-shaping work while the adapter was in flight. The
merge exposed a useful requirement: the same system prompt must travel through
both direct and HEARTH paths, or migration changes user-visible answer quality.
The adapter now passes it as an Operation argument, and both paths share the
same output flattener.

The gateway's older audit ledger also previewed tool arguments. Storing prompts
only in the new artifact system was therefore insufficient. The wrapper now
records prompt byte count and SHA-256 instead of content, with regression tests
for direct and delegated submission.

## Deliberate compromises

- Running provider cancellation is cooperative rather than a socket-level
  abort.
- Lifecycle observation uses cursor long polling.
- The artifact tool retrieves text inline up to 1 MiB; it is not yet a
  signed/downloadable artifact service.
- HERDER/1 remote agents keep their earlier transport ceiling and independent
  execution path.
- BotHerder retains a local model presentation allow-list. It is duplicated
  validation, but useful defense in depth and command UX.

## Follow-up

- Add queue position and estimated start projections.
- Add prioritized PONG or paced output before increasing IRC throughput.
- Add an authorized artifact download surface for large/binary results.
- Move remote-agent execution and large responses onto the same canonical
  artifact lifecycle.
- Add multiline or artifact-backed prompt input.
- Introduce approval records only with an action digest and a real workflow;
  do not claim approval from reserved event names alone.

