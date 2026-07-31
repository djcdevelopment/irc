"""mIRC formatting for bot-composed storefront lines.

Color here is presentation applied ONLY to text the Herder itself composes.
Model and remote-agent output still flows through output.chunk_completion,
which strips every control character — that boundary is what stops a model
or agent from spoofing another identity's colors, and nothing in this module
weakens it.

Palette discipline (color with purpose, not decoration):
- labels are dim grey, values stay the client's default color;
- green, orange, and red are reserved for state;
- exactly one accent color per lab, chosen by the owner (mIRC index 0-15).
"""

from __future__ import annotations

BOLD = "\x02"
COLOR = "\x03"
RESET = "\x0f"

WHITE = 0
BLACK = 1
NAVY = 2
GREEN = 3
RED = 4
MAROON = 5
PURPLE = 6
ORANGE = 7
YELLOW = 8
LIGHT_GREEN = 9
TEAL = 10
CYAN = 11
BLUE = 12
MAGENTA = 13
GREY = 14
LIGHT_GREY = 15

LABEL = GREY
OK = GREEN
WARN = ORANGE
ALERT = RED
DEFAULT_ACCENT = CYAN

_OK_WORDS = {"succeeded", "ok", "active", "live", "online", "awake", "healthy"}
_WARN_WORDS = {"running", "pending", "queued", "provisioning", "stale", "cold"}
_ALERT_WORDS = {"failed", "cancelled", "expired", "rejected", "error", "revoked"}


class Formatter:
    """Renders semantic fragments; a disabled formatter emits plain text.

    Every colored fragment costs 4 bytes (three for the two-digit color
    introducer, one for the reset) against the 510-byte IRC line budget, so
    callers keep colored fragments short and few.
    """

    def __init__(
        self, *, enabled: bool = True, accent: int = DEFAULT_ACCENT
    ) -> None:
        self.enabled = enabled
        self.accent_code = accent if 0 <= accent <= 15 else DEFAULT_ACCENT

    def color(self, text: str, code: int) -> str:
        if not self.enabled or not text:
            return text
        # Two-digit codes keep a leading digit in the text from being eaten;
        # a doubled bold (a no-op) guards a leading comma from becoming a
        # background color.
        guard = f"{BOLD}{BOLD}" if text.startswith(",") else ""
        return f"{COLOR}{code:02d}{guard}{text}{RESET}"

    def bold(self, text: str) -> str:
        if not self.enabled or not text:
            return text
        return f"{BOLD}{text}{BOLD}"

    def label(self, text: str) -> str:
        return self.color(text, LABEL)

    def ok(self, text: str) -> str:
        return self.color(text, OK)

    def warn(self, text: str) -> str:
        return self.color(text, WARN)

    def alert(self, text: str) -> str:
        return self.color(text, ALERT)

    def accent(self, text: str) -> str:
        return self.color(text, self.accent_code)

    def kv(self, name: str, value: object) -> str:
        """A dim label with a plain value: the retro ls(1) look."""
        return f"{self.label(f'{name}=')}{value}"

    def kv_line(self, *pairs: tuple[str, object]) -> str:
        return self.label("; ").join(self.kv(name, value) for name, value in pairs)

    def status_word(self, word: str) -> str:
        folded = word.casefold()
        if folded in _OK_WORDS:
            return self.ok(word)
        if folded in _WARN_WORDS:
            return self.warn(word)
        if folded in _ALERT_WORDS:
            return self.alert(word)
        return word

    def header(self, lab_name: str, tagline: str = "") -> str:
        name = self.bold(self.accent(lab_name))
        return f"{name} — {tagline}" if tagline else name


PLAIN = Formatter(enabled=False)
