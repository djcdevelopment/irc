from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import timedelta
from typing import Any, AsyncIterator

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from .config import HearthConfig, ModelConfig
from .models import (
    Completion,
    EmptyCompletion,
    ModelAuthenticationError,
    ModelResponseError,
    ModelTimeout,
    ModelUnavailable,
)


class HearthClient:
    """Thin protocol adapter for HEARTH's canonical execution tools."""

    def __init__(self, config: HearthConfig) -> None:
        self.config = config

    async def close(self) -> None:
        # Sessions are intentionally scoped to one plan/completion. This makes
        # reconnect behavior deterministic across tailnet changes and gateway
        # restarts without sharing a failed MCP session between Herder owners.
        return None

    @staticmethod
    def _tools(value: Any) -> list[dict[str, Any]]:
        return [
            {
                "name": tool.name,
                "description": tool.description or "",
                "input_schema": tool.inputSchema or {},
            }
            for tool in getattr(value, "tools", [])
        ]

    async def storefront(self, *, principal_id: str | None = None) -> dict[str, Any]:
        """Read the live, caller-filtered HEARTH discovery surface.

        This deliberately uses only read-only tools already granted to the IRC
        adapter. The result is a short-lived projection for presentation; it is
        never persisted as a second catalog by BotHerder.
        """
        async with self._session() as session:
            listed = await session.list_tools()
            tool_names = {item["name"] for item in self._tools(listed)}
            projection: dict[str, Any] = {
                "tools": self._tools(listed),
                "operations": [],
                "providers": [],
                "kernel": {},
            }
            for name, key in (
                ("list_operations", "operations"),
                ("list_execution_providers", "providers"),
                ("kernel_status", "kernel"),
            ):
                if name not in tool_names:
                    continue
                try:
                    projection[key] = await self._call(session, name, {})
                except ModelResponseError:
                    # A partially upgraded gateway should leave the rest of
                    # the storefront usable and visibly incomplete.
                    projection[key] = None
            if "list_owned_executions" in tool_names and principal_id:
                try:
                    projection["executions"] = await self._call(
                        session,
                        "list_owned_executions",
                        {
                            "principal_type": "irc_account",
                            "principal_id": principal_id,
                            "limit": 20,
                        },
                    )
                except ModelResponseError:
                    projection["executions"] = None
            return projection

    @asynccontextmanager
    async def _session(self) -> AsyncIterator[ClientSession]:
        timeout = httpx.Timeout(
            self.config.request_timeout_seconds,
            connect=min(15, self.config.request_timeout_seconds),
        )
        async with httpx.AsyncClient(
            headers={"X-Hearth-Key": self.config.api_key},
            timeout=timeout,
            follow_redirects=False,
        ) as client:
            async with streamable_http_client(
                self.config.endpoint,
                http_client=client,
                terminate_on_close=True,
            ) as (read_stream, write_stream, _session_id):
                async with ClientSession(
                    read_stream,
                    write_stream,
                    read_timeout_seconds=timedelta(
                        seconds=self.config.request_timeout_seconds
                    ),
                ) as session:
                    await session.initialize()
                    yield session

    @staticmethod
    def _value(result: Any) -> Any:
        if getattr(result, "isError", False):
            detail = "HEARTH tool call failed"
            content = getattr(result, "content", None) or []
            if content and isinstance(getattr(content[0], "text", None), str):
                detail = content[0].text
            raise ModelResponseError(detail)
        structured = getattr(result, "structuredContent", None)
        if structured is None:
            structured = getattr(result, "structured_content", None)
        if structured is not None:
            return structured
        content = getattr(result, "content", None) or []
        for item in content:
            text = getattr(item, "text", None)
            if isinstance(text, str):
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return text
        raise ModelResponseError("HEARTH returned no structured content")

    async def _call(
        self, session: ClientSession, tool: str, arguments: dict[str, Any]
    ) -> Any:
        try:
            result = await session.call_tool(tool, arguments=arguments)
            return self._value(result)
        except ModelResponseError:
            raise
        except asyncio.TimeoutError as exc:
            raise ModelTimeout from exc
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in {401, 403}:
                raise ModelAuthenticationError from exc
            raise ModelUnavailable from exc
        except (httpx.HTTPError, OSError) as exc:
            raise ModelUnavailable from exc
        except Exception as exc:
            name = type(exc).__name__.casefold()
            detail = str(exc).casefold()
            if "401" in detail or "403" in detail or "permission" in name:
                raise ModelAuthenticationError from exc
            if "timeout" in name or "timeout" in detail:
                raise ModelTimeout from exc
            raise ModelUnavailable from exc

    async def plan(self, model: ModelConfig, prompt: str) -> dict[str, Any]:
        async with self._session() as session:
            value = await self._call(
                session,
                "plan_execution",
                {
                    "operation": self.config.operation,
                    "model": model.model_id,
                    "prompt_bytes": len(prompt.encode("utf-8")),
                    "policy": {
                        "max_tokens": model.effective_max_tokens,
                        "deadline_s": min(
                            int(model.timeout_seconds),
                            int(self.config.request_timeout_seconds),
                        ),
                    },
                },
            )
        if not isinstance(value, dict):
            raise ModelResponseError("HEARTH plan was not an object")
        return value

    async def complete(
        self,
        model: ModelConfig,
        prompt: str,
        *,
        account: str,
        idempotency_key: str,
        system_prompt: str = "",
    ) -> Completion:
        execution_arguments = {
            "prompt": prompt,
            "model": model.model_id,
        }
        if system_prompt.strip():
            execution_arguments["system"] = system_prompt.strip()
        async with self._session() as session:
            submitted = await self._call(
                session,
                "submit_delegated_execution",
                {
                    "operation": self.config.operation,
                    "arguments": execution_arguments,
                    "principal_type": "irc_account",
                    "principal_id": account,
                    "source_transport": "irc",
                    "policy": {
                        "max_tokens": model.effective_max_tokens,
                        "deadline_s": min(
                            int(model.timeout_seconds),
                            int(self.config.request_timeout_seconds),
                        ),
                    },
                    "idempotency_key": idempotency_key,
                },
            )
            if not isinstance(submitted, dict) or not isinstance(
                submitted.get("job_id"), str
            ):
                raise ModelResponseError("HEARTH submission omitted job_id")
            job_id = submitted["job_id"]
            state = submitted
            sequence = int(state.get("last_sequence") or 0)
            deadline = asyncio.get_running_loop().time() + self.config.request_timeout_seconds
            while state.get("status") not in {
                "succeeded",
                "failed",
                "cancelled",
                "rejected",
                "expired",
            }:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise ModelTimeout
                watched = await self._call(
                    session,
                    "watch_execution",
                    {
                        "job_id": job_id,
                        "after_sequence": sequence,
                        "wait_seconds": min(
                            self.config.watch_seconds, max(0.25, remaining)
                        ),
                        "limit": 100,
                    },
                )
                if isinstance(watched, dict):
                    sequence = int(watched.get("next_sequence") or sequence)
                state = await self._call(
                    session, "get_execution", {"job_id": job_id}
                )
                if not isinstance(state, dict):
                    raise ModelResponseError("HEARTH job projection was not an object")

            if state.get("status") != "succeeded":
                reason = str(state.get("reason") or state.get("status") or "failed")
                if state.get("status") == "expired":
                    raise ModelTimeout
                if state.get("status") == "cancelled":
                    raise ModelUnavailable("HEARTH execution was cancelled")
                raise ModelResponseError(reason)

            artifact_id = state.get("result_artifact_id")
            if not isinstance(artifact_id, str):
                artifact_id = next(
                    (
                        item.get("artifact_id")
                        for item in state.get("artifacts", [])
                        if item.get("role") == "result"
                    ),
                    None,
                )
            if not isinstance(artifact_id, str):
                raise ModelResponseError("HEARTH result artifact is missing")
            artifact = await self._call(
                session,
                "get_execution_artifact",
                {"artifact_id": artifact_id},
            )
            if not isinstance(artifact, dict) or not isinstance(
                artifact.get("content"), str
            ):
                raise ModelResponseError("HEARTH artifact content is missing")
            text = artifact["content"].strip()
            if not text:
                raise EmptyCompletion
            invocation = (
                state.get("invocations", [{}])[-1]
                if state.get("invocations")
                else {}
            )
            prompt_tokens = invocation.get("tokens_in")
            completion_tokens = invocation.get("tokens_out")
            total_tokens = (
                prompt_tokens + completion_tokens
                if isinstance(prompt_tokens, int)
                and isinstance(completion_tokens, int)
                else None
            )
            return Completion(
                text=text,
                prompt_tokens=prompt_tokens if isinstance(prompt_tokens, int) else None,
                completion_tokens=(
                    completion_tokens if isinstance(completion_tokens, int) else None
                ),
                total_tokens=total_tokens,
                artifact={key: value for key, value in artifact.items() if key != "content"},
                request_id=str(state.get("request_id") or ""),
                job_id=job_id,
            )
