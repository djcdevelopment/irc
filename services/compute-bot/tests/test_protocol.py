import unittest

from compute_bridge.protocol import parse_irc_line


class ProtocolTests(unittest.TestCase):
    def test_parses_authenticated_privmsg(self):
        message = parse_irc_line(
            "@account=Alice;time=2026-07-30T00:00:00.000Z "
            ":Alice!user@example PRIVMSG #general :!models\r\n"
        )
        self.assertEqual(message.command, "PRIVMSG")
        self.assertEqual(message.tags["account"], "Alice")
        self.assertEqual(message.nick, "Alice")
        self.assertEqual(message.params, ("#general", "!models"))

    def test_parses_valueless_tag_and_escapes(self):
        message = parse_irc_line(
            r"@example;label=hello\sworld\:x :server NOTICE nick :ok"
        )
        self.assertIsNone(message.tags["example"])
        self.assertEqual(message.tags["label"], "hello world;x")

    def test_rejects_tag_only_line(self):
        with self.assertRaises(ValueError):
            parse_irc_line("@account=alice")
