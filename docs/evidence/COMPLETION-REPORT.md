# AM4 community IRC completion report

Completed and live on 2026-07-30. Secrets and one-time URLs are omitted.

## Deployment

| Service | Image | Approximate RAM |
|---|---|---:|
| Ergo | `ghcr.io/ergochat/ergo:v2.19.0` | 9.2 MiB |
| The Lounge | `ghcr.io/thelounge/thelounge:4.5.2` | 31.7 MiB |
| Community portal | `omen-irc-community-portal:1.0.0` | 12.5 MiB |
| BotHerder supervisor | `omen-irc-bot-herder:2.0.0` | 27.0 MiB |

Both custom Python images use the pinned base
`python:3.14.5-slim-bookworm@sha256:a9bee15510a364124aa24692899d269835683b883de42f7ebec8c293cf679ccb`.
The portal inherits the pinned The Lounge image so it can provision Lounge
users with the official CLI.

Detected AM4 identity:

```text
MagicDNS: am4.tail8e749c.ts.net
Tailscale IPv4: 100.116.82.60
```

## Access and ports

| Address | Use |
|---|---|
| `am4.tail8e749c.ts.net:8443` | Public trusted-TLS IRC; SASL required |
| `https://am4.tail8e749c.ts.net:10000/` | Public HTTPS private-mode Lounge |
| `https://am4.tail8e749c.ts.net/join/` | Public HTTPS one-time join portal |
| `127.0.0.1:6668` | Funnel's PROXY-v2 IRC backend |
| `127.0.0.1:6667` | Internal host IRC handoff |
| `127.0.0.1:9000` | Lounge HTTP backend |
| `127.0.0.1:9010` | Portal HTTP/internal-API backend |

Docker does not bind these backends to AM4's public interface. Funnel owns the
public Tailscale listeners. The existing gallery remains at the root HTTPS
route. Port 6697 is not used on AM4.

Quassel Monolithic/Standalone settings:

```text
Server: am4.tail8e749c.ts.net
Port: 8443
TLS: enabled
Verify certificate: enabled
SASL: PLAIN, personal account and password
Auto-join: #general,#ops
Reconnect: enabled
```

## Validation results

- Public join portal: HTTP 200, trusted certificate.
- Public Lounge: HTTP 200, trusted certificate.
- Public IRC 8443: TCP and trusted TLS/SASL passed.
- Compose: four services running and healthy with no restart loop.
- Core check: 19/19 passed.
- Restart/persistence check: 20/20 passed.
- BotHerder unit tests: 25/25 passed.
- BotHerder live suite: all nine Phase 1 criteria passed.
- Community suite: disposable member, personal Herder, outbound remote agent,
  inference, usage, listing, revocation, and cleanup passed.
- BotHerder environment excludes registrar, operator, invite-admin, and
  credential-encryption secrets.
- BotHerder member records are read-only; the isolated metrics path is writable.
- Configured credentials were absent from logs and captured channel output.

Full sanitized transcripts are in `COMMUNITY-ONBOARDING.md` and
`COMPUTE-BOT-PHASE1.md`.

## Onboarding outcome

The installed `$invite-irc-community` skill and
`scripts/invite-community.ps1` generate a 24-hour, single-use URL. The friend
chooses:

1. Their IRC/SASL account name.
2. Their personal BotHerder name.
3. An optional display name.

The portal displays expectations and time up front, creates personal Ergo and
Lounge identities, configures `#general` and `#ops`, shows the password once,
and provides one-click entry to the browser lobby. No Quassel installation is
required for the first successful chat.

Each owner privately administers their Herder with `status`, `usage`, `agents`,
`invite`, and `revoke`. Token metrics say `not reported` when a provider does
not supply them.

An owner can invite any number of remote agents. Each agent gets a dedicated
non-oper SASL identity and an outbound-only adapter kit. The remote operator
fills only their OpenAI-compatible base URL, provider key, and model ID; the
provider key stays on that host. Shared-room commands explicitly address one
Herder, preventing reply storms.

The legacy `ComputeBot` container was removed and its account suspended.
The primary migrated identity is `DereksBotHerder`, owned by `admin`.

## Manual steps remaining

1. Generate an invite and send it privately to the intended friend.
2. The friend must save the one-time password before leaving the result page.
3. A remote-agent operator must fill three local environment values and run
   their downloaded Compose kit.
4. Perform the human Quassel acceptance from a genuinely off-tailnet network
   when the first friend opts into the desktop client.

Steam/OpenID recovery is deliberately not implemented yet.

## Security tradeoffs

- Funnel terminates TLS; its hop to Ergo is plaintext on loopback.
- BotHerder uses host networking to reach AM4's existing model listener.
- The existing model process listens broadly but requires a bearer key; UFW
  allows 8082 only from the LAN, and an external public-IP connection timed out.
- Public Lounge security depends on each member protecting their generated
  personal password.
- Aggregate model capacity is not yet globally scheduled across Herders; keep
  the current per-member throughput limits until that scheduler exists.
- Rate-limit state resets when the supervisor restarts.

## Repository tree

```text
.
├── compose.yaml
├── compose.am4.yaml
├── .env.example
├── .gitattributes
├── .gitignore
├── README.md
├── config
│   ├── compute-bot
│   │   ├── bot.toml
│   │   ├── models.toml
│   │   └── secrets.env.example
│   ├── ergo
│   │   ├── ircd.am4.template.yaml
│   │   ├── ircd.template.yaml
│   │   └── motd.txt
│   └── thelounge
│       └── config.js
├── deploy
│   └── omen-irc-am4.service
├── docs
│   ├── AM4.md
│   ├── COMMUNITY-ONBOARDING.md
│   ├── COMPUTE-BOT-LIMITS-TODO.md
│   ├── COMPUTE-BOT.md
│   ├── OPERATIONS.md
│   ├── QUASSEL.md
│   ├── RETROSPECTIVE.md
│   ├── SECURITY.md
│   └── evidence
│       ├── COMMUNITY-ONBOARDING.md
│       ├── COMPLETION-REPORT.md
│       └── COMPUTE-BOT-PHASE1.md
├── scripts
│   ├── acceptance-community-am4.py
│   ├── acceptance-compute-bot-am4.py
│   ├── backup-am4.sh
│   ├── bootstrap-am4.sh
│   ├── check-am4.sh
│   ├── check-compute-bot-am4.sh
│   ├── community-admin.sh
│   ├── invite-community.ps1
│   ├── provision-community-am4.sh
│   └── provision-compute-bot-am4.sh
├── services
│   ├── community-portal
│   │   ├── Dockerfile
│   │   ├── server.js
│   │   ├── public
│   │   │   ├── app.js
│   │   │   ├── index.html
│   │   │   └── styles.css
│   │   └── agent-kit
│   │       ├── Dockerfile
│   │       ├── RUNBOOK.md
│   │       ├── agent_adapter.py
│   │       ├── compose.yaml
│   │       └── requirements.txt
│   └── compute-bot
│       ├── Dockerfile
│       ├── requirements.txt
│       ├── src/compute_bridge
│       │   ├── bot.py
│       │   ├── config.py
│       │   ├── metrics.py
│       │   ├── models.py
│       │   ├── output.py
│       │   ├── portal.py
│       │   ├── protocol.py
│       │   ├── rate_limit.py
│       │   └── supervisor.py
│       └── tests
└── skills
    └── invite-irc-community
        ├── SKILL.md
        └── agents/openai.yaml
```

The Windows bootstrap/check/backup/teardown scripts and historical planning
documents remain in the repository but are omitted from this focused tree.

## Repository publication

The portal, BotHerder, adapter kit, provisioning scripts, acceptance suites,
onboarding skill, readable configuration, and current documentation are
versioned together. Generated credentials, databases, certificates, history,
metrics, backups, and AM4 migration staging remain excluded by `.gitignore`
and are not part of the publication set.
