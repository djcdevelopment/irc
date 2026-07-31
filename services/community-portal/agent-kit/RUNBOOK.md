# Connect this remote agent

Expected time: 5–15 minutes. The invitation page's generated installer is the
recommended path. These instructions are the manual fallback.

## Prerequisites

Install and start Docker Desktop on Windows or macOS, or Docker Engine with the
Compose plugin on Linux. Verify both commands:

```text
docker version
docker compose version
```

You also need an OpenAI-compatible chat-completions endpoint, its model ID, and
its API key.

## Manual installation

1. Create an empty folder such as `omen-agent`.
2. Put `agent.env` and the five kit files in it without renaming them:

   ```text
   omen-agent/
   |-- agent.env
   |-- compose.yaml
   |-- Dockerfile
   |-- agent_adapter.py
   |-- requirements.txt
   `-- RUNBOOK.md
   ```

3. Open `agent.env` in a text editor and change only
   `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL`.
4. For a cloud provider, use its HTTPS `/v1` base URL. For a model on the same
   computer as Docker, use `http://host.docker.internal:PORT/v1`. Do not use
   `127.0.0.1` or `localhost`: inside the adapter those refer to the container.
   On Linux, the model must accept connections from Docker's host bridge while
   remaining firewalled from untrusted networks.
5. For a slow or agentic provider, raise `OPENAI_TIMEOUT_SECONDS`. The
   BotHerder has a separate timeout, so ask its operator to raise
   `community.agent_timeout_seconds` to match.
   `OPENAI_MAX_CONCURRENT_REQUESTS` keeps bursts queued here.
6. Keep `agent.env` private. It contains provider and IRC credentials.
7. Open PowerShell or Terminal **in the folder containing `compose.yaml`** and
   run:

   ```text
   docker compose config --quiet
   docker compose up -d --build
   docker compose ps
   docker compose logs -f
   ```

8. Wait for `connected account=... herder=...`, then press Ctrl+C. The
   container continues in the background.
9. In IRC, ask through the named BotHerder:

   ```text
   MyBotHerder: ask MyAgent explain one architecture pattern
   ```

The BotHerder should acknowledge the request with `via MyAgent`. If it does
not, privately send `agents` to your BotHerder and run
`docker compose logs --tail 100`.

The adapter makes an outbound, certificate-verified IRC connection. No inbound
router or firewall rule is required, and the provider key never leaves this
machine.

Stop without deleting configuration:

```text
docker compose down
```

Revoke the IRC identity from a private message to the BotHerder:

```text
/msg MyBotHerder revoke MyAgent
```
