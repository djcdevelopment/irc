import tempfile
import textwrap
import unittest
from pathlib import Path

from compute_bridge.config import ConfigError, load_config


BOT_CONFIG = """
[irc]
server = "127.0.0.1"
port = 6667
nick = "ComputeBot"
account = "ComputeBot"
password_env = "IRC_BOT_PASSWORD"
owner_account = "Alice"
access_mode = "owner"
channels = ["#general"]

[community]
portal_url = "http://127.0.0.1:9010"
guide_url = "https://community.example/guide/"
internal_token_env = "COMMUNITY_INTERNAL_TOKEN"

[limits]
requests_per_minute = 6
irc_payload_bytes = 360

[health]
heartbeat_path = "/tmp/test-heartbeat"
"""

MODELS_CONFIG = """
[models.gpt-oss-120b]
endpoint = "http://127.0.0.1:8082/v1"
api_key_env = "MODEL_KEY"
max_tokens = 256
min_max_tokens = 512
description = "Reasoning model"
"""


COMPLETION_CONFIG = '''
[completion]
system_prompt = """
Plain text only. \\
No tables.
"""
'''


class ConfigTests(unittest.TestCase):
    def _load(self, bot=BOT_CONFIG, models=MODELS_CONFIG, env=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bot_path = root / "bot.toml"
            models_path = root / "models.toml"
            bot_path.write_text(textwrap.dedent(bot), encoding="utf-8")
            models_path.write_text(textwrap.dedent(models), encoding="utf-8")
            return load_config(
                bot_path,
                models_path,
                env
                or {
                    "IRC_BOT_PASSWORD": "irc-secret",
                    "MODEL_KEY": "model-secret",
                    "COMMUNITY_INTERNAL_TOKEN": "internal-secret",
                },
            )

    def test_loads_and_enforces_reasoning_floor(self):
        config = self._load()
        self.assertEqual(config.models["gpt-oss-120b"].effective_max_tokens, 512)
        self.assertEqual(config.limits.irc_payload_bytes, 360)
        self.assertEqual(
            config.community.guide_url, "https://community.example/guide/"
        )
        self.assertNotIn("irc-secret", repr(config))
        self.assertNotIn("model-secret", repr(config))
        self.assertNotIn("internal-secret", repr(config))

    def test_system_prompt_is_absent_by_default(self):
        self.assertEqual(self._load().system_prompt, "")

    def test_system_prompt_is_joined_and_trimmed(self):
        config = self._load(bot=BOT_CONFIG + COMPLETION_CONFIG)
        self.assertEqual(config.system_prompt, "Plain text only. No tables.")

    def test_storefront_presentation_is_loaded(self):
        config = self._load(
            bot=BOT_CONFIG
            + """
[storefront]
channel = "#herder-alice"
about = "  Alice's model workshop.  "
"""
        )
        self.assertEqual(config.storefront.channel, "#herder-alice")
        self.assertEqual(config.storefront.about, "Alice's model workshop.")

    def test_invalid_storefront_channel_is_rejected(self):
        with self.assertRaisesRegex(ConfigError, "storefront.channel"):
            self._load(
                bot=BOT_CONFIG
                + """
[storefront]
channel = "herder alice"
"""
            )

    def test_oversized_system_prompt_is_rejected(self):
        oversized = "x" * 2049
        with self.assertRaisesRegex(ConfigError, "system_prompt"):
            self._load(
                bot=f'{BOT_CONFIG}\n[completion]\nsystem_prompt = "{oversized}"\n'
            )

    def test_missing_secret_is_rejected_without_value(self):
        with self.assertRaisesRegex(ConfigError, "MODEL_KEY"):
            self._load(
                env={
                    "IRC_BOT_PASSWORD": "present",
                    "COMMUNITY_INTERNAL_TOKEN": "internal-secret",
                }
            )

    def test_endpoint_must_be_v1_base(self):
        invalid = MODELS_CONFIG.replace(
            "http://127.0.0.1:8082/v1", "file:///tmp/model"
        )
        with self.assertRaisesRegex(ConfigError, "endpoint"):
            self._load(models=invalid)

    def test_remote_guide_url_requires_https(self):
        invalid = BOT_CONFIG.replace(
            "https://community.example/guide/",
            "http://community.example/guide/",
        )
        with self.assertRaisesRegex(ConfigError, "guide_url"):
            self._load(bot=invalid)

    def test_model_name_is_safe(self):
        invalid = MODELS_CONFIG.replace(
            "[models.gpt-oss-120b]", '[models."bad model"]'
        )
        with self.assertRaisesRegex(ConfigError, "registry name"):
            self._load(models=invalid)

    def test_hearth_mode_requires_https_and_hearth_key_but_not_model_key(self):
        bot = BOT_CONFIG + """
[hearth]
mode = "hearth"
endpoint = "https://omen.tail.example:8443/mcp"
api_key_env = "HEARTH_API_KEY"
"""
        config = self._load(
            bot=bot,
            env={
                "IRC_BOT_PASSWORD": "present",
                "COMMUNITY_INTERNAL_TOKEN": "internal-secret",
                "HEARTH_API_KEY": "hearth-secret",
            },
        )
        self.assertEqual("hearth", config.hearth.mode)
        self.assertEqual("", config.models["gpt-oss-120b"].api_key)
        self.assertNotIn("hearth-secret", repr(config))
        self.assertIn("hearth-secret", config.secrets)

    def test_shadow_mode_still_requires_direct_model_key(self):
        bot = BOT_CONFIG + """
[hearth]
mode = "shadow"
endpoint = "https://omen.tail.example:8443/mcp"
api_key_env = "HEARTH_API_KEY"
"""
        with self.assertRaisesRegex(ConfigError, "MODEL_KEY"):
            self._load(
                bot=bot,
                env={
                    "IRC_BOT_PASSWORD": "present",
                    "COMMUNITY_INTERNAL_TOKEN": "internal-secret",
                    "HEARTH_API_KEY": "hearth-secret",
                },
            )

    def test_remote_hearth_plaintext_is_rejected(self):
        bot = BOT_CONFIG + """
[hearth]
mode = "hearth"
endpoint = "http://omen.tail.example:8443/mcp"
api_key_env = "HEARTH_API_KEY"
"""
        with self.assertRaisesRegex(ConfigError, "must use HTTPS"):
            self._load(
                bot=bot,
                env={
                    "IRC_BOT_PASSWORD": "present",
                    "COMMUNITY_INTERNAL_TOKEN": "internal-secret",
                    "HEARTH_API_KEY": "hearth-secret",
                },
            )
