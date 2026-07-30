from __future__ import annotations

from typing import Any

import httpx

from .config import ModelConfig


class ModelError(RuntimeError):
    public_message = "the model request failed"


class ModelTimeout(ModelError):
    public_message = "the model timed out"


class ModelUnavailable(ModelError):
    public_message = "the model endpoint is unavailable"


class ModelAuthenticationError(ModelError):
    public_message = "the model endpoint rejected its configured credential"


class ModelResponseError(ModelError):
    public_message = "the model returned an invalid response"


class EmptyCompletion(ModelError):
    public_message = "the model returned no completion"


def _extract_content(payload: Any) -> str:
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ModelResponseError from exc
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts).strip()
    raise ModelResponseError


class ModelClient:
    def __init__(self) -> None:
        self._client = httpx.AsyncClient(
            follow_redirects=False,
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=4),
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def complete(self, model: ModelConfig, prompt: str) -> str:
        timeout = httpx.Timeout(model.timeout_seconds, connect=min(10, model.timeout_seconds))
        try:
            response = await self._client.post(
                f"{model.endpoint}/chat/completions",
                headers={
                    "Authorization": f"Bearer {model.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": model.model_id,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": model.effective_max_tokens,
                    "stream": False,
                },
                timeout=timeout,
            )
        except httpx.TimeoutException as exc:
            raise ModelTimeout from exc
        except httpx.HTTPError as exc:
            raise ModelUnavailable from exc

        if response.status_code in {401, 403}:
            raise ModelAuthenticationError
        if response.status_code >= 500:
            raise ModelUnavailable
        if response.status_code < 200 or response.status_code >= 300:
            raise ModelResponseError
        try:
            payload = response.json()
        except ValueError as exc:
            raise ModelResponseError from exc
        content = _extract_content(payload)
        if not content:
            raise EmptyCompletion
        return content
