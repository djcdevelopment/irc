#!/usr/bin/env python3
"""Run sanitized live acceptance checks against Derek's AM4 BotHerder."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


PROJECT_DIR = Path(os.environ.get("OMEN_IRC_PROJECT_DIR", "/opt/omen-irc"))
BOOTSTRAP_FILE = Path(
    os.environ.get("OMEN_IRC_CONFIG_DIR", "/etc/omen-irc")
) / "bootstrap.json"
BOT_ENV_FILE = Path(
    os.environ.get("OMEN_IRC_CONFIG_DIR", "/etc/omen-irc")
) / "compute-bot.env"
ACCEPTANCE_CHANNEL = "#bot-collab-test"


def configured_bot_nick() -> str:
    """The primary companion's nick from the deployed bot configuration."""
    try:
        text = (PROJECT_DIR / "config" / "compute-bot" / "bot.toml").read_text(
            encoding="utf-8"
        )
    except OSError:
        return "DereksBotHerder"
    match = re.search(r'^nick\s*=\s*"([^"]+)"', text, re.MULTILINE)
    return match.group(1) if match else "DereksBotHerder"


BOT_NICK = configured_bot_nick()


class AcceptanceFailure(RuntimeError):
    pass


def compose_command() -> list[str]:
    if shutil.which("docker"):
        result = subprocess.run(
            ["docker", "compose", "version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode == 0:
            return ["docker", "compose"]
    candidates = sorted(Path("/home").glob("*/.docker/cli-plugins/docker-compose"))
    for candidate in candidates:
        if os.access(candidate, os.X_OK):
            return [str(candidate)]
    raise AcceptanceFailure("Docker Compose v2 is unavailable")


def parse_message(line: str) -> tuple[str, str, list[str]]:
    rest = line
    if rest.startswith("@"):
        _, _, rest = rest.partition(" ")
    prefix = ""
    if rest.startswith(":"):
        prefix, _, rest = rest[1:].partition(" ")
    middle, separator, trailing = rest.partition(" :")
    parts = middle.split()
    command = parts.pop(0).upper() if parts else ""
    if separator:
        parts.append(trailing)
    return prefix, command, parts


def message_wire_size_without_tags(line: str) -> int:
    """Return the IRCv3 512-byte message segment, excluding message tags."""
    message = line.partition(" ")[2] if line.startswith("@") else line
    return len((message + "\r\n").encode("utf-8"))


def message_tag_wire_size(line: str) -> int:
    """Return the IRCv3 tag section, including its leading @ and trailing space."""
    if not line.startswith("@"):
        return 0
    tags, separator, _ = line.partition(" ")
    return len((tags + separator).encode("utf-8"))


class IRCClient:
    def __init__(self, account: str, password: str) -> None:
        self.account = account
        self.password = password
        self.socket = socket.create_connection(("127.0.0.1", 6667), timeout=10)
        self.socket.settimeout(1)
        self.buffer = b""

    def close(self) -> None:
        try:
            self.send("QUIT :Acceptance complete")
        except OSError:
            pass
        self.socket.close()

    def send(self, line: str) -> None:
        if any(character in line for character in "\r\n\0"):
            raise ValueError("unsafe outgoing IRC line")
        payload = (line + "\r\n").encode("utf-8")
        if len(payload) > 512:
            raise ValueError("outgoing IRC line is too large")
        self.socket.sendall(payload)

    def read_line(self, timeout: float) -> tuple[str, int]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if b"\n" in self.buffer:
                raw, self.buffer = self.buffer.split(b"\n", 1)
                raw += b"\n"
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                prefix, command, params = parse_message(line)
                if command == "PING":
                    self.send(f"PONG :{params[-1] if params else ''}")
                    continue
                tag_size = message_tag_wire_size(line)
                if tag_size > 8191:
                    raise AcceptanceFailure(
                        f"IRCv3 message tags exceeded 8191 bytes ({tag_size})"
                    )
                return line, message_wire_size_without_tags(line)
            self.socket.settimeout(max(0.1, deadline - time.monotonic()))
            try:
                block = self.socket.recv(8192)
            except TimeoutError:
                break
            if not block:
                raise AcceptanceFailure("IRC server closed the connection")
            self.buffer += block
        raise TimeoutError

    def wait_for(self, predicate, timeout: float) -> tuple[str, int]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                line, size = self.read_line(deadline - time.monotonic())
            except TimeoutError:
                break
            if predicate(line):
                return line, size
        raise AcceptanceFailure("timed out waiting for expected IRC response")

    def login(self) -> None:
        self.send("CAP LS 302")
        self.send(f"NICK {self.account}")
        self.send(f"USER {self.account} 0 * :BotHerder acceptance")
        self.wait_for(
            lambda line: parse_message(line)[1] == "CAP"
            and " LS " in f" {line} ",
            10,
        )
        self.send("CAP REQ :sasl account-tag message-tags server-time")
        self.wait_for(
            lambda line: parse_message(line)[1] == "CAP"
            and " ACK " in f" {line} ",
            10,
        )
        self.send("AUTHENTICATE PLAIN")
        self.wait_for(
            lambda line: parse_message(line)[1] == "AUTHENTICATE", 10
        )
        payload = base64.b64encode(
            b"\0" + self.account.encode() + b"\0" + self.password.encode()
        ).decode("ascii")
        self.send(f"AUTHENTICATE {payload}")
        self.wait_for(lambda line: parse_message(line)[1] == "903", 10)
        self.send("CAP END")
        self.wait_for(lambda line: parse_message(line)[1] == "001", 10)
        self.send(f"JOIN {ACCEPTANCE_CHANNEL}")
        self.wait_for(
            lambda line: parse_message(line)[1] in {"366", "JOIN"}
            and ACCEPTANCE_CHANNEL in line,
            10,
        )
        self.send(f"INVITE {BOT_NICK} {ACCEPTANCE_CHANNEL}")

        def bot_is_present(line: str) -> bool:
            prefix, command, params = parse_message(line)
            return (
                command == "443" and ACCEPTANCE_CHANNEL in params
            ) or (
                command == "JOIN"
                and prefix.split("!", 1)[0].casefold() == BOT_NICK.casefold()
                and ACCEPTANCE_CHANNEL in params
            )

        self.wait_for(bot_is_present, 10)

    @staticmethod
    def bot_text(line: str) -> str | None:
        prefix, command, params = parse_message(line)
        if (
            command != "PRIVMSG"
            or len(params) < 2
            or prefix.split("!", 1)[0].casefold() != BOT_NICK.casefold()
        ):
            return None
        return params[1]

    def wait_for_bot(self, contains: str, timeout: float = 130) -> tuple[str, int]:
        folded = contains.casefold()
        line, size = self.wait_for(
            lambda candidate: (
                (text := self.bot_text(candidate)) is not None
                and folded in text.casefold()
            ),
            timeout,
        )
        return self.bot_text(line) or "", size

    def drain(self, seconds: float = 0.5) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                self.read_line(deadline - time.monotonic())
            except TimeoutError:
                return

    def collect_completion(self, timeout: float = 130) -> list[tuple[str, int]]:
        first_deadline = time.monotonic() + timeout
        messages: list[tuple[str, int]] = []
        while time.monotonic() < first_deadline:
            try:
                line, size = self.read_line(first_deadline - time.monotonic())
            except TimeoutError:
                break
            text = self.bot_text(line)
            if text is not None and "working" not in text.casefold():
                messages.append((text, size))
                break
        if not messages:
            raise AcceptanceFailure("bot returned no completion")

        idle_deadline = time.monotonic() + 2
        while time.monotonic() < idle_deadline:
            try:
                line, size = self.read_line(idle_deadline - time.monotonic())
            except TimeoutError:
                break
            text = self.bot_text(line)
            if text is not None:
                messages.append((text, size))
                idle_deadline = time.monotonic() + 2
        return messages


def credentials() -> tuple[str, str]:
    with BOOTSTRAP_FILE.open(encoding="utf-8") as handle:
        value = json.load(handle)
    return value["AdminAccount"], value["AdminPassword"]


def configured_secrets() -> tuple[str, ...]:
    secrets: list[str] = []
    with BOOTSTRAP_FILE.open(encoding="utf-8") as handle:
        bootstrap = json.load(handle)
    secrets.extend(
        str(value)
        for key, value in bootstrap.items()
        if "password" in key.casefold()
    )
    for line in BOT_ENV_FILE.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            secrets.append(line.split("=", 1)[1])
    return tuple(value for value in secrets if value)


def print_transcript(label: str, text: str) -> None:
    if any(secret in text for secret in configured_secrets()):
        raise AcceptanceFailure("a configured secret appeared in channel output")
    print(f"TRANSCRIPT {label}: {text}")


def start_anonymous_probe(compose: list[str], marker: str) -> subprocess.Popen:
    script = (
        "{ "
        "printf 'NICK AnonymousProbe\\r\\n'; "
        "printf 'USER anonymous 0 * :Unauthenticated probe\\r\\n'; "
        "sleep 1; "
        f"printf 'JOIN {ACCEPTANCE_CHANNEL}\\r\\n'; "
        "sleep 1; "
        f"printf 'PRIVMSG {ACCEPTANCE_CHANNEL} :{BOT_NICK}: "
        f"ask missing-model {marker}\\r\\n'; "
        "sleep 4; "
        "printf 'QUIT :done\\r\\n'; "
        "} | nc 127.0.0.1 6667"
    )
    return subprocess.Popen(
        compose
        + [
            "-f",
            str(PROJECT_DIR / "compose.am4.yaml"),
            "exec",
            "-T",
            "ergo",
            "sh",
            "-c",
            script,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def test_basic() -> None:
    account, password = credentials()
    compose = compose_command()
    client = IRCClient(account, password)
    try:
        client.login()
        print("PASS 1: authenticated acceptance client connected to Ergo")

        client.send(f"PRIVMSG {ACCEPTANCE_CHANNEL} :{BOT_NICK}: models")
        models, _ = client.wait_for_bot("gpt-oss-120b")
        print_transcript("models", models)
        print("PASS 2: addressed models command returned the seeded allow-list")

        client.send(
            f"PRIVMSG {ACCEPTANCE_CHANNEL} :{BOT_NICK}: ask gpt-oss-120b "
            "name one software architecture pattern"
        )
        working, _ = client.wait_for_bot("working")
        completion = client.collect_completion()
        if not any(text.strip() for text, _ in completion):
            raise AcceptanceFailure("simple completion was empty")
        print_transcript("ask-ack", working)
        print_transcript("ask-result", completion[0][0])
        print("PASS 3: gpt-oss-120b returned a non-empty completion")

        # A line that names no provider is treated as the question itself and
        # routed to the default model. The acknowledgement names the provider,
        # which is how a mistyped agent name stays visible.
        client.send(
            f"PRIVMSG {ACCEPTANCE_CHANNEL} :!ask what is a bloom filter?"
        )
        routed, _ = client.wait_for_bot("via gpt-oss-120b")
        print_transcript("default-route", routed)
        client.drain(3)
        print("PASS 4: bare !ask routed to the default model and named it")

        marker = f"anon-{int(time.time())}"
        anonymous = start_anonymous_probe(compose, marker)
        try:
            client.wait_for(
                lambda line: "AnonymousProbe" in line and marker in line,
                10,
            )
            silence_deadline = time.monotonic() + 3
            while time.monotonic() < silence_deadline:
                try:
                    line, _ = client.read_line(silence_deadline - time.monotonic())
                except TimeoutError:
                    break
                text = client.bot_text(line)
                if text is not None and "AnonymousProbe" in text:
                    raise AcceptanceFailure(
                        "bot responded to an unauthenticated account"
                    )
        finally:
            try:
                anonymous.wait(timeout=10)
            except subprocess.TimeoutExpired:
                anonymous.terminate()
        print("PASS 5: unauthenticated command received no bot response")

        long_completion = []
        for prompt in (
            "Explain Model-View-Controller in three detailed paragraphs with "
            "concrete responsibilities and tradeoffs.",
            "Compare layered architecture and hexagonal architecture in three "
            "detailed paragraphs with concrete examples.",
        ):
            client.send(
                f"PRIVMSG {ACCEPTANCE_CHANNEL} :{BOT_NICK}: "
                f"ask gpt-oss-120b {prompt}"
            )
            client.wait_for_bot("working")
            candidate = client.collect_completion()
            if len(candidate) >= 2 and not any(
                "try again later" in text.casefold() for text, _ in candidate
            ):
                long_completion = candidate
                break
        if len(long_completion) > 15:
            raise AcceptanceFailure("long completion exceeded 15 output lines")
        oversized = [
            (len(text.encode("utf-8")), size)
            for text, size in long_completion
            if size > 512
        ]
        if oversized:
            largest_text, largest_frame = max(
                oversized, key=lambda value: value[1]
            )
            raise AcceptanceFailure(
                "long completion emitted an oversized IRC message segment "
                f"(text={largest_text} bytes, non-tag-wire={largest_frame} bytes)"
            )
        if len(long_completion) < 2:
            raise AcceptanceFailure("long completion was not chunked")
        preview = " | ".join(text for text, _ in long_completion[:2])
        print_transcript("long-preview", preview)
        print(
            "PASS 7: long output was chunked into "
            f"{len(long_completion)} safe IRC lines; largest non-tag segment="
            f"{max(size for _, size in long_completion)} bytes"
        )

        # Capacity is consumed only for dispatchable requests, so an unknown
        # model name no longer costs the caller a slot. Throttling has to be
        # provoked with the seeded model. Send without waiting, then look past
        # the acknowledgements and completions for the refusal.
        for index in range(8):
            client.send(
                f"PRIVMSG {ACCEPTANCE_CHANNEL} :{BOT_NICK}: ask gpt-oss-120b "
                f"rate-test-{index}"
            )
        try:
            throttled, _ = client.wait_for_bot("rate limit", 90)
        except TimeoutError:
            raise AcceptanceFailure("per-account rate limiter did not throttle")
        print_transcript("throttle", throttled)
        print("PASS 6: per-account rate limit produced a throttle notice")
        # Six accepted requests are still running; let them settle so they do
        # not bleed into the next check.
        client.drain(5)
        print("PASS 9: no configured secret appeared in captured channel output")
    finally:
        client.close()


def model_service(action: str) -> None:
    subprocess.run(
        [
            "runuser",
            "-u",
            "derek",
            "--",
            "env",
            "XDG_RUNTIME_DIR=/run/user/1000",
            "systemctl",
            "--user",
            action,
            "b70-moe.service",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
    )


def wait_for_model(timeout: float = 900) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:8082/health", timeout=5
            ) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(5)
    raise AcceptanceFailure("model endpoint did not return after restart")


def test_disruption() -> None:
    account, password = credentials()
    client = IRCClient(account, password)
    model_stopped = False
    try:
        client.login()
        client.send(
            f"PRIVMSG {ACCEPTANCE_CHANNEL} :{BOT_NICK}: ask gpt-oss-120b "
            "Explain the circuit breaker pattern in three sentences."
        )
        working, _ = client.wait_for_bot("working")
        print_transcript("disruption-ack", working)
        model_service("stop")
        model_stopped = True
        failure, _ = client.wait_for_bot("unavailable", timeout=130)
        print_transcript("endpoint-down", failure)
        client.send(f"PRIVMSG {ACCEPTANCE_CHANNEL} :{BOT_NICK}: help")
        client.wait_for_bot("ask <model-or-agent>", timeout=10)
        print("PASS 8a: endpoint loss returned a graceful error; bot stayed connected")
    finally:
        if model_stopped:
            model_service("start")
            wait_for_model()

    recovery = IRCClient(account, password)
    try:
        recovery.login()
        recovery.send(
            f"PRIVMSG {ACCEPTANCE_CHANNEL} :{BOT_NICK}: ask gpt-oss-120b "
            "name one software architecture pattern"
        )
        recovery.wait_for_bot("working")
        completion = recovery.collect_completion()
        if any(
            marker in text.casefold()
            for text, _ in completion
            for marker in (
                "try again later",
                "timed out",
                "returned no completion",
                "request failed",
            )
        ):
            raise AcceptanceFailure("recovery request returned a model error")
        print_transcript("recovery-result", completion[0][0])
        print("PASS 8b: restarted endpoint completed the next request")
    finally:
        recovery.close()


def test_recovery_only() -> None:
    wait_for_model()
    account, password = credentials()
    client = IRCClient(account, password)
    try:
        client.login()
        client.send(
            f"PRIVMSG {ACCEPTANCE_CHANNEL} :{BOT_NICK}: ask gpt-oss-120b "
            "name one software architecture pattern"
        )
        client.wait_for_bot("working")
        completion = client.collect_completion()
        if any(
            "try again later" in text.casefold() for text, _ in completion
        ):
            raise AcceptanceFailure("recovery request returned a model error")
        print_transcript("recovery-result", completion[0][0])
        print("PASS 8b: restarted endpoint completed the next request")
    finally:
        client.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--disrupt-model",
        action="store_true",
        help="run the coordinated stop/restart resilience test",
    )
    mode.add_argument(
        "--recovery-only",
        action="store_true",
        help="wait for the restarted model and verify the recovery request",
    )
    arguments = parser.parse_args()
    if os.geteuid() != 0:
        raise AcceptanceFailure("run with sudo so protected credentials stay local")
    if arguments.disrupt_model:
        test_disruption()
    elif arguments.recovery_only:
        test_recovery_only()
    else:
        test_basic()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AcceptanceFailure as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1)
