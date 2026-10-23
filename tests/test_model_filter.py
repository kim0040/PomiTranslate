"""Model lists offer models that can translate text; the one a person configured is never hidden."""

from __future__ import annotations

import json
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from llm_backends import LLMProviderClient
from mwt.model_filter import filter_translation_models, unsuitable_reason


def record(model_id: str, outputs: list[str] | None = None) -> dict:
    item: dict = {"id": model_id}
    if outputs is not None:
        item["output_modalities"] = outputs
    return item


# The ids the provider test fixtures serve, plus the public naming shapes each provider uses.
KEEP = {
    "openai": ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-5", "gpt-5-mini", "o3", "o4-mini", "json-model", "text-model"],
    "gemini": [
        "gemini-test", "gemini-3.5-flash", "gemini-3.8-flash", "gemini-flash-latest", "gemini-2.5-flash",
        "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemma-3-27b-it",
    ],
    "anthropic": ["claude-sonnet-4-5", "claude-opus-4-1-20250805", "claude-3-5-haiku-20241022", "claude-haiku-4-5"],
    "openrouter": [
        "openai/gpt-4o-mini", "xiaomi/mimo-v2.6-flash", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-flash",
        "meta-llama/llama-3.3-70b-instruct", "deepseek/deepseek-chat-v3.1:free", "qwen/qwen3-235b-a22b",
    ],
}
DROP = {
    "openai": [
        "text-embedding-3-small", "text-embedding-ada-002", "omni-moderation-latest", "text-moderation-stable",
        "whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "tts-1", "tts-1-hd", "gpt-4o-mini-tts",
        "dall-e-3", "gpt-image-1", "sora-2", "gpt-4o-realtime-preview", "gpt-realtime", "gpt-4o-audio-preview",
        "gpt-audio", "computer-use-preview", "o3-deep-research", "embed-model",
    ],
    "gemini": [
        "gemini-robotics-er-1.5-preview", "gemini-2.5-computer-use-preview-10-2025", "gemini-embedding-001",
        "gemini-embed", "gemini-2.5-flash-image", "gemini-3-pro-image-preview", "imagen-4.0-generate-001",
        "veo-3.0-generate-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-flash-native-audio-preview-09-2025",
        "gemini-live-2.5-flash-preview", "gemini-2.0-flash-live-001", "lyria-realtime-exp", "aqa",
    ],
    "anthropic": [],
    "openrouter": [
        "openai/gpt-4o-audio-preview", "openai/gpt-audio", "google/gemini-robotics-er-1.5-preview",
        "google/gemini-2.5-computer-use-preview", "google/gemini-2.5-flash-image", "openai/text-embedding-3-large",
        "meta-llama/llama-guard-4-12b", "openai/o3-deep-research",
    ],
}


def test_ids_by_provider() -> None:
    for provider, ids in KEEP.items():
        for model_id in ids:
            assert unsuitable_reason(provider, model_id) == "", (provider, model_id)
        kept = [item["id"] for item in filter_translation_models(provider, [record(i) for i in ids])]
        assert kept == ids, provider
    for provider, ids in DROP.items():
        for model_id in ids:
            assert unsuitable_reason(provider, model_id), (provider, model_id)
        assert filter_translation_models(provider, [record(i) for i in ids]) == [], provider
    print("PASS model_filter.ids")


def test_words_match_whole_segments() -> None:
    # "tts", "veo", "live" are words, not substrings: ids that merely contain the letters stay.
    for model_id in ("matts-instruct", "oliver-7b", "deliverance-1", "alive-chat", "veolia-text", "sorachat"):
        assert unsuitable_reason("openrouter", model_id) == "", model_id
    for model_id in ("vendor/some-tts", "vendor/model.tts.v2", "vendor/live", "veo-3"):
        assert unsuitable_reason("openrouter", model_id), model_id
    print("PASS model_filter.words")


def test_capability_fields_win() -> None:
    assert unsuitable_reason("openrouter", "vendor/plain-name", record("x", ["image"])) == "output:image"
    assert unsuitable_reason("openrouter", "vendor/plain-name", record("x", ["audio", "text"])) == "output:audio"
    assert unsuitable_reason("openrouter", "vendor/plain-name", record("x", ["text"])) == ""
    assert unsuitable_reason("openrouter", "vendor/plain-name", record("x", [])) == ""
    # What the provider says about outputs is not overridden by a name that looks fine.
    assert unsuitable_reason("openai", "gpt-5", record("gpt-5", ["embeddings"])) == "output:embeddings"
    print("PASS model_filter.capabilities")


def test_configured_model_stays_marked() -> None:
    models = [record("gpt-4o"), record("text-embedding-3-small"), record("tts-1")]
    kept = filter_translation_models("openai", models, configured="tts-1")
    assert [item["id"] for item in kept] == ["gpt-4o", "tts-1"]
    assert kept[1]["unsuitable_reason"] == "id:tts" and "unsuitable_reason" not in kept[0]
    assert "unsuitable_reason" not in models[2], "the input record is not changed"
    assert [item["id"] for item in filter_translation_models("openai", models)] == ["gpt-4o"]
    assert [item["id"] for item in filter_translation_models("openai", models, configured="gpt-4o")] == ["gpt-4o"]
    print("PASS model_filter.configured")


class Catalog(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/v1beta/models"):
            body = {
                "models": [
                    {"name": f"models/{name}", "displayName": name, "supportedGenerationMethods": ["generateContent"]}
                    for name in (
                        "gemini-2.5-flash",
                        "gemini-robotics-er-1.5-preview",
                        "gemini-2.5-computer-use-preview-10-2025",
                        "gemini-2.5-flash-preview-tts",
                    )
                ]
            }
        else:
            body = {
                "data": [
                    {"id": "gpt-4o-mini", "owned_by": "system"},
                    {"id": "text-embedding-3-small", "owned_by": "system"},
                    {"id": "gpt-4o-mini-tts", "owned_by": "system"},
                    {"id": "gpt-image-1", "owned_by": "system"},
                ]
            }
        raw = json.dumps(body).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


def client(base: str, provider: str, model: str, data_dir: Path | None = None) -> LLMProviderClient:
    return LLMProviderClient(
        {
            "api": {"provider": provider, "api_key": "k", "base_url": base, "model": model, "request_timeout": 30},
            "runtime": {"data_dir": str(data_dir) if data_dir else ""},
        }
    )


def test_client_lists(tmp: Path) -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Catalog)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    base = f"http://{host}:{port}"
    try:
        openai = client(f"{base}/v1", "openai", "")
        assert [item["id"] for item in openai.list_models()] == ["gpt-4o-mini"]
        gemini = client(f"{base}/v1beta", "gemini", "")
        assert [item["id"] for item in gemini.list_models()] == ["gemini-2.5-flash"]
        # The model already chosen stays in the list the screen gets, marked.
        configured = client(f"{base}/v1beta", "gemini", "gemini-robotics-er-1.5-preview", tmp / "marked")
        listed = configured.try_refresh_text_models()
        assert [item["id"] for item in listed] == ["gemini-2.5-flash", "gemini-robotics-er-1.5-preview"]
        assert listed[1]["unsuitable_reason"] == "id:robotics" and configured.model_info["unsuitable_reason"]
        # A catalog cached before the filter existed is filtered when it is read back.
        from mwt.userdata import remember_model_catalog

        remember_model_catalog(
            "openai",
            [{"id": "gpt-4o-mini", "text": True}, {"id": "text-embedding-3-small", "text": True}, {"id": "gpt-image-1"}],
            root=tmp / "stale",
        )
        offline = client("http://127.0.0.1:9/v1", "openai", "", tmp / "stale")
        assert [item["id"] for item in offline.try_refresh_text_models()] == ["gpt-4o-mini"]
    finally:
        server.shutdown()
        server.server_close()
    print("PASS model_filter.client")


def main() -> None:
    test_ids_by_provider()
    test_words_match_whole_segments()
    test_capability_fields_win()
    test_configured_model_stays_marked()
    with tempfile.TemporaryDirectory() as raw:
        test_client_lists(Path(raw))
    print("PASS model_filter")


if __name__ == "__main__":
    main()
