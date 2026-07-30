import json
import unittest

import httpx

from compute_bridge.config import ModelConfig
from compute_bridge.models import (
    EmptyCompletion,
    ModelAuthenticationError,
    ModelClient,
)


def model_config():
    return ModelConfig(
        name="gpt-oss-120b",
        model_id="gpt-oss-120b",
        endpoint="http://model.test/v1",
        api_key_env="MODEL_KEY",
        api_key="super-secret",
        max_tokens=128,
        min_max_tokens=512,
        description="test",
        timeout_seconds=10,
    )


class ModelClientTests(unittest.IsolatedAsyncioTestCase):
    async def _client_with_handler(self, handler):
        client = ModelClient()
        await client._client.aclose()
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.addAsyncCleanup(client.close)
        return client

    async def test_sends_bearer_key_and_reasoning_floor(self):
        observed = {}

        def handler(request):
            observed["authorization"] = request.headers["Authorization"]
            observed["body"] = json.loads(request.content)
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "Repository pattern"}}]},
            )

        client = await self._client_with_handler(handler)
        result = await client.complete(model_config(), "name a pattern")
        self.assertEqual(result, "Repository pattern")
        self.assertEqual(observed["authorization"], "Bearer super-secret")
        self.assertEqual(observed["body"]["max_tokens"], 512)
        self.assertFalse(observed["body"]["stream"])

    async def test_empty_content_is_an_error(self):
        client = await self._client_with_handler(
            lambda request: httpx.Response(
                200, json={"choices": [{"message": {"content": ""}}]}
            )
        )
        with self.assertRaises(EmptyCompletion):
            await client.complete(model_config(), "prompt")

    async def test_auth_failure_does_not_contain_secret(self):
        client = await self._client_with_handler(
            lambda request: httpx.Response(401, json={"error": "denied"})
        )
        with self.assertRaises(ModelAuthenticationError) as raised:
            await client.complete(model_config(), "prompt")
        self.assertNotIn("super-secret", str(raised.exception))
