import asyncio
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType

from compute_bridge.bot import BotHerder
from compute_bridge.config import (
    AppConfig,
    CommunityConfig,
    HealthConfig,
    HearthConfig,
    IRCConfig,
    LimitsConfig,
    ModelConfig,
)
from compute_bridge.models import Completion
from compute_bridge.protocol import IRCMessage
from compute_bridge.output import chunk_completion


def app_config(heartbeat_path):
    model = ModelConfig(
        name="test",
        model_id="test",
        endpoint="http://127.0.0.1:8082/v1",
        api_key_env="MODEL_KEY",
        api_key="secret",
        max_tokens=512,
        min_max_tokens=1,
        description="Test model",
        timeout_seconds=10,
    )
    return AppConfig(
        irc=IRCConfig(
            server="127.0.0.1",
            port=6667,
            nick="AlicesHerder",
            account="AlicesHerder",
            password_env="IRC_BOT_PASSWORD",
            password="password",
            owner_account="Alice",
            access_mode="owner",
            channels=("#general",),
            reconnect_initial_seconds=1,
            reconnect_max_seconds=2,
        ),
        limits=LimitsConfig(
            requests_per_minute=6,
            max_prompt_bytes=2048,
            max_output_bytes=4096,
            max_output_lines=15,
            irc_payload_bytes=360,
            max_concurrent_requests=2,
            max_pending_requests=16,
        ),
        health=HealthConfig(str(heartbeat_path), 15),
        community=CommunityConfig(
            portal_url="http://127.0.0.1:9010",
            internal_token_env="COMMUNITY_INTERNAL_TOKEN",
            internal_token="internal-secret",
            agent_timeout_seconds=5,
        ),
        models=MappingProxyType({"test": model}),
        log_level="INFO",
    )


class BotCommandTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.bot = BotHerder(
            app_config(Path(self.temporary.name) / "heartbeat")
        )
        self.bot.registered = True
        self.replies = []

        async def capture(target, text):
            self.replies.append((target, text))
            return True

        self.bot._reply = capture

    async def asyncTearDown(self):
        for task in list(self.bot.request_tasks):
            task.cancel()
        if self.bot.request_tasks:
            await asyncio.gather(*self.bot.request_tasks, return_exceptions=True)
        await self.bot.model_client.close()
        self.temporary.cleanup()

    async def test_unauthenticated_command_gets_no_response(self):
        await self.bot._handle_privmsg(
            IRCMessage(
                tags={},
                prefix="Guest!user@host",
                command="PRIVMSG",
                params=("#general", "AlicesHerder: models"),
            )
        )
        self.assertEqual(self.replies, [])

    async def test_authenticated_owner_lists_registry(self):
        await self.bot._handle_privmsg(
            IRCMessage(
                tags={"account": "Alice"},
                prefix="Alice!user@host",
                command="PRIVMSG",
                params=("#general", "AlicesHerder: models"),
            )
        )
        self.assertEqual(
            self.replies, [("#general", "Alice: test - Test model")]
        )

    async def _channel(self, text, account="Alice"):
        await self.bot._handle_privmsg(
            IRCMessage(
                tags={"account": account},
                prefix=f"{account}!user@host",
                command="PRIVMSG",
                params=("#general", text),
            )
        )

    async def test_bare_command_from_owner_is_answered(self):
        await self._channel("!models")
        self.assertEqual(self.replies, [("#general", "Alice: test - Test model")])

    async def test_help_links_to_configured_public_guide(self):
        self.bot.config = replace(
            self.bot.config,
            community=replace(
                self.bot.config.community,
                guide_url="https://community.example/guide/",
            ),
        )
        await self._channel("!help")
        self.assertEqual(
            self.replies,
            [
                (
                    "#general",
                    "Alice: !ask <prompt> | !ask <model-or-agent> <prompt> | "
                    "!models | !status",
                ),
                (
                    "#general",
                    "Alice: guide: https://community.example/guide/",
                ),
            ],
        )

    async def test_bare_command_from_non_owner_is_ignored(self):
        await self._channel("!models", account="Bob")
        self.assertEqual(self.replies, [])

    async def test_bare_bang_requires_a_letter(self):
        await self._channel("!!models")
        await self._channel("!42")
        await self._channel("!")
        self.assertEqual(self.replies, [])

    async def test_bare_ask_without_a_model_uses_the_default(self):
        seen = {}

        async def completion(model, prompt):
            seen["model"] = model.name
            seen["prompt"] = prompt
            return Completion(text="42")

        self.bot.model_client.complete = completion
        await self._channel("!ask what's the meaning of life?")
        await asyncio.gather(*self.bot.request_tasks)
        self.assertEqual(seen["model"], "test")
        self.assertEqual(seen["prompt"], "what's the meaning of life?")

    async def test_named_model_still_wins_and_is_stripped(self):
        seen = {}

        async def completion(model, prompt):
            seen["prompt"] = prompt
            return Completion(text="ok")

        self.bot.model_client.complete = completion
        await self._channel("!ask test explain the tradeoff")
        await asyncio.gather(*self.bot.request_tasks)
        self.assertEqual(seen["prompt"], "explain the tradeoff")

    async def test_hearth_mode_uses_canonical_client_instead_of_direct_endpoint(self):
        calls = []

        class FakeHearth:
            async def complete(
                self,
                model,
                prompt,
                *,
                account,
                idempotency_key,
                system_prompt="",
            ):
                calls.append(
                    (model.name, prompt, account, idempotency_key, system_prompt)
                )
                return Completion(
                    text="canonical result",
                    job_id="job_123",
                    request_id="req_123",
                    artifact={
                        "artifact_id": "art_123",
                        "size": 16,
                        "sha256": "a" * 64,
                    },
                )

            async def close(self):
                return None

        async def direct_must_not_run(_model, _prompt):
            self.fail("direct model endpoint must not run in hearth mode")

        hearth_config = HearthConfig(
            mode="hearth",
            endpoint="https://omen.example:8443/mcp",
            api_key_env="HEARTH_API_KEY",
            api_key="secret",
        )
        object.__setattr__(
            self.bot,
            "config",
            replace(self.bot.config, hearth=hearth_config),
        )
        self.bot.hearth = FakeHearth()
        self.bot.model_client.complete = direct_must_not_run
        await self._channel("!ask test use the ledger")
        await asyncio.gather(*self.bot.request_tasks)
        self.assertEqual("use the ledger", calls[0][1])
        self.assertEqual("Alice", calls[0][2])
        self.assertTrue(calls[0][3].startswith("irc:alicesherder:"))
        self.assertIn("this request used HEARTH", calls[0][4])
        self.assertTrue(any("through HEARTH" in text for _, text in self.replies))
        self.assertTrue(any("canonical result" in text for _, text in self.replies))

    async def test_hearth_large_result_projects_artifact_reference(self):
        class FakeHearth:
            async def complete(self, *_args, **_kwargs):
                return Completion(
                    text="x" * 5000,
                    job_id="job_123",
                    artifact={
                        "artifact_id": "art_123",
                        "size": 5000,
                        "sha256": "b" * 64,
                    },
                )

            async def close(self):
                return None

        object.__setattr__(
            self.bot,
            "config",
            replace(
                self.bot.config,
                hearth=HearthConfig(
                    mode="hearth",
                    endpoint="https://omen.example:8443/mcp",
                    api_key_env="HEARTH_API_KEY",
                    api_key="secret",
                ),
            ),
        )
        self.bot.hearth = FakeHearth()
        await self._channel("!ask test long result")
        await asyncio.gather(*self.bot.request_tasks)
        self.assertTrue(any("artifact=art_123" in text for _, text in self.replies))
        self.assertTrue(any("sha256=" + ("b" * 64) in text for _, text in self.replies))

    async def test_acknowledgement_names_the_chosen_provider(self):
        async def completion(model, prompt):
            return Completion(text="ok")

        self.bot.model_client.complete = completion
        await self._channel("!ask an unnamed question")
        await asyncio.gather(*self.bot.request_tasks)
        self.assertIn("via test", self.replies[0][1])

    async def test_dispatchable_requests_are_rate_limited(self):
        async def completion(model, prompt):
            return Completion(text="done")

        self.bot.model_client.complete = completion
        message = IRCMessage(
            tags={"account": "Alice"},
            prefix="Alice!user@host",
            command="PRIVMSG",
            params=("#general", "AlicesHerder: ask test a prompt"),
        )
        for _ in range(7):
            await self.bot._handle_privmsg(message)
        await asyncio.gather(*self.bot.request_tasks)
        # Completions land after the refusal, so scan all replies rather than
        # assuming the limit message is last.
        self.assertTrue(
            any("rate limit reached" in text for _, text in self.replies)
        )

    async def test_oversized_prompt_does_not_consume_rate_limit(self):
        oversized = IRCMessage(
            tags={"account": "Alice"},
            prefix="Alice!user@host",
            command="PRIVMSG",
            params=("#general", "AlicesHerder: ask test " + ("x" * 2049)),
        )
        for _ in range(7):
            await self.bot._handle_privmsg(oversized)
        for _, text in self.replies:
            self.assertIn("2048-byte limit", text)

    async def test_slow_inference_does_not_block_other_commands(self):
        release = asyncio.Event()

        async def slow_completion(model, prompt):
            await release.wait()
            return Completion(text="complete")

        self.bot.model_client.complete = slow_completion
        await self.bot._handle_privmsg(
            IRCMessage(
                tags={"account": "Alice"},
                prefix="Alice!user@host",
                command="PRIVMSG",
                params=("#general", "AlicesHerder: ask test slow request"),
            )
        )
        self.assertRegex(
            self.replies[-1][1],
            r"^Alice: working\.\.\. \(req [0-9a-f]{12} via test\)$",
        )
        self.assertEqual(self.bot.pending_count, 1)

        await self.bot._handle_privmsg(
            IRCMessage(
                tags={"account": "Alice"},
                prefix="Alice!user@host",
                command="PRIVMSG",
                params=("#general", "AlicesHerder: help"),
            )
        )
        self.assertIn("ask <model-or-agent>", self.replies[-1][1])
        release.set()
        await asyncio.gather(*self.bot.request_tasks)
        self.assertEqual(self.bot.pending_count, 0)

    async def test_oversized_prompt_is_rejected_before_model_call(self):
        await self.bot._handle_privmsg(
            IRCMessage(
                tags={"account": "Alice"},
                prefix="Alice!user@host",
                command="PRIVMSG",
                params=(
                    "#general",
                    "AlicesHerder: ask test " + ("x" * 2049),
                ),
            )
        )
        self.assertIn("2048-byte limit", self.replies[-1][1])
        self.assertEqual(self.bot.pending_count, 0)

    async def test_only_authenticated_invites_add_a_channel(self):
        sent = []

        async def capture_raw(line):
            sent.append(line)

        self.bot._send_raw = capture_raw
        await self.bot._handle_invite(
            IRCMessage(
                tags={},
                prefix="Guest!user@host",
                command="INVITE",
                params=("AlicesHerder", "#unauthenticated"),
            )
        )
        self.assertNotIn("#unauthenticated", self.bot.channels_to_join)

        await self.bot._handle_invite(
            IRCMessage(
                tags={"account": "Alice"},
                prefix="Alice!user@host",
                command="INVITE",
                params=("AlicesHerder", "#project"),
            )
        )
        self.assertIn("#project", self.bot.channels_to_join)
        self.assertEqual(sent, ["JOIN #project"])

    async def test_bare_command_owner_match_ignores_access_mode(self):
        # Owner-match is the only thing stopping every member's Herder from
        # answering the same bare command, so "authenticated" must not relax it.
        authenticated = replace(self.bot.config.irc, access_mode="authenticated")
        object.__setattr__(self.bot, "config", replace(self.bot.config, irc=authenticated))
        await self._channel("!models", account="Bob")
        self.assertEqual(self.replies, [])

    async def _pending_agent_request(self):
        async def agents():
            return [
                {
                    "account": "SamsAgent",
                    "display_name": "SamsAgent",
                    "state": "active",
                }
            ]

        self.bot._get_agents = agents
        await self.bot._start_agent_request(
            "#general", "Alice", "Alice", (await agents())[0], "prompt"
        )
        return next(iter(self.bot.agent_requests))

    async def test_known_error_reason_is_rendered_specifically(self):
        request_id = await self._pending_agent_request()
        await self.bot._handle_agent_protocol(
            "SamsAgent", f"HERDER/1 ERROR {request_id} busy"
        )
        self.assertIn("at capacity", self.replies[-1][1])

    async def test_unknown_error_reason_falls_back_to_generic(self):
        request_id = await self._pending_agent_request()
        await self.bot._handle_agent_protocol(
            "SamsAgent", f"HERDER/1 ERROR {request_id} ReadTimeout"
        )
        self.assertIn("reported an error", self.replies[-1][1])

    async def test_undelivered_result_is_not_recorded_as_ok(self):
        recorded = {}

        class Recorder:
            def start_request(self, *args, **kwargs):
                return None

            def finish_request(self, request_id, **kwargs):
                recorded.update(kwargs)

            def agent_seen(self, *args, **kwargs):
                return None

        async def dropped(target, text):
            self.replies.append((target, text))
            return False

        async def completion(model, prompt):
            return Completion(text="a result nobody receives")

        self.bot.metrics = Recorder()
        self.bot.model_client.complete = completion
        await self.bot._run_local_request(
            "abcdef123456",
            "#general",
            "Alice",
            "Alice",
            self.bot.config.models["test"],
            "prompt",
        )
        self.bot._reply = dropped
        recorded.clear()
        await self.bot._run_local_request(
            "abcdef123457",
            "#general",
            "Alice",
            "Alice",
            self.bot.config.models["test"],
            "prompt",
        )
        self.assertEqual(recorded["status"], "undelivered")
        self.assertEqual(recorded["output_lines"], 0)

    async def test_local_usage_reaches_the_ledger(self):
        recorded = {}

        class Recorder:
            def start_request(self, *args, **kwargs):
                return None

            def finish_request(self, request_id, **kwargs):
                recorded.update(kwargs)

            def agent_seen(self, *args, **kwargs):
                return None

        async def completion(model, prompt):
            return Completion(
                text="ok", prompt_tokens=7, completion_tokens=8, total_tokens=15
            )

        self.bot.metrics = Recorder()
        self.bot.model_client.complete = completion
        await self.bot._run_local_request(
            "abcdef123458",
            "#general",
            "Alice",
            "Alice",
            self.bot.config.models["test"],
            "prompt",
        )
        self.assertEqual(recorded["status"], "ok")
        self.assertEqual(recorded["total_tokens"], 15)

    async def test_non_owner_cannot_control_herder(self):
        await self.bot._handle_privmsg(
            IRCMessage(
                tags={"account": "Bob"},
                prefix="Bob!user@host",
                command="PRIVMSG",
                params=("#general", "AlicesHerder: status"),
            )
        )
        self.assertEqual(self.replies, [])


class CaptureWriter:
    def __init__(self):
        self.payloads = []

    def is_closing(self):
        return False

    def write(self, payload):
        self.payloads.append(payload)

    async def drain(self):
        return None


class BotWireBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.bot = BotHerder(
            app_config(Path(self.temporary.name) / "heartbeat")
        )
        self.writer = CaptureWriter()
        self.bot.writer = self.writer

    async def asyncTearDown(self):
        await self.bot.model_client.close()
        self.temporary.cleanup()

    async def test_360_byte_chunks_fit_worst_case_privmsg_without_clipping(self):
        target = "#" + ("c" * 63)
        requester_nick = "N" * 32
        content = ("a" * 356) + "\U0001f642" + ("b" * 5000)
        chunks = chunk_completion(
            content,
            max_payload_bytes=360,
            max_output_bytes=4096,
            max_lines=15,
        )

        self.assertTrue(chunks)
        self.assertEqual(len(chunks[0].encode("utf-8")), 360)
        for chunk in chunks:
            expected_text = f"{requester_nick}: {chunk}"
            await self.bot._reply(target, expected_text)
            payload = self.writer.payloads[-1]
            self.assertLessEqual(len(payload), 512)
            self.assertTrue(payload.endswith(b"\r\n"))
            self.assertEqual(
                payload.decode("utf-8"),
                f"PRIVMSG {target} :{expected_text}\r\n",
            )

    async def test_send_raw_accepts_512_bytes_and_rejects_513(self):
        framing = "PRIVMSG #boundary :"
        accepted = framing + ("x" * (510 - len(framing.encode("utf-8"))))
        await self.bot._send_raw(accepted)
        self.assertEqual(len(self.writer.payloads[-1]), 512)

        with self.assertRaisesRegex(ValueError, "exceeds 512 bytes"):
            await self.bot._send_raw(accepted + "x")
