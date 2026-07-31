#!/usr/bin/env python3
"""Verify that BotHerder's deterministic and generated provenance agree."""

from __future__ import annotations

import runpy
from pathlib import Path


support = runpy.run_path(
    str(Path(__file__).with_name("acceptance-compute-bot-am4.py"))
)
IRCClient = support["IRCClient"]
credentials = support["credentials"]
print_transcript = support["print_transcript"]


def main() -> int:
    account, password = credentials()
    client = IRCClient(account, password)
    try:
        client.login()
        client.send(
            "PRIVMSG #bot-collab-test :DereksBotHerder: status"
        )
        status, _ = client.wait_for_bot("execution=hearth")
        print_transcript("provenance-status", status)

        client.send(
            "PRIVMSG #bot-collab-test :DereksBotHerder: ask "
            "are you using HEARTH now, or the direct model endpoint?"
        )
        acknowledgement, _ = client.wait_for_bot("working")
        completion = client.collect_completion()
        answer = " | ".join(text for text, _ in completion)

        print_transcript("provenance-ack", acknowledgement)
        print_transcript("provenance-answer", answer)

        if "through HEARTH" not in acknowledgement:
            raise support["AcceptanceFailure"](
                "working acknowledgement omitted canonical HEARTH provenance"
            )
        folded = answer.casefold()
        if "hearth" not in folded:
            raise support["AcceptanceFailure"](
                "completion did not acknowledge its HEARTH execution context"
            )
        contradictions = (
            "not running on hearth",
            "not using hearth",
            "use the direct model endpoint",
            "using the direct model endpoint",
        )
        if any(phrase in folded for phrase in contradictions):
            raise support["AcceptanceFailure"](
                "completion contradicted canonical execution provenance"
            )
    finally:
        client.close()

    print("PASS: deterministic acknowledgement and generated answer agree on HEARTH")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
