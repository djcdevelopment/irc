from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class IRCMessage:
    tags: dict[str, str | None]
    prefix: str | None
    command: str
    params: tuple[str, ...]

    @property
    def nick(self) -> str:
        if not self.prefix:
            return ""
        return self.prefix.split("!", 1)[0]


def _unescape_tag(value: str) -> str:
    replacements = {
        ":": ";",
        "s": " ",
        "\\": "\\",
        "r": "\r",
        "n": "\n",
    }
    output: list[str] = []
    index = 0
    while index < len(value):
        if value[index] == "\\" and index + 1 < len(value):
            index += 1
            output.append(replacements.get(value[index], value[index]))
        else:
            output.append(value[index])
        index += 1
    return "".join(output)


def parse_irc_line(line: str) -> IRCMessage:
    rest = line.rstrip("\r\n")
    tags: dict[str, str | None] = {}
    prefix: str | None = None

    if rest.startswith("@"):
        tag_block, separator, rest = rest[1:].partition(" ")
        if not separator:
            raise ValueError("IRC tag block has no command")
        for raw_tag in tag_block.split(";"):
            key, equals, value = raw_tag.partition("=")
            if key:
                tags[key] = _unescape_tag(value) if equals else None

    if rest.startswith(":"):
        prefix, separator, rest = rest[1:].partition(" ")
        if not separator:
            raise ValueError("IRC prefix has no command")

    middle, trailing_separator, trailing = rest.partition(" :")
    parts = middle.split()
    if not parts:
        raise ValueError("IRC line has no command")
    command = parts.pop(0).upper()
    if trailing_separator:
        parts.append(trailing)
    return IRCMessage(tags=tags, prefix=prefix, command=command, params=tuple(parts))
