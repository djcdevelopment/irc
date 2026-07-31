# DereksBotHerder storefront UX journal

Status: living research record
Prototype: `#herder-derek`
Primary participant: Derek
Last updated: 2026-07-31

## Research question

Does Derek begin to experience `#herder-derek` as **my lab** or **my
workshop**, rather than as a bot interface or software dashboard?

This is an observation study of the deployed prototype. It is not a feature
backlog. Repository descriptions, intended behavior, and researcher
expectations are context only; they are not evidence of Derek's experience.

No real usage session has been recorded in this journal yet.

## Study guardrails

- Preserve the deployed prototype during the observation period.
- Change it only if a usability problem prevents continued use and Derek
  explicitly asks for an adjustment.
- Record what happened before interpreting why it happened.
- Preserve spontaneous phrases verbatim, especially phrases beginning with
  "I wish," "I expected," "This feels," "I keep," and "I never."
- Keep observed behavior, participant quotes, researcher interpretations, and
  possible design directions visibly separate.
- Mark every design direction as **unvalidated** until repeated evidence
  supports it.
- Do not create a feature ticket or implement a change from one observation.
- Do not treat command output, telemetry, repository documentation, or a
  researcher walkthrough as a participant session.
- Remove credentials, private prompts, artifact contents, and other sensitive
  material from notes. Retain only the minimum excerpt needed to understand
  the interaction.

The study does not add or generalize contracts, schemas, APIs, persistence,
event models, provisioning architecture, multi-member behavior, commands,
leaderboards, counters, gamification, popularity metrics, public onboarding,
or optimization for future members.

Guestbooks, marquees, banners, and ambient-update systems also remain out of
scope until a concrete observed need exists. If an observation eventually
suggests new architecture, record it only in
[Deferred design directions](#deferred-design-directions), together with the
additional evidence required to revisit it.

## What to observe

### Place, identity, and ownership

- First impression before Derek issues a command.
- Whether the channel name, Herder display name, topic, banner, and welcome
  behavior feel personal, generic, artificial, or familiar.
- Language that signals ownership: "mine," "my lab," "my workshop," "our
  channel," or the opposite.
- Whether Derek behaves like the owner of a place or the operator of a bot.

### Discovery and conversation

- What Derek tries first and why.
- Commands or conversational forms he expects without prompting.
- Whether discovery feels natural, memorized, or dependent on documentation.
- Where the exchange feels like conversation and where it feels like command
  entry.

### Information and activity

- Which of catalog, hardware, models, agents, status, recent activity, and
  artifacts Derek looks for first.
- What he reads, ignores, revisits, or cannot find.
- Information density, noise, visual rhythm, and signs of ambient life.
- Whether activity reads like a laboratory whiteboard or software telemetry.

## Session method

Before a session, record enough context to make the observation interpretable:
client, device, prior familiarity, task or reason for visiting, and the
identity surfaces actually visible. Capture the prototype state as seen rather
than assuming it matches configuration.

Let Derek explore without explaining the intended metaphor or naming the
success signal. Ask neutral follow-ups after spontaneous exploration:

- What felt natural?
- What felt awkward?
- What did you expect to find?
- What information did you look for first?
- What did you ignore?
- What made the channel feel alive?
- What made it feel artificial?
- Did anything make the space feel like yours?
- Did anything make it feel like a dashboard?

For each meaningful moment, write the quote or action first. A meaningful
moment includes hesitation, repetition, abandonment, surprise, a workaround,
a stated expectation, or a clear expression of ownership.

Use these evidence labels consistently:

- **Quote:** Derek's exact words.
- **Observed action:** behavior seen directly in the session.
- **Researcher interpretation:** a possible explanation, never presented as
  fact.
- **Unvalidated direction:** a possible wording, ordering, or presentation
  response that has not earned implementation.

Confidence describes the strength of the interpretation, not the importance
of the issue:

- **Low:** plausible interpretation with ambiguous or incomplete evidence.
- **Medium:** the action and context support the interpretation, but another
  explanation remains credible.
- **High:** explicit participant explanation closely matches the observed
  behavior. High confidence from one session still does not establish a
  repeated pattern.

## Observation log

Add one row for each meaningful interaction. Give observations stable IDs
(`O-001`, `O-002`, and so on) so later synthesis can cite evidence without
rewriting it.

| ID | Date / session | Exact quote or observed action | What Derek was trying to do | Researcher interpretation: why it likely produced that reaction | Affected area | Unvalidated design direction | Confidence | Unresolved questions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| _None yet_ |  |  |  |  |  |  |  |  |

Do not combine separate reactions merely because they occurred during the
same task. If the interpretation changes later, preserve the original entry
and add a dated correction or qualification in the session notes.

## Usage rounds

Create a copy of the following section after every real usage round. A round
may contain one or more related sessions. Cite observation IDs in every
interpretive output.

### Round template: YYYY-MM-DD — short context

#### Session context

- Session ID:
- Date and local time:
- Client and device:
- Location or network context, if relevant:
- Prior familiarity:
- Derek's goal on entering:
- Researcher involvement:

#### Prototype snapshot

- Channel name as displayed:
- Herder display name as displayed:
- Topic:
- Banner or welcome behavior:
- Initially visible activity:
- Relevant commands or responses encountered:
- Anything materially different from the preceding session:

This snapshot documents exposure, not participant reaction.

#### Exact observations

Add the session's evidence to the main [Observation log](#observation-log),
then list its observation IDs here:

- Observation IDs:

#### Product insights

Interpret the round without turning it into a solution. Each insight must cite
one or more observation IDs and note credible alternate explanations.

- Insight:
- Evidence:
- Alternate explanation:
- Confidence:

#### Lightweight information-architecture notes

Record what Derek looked for, the order in which he looked, what he grouped
together, and what he ignored. Do not infer a navigation hierarchy from the
available commands alone.

- Expected location or grouping:
- Observed path:
- Missing or competing cue:
- Evidence:

#### Presentation or wording recommendations

Recommendations are advisory and **unvalidated**. Keep them small enough to
test as wording, ordering, or presentation changes. Do not convert them into
implementation plans.

- Unvalidated recommendation:
- Observation(s) it responds to:
- Expected effect:
- What would disconfirm it:

#### Unresolved design questions

- Question:
- Why it remains unresolved:
- Observation needed next:

#### Optional channel-flow sketch

Use a short transcript-shaped sketch only when it clarifies a conversational
or presentation hypothesis. Label it **example, not observed** and exclude
private prompt or artifact content.

```text
Example, not observed:
Derek: ...
DereksBotHerder: ...
```

#### Round boundary

- Changes made to the deployed prototype: none / describe explicit exception
- Blocking usability problem, if any:
- Follow-up observation focus:

## Pattern index

Update this table only after logging the underlying observations. Similar
events are not necessarily the same pattern; preserve differences in task and
context.

| Pattern ID | Neutral pattern description | Observation IDs | Distinct sessions | Current classification | Confidence | Next evidence needed |
| --- | --- | --- | ---: | --- | --- | --- |
| _None yet_ |  |  | 0 | Insufficiently observed |  |  |

Possible classifications before the review threshold are:

- **Emerging:** more than an isolated moment, but not ready for a product
  conclusion.
- **Insufficiently observed:** interesting and worth watching without acting.
- **Counterexample present:** evidence conflicts; investigate context rather
  than averaging it away.

## Cross-session review

Do not complete this review after a single observation or a researcher-only
walkthrough. At the end of several real usage sessions, record the session
count and dates, then sort recurring patterns into exactly these groups.

### Review basis

- Sessions included:
- Date range:
- Tasks represented:
- Important gaps or biases:

### 1. Clearly helpful and repeatable behavior

Behavior belongs here when it helped across multiple real sessions or tasks.
Preserve it; do not turn success into a reason to generalize the product.

| Pattern | Evidence | Why it appears repeatable | Counterexamples |
| --- | --- | --- | --- |
| _Not reviewed_ |  |  |  |

### 2. Repeated friction suitable for a small prototype adjustment

Only this group may be considered for a small wording, ordering, or
presentation adjustment, and only after Derek explicitly asks for a change.

| Pattern | Evidence across sessions | Small unvalidated adjustment | Validation check |
| --- | --- | --- | --- |
| _Not reviewed_ |  |  |  |

### 3. Interesting but insufficiently observed ideas

Keep these unresolved. State what future observation would make each idea
actionable or disconfirm it.

| Idea | Evidence | Why evidence is insufficient | Observation needed |
| --- | --- | --- | --- |
| _Not reviewed_ |  |  |  |

## Adjustment record

Leave this section empty during the observation period. If Derek explicitly
requests a small prototype adjustment after the cross-session review, record:

- the group 2 pattern and supporting observation IDs;
- the exact wording, ordering, or presentation change;
- the intended user-visible effect;
- how the next real session will test it;
- rollback criteria; and
- the date and result of that validation.

An adjustment is not validated merely because it was implemented.

## Deferred design directions

This is a parking area, not a roadmap. Do not add an item without both an
observation and a clear revisit condition.

| Direction | Triggering observation IDs | Why architecture would be required | Observation required before revisiting |
| --- | --- | --- | --- |
| _None_ |  |  |  |
