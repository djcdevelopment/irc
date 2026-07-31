import unittest

from compute_bridge import ircfmt
from compute_bridge.ircfmt import Formatter
from compute_bridge.output import chunk_completion


class FormatterTests(unittest.TestCase):
    def test_colored_fragment_uses_two_digit_code_and_reset(self):
        fmt = Formatter(enabled=True, accent=3)
        self.assertEqual(fmt.accent("lab"), "\x0303lab\x0f")

    def test_colored_fragment_costs_exactly_four_bytes(self):
        fmt = Formatter(enabled=True, accent=11)
        for text in ("x", "some longer value", "42"):
            self.assertEqual(
                len(fmt.accent(text).encode("utf-8")),
                len(text.encode("utf-8")) + 4,
            )

    def test_disabled_formatter_emits_zero_control_characters(self):
        fmt = Formatter(enabled=False, accent=4)
        rendered = " ".join(
            (
                fmt.accent("a"),
                fmt.kv("key", "value"),
                fmt.kv_line(("a", 1), ("b", 2)),
                fmt.header("Lab", "tagline"),
                fmt.status_word("failed"),
                fmt.bold("b"),
                fmt.alert("!"),
            )
        )
        self.assertFalse(any(ord(character) < 32 for character in rendered))
        self.assertIn("key=value", rendered)

    def test_invalid_accent_falls_back_to_default(self):
        self.assertEqual(Formatter(accent=99).accent_code, ircfmt.DEFAULT_ACCENT)
        self.assertEqual(Formatter(accent=-1).accent_code, ircfmt.DEFAULT_ACCENT)
        self.assertEqual(Formatter(accent=0).accent_code, 0)

    def test_leading_comma_is_guarded_from_background_parsing(self):
        fmt = Formatter(enabled=True, accent=11)
        self.assertEqual(fmt.accent(",5x"), "\x0311\x02\x02,5x\x0f")

    def test_leading_digit_is_safe_behind_two_digit_code(self):
        fmt = Formatter(enabled=True, accent=3)
        self.assertEqual(fmt.accent("30b"), "\x030330b\x0f")

    def test_status_words_map_to_semantic_colors(self):
        fmt = Formatter(enabled=True)
        self.assertTrue(
            fmt.status_word("succeeded").startswith(f"\x03{ircfmt.OK:02d}")
        )
        self.assertTrue(
            fmt.status_word("FAILED").startswith(f"\x03{ircfmt.ALERT:02d}")
        )
        self.assertTrue(
            fmt.status_word("running").startswith(f"\x03{ircfmt.WARN:02d}")
        )
        self.assertEqual(fmt.status_word("novel"), "novel")

    def test_empty_text_is_untouched(self):
        fmt = Formatter(enabled=True)
        self.assertEqual(fmt.accent(""), "")
        self.assertEqual(fmt.bold(""), "")

    def test_model_output_path_still_strips_formatting(self):
        # The anti-spoofing boundary: nothing a model emits may carry mIRC
        # codes into a channel, no matter what the storefront layer renders.
        chunks = chunk_completion(
            "hello \x02bold\x02 \x0304red\x0f world",
            max_payload_bytes=360,
            max_output_bytes=4096,
            max_lines=15,
        )
        joined = " ".join(chunks)
        self.assertFalse(any(ord(character) < 32 for character in joined))
        self.assertIn("hello", joined)
        self.assertIn("world", joined)


if __name__ == "__main__":
    unittest.main()
