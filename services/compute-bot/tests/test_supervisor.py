import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType

from compute_bridge.config import (
    AppConfig,
    CommunityConfig,
    HealthConfig,
    IRCConfig,
    LimitsConfig,
    ModelConfig,
    StorefrontConfig,
)
from compute_bridge.supervisor import HerderSupervisor


def base_config(heartbeat_path):
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
            nick="DereksBotHerder",
            account="DereksBotHerder",
            password_env="IRC_BOT_PASSWORD",
            password="password",
            owner_account="derek",
            access_mode="authenticated",
            channels=("#general", "#ops"),
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
        storefront=StorefrontConfig(
            channel="#herder-derek",
            about="Derek's BotHerder — the primary owner introduction.",
            color=True,
        ),
    )


class MemberConfigTests(unittest.TestCase):
    def setUp(self):
        # The supervisor's metrics store keeps its database open; on Windows
        # that must not fail directory cleanup.
        self.temporary = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        root = Path(self.temporary.name)
        self.members_dir = root / "members"
        self.members_dir.mkdir()
        self.supervisor = HerderSupervisor(
            base_config(root / "heartbeat"),
            members_dir=self.members_dir,
            metrics_path=root / "metrics.sqlite",
        )

    def tearDown(self):
        self.temporary.cleanup()

    def _member_file(self, extra=None):
        member = {
            "schema_version": 1,
            "owner_account": "sam",
            "display_name": "Sam",
            "account": "SamsHerder",
            "nick": "SamsHerder",
            "irc_password": "member-password",
            "channels": ["#general", "#ops", "#herder-sam"],
            "access_mode": "owner",
        }
        member.update(extra or {})
        path = self.members_dir / "SamsHerder.json"
        path.write_text(json.dumps(member), encoding="utf-8")
        return path

    def test_member_does_not_inherit_the_primary_storefront(self):
        # Regression: every member bot used to inherit the primary's
        # [storefront] table, join #herder-derek, and answer !about with the
        # primary owner's introduction.
        config = self.supervisor._member_config(self._member_file())
        self.assertEqual(config.storefront.channel, "")
        self.assertEqual(config.storefront.about, "")
        self.assertEqual(config.irc.account, "SamsHerder")
        self.assertIn("#herder-sam", config.irc.channels)
        self.assertNotIn("#herder-derek", config.irc.channels)

    def test_member_storefront_channel_field_is_honored(self):
        config = self.supervisor._member_config(
            self._member_file({"storefront_channel": "#lab-sam"})
        )
        self.assertEqual(config.storefront.channel, "#lab-sam")

    def test_member_color_toggle_follows_the_base_config(self):
        config = self.supervisor._member_config(self._member_file())
        self.assertTrue(config.storefront.color)
        self.supervisor.base_config = replace(
            self.supervisor.base_config,
            storefront=replace(
                self.supervisor.base_config.storefront, color=False
            ),
        )
        config = self.supervisor._member_config(self._member_file())
        self.assertFalse(config.storefront.color)

    def test_invalid_member_storefront_channel_is_rejected(self):
        for value in ("lab-sam", "#bad channel", 7):
            with self.assertRaises(ValueError):
                self.supervisor._member_config(
                    self._member_file({"storefront_channel": value})
                )


if __name__ == "__main__":
    unittest.main()
