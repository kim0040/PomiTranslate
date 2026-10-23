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
    "openai": [
        "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-5", "gpt-5-mini", "o3", "o4-mini", "json-model", "text-model",
        # Audio models that answer in text through chat completions (P-5).
        "gpt-audio", "gpt-audio-mini", "gpt-4o-audio-preview",
    ],
    "gemini": [
        "gemini-test", "gemini-3.5-flash", "gemini-3.8-flash", "gemini-flash-latest", "gemini-2.5-flash",
        "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemma-3-27b-it",
    ],
    "anthropic": ["claude-sonnet-4-5", "claude-opus-4-1-20250805", "claude-3-5-haiku-20241022", "claude-haiku-4-5"],
    "openrouter": [
        "openai/gpt-4o-mini", "xiaomi/mimo-v2.6-flash", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-flash",
        "meta-llama/llama-3.3-70b-instruct", "deepseek/deepseek-chat-v3.1:free", "qwen/qwen3-235b-a22b",
        "openai/gpt-audio", "openai/gpt-audio-mini", "openai/gpt-4o-audio-preview",
    ],
}
DROP = {
    "openai": [
        "text-embedding-3-small", "text-embedding-ada-002", "omni-moderation-latest", "text-moderation-stable",
        "whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "tts-1", "tts-1-hd", "gpt-4o-mini-tts",
        "dall-e-3", "gpt-image-1", "sora-2", "gpt-4o-realtime-preview", "gpt-realtime",
        "computer-use-preview", "o3-deep-research", "embed-model",
    ],
    "gemini": [
        "gemini-robotics-er-1.5-preview", "gemini-2.5-computer-use-preview-10-2025", "gemini-embedding-001",
        "gemini-embed", "gemini-2.5-flash-image", "gemini-3-pro-image-preview", "imagen-4.0-generate-001",
        "veo-3.0-generate-preview", "gemini-2.5-flash-preview-tts", "gemini-2.5-flash-native-audio-preview-09-2025",
        "gemini-live-2.5-flash-preview", "gemini-2.0-flash-live-001", "lyria-realtime-exp", "aqa",
    ],
    "anthropic": [],
    "openrouter": [
        "openai/gpt-4o-realtime-preview", "openai/gpt-4o-transcribe", "google/gemini-robotics-er-1.5-preview",
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
    # Extra outputs next to text are not a reason (P-5): the model still writes text.
    for outputs in (["audio", "text"], ["text", "image"], ["text", "audio", "video"]):
        assert unsuitable_reason("openrouter", "vendor/plain-name", record("x", outputs)) == "", outputs
    for provider, model_id in (("openai", "gpt-audio"), ("openai", "gpt-audio-mini"), ("openrouter", "openai/gpt-audio"), ("openrouter", "openai/gpt-audio-mini")):
        assert unsuitable_reason(provider, model_id, record(model_id, ["text"])) == "", model_id
        assert unsuitable_reason(provider, model_id, record(model_id, ["text", "audio"])) == "", model_id
    # Without text among the outputs it is out, and so are the endpoint-specific families, even with text listed.
    assert unsuitable_reason("openrouter", "vendor/plain-name", record("x", ["audio"])) == "output:audio"
    assert unsuitable_reason("openai", "gpt-realtime", record("gpt-realtime", ["text", "audio"])) == "id:realtime"
    assert unsuitable_reason("openai", "gpt-4o-mini-tts", record("x", ["text", "audio"])) == "id:tts"
    # What the list reader found: no text output, or a Gemini model without generateContent.
    assert unsuitable_reason("openai", "plain-name", {"id": "plain-name", "text": False})
    assert unsuitable_reason("gemini", "plain-name", {"id": "plain-name", "generation_methods": ["embedContent"]}) == "method:generateContent"
    assert unsuitable_reason("gemini", "plain-name", {"id": "plain-name", "generation_methods": ["generateContent"]}) == ""
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
    # A configured id the list does not contain is not invented.
    assert [item["id"] for item in filter_translation_models("openai", models, configured="missing")] == ["gpt-4o"]
    # A mark left by an earlier selection is recomputed, not trusted.
    marked = [{"id": "gpt-4o", "unsuitable_reason": "id:old"}, {"id": "tts-1", "unsuitable_reason": "id:tts"}]
    again = filter_translation_models("openai", marked, configured="gpt-4o")
    assert again == [{"id": "gpt-4o"}], again
    assert marked[0]["unsuitable_reason"] == "id:old", "the input record is not changed"
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
                + [
                    {"name": "models/gemini-embedding-001", "displayName": "e", "supportedGenerationMethods": ["embedContent"]},
                    {"name": "models/gemini-no-generate", "displayName": "n", "supportedGenerationMethods": ["countTokens"]},
                ]
            }
        else:
            body = {
                "data": [
                    {"id": "gpt-4o-mini", "owned_by": "system"},
                    {"id": "text-embedding-3-small", "owned_by": "system"},
                    {"id": "gpt-4o-mini-tts", "owned_by": "system"},
                    {"id": "gpt-image-1", "owned_by": "system"},
                    {"id": "vendor/pic-gen", "architecture": {"output_modalities": ["image"]}},
                    {"id": "vendor/talker", "architecture": {"output_modalities": ["text", "audio"]}},
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
        assert [item["id"] for item in openai.list_models()] == ["gpt-4o-mini", "vendor/talker"]
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
        test_keep_paths(base, tmp)
    finally:
        server.shutdown()
        server.server_close()
    print("PASS model_filter.client")


def listed(base: str, provider: str, keep: str, data_dir: Path | None = None) -> list[dict]:
    """What the desktop list request does: ``model`` stays blank, the saved model travels as ``keep_model``."""
    blank = client(base, provider, "", data_dir)
    blank.keep_model = keep
    return blank.try_refresh_text_models()


def test_keep_paths(base: str, tmp: Path) -> None:
    from llm_backends import ModelCatalogError
    from mwt.userdata import load_model_catalog

    # P-3 scenario A / UX F3: the request model is blank, the saved one still comes back, marked.
    found = listed(f"{base}/v1", "openai", "gpt-4o-mini-tts")
    assert [item["id"] for item in found] == ["gpt-4o-mini", "gpt-4o-mini-tts", "vendor/talker"], found
    assert found[1]["unsuitable_reason"] == "id:tts" and "unsuitable_reason" not in found[0]
    found = listed(f"{base}/v1beta", "gemini", "gemini-robotics-er-1.5-preview")
    assert [item["id"] for item in found] == ["gemini-2.5-flash", "gemini-robotics-er-1.5-preview"], found
    assert found[1]["unsuitable_reason"] == "id:robotics"
    # P-3 scenario B: a record the provider says writes no text, and a Gemini model without generateContent.
    found = listed(f"{base}/v1", "openai", "vendor/pic-gen")
    assert [item["id"] for item in found] == ["gpt-4o-mini", "vendor/pic-gen", "vendor/talker"], found
    assert found[1]["unsuitable_reason"] == "output:image"
    found = listed(f"{base}/v1beta", "gemini", "gemini-no-generate")
    assert [item["id"] for item in found] == ["gemini-2.5-flash", "gemini-no-generate"], found
    assert found[1]["unsuitable_reason"] == "method:generateContent"
    # Without a saved model neither shows, as before the prefilters moved into the filter.
    assert [item["id"] for item in listed(f"{base}/v1", "openai", "")] == ["gpt-4o-mini", "vendor/talker"]
    assert [item["id"] for item in listed(f"{base}/v1beta", "gemini", "")] == ["gemini-2.5-flash"]
    # A saved id the provider does not list is not invented; the screen's own warning covers it.
    assert [item["id"] for item in listed(f"{base}/v1", "openai", "gone-model")] == ["gpt-4o-mini", "vendor/talker"]
    # P-4: the cache holds the whole normalized catalog without marks, and the filter runs when it is read.
    data = tmp / "switch"
    listed(f"{base}/v1", "openai", "gpt-4o-mini-tts", data)
    cached = load_model_catalog("openai", root=data)
    ids = [item["id"] for item in cached]
    assert {"gpt-4o-mini", "gpt-4o-mini-tts", "text-embedding-3-small", "gpt-image-1", "vendor/pic-gen"} <= set(ids), ids
    assert not any("unsuitable_reason" in item for item in cached), "a mark belongs to one selection"
    for keep, marked in (("gpt-image-1", "id:gpt-image"), ("text-embedding-3-small", "id:embed")):
        found = listed("http://127.0.0.1:9/v1", "openai", keep, data)  # offline: the cache answers
        reasons = {item["id"]: item.get("unsuitable_reason") for item in found}
        assert reasons == {"gpt-4o-mini": None, keep: marked, "vendor/talker": None}, (keep, reasons)
    # A cache written with an earlier selection's mark (or before the filter) is not trusted either.
    from mwt.userdata import remember_model_catalog

    stale = tmp / "stale-mark"
    remember_model_catalog("openai", [{"id": "gpt-4o-mini"}, {"id": "gpt-image-1"}], root=stale)
    path = next((stale / "models").glob("openai.json"))
    document = json.loads(path.read_text(encoding="utf-8"))
    document["models"][0]["unsuitable_reason"] = "id:old"
    path.write_text(json.dumps(document), encoding="utf-8")
    found = listed("http://127.0.0.1:9/v1", "openai", "gpt-image-1", stale)
    assert [(item["id"], item.get("unsuitable_reason")) for item in found] == [("gpt-4o-mini", None), ("gpt-image-1", "id:gpt-image")], found
    # A job (model set, not blank) still refuses a model that writes no text, as it did before.
    for model in ("vendor/pic-gen", "gpt-4o-mini-tts"):
        job = client(f"{base}/v1", "openai", model)
        try:
            job.try_refresh_text_models()
        except ModelCatalogError:
            pass
        else:
            raise AssertionError(f"{model} must not be accepted as a text model")
    ok = client(f"{base}/v1", "openai", "vendor/talker")
    ok.try_refresh_text_models()
    assert ok.model == "vendor/talker"
    print("PASS model_filter.keep_paths")


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
