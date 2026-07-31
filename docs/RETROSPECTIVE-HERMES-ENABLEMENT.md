# Hermes enablement retrospective

Covers 2026-07-30, from `1e638f9` to `f114550`: scoping the BotHerder 2.0
brief, enabling a second member's Hermes Agent, ten correctness and
quality-of-life fixes, and the first session with two humans in the channel.

Twenty-one files, roughly 1,800 lines added. Unit tests went from 25 to 43.

See [RETROSPECTIVE.md](RETROSPECTIVE.md) for the preceding deployment era.

## Executive summary

The session started with a large architectural brief and ended with a working
two-person channel. Almost none of the brief was implemented, and that was the
right outcome: verifying its central premise showed the premise did not hold
yet.

The Hermes work turned out to need no code at all. The genuinely valuable
changes were small: correctness fixes in reporting, a timeout that matched how
agents actually behave, and a command syntax a second person could guess.

The most useful thing to carry forward is a failure. The one change the owner
explicitly chose during planning was the one change not delivered, and it
surfaced as silence in front of a guest.

## What worked

### Verifying the premise before planning it

`BotHerder20_spec.md` assigns canonical requests, job lifecycle, cancellation,
subscribable events, result artifacts, per-user principals, capacity
enforcement, and approvals to HEARTH. Reading the implementation showed that
none of those exist there. `submit_task` writes a file over SSH and
`task_status` reports completion by checking whether a result file exists.

Two vocabulary mismatches did most of the damage to the brief.
`query_capabilities` returns an evidence-derived assay of what the fleet has
been *shown* able to do, not a registry of what can be *invoked*.
`query_capacity` returns observed history, not live headroom. A command surface
built on either would have been built on sand.

This cost one exploration pass and saved a migration that could not have
worked. It is written down in
[HEARTH-GAP-ANALYSIS.md](HEARTH-GAP-ANALYSIS.md) so the verification is not
repeated.

### The integration was already built

The remote-agent kit calls "one operator-configured OpenAI-compatible
endpoint." Hermes Agent serves exactly that on port 8642 with bearer auth. The
contract already matched, so enabling a Hermes user required no code — only
documentation, and honesty about the limits it would hit.

The instinct to look for the seam that already exists, before designing one,
was worth more here than any amount of implementation.

### Acceptance tests that asserted bugs

The live acceptance suite failed twice, and both times it was correct to fail
and wrong in what it asserted.

The rate-limit check provoked throttling by spamming an unknown model name.
Once capacity was consumed only after validation, an unknown model no longer
counted against the caller and the check could not pass. The check had been
encoding the defect.

Later, the unknown-model check asserted a friendly error that default routing
had deliberately removed.

Both were caught only because the suite was run against the live stack rather
than trusted. A test that encodes current behaviour will defend a bug as
loyally as it defends a feature.

### Probing the host instead of believing the documentation

`/opt/omen-irc` turned out to be a plain directory on local disk — not a git
checkout, not a mount, not synchronised. Nothing in this repository or the one
it borrowed its SSH patterns from described how a working tree gets there. That
step had been manual and undocumented since the beginning. It is now
[scripts/deploy-am4.sh](../scripts/deploy-am4.sh).

## What went wrong

### A chosen decision became a backlog item

Early in planning the owner was asked how `!ask` should resolve against the
existing addressed-nick grammar, and explicitly chose to support both. That
decision was recorded as a plan slice. When the next request asked for the top
ten quality-of-life improvements, the list was assembled from defects found
while reading the code — and the already-decided change was not on it, because
it had been filed as future work rather than as committed scope.

The result: twenty minutes into the first two-person session, `!ask what's the
meaning of life?` returned silence, in front of a guest, while a
freshly-deployed patch claimed to improve the experience.

**The lesson is about bookkeeping, not judgment.** An explicit user decision and
a self-generated improvement idea are not the same kind of object and must not
compete in the same ranking. Once chosen, it is scope.

### Stopping one step short

With a guest about to log on, the work was handed back as a six-command
runbook: deploy, build, bootstrap, check, two acceptance suites. The access was
already established, the procedures were documented as rerunnable, and they had
already been verified.

Caution about consequential action on a live host is right in general and was
wrong in that moment. The relevant context — a person arriving, a stated
deadline — had already been given. Deferring to the operator is only deferral
if they have time to act.

### Green tests, silent command

Thirty-eight tests passed while the headline user path did nothing. Every unit
test and every acceptance check exercised the addressed form,
`Nick: ask <model> <prompt>`, because that is what the code supported. Nothing
exercised what a person would actually type.

Coverage measured against the implementation will never reveal a missing
entry point. At least one check should start from the user's keystrokes.

### Small self-inflicted friction

PowerShell here-string syntax was used in a Bash shell, which scattered a commit
message across a dozen failed commands. `git update-index --chmod=+x` was run
against a file that was still untracked, so it silently did nothing and the
deploy script was committed non-executable while every sibling script is `755`.
Both were caught before anything left the machine, and both were avoidable by
checking the result rather than the intent.

## Deliberate tradeoffs

- **`access_mode = "authenticated"` on the primary Herder.** Any authenticated
  member can now spend the owner's inference capacity by addressing it. Taken
  because the owner had just told the guest it would work. One line to revert.
- **Remote-agent timeout 120s to 660s.** Agentic providers run for minutes. The
  cost is that a stuck request holds one of sixteen pending slots for eleven
  minutes, and the window in which a finished result can be lost to a reconnect
  is now much wider.
- **Default model routing removed the unknown-model error.** A mistyped agent
  name now reaches the default model instead of being refused. Mitigated by
  naming the chosen provider in the acknowledgement rather than by refusing.
- **The deploy ships loose files.** The host keeps no record of which commit it
  runs. Baseline's ADR-0006 moved to a git-bundle transport for exactly this
  reason; that would be better here too, but it requires committing before every
  deploy.

## What remains

Unchanged from Gate B and Gate C in
[COMPUTE-BOT-LIMITS-TODO.md](COMPUTE-BOT-LIMITS-TODO.md), with the longer
timeout making the first three more pressing:

1. Artifacts for large results, so the ~4.5 KiB truncation stops discarding the
   tail and a result survives a lost IRC projection.
2. Cancellation, now that a request can occupy a slot for eleven minutes.
3. Progress and liveness frames, so a long agentic run is distinguishable from a
   dead one.
4. A supervisor-level scheduler bounding aggregate concurrency across Herders.
5. The HEARTH prerequisites in [HEARTH-GAP-ANALYSIS.md](HEARTH-GAP-ANALYSIS.md),
   if that migration is ever attempted.

The clearest signal for whether the syntax work landed is whether the second
member needs to ask what to type. That question was asked once, at 5:24 pm, and
answering it properly is what the session should be judged on.
