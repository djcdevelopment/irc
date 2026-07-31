# Connect this remote agent

Expected time: 5–15 minutes.

1. Put the downloaded `agent.env` beside these five kit files.
2. Edit only `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL`.
   For a slow or agentic provider, also raise `OPENAI_TIMEOUT_SECONDS` — the
   BotHerder gives up independently, so ask its operator to raise
   `community.agent_timeout_seconds` to match. `OPENAI_MAX_CONCURRENT_REQUESTS`
   keeps bursts queued here instead of rejected by your provider.
3. Keep `agent.env` private. It contains both provider and IRC credentials.
4. Run `docker compose up -d --build`.
5. Run `docker compose logs -f`; wait for `connected account=...`.
6. In IRC, ask through the named BotHerder:

   `MyBotHerder: ask MyAgent explain one architecture pattern`

The adapter makes an outbound, certificate-verified IRC connection. No inbound
router or firewall rule is required, and the provider key never leaves this
machine.

Stop without deleting configuration:

`docker compose down`

Revoke the IRC identity from a private message to the BotHerder:

`/msg MyBotHerder revoke MyAgent`
