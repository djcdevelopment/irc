import unittest

from compute_bridge.output import TRUNCATION_MARKER, chunk_completion


class OutputTests(unittest.TestCase):
    def test_utf8_chunks_stay_within_limits(self):
        chunks = chunk_completion(
            "🙂" * 200,
            max_payload_bytes=37,
            max_output_bytes=600,
            max_lines=15,
        )
        self.assertLessEqual(len(chunks), 15)
        self.assertTrue(all(len(chunk.encode("utf-8")) <= 37 for chunk in chunks))
        self.assertEqual(chunks[-1], TRUNCATION_MARKER)

    def test_controls_are_removed(self):
        chunks = chunk_completion(
            "alpha\0beta\r\ngamma\x07",
            max_payload_bytes=100,
            max_output_bytes=1000,
            max_lines=15,
        )
        joined = " ".join(chunks)
        self.assertNotIn("\0", joined)
        self.assertNotIn("\r", joined)
        self.assertNotIn("\x07", joined)

    def test_line_limit_has_marker(self):
        chunks = chunk_completion(
            "\n".join(f"line {index}" for index in range(30)),
            max_payload_bytes=100,
            max_output_bytes=4096,
            max_lines=5,
        )
        self.assertEqual(len(chunks), 5)
        self.assertEqual(chunks[-1], TRUNCATION_MARKER)

    def test_360_byte_boundary_does_not_split_utf8(self):
        content = ("a" * 356) + "\U0001f642" + ("b" * 800)
        chunks = chunk_completion(
            content,
            max_payload_bytes=360,
            max_output_bytes=4096,
            max_lines=15,
        )
        self.assertEqual(len(chunks[0].encode("utf-8")), 360)
        self.assertTrue(all(len(chunk.encode("utf-8")) <= 360 for chunk in chunks))
        self.assertNotIn("\ufffd", "".join(chunks))
