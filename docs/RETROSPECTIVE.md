# IRC community deployment retrospective

## Executive summary

The project began as a small tailnet-only Ergo and The Lounge deployment on
OMEN. It finished as an account-private community service on AM4 with:

- public, trusted-TLS IRC through Tailscale Funnel;
- a private-mode browser lobby;
- 24-hour, single-use member onboarding;
- one owner-scoped BotHerder per member;
- allow-listed local inference through `gpt-oss-120b`;
- outbound-only adapters for member-controlled remote agents; and
- persistent accounts, channels, history, Lounge state, membership state, and
  operational metrics.

The final architecture is still small: Ergo and The Lounge remain the core,
the portal provisions identities, and BotHerder delegates inference. No public
cloud VM, reverse-proxy fleet, database server, Quassel Core, or separate
bouncer was added.

## How the design changed

### 1. OMEN proved the IRC behavior

The first deployment established that Ergo already supplied the account,
history, channel-registration, always-on, and multi-client behavior that had
initially suggested adding Quassel Core or another bouncer. Quassel
Monolithic/Standalone could connect directly to Ergo.

The tailnet-only boundary was operationally safe but socially expensive:
inviting a friend also meant inviting them into the operator's tailnet.

### 2. AM4 removed recurring cloud cost

A small GCP VM was considered, then rejected because another monthly service
was the wrong cost shape for an experimental community. AM4 already had
Docker, persistent storage, a public Tailscale Funnel presence, and the local
model endpoint.

The chosen public path was additive Funnel configuration:

```text
IRC client
  -> trusted TLS at am4.tail8e749c.ts.net:8443
  -> PROXY v2 over AM4 loopback
  -> Ergo
```

This avoided router forwarding, a new public VM, and certificate lifecycle
work while preserving the original client address for Ergo limits.

### 3. Browser-first onboarding replaced password runbooks

The initial operator-generated credentials were appropriately strong but
hostile to manual entry. The onboarding portal turned that into:

1. an administrator-generated, 24-hour, single-use link;
2. a short expectations-and-outcome page;
3. member selection of their account and BotHerder names;
4. one-time display of a generated personal password; and
5. immediate entry through a preconfigured private Lounge profile.

Quassel remains the preferred desktop client, but it is no longer required for
the first successful conversation.

### 4. The shared bot became personal BotHerders

The Phase 1 `ComputeBot` proved authenticated, allow-listed local inference.
The community design then moved to one IRC identity and control plane per
member. Shared-channel commands explicitly address a Herder, while private
commands expose owner-only status, usage, agent invitation, listing, and
revocation.

The primary migrated identity is `DereksBotHerder`; the legacy `ComputeBot`
account is suspended.

### 5. Remote agents stayed outbound-only

Remote providers do not upload API keys to AM4 and do not expose inbound
ports. A BotHerder creates a one-time agent invitation; redemption returns a
dedicated non-oper SASL identity and an adapter kit. The adapter connects
outbound to IRC and calls its operator's OpenAI-compatible endpoint locally.

This keeps IRC as the authenticated control plane without turning the portal
into a provider-key vault.

## What worked well

- **Ergo as the stateful center.** Native accounts, history, channel ownership,
  multi-client attachment, and SASL eliminated several unnecessary services.
- **A thin bridge.** BotHerder enforces identity, allow-lists, limits, and
  output framing, while model servers continue to own inference.
- **Browser-first acceptance.** The Lounge made the first-use path independent
  of Quassel packaging and Quassel Core terminology.
- **Additive networking.** Funnel routes were added without resetting or
  replacing AM4's gallery route.
- **Least-privilege provisioning.** The portal registrar can create and
  suspend accounts but cannot administer channels, rehash Ergo, or read
  history.
- **Disposable acceptance identities.** Community tests provision and offboard
  temporary members, Herders, and agents instead of depending on hand-built
  state.
- **Secret discipline.** Invite tokens are hashed, credentials are shown once,
  provider keys remain with providers, and prompts/completions are excluded
  from logs and metrics.

## Friction and corrections

### Quassel packaging was confusing

The application named only **Quassel Client** expects a Quassel Core. The
correct direct-to-Ergo application is **Quassel Monolithic/Standalone**. The
client guide now says this before presenting network fields.

### Local and remote server entries hid failures

Quassel cycled through stale `127.0.0.1` and OMEN entries, making certificate
and reachability failures look inconsistent. Current instructions use only the
AM4 endpoint unless deliberately testing rollback.

### Password roles were easy to conflate

The Ergo account password, operator password, Lounge login, and model bearer
key serve different roles. The onboarding flow now uses one generated member
credential for Ergo SASL and that member's Lounge login, while operator and
model credentials remain inaccessible.

### Model output needed empirical limits

The reasoning model requires a meaningful token floor or it can return empty
visible content. Long IRC output also interacts with Ergo fakelag and protocol
framing. The deployed model floor is 512 tokens.

The completion payload was safely raised from 300 to 360 bytes only after:

- worst-case nickname/channel tests;
- exact 512/513-byte frame tests;
- multi-byte UTF-8 boundary tests; and
- a live Ergo relay test whose largest non-tag message segment was 434 bytes.

The acceptance harness initially counted IRCv3 message tags against the
legacy 512-byte message segment. Correcting that measurement was preferable
to reducing a safe payload based on the wrong protocol boundary.

### Acceptance traffic was too visible

Automated long-output tests briefly filled `#general`. They now invite the
Herder into `#bot-collab-test`, leaving the human channel readable.

### API acceptance did not exercise the browser

The first real member invitation exposed a front-end initialization failure:
HTML IDs used kebab-case while the JavaScript read camelCase properties. API
acceptance passed because it never executed the browser bundle. The portal
image now runs a dependency-free DOM smoke harness during every build, and the
AM4 health check executes the same harness against the installed assets.

## Deliberate tradeoffs

- **Funnel dependency:** removes certificate and router work, but is a beta
  ingress service with constrained public ports.
- **Loopback plaintext after TLS termination:** acceptable within the current
  host boundary, but not a design for a cross-host backend.
- **BotHerder host networking:** provides the most direct path to the existing
  loopback-only model endpoint, but expands what the hardened container can
  reach on AM4.
- **Generated passwords:** avoid weak user-selected credentials, but require
  the member to save a secret shown once.
- **In-memory per-Herder rate limits:** simple and effective for Phase 1, but
  reset on supervisor restart.

## What remains

The next work should improve reliability before increasing throughput:

1. Add a supervisor-level scheduler or semaphore that globally bounds access
   to the shared llama.cpp endpoint.
2. Verify and enforce the endpoint's actual parallel slot count.
3. Prioritize PONG or pace long output, and expose queue position/timestamps.
4. Add explicit HERDER/1 fragmentation guards and retry idempotency.
5. Use access-controlled artifacts for bulk results instead of raising IRC
   line limits indefinitely.
6. Perform the first human Quassel test from a genuinely non-Tailscale
   network.
7. Test an off-host restore, not only in-place persistence.
8. Add recovery binding, such as Steam/OpenID, without replacing Ergo SASL.

Detailed compute-limit gates are in
[COMPUTE-BOT-LIMITS-TODO.md](COMPUTE-BOT-LIMITS-TODO.md).

## Canonical documentation

- [README.md](../README.md): architecture, endpoints, bootstrap, and current
  limitations.
- [COMMUNITY-ONBOARDING.md](COMMUNITY-ONBOARDING.md): member and remote-agent
  flows.
- [COMPUTE-BOT.md](COMPUTE-BOT.md): BotHerder behavior and validation.
- [RETROSPECTIVE-HERMES-ENABLEMENT.md](RETROSPECTIVE-HERMES-ENABLEMENT.md): the
  following phase — scoping BotHerder 2.0, enabling a second member's Hermes
  Agent, and the first two-person session.
- [HERMES-AGENT.md](HERMES-AGENT.md): connecting a Hermes Agent as a remote
  agent, and the security tradeoff it carries.
- [HEARTH-GAP-ANALYSIS.md](HEARTH-GAP-ANALYSIS.md): the original gaps and how
  they were closed for BotHerder execution.
- [HEARTH-EXECUTION.md](HEARTH-EXECUTION.md): canonical execution architecture,
  rollout, and rollback.
- [RETROSPECTIVE-HEARTH-EXECUTION.md](RETROSPECTIVE-HEARTH-EXECUTION.md): why
  the control plane was built in HEARTH before migrating IRC.
- [RETROSPECTIVE-STOREFRONT-PROTOTYPE.md](RETROSPECTIVE-STOREFRONT-PROTOTYPE.md):
  the first persistent personal storefront, its projection boundaries, and why
  the next phase is observation rather than feature expansion.
- [STOREFRONT-UX-JOURNAL.md](STOREFRONT-UX-JOURNAL.md): the living evidence log
  for whether `#herder-derek` feels like Derek's lab or workshop.
- [AM4.md](AM4.md): production topology and host layout.
- [OPERATIONS.md](OPERATIONS.md): administration, backup, recovery, and
  teardown.
- [SECURITY.md](SECURITY.md): trust boundary, secrets, and exposure posture.
- [evidence/COMMUNITY-ONBOARDING.md](evidence/COMMUNITY-ONBOARDING.md):
  sanitized acceptance evidence.

Historical plans and worker briefs are retained for decision provenance and
are explicitly labeled as historical rather than current runbooks.
