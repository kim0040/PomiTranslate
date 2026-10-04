"""Provider wire formats, text-model catalogs, and remembered settings."""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from llm_backends import LLMProviderClient, ModelCatalogError, public_provider_choices
from mc_world_translator import main
from mwt.secrets import load_api_key
from tests.test_release_fixtures import compound, nbt_bytes, string, write_region


class Recorder(BaseHTTPRequestHandler):
    seen: list[tuple] = []

    def _send(self, payload: dict, status: int = 200) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        Recorder.seen.append(("GET", self.path.split("?", 1)[0], self.path))
        self._send(
            {
                "data": [
                    {
                        "id": "text-model",
                        "name": "Text Model",
                        "description": "A text model",
                        "context_length": 8192,
                        "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
                        "pricing": {"prompt": "0.0000001", "completion": "0.0000002"},
                        "supported_parameters": ["temperature"],
                        "display_name": "Text Model",
                    },
                    {
                        "id": "json-model",
                        "name": "JSON Model",
                        "description": "Supports JSON",
                        "context_length": 4096,
                        "architecture": {"output_modalities": ["text"]},
                        "supported_parameters": ["temperature", "response_format"],
                        "display_name": "JSON Model",
                    },
                    {
                        "id": "image-model",
                        "name": "Image Model",
                        "description": "Image only",
                        "architecture": {"output_modalities": ["image"], "input_modalities": ["text"]},
                    },
                    {"id": "embed-model", "owned_by": "vendor"},
                ],
                "models": [
                    {
                        "name": "models/gemini-test",
                        "displayName": "Gemini Test",
                        "description": "text model",
                        "supportedGenerationMethods": ["generateContent"],
                    },
                    {
                        "name": "models/gemini-3.5-flash",
                        "displayName": "Gemini 3.5 Flash",
                        "supportedGenerationMethods": ["generateContent"],
                        "thinking": True,
                    },
                    {
                        "name": "models/gemini-3.8-flash",
                        "displayName": "Gemini 3.8 Flash",
                        "supportedGenerationMethods": ["generateContent"],
                        "thinking": True,
                    },
                    {
                        "name": "models/gemini-flash-latest",
                        "displayName": "Gemini Flash Latest",
                        "supportedGenerationMethods": ["generateContent"],
                        "thinking": True,
                    },
                    {
                        "name": "models/gemini-2.5-flash",
                        "displayName": "Gemini 2.5 Flash",
                        "supportedGenerationMethods": ["generateContent"],
                        "thinking": True,
                    },
                    {
                        "name": "models/gemini-embed",
                        "displayName": "Embed",
                        "supportedGenerationMethods": ["embedContent"],
                    },
                ],
            }
        )

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        headers = {key.lower(): value for key, value in self.headers.items()}
        Recorder.seen.append(("POST", self.path.split("?", 1)[0], self.path, headers, body))
        if "generateContent" in self.path:
            level = body.get("generationConfig", {}).get("thinkingConfig", {}).get("thinkingLevel")
            if "gemini-3.8-flash" in self.path and level == "minimal":
                self._send({"error": {"code": 400, "message": "Thinking level MINIMAL is not supported for this model. Please retry with other thinking level.", "status": "INVALID_ARGUMENT"}}, 400)
                return
            if "max-tokens" in self.path:
                self._send({"candidates": [{"content": {"parts": [{"text": "{\"0\": \"Ho"}]}, "finishReason": "MAX_TOKENS"}]})
                return
            self._send({
                "candidates": [{"content": {"parts": [
                    {"text": "thinking about it", "thought": True},
                    {"text": json.dumps({"0": "Hola"})},
                ]}, "finishReason": "STOP"}],
                "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 4, "thoughtsTokenCount": 30},
            })
            return
        if self.path.split("?", 1)[0].endswith("/messages"):
            self._send({"content": [{"type": "text", "text": json.dumps({"0": "Hola"})}]})
            return
        self._send({"choices": [{"message": {"content": json.dumps({"0": "Hola"})}}]})

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


def start() -> tuple[ThreadingHTTPServer, str]:
    Recorder.seen = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    return server, f"http://{host}:{port}"


def client(
    base: str, provider: str, model: str, *, wire: str = "", data_dir: Path | None = None, reasoning: str = "default"
) -> LLMProviderClient:
    return LLMProviderClient(
        {
            "api": {
                "provider": provider,
                "api_key": f"{provider}-key",
                "base_url": base,
                "model": model,
                "request_timeout": 30,
                "wire_format": wire,
                "openrouter_reasoning": reasoning,
            },
            "runtime": {"data_dir": str(data_dir or "")},
        }
    )


def last_post() -> tuple:
    posts = [item for item in Recorder.seen if item[0] == "POST"]
    if not posts:
        raise AssertionError("no provider request was recorded")
    return posts[-1]


def test_public_providers() -> None:
    assert public_provider_choices() == ["openai", "gemini", "anthropic", "openrouter", "comet", "custom"]
    print("PASS providers.public")


def test_openai_gemini_anthropic_openrouter_custom(base: str, tmp: Path) -> None:
    root = base
    openai = client(f"{root}/v1", "openai", "json-model", data_dir=tmp / "openai")
    assert openai.translate_mapping({"0": "Hello"}, system_prompt="sys", temperature=0) == {"0": "Hola"}
    _, path, _full, headers, body = last_post()
    assert path == "/v1/chat/completions"
    assert headers["authorization"] == "Bearer openai-key"
    assert body["model"] == "json-model"
    assert body["response_format"] == {"type": "json_object"}
    assert openai.model_info["display_name"] == "JSON Model"
    assert openai.model_info["context_length"] == 4096

    openrouter = client(f"{root}/v1", "openrouter", "text-model", data_dir=tmp / "openrouter")
    assert openrouter.translate_mapping({"0": "Hello"}, system_prompt="sys", temperature=0) == {"0": "Hola"}
    _, path, full, headers, body = last_post()
    assert path == "/v1/chat/completions"
    assert any(item[0] == "GET" and item[2] == "/v1/models" for item in Recorder.seen)
    assert not any(item[0] == "GET" and "output_modalities=text" in item[2] for item in Recorder.seen)
    assert headers["authorization"] == "Bearer openrouter-key"
    assert headers["x-title"] == "PomiTranslate"
    assert "response_format" not in body
    assert openrouter.model_info["description"] == "A text model"
    assert openrouter.model_info["pricing_prompt"] == "0.0000001"
    ids = [item["id"] for item in openrouter.try_refresh_text_models()]
    assert ids == ["text-model", "json-model"]
    assert "image-model" not in ids
    assert "embed-model" not in ids
    catalog = {item["id"]: item for item in openrouter.list_models()}
    assert catalog["image-model"]["text"] is False and catalog["image-model"]["suitable"] is False
    assert catalog["embed-model"]["suitable"] is False
    from mwt.userdata import load_model_catalog
    assert len(load_model_catalog("openrouter", root=tmp / "openrouter")) == 4

    LLMProviderClient.reset_counters()
    gemini = client(f"{root}/v1beta", "gemini", "gemini-test")
    assert gemini.translate_mapping({"0": "Hello"}, system_prompt="sys", temperature=0) == {"0": "Hola"}
    _, path, full, headers, body = last_post()
    assert "/models/gemini-test:generateContent" in full
    # The key travels in a header, never in a URL that proxies or logs could record.
    assert "gemini-key" not in full and headers["x-goog-api-key"] == "gemini-key"
    assert all("gemini-key" not in item[2] for item in Recorder.seen)
    assert body["systemInstruction"]["parts"][0]["text"] == "sys"
    assert "thinkingConfig" not in body["generationConfig"]
    assert body["generationConfig"]["maxOutputTokens"] >= 32768
    # Thought tokens are billed as output: counted, but thought text never becomes the answer.
    assert LLMProviderClient.usage["completion_tokens"] == 34
    assert LLMProviderClient.usage["prompt_tokens"] == 10
    assert [item["id"] for item in gemini.try_refresh_text_models()] == [
        "gemini-test", "gemini-3.5-flash", "gemini-3.8-flash", "gemini-flash-latest", "gemini-2.5-flash"
    ]
    assert gemini.model_info["reasoning"] is None

    flash3 = client(f"{root}/v1beta", "gemini", "gemini-3.5-flash", reasoning="disabled")
    flash3.translate_mapping({"0": "Hello"}, system_prompt="sys", temperature=0)
    assert last_post()[4]["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "minimal"}
    assert flash3.model_info["reasoning"]["supported_efforts"] == ["minimal", "low", "medium", "high"]
    low3 = client(f"{root}/v1beta", "gemini", "gemini-3.5-flash", reasoning="low")
    low3.translate_mapping({"0": "Hello"}, system_prompt="sys", temperature=0)
    assert last_post()[4]["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "low"}
    # 3.8 flash rejects "minimal" (measured): the client steps up once and remembers the floor.
    newest = client(f"{root}/v1beta", "gemini", "gemini-3.8-flash", reasoning="disabled")
    before = len([item for item in Recorder.seen if item[0] == "POST"])
    assert newest.translate_mapping({"0": "Hello"}, system_prompt="sys", temperature=0) == {"0": "Hola"}
    posts = [item for item in Recorder.seen if item[0] == "POST"][before:]
    assert [p[4]["generationConfig"]["thinkingConfig"]["thinkingLevel"] for p in posts] == ["minimal", "low"]
    newest.translate_mapping({"0": "Hello"}, system_prompt="sys", temperature=0)
    assert last_post()[4]["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "low"}, "the floor is reused"
    alias = client(f"{root}/v1beta", "gemini", "gemini-flash-latest", reasoning="low")
    alias.translate_mapping({"0": "Hello"}, system_prompt="sys", temperature=0)
    assert last_post()[4]["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "low"}
    flash25 = client(f"{root}/v1beta", "gemini", "gemini-2.5-flash", reasoning="disabled")
    flash25.translate_mapping({"0": "Hello"}, system_prompt="sys", temperature=0)
    assert last_post()[4]["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 0}
    plain = client(f"{root}/v1beta", "gemini", "gemini-test", reasoning="low")
    try:
        plain.translate_mapping({"0": "Hello"}, system_prompt="sys", temperature=0)
    except Exception as exc:
        assert "reasoning" in str(exc)
    else:
        raise AssertionError("a model without thinking must reject a thinking setting")
    truncated = client(f"{root}/v1beta/max-tokens", "gemini", "gemini-test")
    truncated._catalog_checked = True
    try:
        truncated.translate_mapping({"0": "Hello"}, system_prompt="sys", temperature=0)
    except RuntimeError as exc:
        assert "output token limit" in str(exc)
    else:
        raise AssertionError("a truncated Gemini answer must not pass as a translation")

    anthropic = client(f"{root}/v1", "anthropic", "text-model")
    assert anthropic.translate_mapping({"0": "Hello"}, system_prompt="sys", temperature=0) == {"0": "Hola"}
    _, path, _full, headers, body = last_post()
    assert path == "/v1/messages"
    assert headers["x-api-key"] == "anthropic-key"
    assert headers["anthropic-version"] == "2023-06-01"
    assert body["system"] == "sys"
    assert body["model"] == "text-model"

    custom = client(f"{root}/v1", "custom", "json-model", wire="openai")
    assert custom.family == "openai_compatible"
    assert custom.translate_mapping({"0": "Hello"}, system_prompt="sys", temperature=0) == {"0": "Hola"}
    _, path, _full, headers, body = last_post()
    assert path == "/v1/chat/completions"
    assert headers["authorization"] == "Bearer custom-key"
    assert body["model"] == "json-model"

    custom_anthropic = client(f"{root}/v1", "custom", "text-model", wire="anthropic")
    assert custom_anthropic.family == "anthropic"
    assert custom_anthropic.translate_mapping({"0": "Hello"}, system_prompt="sys", temperature=0) == {"0": "Hola"}
    _, path, _full, headers, _body = last_post()
    assert path == "/v1/messages"
    assert headers["x-api-key"] == "custom-key"
    print("PASS providers.wire")


def test_unknown_model_does_not_write(base: str, tmp: Path) -> None:
    from mc_world_translator import DEFAULT_CONFIG, WorldTranslator, merge_nested

    world = tmp / "catalog-world"
    region = world / "region" / "r.0.0.mca"
    write_region(region, {0: (2, nbt_bytes(compound("sign", string("Text1", '{"text":"Hello sign"}'))), False)})
    original = region.read_bytes()
    config = merge_nested(
        DEFAULT_CONFIG,
        {
            "world_dir": str(world),
            "dry_run": False,
            "report_path": str(tmp / "catalog-report.json"),
            "inherit_translate_py": False,
            "runtime": {"checkpoint_enabled": False, "data_dir": str(tmp / "catalog-data")},
            "api": {
                "provider": "openai",
                "api_key": "openai-key",
                "model": "not-published",
                "base_url": f"{base}/v1",
            },
        },
    )
    report = WorldTranslator(config).run()
    assert report["status"] == "failed"
    assert "not-published" in report["error"]
    assert region.read_bytes() == original
    print("PASS providers.catalog_blocks_write")


def test_settings_are_remembered(tmp: Path) -> None:
    import keyring
    from keyring.backend import KeyringBackend

    class MemoryKeyring(KeyringBackend):
        priority = 1

        def __init__(self) -> None:
            self.values: dict[tuple[str, str], str] = {}

        def set_password(self, service: str, username: str, password: str) -> None:
            self.values[(service, username)] = password

        def get_password(self, service: str, username: str) -> str | None:
            return self.values.get((service, username))

        def delete_password(self, service: str, username: str) -> None:
            self.values.pop((service, username), None)

    keyring.set_keyring(MemoryKeyring())
    data = tmp / "cli-data"
    world = tmp / "cli-world"
    world.mkdir()
    secret = "cli-test-key-remembered"
    main(
        [
            "--data-dir",
            str(data),
            "--provider",
            "openrouter",
            "--model",
            "xiaomi/mimo-v2.6-flash",
            "--base-url",
            "https://openrouter.ai/api/v1",
            "--wire-format",
            "openai",
            "--target-language",
            "한국어",
            "--world-dir",
            str(world),
            "--report-path",
            str(tmp / "cli-report.json"),
            "--dry-run",
            "--api-key",
            secret,
        ]
    )
    stored = json.loads((data / "settings.json").read_text(encoding="utf-8"))
    assert stored["provider"] == "openrouter"
    assert stored["model"] == "xiaomi/mimo-v2.6-flash"
    assert stored["last_world_dir"] == str(world.resolve())
    assert secret not in json.dumps(stored)
    assert secret not in (tmp / "cli-report.json").read_text(encoding="utf-8")
    assert load_api_key("openrouter") == secret
    stored["ui_scale"] = 1.25
    stored["custom_note"] = "keep-me"
    (data / "settings.json").write_text(json.dumps(stored), encoding="utf-8")
    from mwt.userdata import load_user_settings, remember_user_settings, user_data_dir

    remember_user_settings({"model": "still-openrouter-model", "api_key": secret}, root=data)
    reloaded = load_user_settings(data)
    assert reloaded["provider"] == "openrouter"
    assert reloaded["model"] == "still-openrouter-model"
    assert reloaded["ui_scale"] == 1.25
    assert reloaded["custom_note"] == "keep-me"
    assert reloaded["last_world_dir"] == str(world.resolve())
    assert "api_key" not in reloaded
    assert secret not in (data / "settings.json").read_text(encoding="utf-8")
    install = Path(__file__).resolve().parents[1]
    assert install not in user_data_dir().parents
    print("PASS providers.settings_persist")


def test_desktop_settings(tmp: Path) -> None:
    import keyring
    from keyring.backend import KeyringBackend

    from mwt.desktop_entry import handle

    class MemoryKeyring(KeyringBackend):
        priority = 1

        def __init__(self) -> None:
            self.values: dict[tuple[str, str], str] = {}

        def set_password(self, service: str, username: str, password: str) -> None:
            self.values[(service, username)] = password

        def get_password(self, service: str, username: str) -> str | None:
            return self.values.get((service, username))

        def delete_password(self, service: str, username: str) -> None:
            self.values.pop((service, username), None)

    keyring.set_keyring(MemoryKeyring())
    data = tmp / "desktop-data"
    secret = "desktop-settings-secret"
    captured: list[str] = []

    def emit_capture(message: dict) -> None:
        captured.append(json.dumps(message))

    import mwt.desktop_entry as entry

    original = entry.emit
    entry.emit = lambda message: captured.append(json.dumps(message))  # type: ignore[assignment]
    try:
        handle(
            {
                "v": 1,
                "id": "set",
                "type": "settings.set",
                "payload": {
                    "provider": "custom",
                    "model": "local-model",
                    "baseUrl": "http://127.0.0.1:9/v1",
                    "wireFormat": "openai",
                    "targetLanguage": "한국어",
                    "stylePrompt": "Keep names",
                    "customSystemPrompt": "Translate safely",
                    "temperature": 0.2,
                    "batchSize": 25,
                    "requestTimeout": 45,
                    "rpmLimit": 30,
                    "tpmLimit": 5000,
                    "maxBatchRetries": 4,
                    "resourcePackEnabled": True,
                    "uiLanguage": "ja",
                    "apiKey": secret,
                },
            },
            tmp / "reports",
            data,
        )
        handle({"v": 1, "id": "get", "type": "settings.get", "payload": {}}, tmp / "reports", data)
        handle(
            {
                "v": 1,
                "id": "get-rust-owned",
                "type": "settings.get",
                "payload": {"credentialOwner": "rust"},
            },
            tmp / "reports",
            data,
        )
    finally:
        entry.emit = original
    assert secret not in "\n".join(captured)
    saved = json.loads((data / "settings.json").read_text(encoding="utf-8"))
    assert saved["provider"] == "custom"
    assert saved["model"] == "local-model"
    assert saved["wire_format"] == "openai"
    assert saved["style_prompt"] == "Keep names"
    assert saved["custom_system_prompt"] == "Translate safely"
    assert saved["temperature"] == 0.2
    assert saved["batch_size"] == 25
    assert saved["request_timeout"] == 45
    assert saved["rpm_limit"] == 30
    assert saved["tpm_limit"] == 5000
    assert saved["max_batch_retries"] == 4
    assert saved["resource_pack_enabled"] is True
    assert saved["ui_language"] == "ja"
    assert secret not in json.dumps(saved)
    assert load_api_key("custom") == secret
    rust_owned = json.loads(captured[-1])
    assert rust_owned["payload"]["apiKeyStored"] is False

    # Switching away from Custom without an explicit URL must discard its hidden endpoint.
    entry.emit = lambda message: None  # type: ignore[assignment]
    try:
        handle(
            {
                "v": 1,
                "id": "switch-provider",
                "type": "settings.set",
                "payload": {"provider": "openrouter", "model": "fixture"},
            },
            tmp / "reports",
            data,
        )
    finally:
        entry.emit = original
    switched = json.loads((data / "settings.json").read_text(encoding="utf-8"))
    assert switched["provider"] == "openrouter"
    assert switched["base_url"] == "https://openrouter.ai/api/v1"
    second = handle
    assert second is handle
    print("PASS providers.desktop_settings")


def test_reasoning_request_shapes() -> None:
    from unittest.mock import patch
    from llm_backends import _model_record
    from mwt.reasoning import normalize_reasoning, reasoning_payload

    info = _model_record("reasoning-model", {
        "supported_parameters": ["reasoning"],
        "reasoning": {"mandatory": False, "default_enabled": True, "default_effort": "high", "supported_efforts": ["max", "high", "low"]},
    }, display_name="Reasoning", description="Synthetic")
    assert info["reasoning"]["supported_efforts"] == ["max", "high", "low"]
    for choice, expected in [
        ("default", None), ("enabled", {"enabled": True, "exclude": True}),
        ("disabled", {"enabled": False, "exclude": True}),
        *[(effort, {"effort": effort, "exclude": True}) for effort in ["low", "high", "max"]],
    ]:
        provider = client("https://example.invalid/v1", "openrouter", "reasoning-model")
        provider.openrouter_reasoning = choice
        provider._catalog_checked = True
        provider.model_info = info
        with patch.object(provider, "_request_json", return_value={"choices": [{"message": {"content": "final answer", "reasoning": "synthetic reasoning"}}]}) as request:
            assert provider.complete_text(system_prompt="translate", user_prompt="sample", temperature=0.3) == "final answer"
            payload = request.call_args.kwargs["payload"]
            assert payload.get("reasoning") == expected, payload
            assert payload["usage"] == {"include": True}
    for choice, metadata in [("medium", info), ("disabled", {**info, "reasoning": {"mandatory": True}}), ("high", None), ("enabled", {"supported_parameters": []})]:
        provider = client("https://example.invalid/v1", "openrouter", "reasoning-model")
        provider.openrouter_reasoning = choice; provider.model_info = metadata; provider._catalog_checked = True
        with patch.object(provider, "_request_json") as request:
            try:
                provider.complete_text(system_prompt="translate", user_prompt="sample", temperature=0.3)
                raise AssertionError("unsupported reasoning must fail before POST")
            except ValueError:
                pass
            request.assert_not_called()
    for invalid in [None, {}, True, "ultra", "HIGH"]:
        try:
            normalize_reasoning(invalid)
            raise AssertionError("invalid choice accepted")
        except ValueError:
            pass
    non_router = client("https://example.invalid/v1", "custom", "reasoning-model")
    non_router.openrouter_reasoning = "high"; non_router._catalog_checked = True
    with patch.object(non_router, "_request_json", return_value={"choices": [{"message": {"content": "ok"}}]}) as request:
        non_router.complete_text(system_prompt="translate", user_prompt="sample", temperature=0.3)
        assert "reasoning" not in request.call_args.kwargs["payload"]
    print("PASS providers.reasoning_shapes_and_boundaries")


def main_test() -> None:
    import tempfile

    test_public_providers()
    test_reasoning_request_shapes()
    server, base = start()
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            tmp = Path(temp_dir)
            test_openai_gemini_anthropic_openrouter_custom(base, tmp)
            test_unknown_model_does_not_write(base, tmp)
            test_settings_are_remembered(tmp)
            test_desktop_settings(tmp)
    finally:
        server.shutdown()
    print("ALL_PROVIDER_TESTS_PASSED")


if __name__ == "__main__":
    main_test()
