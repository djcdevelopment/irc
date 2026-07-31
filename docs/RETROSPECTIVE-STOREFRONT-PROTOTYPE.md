# DereksBotHerder storefront prototype retrospective

## Outcome

The first personal BotHerder storefront gives Derek a persistent
`#herder-derek` channel whose contents are projected from existing HEARTH and
community-registry state. It adds a place-oriented view of the Herder without
creating another operational database or moving execution responsibility out
of HEARTH.

This is a living research prototype, not a generalized product surface. The
next phase is to observe whether Derek experiences the channel as his lab or
workshop. No participant session is claimed by this retrospective; observations
and quotes belong in
[STOREFRONT-UX-JOURNAL.md](STOREFRONT-UX-JOURNAL.md).

## What changed

### Persistent place

- Bootstrap creates and registers the administrator's `#herder-derek`
  channel.
- Member onboarding derives a channel from the display name, registers it,
  adds it to the member's Lounge network, and adds it to the member's Herder
  channel set.
- The initial owner introduction is intentionally small and configured as
  presentation text rather than operational state.

### Read-only projections

BotHerder reads the tools already visible to its least-privilege HEARTH caller
and, when available, projects:

- registered operations and execution providers;
- kernel status;
- owner-filtered recent executions and public/result artifact metadata; and
- attached-agent and member storefront data from the portal's authenticated
  internal API.

The IRC process caches these reads briefly for presentation. It does not
persist a second catalog, copy prompt bodies, expose input artifacts, or take
ownership of provider routing.

### Storefront conversation

The channel exposes short views for introduction, catalog, hardware, models,
agents, status, recent activity, artifacts, and community discovery. Responses
remain bounded by the existing IRC output controls. A partially upgraded or
temporarily unavailable HEARTH gateway leaves a smaller fallback view instead
of taking down the Herder session.

## Decisions that held up

### Canonical state stayed canonical

Operational inventory comes from HEARTH and the community registrar. This
avoids the attractive but costly mistake of adding a storefront database,
event model, or synchronization contract before the experience proves useful.

### The channel is persistent, but the projection is disposable

Ergo owns channel identity and history. BotHerder owns only the current
presentation. A short cache reduces repeated discovery calls without turning
the projection into durable product state.

### Partial availability is visible

Storefront discovery is read-only and additive. Missing tools or failed
projection calls produce an incomplete or explicit unavailable response;
model execution and the normal Herder reconnect loop remain separate.

## Friction and lessons

### The concept expanded faster than the evidence

Catalog and owner-lab views naturally suggested browse, compare, and capability
discovery. Those affordances are useful for exercising the projection boundary,
but there is not yet participant evidence that they help the channel feel
owned, alive, or workshop-like. They should not be generalized further during
the observation period.

### Naming is a prototype convention, not an identity contract

Member channel names are derived from display names. The current pilot does not
define collision, rename, migration, or internationalized-slug semantics.
Building those rules now would turn a presentation experiment into provisioning
architecture. Revisit only after a real usage pattern demonstrates the need.

### Availability is limited by upstream discovery

Recent activity and artifact listings appear only when the HEARTH caller can
see the corresponding read-only tools and owner-filtered execution projection.
The fallback is intentionally honest; BotHerder does not reconstruct missing
history locally.

### A working interface is not evidence of belonging

Unit tests can prove command routing, projection shaping, and fallback behavior.
They cannot prove that the channel feels like Derek's place. That is why the
prototype now has a separate living journal with exact quotes, observed
actions, confidence, unresolved questions, and a cross-session review gate.

## What is deliberately deferred

- New commands or capability categories.
- A durable storefront schema, API, event stream, or synchronization layer.
- Generalized multi-member ownership and rename behavior.
- Ambient updates, banners, guestbooks, marquees, counters, leaderboards, or
  popularity signals.
- Public onboarding optimization around the storefront.
- Any architecture justified by only one observed reaction.

If future evidence points toward one of these, record the observation and the
revisit condition in the journal rather than creating an implementation plan.

## Validation boundary

The repository checks for this slice cover BotHerder configuration and command
behavior, HEARTH projection handling, portal browser assets and invitation
flows, and whitespace-safe documentation. Live production behavior must still
be assessed through an actual Derek session; operational acceptance output is
not substituted for UX evidence.

On 2026-07-31, the local verification completed with:

- 68 passing BotHerder Python tests;
- four passing portal/browser and invitation-flow scripts; and
- a clean Git whitespace check plus Markdown trailing-whitespace scan.

## Next phase

1. Leave the deployed presentation stable.
2. Record real sessions in
   [STOREFRONT-UX-JOURNAL.md](STOREFRONT-UX-JOURNAL.md).
3. After several sessions, separate helpful repeatable behavior, repeated
   small presentation friction, and interesting but insufficiently observed
   ideas.
4. Consider only the repeated presentation friction for a small prototype
   adjustment, and only when Derek explicitly asks for it.

## Addendum — 2026-07-31: the deferral is resolved, not ignored

The deferral list above gated banners, guestbook-era surfaces, a durable
storefront schema, and rename semantics on "a concrete observed need" and
"only when Derek explicitly asks." Both conditions were met on 2026-07-31:
Derek used the deployed `#herder-derek` prototype in a real session (logged
as O-001…O-003 in the journal), then delivered an explicit product decision —
the Personal AI Storefronts design specification plus direct scope choices
(MVP slice; full migration of user-visible "herder" naming to owner-chosen
`#lab-<slug>` identities; raw HTML fragments still deferred).

What was built in response: a `storefront_profiles` table in the portal's
existing SQLite holding **owner-authored presentation state only**; a public
`/lab/<slug>` page; an IRC-rooted magic-link editor; an mIRC color layer on
bot-composed lines; join banners and welcome topics; and rename flows.

The boundary this retrospective defended survives intact and is now enforced
in more places, not fewer:

- HEARTH remains the only source of operational truth. The web page renders a
  trimmed snapshot pushed by the member's own bot, stamped with its age and
  displayed as stale or absent when it is — never reconstructed locally.
- Ergo still owns channel identity; profiles reference channels, they do not
  replace them.
- The model/agent output path still strips every control character; color is
  applied only to lines the bot composes itself. The prototype's
  anti-spoofing stance is unchanged.
- One prototype bug was found and fixed during generalization: member bots
  inherited the primary `[storefront]` table and joined `#herder-derek`
  (supervisor `_member_config`), which the per-member storefront override and
  a regression test now prevent.
