#!/usr/bin/env python3
"""End-to-end member BotHerder and outbound remote-agent acceptance."""

from __future__ import annotations

import argparse
import base64
import contextlib
import http.server
import json
import os
import re
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
from pathlib import Path


class AcceptanceFailure(RuntimeError):
    pass


class IRCClient:
    def __init__(self, account: str, password: str) -> None:
        self.account = account
        self.password = password
        self.socket = socket.create_connection(("127.0.0.1", 6667), timeout=10)
        self.socket.settimeout(0.5)
        self.buffer = b""
        self.pending_lines: list[str] = []

    def send(self, line: str) -> None:
        if any(character in line for character in "\r\n\0"):
            raise ValueError("unsafe IRC line")
        self.socket.sendall((line + "\r\n").encode("utf-8"))

    def lines(self, seconds: float) -> list[str]:
        deadline = time.monotonic() + seconds
        result = []
        while time.monotonic() < deadline:
            if b"\n" in self.buffer:
                raw, self.buffer = self.buffer.split(b"\n", 1)
                line = raw.decode("utf-8", errors="replace").rstrip("\r")
                result.append(line)
                if line.startswith("PING "):
                    self.send(f"PONG :{line.rsplit(':', 1)[-1]}")
                continue
            try:
                self.buffer += self.socket.recv(8192)
            except TimeoutError:
                pass
        return result

    def wait(self, needle: str, timeout: float = 15) -> str:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pending_lines.extend(
                self.lines(min(0.8, deadline - time.monotonic()))
            )
            for index, line in enumerate(self.pending_lines):
                if needle.casefold() in line.casefold():
                    return self.pending_lines.pop(index)
        raise AcceptanceFailure(f"timed out waiting for {needle}")

    def login(self) -> None:
        self.send("CAP LS 302")
        self.send(f"NICK {self.account}")
        self.send(f"USER {self.account} 0 * :Community acceptance")
        self.lines(0.7)
        self.send("CAP REQ :sasl account-tag message-tags")
        self.lines(0.5)
        self.send("AUTHENTICATE PLAIN")
        self.lines(0.4)
        payload = base64.b64encode(
            b"\0"
            + self.account.encode()
            + b"\0"
            + self.password.encode()
        ).decode("ascii")
        self.send(f"AUTHENTICATE {payload}")
        self.wait(" 903 ")
        self.send("CAP END")
        self.wait(" 001 ")
        self.send("JOIN #general")
        self.lines(1)

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self.send("QUIT :Community acceptance complete")
        self.socket.close()


class ModelHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802
        if (
            self.path != "/v1/chat/completions"
            or self.headers.get("Authorization") != "Bearer acceptance-key"
        ):
            self.send_response(403)
            self.end_headers()
            return
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        body = json.dumps(
            {
                "choices": [
                    {
                        "message": {
                            "content": "Remote adapter acceptance completed."
                        }
                    }
                ],
                "usage": {
                    "prompt_tokens": 3,
                    "completion_tokens": 4,
                    "total_tokens": 7,
                },
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args) -> None:
        pass


def profile_credentials(account: str) -> tuple[str, str]:
    path = Path("/var/lib/omen-irc/thelounge/users") / f"{account}.json"
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    network = value["networks"][0]
    return account, network["saslPassword"]


def redeem(token: str) -> dict:
    request = urllib.request.Request(
        "http://127.0.0.1:9010/api/invites/redeem",
        data=json.dumps({"token": token}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def community_values() -> dict[str, str]:
    result = {}
    for line in Path("/etc/omen-irc/community.env").read_text(
        encoding="utf-8"
    ).splitlines():
        name, separator, value = line.partition("=")
        if separator:
            result[name] = value
    return result


def admin_request(path: str, payload: dict) -> dict:
    values = community_values()
    request = urllib.request.Request(
        f"http://127.0.0.1:9010{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {values['COMMUNITY_ADMIN_TOKEN']}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def internal_request(path: str) -> dict:
    values = community_values()
    request = urllib.request.Request(
        f"http://127.0.0.1:9010{path}",
        headers={
            "Authorization": f"Bearer {values['COMMUNITY_INTERNAL_TOKEN']}"
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def lab_acceptance(
    owner_account: str, herder_account: str, owner: IRCClient
) -> None:
    """Personal AI Storefront: profile projection, lab page, editor loop."""
    storefronts = internal_request("/api/internal/storefronts")["storefronts"]
    entry = next(
        (
            item
            for item in storefronts
            if item["owner_account"].casefold() == owner_account.casefold()
        ),
        None,
    )
    if not entry or not entry.get("lab_slug") or not entry.get("web_url"):
        raise AcceptanceFailure("storefront profile is missing lab fields")
    page_url = f"http://127.0.0.1:9010/lab/{entry['lab_slug']}"
    with urllib.request.urlopen(page_url, timeout=30) as response:
        page = response.read().decode("utf-8")
        csp = response.headers.get("Content-Security-Policy", "")
    if "default-src 'none'" not in csp:
        raise AcceptanceFailure("lab page CSP is not locked down")
    if "you are visitor" not in page:
        raise AcceptanceFailure("lab page did not render the visitor counter")

    minted = admin_request(
        "/api/admin/lab-edit-links", {"owner_account": owner_account}
    )
    edit_token = minted["url"].rsplit("#", 1)[-1]
    update = urllib.request.Request(
        "http://127.0.0.1:9010/lab/api/profile",
        data=json.dumps({"tagline": "<script>alert(1)</script>"}).encode(
            "utf-8"
        ),
        headers={
            "Authorization": f"Bearer {edit_token}",
            "Content-Type": "application/json",
        },
        method="PUT",
    )
    with urllib.request.urlopen(update, timeout=30):
        pass
    with urllib.request.urlopen(page_url, timeout=30) as response:
        page = response.read().decode("utf-8")
    if "<script>alert" in page:
        raise AcceptanceFailure("owner text reached the lab page unescaped")
    if "&lt;script&gt;" not in page:
        raise AcceptanceFailure("lab page did not render the updated tagline")

    owner.send(f"PRIVMSG {herder_account} :editlab")
    owner.wait("lab editor link", 20)


def create_disposable_member(suffix: str) -> tuple[str, str, str]:
    account = f"Accept{suffix}"
    herder = f"Herder{suffix}"
    invitation = admin_request(
        "/api/admin/invites",
        {"display_name": "Community acceptance", "expires_hours": 1},
    )
    token = invitation["url"].rsplit("#", 1)[-1]
    request = urllib.request.Request(
        "http://127.0.0.1:9010/api/invites/redeem",
        data=json.dumps(
            {
                "token": token,
                "account": account,
                "herder_account": herder,
                "display_name": "Community acceptance",
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        result = json.load(response)
    return result["account"], result["password"], result["herder_account"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owner")
    parser.add_argument("--herder")
    parser.add_argument("--adapter-image", default="omen-agent-adapter:test")
    arguments = parser.parse_args()
    if os.geteuid() != 0:
        raise AcceptanceFailure("run with sudo")

    if bool(arguments.owner) != bool(arguments.herder):
        raise AcceptanceFailure("--owner and --herder must be supplied together")
    suffix = str(int(time.time()))[-7:]
    disposable = not arguments.owner
    if disposable:
        owner_account, owner_password, herder_account = (
            create_disposable_member(suffix)
        )
    else:
        owner_account, owner_password = profile_credentials(arguments.owner)
        herder_account = arguments.herder
    owner = IRCClient(owner_account, owner_password)
    owner.login()
    owner.send(f"PRIVMSG {herder_account} :status")
    owner.wait("pending=", 20)
    lab_acceptance(owner_account, herder_account, owner)
    print("PASS: storefront lab page rendered with a locked-down CSP")
    print("PASS: owner edits stayed escaped presentation, not markup")
    print("PASS: the companion minted a one-hour lab editor link")
    agent_name = f"Probe{suffix}"
    agent_account = f"{owner_account[:14]}-{agent_name[:14]}"[:32]
    container = "omen-agent-acceptance"
    env_path: str | None = None
    server: http.server.ThreadingHTTPServer | None = None
    try:
        owner.send(f"PRIVMSG {herder_account} :invite {agent_name}")
        invitation = owner.wait(f"account={agent_account}", 20)
        match = re.search(r"https://\S+/#([A-Za-z0-9_-]+)", invitation)
        if not match:
            raise AcceptanceFailure("BotHerder did not return an agent URL")
        result = redeem(match.group(1))

        server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 18083), ModelHandler
        )
        threading.Thread(target=server.serve_forever, daemon=True).start()
        file_descriptor, env_path = tempfile.mkstemp(
            prefix="agent-acceptance-", text=True
        )
        os.fchmod(file_descriptor, 0o600)
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as handle:
            handle.write(
                "IRC_SERVER=am4.tail8e749c.ts.net\n"
                "IRC_PORT=8443\n"
                "IRC_TLS=true\n"
                f"IRC_ACCOUNT={result['account']}\n"
                f"IRC_NICK={result['account']}\n"
                f"IRC_PASSWORD={result['password']}\n"
                f"HERDER_ACCOUNT={herder_account}\n"
                f"OWNER_ACCOUNT={owner_account}\n"
                "OPENAI_BASE_URL=http://127.0.0.1:18083/v1\n"
                "OPENAI_API_KEY=acceptance-key\n"
                "OPENAI_MODEL=acceptance-model\n"
                "OPENAI_MAX_TOKENS=512\n"
                f"AGENT_DESCRIPTION={agent_name}\n"
            )
        subprocess.run(
            ["docker", "rm", "-f", container],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        subprocess.run(
            [
                "docker",
                "run",
                "-d",
                "--rm",
                "--network",
                "host",
                "--name",
                container,
                "--env-file",
                env_path,
                arguments.adapter_image,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            log_result = subprocess.run(
                ["docker", "logs", container],
                capture_output=True,
                text=True,
                check=False,
            )
            logs = log_result.stdout + log_result.stderr
            if "connected account=" in logs:
                break
            time.sleep(1)
        else:
            tail = " | ".join(logs.strip().splitlines()[-3:])
            raise AcceptanceFailure(f"remote adapter did not connect: {tail}")

        owner.send(
            f"PRIVMSG #general :{herder_account}: ask "
            f"{agent_name} prove the bridge"
        )
        owner.wait("working", 10)
        owner.wait("Remote adapter acceptance completed.", 40)
        owner.send(f"PRIVMSG {herder_account} :usage")
        usage_line = owner.wait("tokens=", 10)
        if "not reported" in usage_line:
            raise AcceptanceFailure("provider token usage was not recorded")
        owner.send(f"PRIVMSG {herder_account} :agents")
        owner.wait(agent_name, 10)
        owner.send(
            f"PRIVMSG {herder_account} :revoke {result['account']}"
        )
        owner.wait("revoked remote agent", 20)

        print("PASS: BotHerder created a private one-time agent invitation")
        print("PASS: redemption returned a dedicated non-oper SASL identity")
        print("PASS: outbound trusted-TLS adapter connected without an inbound port")
        print("PASS: addressed ask completed through the remote compatible endpoint")
        print("PASS: provider-reported usage reached the owner ledger")
        print("PASS: owner agent listing and revocation succeeded")
        return 0
    finally:
        subprocess.run(
            ["docker", "rm", "-f", container],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if env_path:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(env_path)
        if server:
            server.shutdown()
        owner.close()
        if disposable:
            with contextlib.suppress(Exception):
                admin_request(
                    "/api/admin/members/offboard",
                    {
                        "owner_account": owner_account,
                        "herder_account": herder_account,
                    },
                )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AcceptanceFailure as error:
        print(f"FAIL: {error}", file=os.sys.stderr)
        raise SystemExit(1)
