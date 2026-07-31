from __future__ import annotations

import httpx


class PortalError(RuntimeError):
    pass


class CommunityPortalClient:
    def __init__(self, base_url: str, token: str) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=httpx.Timeout(15),
        )

    async def _request(self, method: str, path: str, **kwargs) -> dict:
        try:
            response = await self._client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise PortalError("community registrar is unavailable") from exc
        try:
            value = response.json()
        except ValueError as exc:
            raise PortalError("community registrar returned an invalid response") from exc
        if response.status_code >= 400:
            raise PortalError(value.get("message") or value.get("error") or "request failed")
        return value

    async def agents(self, owner_account: str, herder_account: str) -> list[dict]:
        value = await self._request(
            "GET",
            "/api/internal/agents",
            params={"owner": owner_account, "herder": herder_account},
        )
        return list(value.get("agents") or [])

    async def storefronts(self) -> list[dict]:
        value = await self._request("GET", "/api/internal/storefronts")
        return list(value.get("storefronts") or [])

    async def invite_agent(
        self, owner_account: str, herder_account: str, agent_name: str
    ) -> dict:
        return await self._request(
            "POST",
            "/api/internal/agent-invites",
            json={
                "owner_account": owner_account,
                "herder_account": herder_account,
                "agent_name": agent_name,
            },
        )

    async def revoke_agent(
        self, owner_account: str, herder_account: str, account: str
    ) -> dict:
        return await self._request(
            "POST",
            "/api/internal/agents/revoke",
            json={
                "owner_account": owner_account,
                "herder_account": herder_account,
                "account": account,
            },
        )

    async def push_snapshot(self, herder_account: str, snapshot: dict) -> dict:
        return await self._request(
            "POST",
            "/api/internal/storefront-snapshot",
            json={"herder_account": herder_account, "snapshot": snapshot},
        )

    async def mint_edit_link(self, owner_account: str, herder_account: str) -> dict:
        return await self._request(
            "POST",
            "/api/internal/lab-edit-links",
            json={
                "owner_account": owner_account,
                "herder_account": herder_account,
            },
        )

    async def close(self) -> None:
        await self._client.aclose()
