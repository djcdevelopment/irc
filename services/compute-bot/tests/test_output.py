import unittest

from compute_bridge.output import (
    TRUNCATION_MARKER,
    chunk_completion,
    format_bytes,
    truncation_marker,
)


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
        self.assertTrue(chunks[-1].startswith("… (truncated"))

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
        self.assertTrue(chunks[-1].startswith("… (truncated"))

    def test_truncation_marker_names_the_full_size(self):
        content = "x" * 20000
        chunks = chunk_completion(
            content,
            max_payload_bytes=360,
            max_output_bytes=4096,
            max_lines=15,
        )
        self.assertEqual(chunks[-1], truncation_marker(20000))
        self.assertIn("19.5KiB", chunks[-1])

    def test_untruncated_output_has_no_marker(self):
        chunks = chunk_completion(
            "short answer",
            max_payload_bytes=360,
            max_output_bytes=4096,
            max_lines=15,
        )
        self.assertEqual(chunks, ["short answer"])

    def test_markdown_table_flattens_to_informative_lines(self):
        content = "\n".join(
            [
                "## 1. A Quick Biography",
                "",
                "| Year | Milestone |",
                "|------|-----------|",
                "| **1945** | Born in New York City. |",
                "| **1979** | Published *Gödel, Escher, Bach*. |",
                "---",
                "## 2. Core Ideas",
            ]
        )
        chunks = chunk_completion(
            content,
            max_payload_bytes=360,
            max_output_bytes=4096,
            max_lines=15,
        )
        self.assertEqual(
            chunks,
            [
                "1. A Quick Biography",
                "Year — Milestone",
                "1945 — Born in New York City.",
                "1979 — Published Gödel, Escher, Bach.",
                "2. Core Ideas",
            ],
        )

    def test_emphasis_markers_are_stripped(self):
        chunks = chunk_completion(
            "**bold** and *italic* and ***both***",
            max_payload_bytes=360,
            max_output_bytes=4096,
            max_lines=15,
        )
        self.assertEqual(chunks, ["bold and italic and both"])

    def test_code_identifiers_survive_flattening(self):
        content = "set max_output_bytes and pass **args and **kwargs to __init__"
        chunks = chunk_completion(
            content,
            max_payload_bytes=360,
            max_output_bytes=4096,
            max_lines=15,
        )
        self.assertEqual(chunks, [content])

    def test_code_fences_go_but_the_code_stays(self):
        chunks = chunk_completion(
            "```python\nprint('hi')\n```",
            max_payload_bytes=360,
            max_output_bytes=4096,
            max_lines=15,
        )
        self.assertEqual(chunks, ["print('hi')"])

    def test_flattening_keeps_a_table_inside_the_line_budget(self):
        rows = "\n".join(f"| {year} | milestone {year} |" for year in range(1900, 1912))
        content = f"## Timeline\n\n| Year | Milestone |\n|---|---|\n{rows}\n---\n## Next"
        chunks = chunk_completion(
            content,
            max_payload_bytes=360,
            max_output_bytes=4096,
            max_lines=15,
        )
        self.assertNotIn(TRUNCATION_MARKER[:-1], chunks[-1])
        self.assertEqual(chunks[-1], "Next")

    def test_format_bytes_scales(self):
        self.assertEqual(format_bytes(512), "512B")
        self.assertEqual(format_bytes(2048), "2.0KiB")
        self.assertEqual(format_bytes(3 * 1024 * 1024), "3.0MiB")

    def test_legacy_marker_prefix_is_preserved(self):
        self.assertTrue(truncation_marker(10).startswith(TRUNCATION_MARKER[:-1]))

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
