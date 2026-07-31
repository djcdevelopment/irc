import unittest
from contextlib import asynccontextmanager

from compute_bridge.config import HearthConfig, ModelConfig
from compute_bridge.hearth import HearthClient


class FakeHearthClient(HearthClient):
    def __init__(self):
        super().__init__(
            HearthConfig(
                mode="hearth",
                endpoint="https://omen.example:8443/mcp",
                api_key_env="HEARTH_API_KEY",
                api_key="secret",
                request_timeout_seconds=5,
                watch_seconds=0.25,
            )
        )
        self.calls = []

    @asynccontextmanager
    async def _session(self):
        yield object()

    async def _call(self, _session, tool, arguments):
        self.calls.append((tool, arguments))
        if tool == "submit_delegated_execution":
            return {
                "request_id": "req_test",
                "job_id": "job_test",
                "status": "queued",
                "last_sequence": 3,
            }
        if tool == "watch_execution":
            return {"events": [{"sequence": 9}], "next_sequence": 9}
        if tool == "get_execution":
            return {
                "request_id": "req_test",
                "job_id": "job_test",
                "status": "succeeded",
                "result_artifact_id": "art_test",
                "invocations": [
                    {
                        "tokens_in": 5,
                        "tokens_out": 7,
                    }
                ],
            }
        if tool == "get_execution_artifact":
            return {
                "artifact_id": "art_test",
                "content": "complete result",
                "size": 15,
                "sha256": "a" * 64,
                "media_type": "text/plain",
            }
        if tool == "plan_execution":
            return {
                "provider": "am4-moe",
                "model": "gpt-oss-120b",
                "dispatch": False,
            }
        raise AssertionError(tool)


def model():
    return ModelConfig(
        name="gpt-oss-120b",
        model_id="gpt-oss-120b",
        endpoint="http://127.0.0.1:8082/v1",
        api_key_env="MODEL_KEY",
        api_key="",
        max_tokens=512,
        min_max_tokens=512,
        description="test",
        timeout_seconds=3,
    )


class HearthClientTest(unittest.IsolatedAsyncioTestCase):
    async def test_completion_delegates_identity_and_fetches_artifact(self):
        client = FakeHearthClient()
        completion = await client.complete(
            model(),
            "hello",
            account="Alice",
            idempotency_key="irc:alice:1",
            system_prompt="Plain IRC text.",
        )
        self.assertEqual("complete result", completion.text)
        self.assertEqual("job_test", completion.job_id)
        self.assertEqual(12, completion.total_tokens)
        submit = client.calls[0]
        self.assertEqual("submit_delegated_execution", submit[0])
        self.assertEqual("Alice", submit[1]["principal_id"])
        self.assertEqual("irc", submit[1]["source_transport"])
        self.assertEqual("irc:alice:1", submit[1]["idempotency_key"])
        self.assertEqual("Plain IRC text.", submit[1]["arguments"]["system"])
        self.assertNotIn("secret", str(client.calls))

    async def test_shadow_plan_contains_no_prompt_content(self):
        client = FakeHearthClient()
        result = await client.plan(model(), "private words")
        self.assertFalse(result["dispatch"])
        _, arguments = client.calls[0]
        self.assertEqual(len("private words"), arguments["prompt_bytes"])
        self.assertNotIn("private words", str(arguments))


if __name__ == "__main__":
    unittest.main()
