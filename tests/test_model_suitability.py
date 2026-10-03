"""The catalog marks models that are not for translating text, and a connection check reports readable codes.

No network and no paid call: every provider response here is a patched stand-in.
"""
from __future__ import annotations

import io
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch
from urllib import error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import mwt.desktop_entry as entry
from llm_backends import LLMProviderClient, ProviderError, annotate_suitability, is_translation_suitable


def test_ids_and_modalities() -> None:
    for model_id in [
        "gpt-5-mini", "gpt-4o", "gemini-2.5-flash", "gemini-2.5-flash-lite", "claude-haiku-4-5", "claude-sonnet-4-5",
        "deepseek/deepseek-v4.1-flash", "meta-llama/llama-3.3-70b-instruct", "mistral-small-latest",
        "xiaomi/mimo-v2.6-flash", "o4-mini", "grok-4-fast",
    ]:
        assert is_translation_suitable(model_id), model_id
    for model_id in [
        "text-embedding-3-large", "text-embedding-004", "whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-tts", "tts-1-hd",
        "dall-e-3", "gpt-image-1", "imagen-4.0-generate", "gemini-2.5-flash-image", "omni-moderation-latest",
        "gpt-realtime", "gpt-4o-realtime-preview", "gpt-4o-audio-preview", "gemini-robotics-er-1.5-preview",
        "computer-use-preview", "claude-computer-use", "gemini-2.5-computer-use-preview", "veo-3.0-generate", "sora-2",
        "gemini-live-2.5-flash", "openai/gpt-5-image",
    ]:
        assert not is_translation_suitable(model_id), model_id
    # A catalog that publishes modalities decides for itself, except for ids that name another purpose.
    assert not is_translation_suitable("some/painter", {"architecture": {"output_modalities": ["image"]}})
    assert not is_translation_suitable("some/speaker", {"architecture": {"output_modalities": ["audio"]}})
    assert is_translation_suitable("some/vision-chat", {"architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]}})
    assert is_translation_suitable("some/mixed", {"architecture": {"output_modalities": ["text", "image"]}})
    assert not is_translation_suitable("some/mixed-image-out", {"architecture": {"output_modalities": ["text", "image"]}})
    # The words must match whole id parts: "imagination" or "livery" are not "image" or "live".
    assert is_translation_suitable("vendor/imagination-chat")
    assert is_translation_suitable("vendor/livery-8b")
    print("PASS model_suitability.ids_and_modalities")


def test_annotate_marks_every_record_including_old_cache_entries() -> None:
    records = [
        {"id": "gpt-5-mini"},
        {"id": "whisper-1"},
        {"id": "kept-flag", "suitable": False},
        {"id": "old-image", "output_modalities": ["image"]},
        {"id": "old-text", "output_modalities": ["text"]},
    ]
    marked = {record["id"]: record["suitable"] for record in annotate_suitability(records)}
    assert marked == {"gpt-5-mini": True, "whisper-1": False, "kept-flag": False, "old-image": False, "old-text": True}
    assert "suitable" not in records[0], "the input records are left as they were"
    print("PASS model_suitability.annotate")


def _handle(payload: dict, data: Path) -> dict:
    with patch.object(entry, "emit") as emit:
        entry.handle({"v": 1, "id": "check", "type": "models.list", "payload": payload}, data / "reports", data)
    return emit.call_args.args[0]


def test_models_list_reports_suitability_and_hidden_count() -> None:
    catalog = [
        {"id": "gpt-5-mini", "text": True, "suitable": True},
        {"id": "text-embedding-3-large", "text": True},
        {"id": "gpt-image-1"},
    ]
    with tempfile.TemporaryDirectory() as directory, patch.object(LLMProviderClient, "try_refresh_text_models", return_value=catalog):
        reply = _handle({"provider": "openai", "model": "", "credentialOwner": "rust", "apiKey": "synthetic-key"}, Path(directory) / "data")
    assert reply["type"] == "response.ok"
    flags = {item["id"]: item["suitable"] for item in reply["payload"]["models"]}
    assert flags == {"gpt-5-mini": True, "text-embedding-3-large": False, "gpt-image-1": False}
    assert reply["payload"]["hiddenCount"] == 2
    print("PASS model_suitability.models_list_payload")


def test_connection_check_error_codes() -> None:
    cases = [
        (ProviderError("rejected", status=401), "AUTH_FAILED"),
        (ProviderError("rejected", status=403), "AUTH_FAILED"),
        (ProviderError("no credit", status=402), "NO_CREDIT"),
        (ProviderError("slow down", status=429), "RATE_LIMITED"),
        (ProviderError("down", status=503), "PROVIDER_ERROR"),
        (ProviderError("bad request", status=400), "REQUEST_REJECTED"),
        (ProviderError("unreachable"), "NETWORK_ERROR"),
        (ProviderError("too slow", kind="TIMEOUT"), "TIMEOUT"),
        (RuntimeError("OpenAI API key is missing."), "KEY_MISSING"),
        (ValueError("something unexpected"), "MODELS_FAILED"),
    ]
    with tempfile.TemporaryDirectory() as directory:
        data = Path(directory) / "data"
        for failure, code in cases:
            with patch.object(LLMProviderClient, "check_connection", side_effect=failure):
                reply = _handle({"provider": "openai", "model": "", "credentialOwner": "rust", "apiKey": "synthetic-key", "connectionCheck": True}, data)
            assert reply["type"] == "response.error" and reply["error"]["code"] == code, (code, reply)
        # A failed check never falls back to a cached list: it would make a wrong key look fine.
        from mwt.userdata import remember_model_catalog
        remember_model_catalog("openai", [{"id": "cached-model", "text": True}], root=data)
        with patch.object(LLMProviderClient, "check_connection", side_effect=ProviderError("rejected", status=401)):
            reply = _handle({"provider": "openai", "model": "", "credentialOwner": "rust", "apiKey": "synthetic-key", "connectionCheck": True}, data)
        assert reply["type"] == "response.error" and reply["error"]["code"] == "AUTH_FAILED"
    print("PASS model_suitability.connection_check_codes")


def test_connection_check_success_remembers_the_catalog() -> None:
    models = [{"id": "gpt-5-mini", "text": True}, {"id": "gpt-image-1", "text": True}]
    with tempfile.TemporaryDirectory() as directory, patch.object(LLMProviderClient, "check_connection", return_value=models):
        data = Path(directory) / "data"
        reply = _handle({"provider": "openai", "model": "", "credentialOwner": "rust", "apiKey": "synthetic-key", "connectionCheck": True}, data)
        assert reply["type"] == "response.ok" and reply["payload"]["cached"] is False and reply["payload"]["hiddenCount"] == 1
        from mwt.userdata import load_model_catalog
        assert [item["id"] for item in load_model_catalog("openai", root=data)] == ["gpt-5-mini", "gpt-image-1"]
    print("PASS model_suitability.connection_check_success")


def _client(provider: str, key: str = "sk-synthetic-secret-1234567890") -> LLMProviderClient:
    from llm_backends import default_base_url
    return LLMProviderClient({"api": {"provider": provider, "model": "", "api_key": key, "base_url": default_base_url(provider), "wire_format": "openai"}})


def test_check_connection_requests_and_failures() -> None:
    # OpenRouter lists models without a key, so its key is checked on /key before the list.
    router = _client("openrouter")
    calls: list[str] = []
    def fake(method, url, *, headers, payload=None):
        calls.append(url)
        return {"data": []} if url.endswith("/key") else {"data": [{"id": "a/chat", "architecture": {"output_modalities": ["text"]}}]}
    with patch.object(router, "_request_json", side_effect=fake):
        assert [item["id"] for item in router.check_connection()] == ["a/chat"]
    assert calls[0].endswith("/key") and len(calls) == 2
    with patch.object(router, "_request_json", side_effect=ProviderError("HTTP 401", status=401)):
        try:
            router.check_connection()
        except ProviderError as exc:
            assert exc.code == "AUTH_FAILED"
        else:
            raise AssertionError("a rejected key must fail the check")

    # Other providers fail loudly on the list itself, while the ordinary refresh hides the failure.
    plain = _client("openai")
    with patch.object(plain, "_request_json", side_effect=ProviderError("HTTP 401", status=401)):
        try:
            plain.check_connection()
        except ProviderError as exc:
            assert exc.code == "AUTH_FAILED"
        else:
            raise AssertionError("a rejected key must fail the check")
    try:
        _client("openai", key="").check_connection()
    except RuntimeError as exc:
        assert "API key is missing" in str(exc)
    else:
        raise AssertionError("a missing key must fail the check")
    print("PASS model_suitability.check_connection")


def test_transport_failures_have_codes_and_never_echo_the_key() -> None:
    secret = "sk-synthetic-secret-1234567890"
    client = _client("openai", secret)
    with patch("llm_backends.request.urlopen", side_effect=error.URLError(TimeoutError("timed out"))):
        try:
            client.check_connection()
        except ProviderError as exc:
            assert exc.code == "TIMEOUT"
        else:
            raise AssertionError("a timeout must fail the check")
    with patch("llm_backends.request.urlopen", side_effect=error.URLError(OSError("Name or service not known"))):
        try:
            client.check_connection()
        except ProviderError as exc:
            assert exc.code == "NETWORK_ERROR"
        else:
            raise AssertionError("an unreachable host must fail the check")
    body = io.BytesIO(json.dumps({"error": {"message": f"Incorrect API key provided: {secret}"}}).encode())
    http = error.HTTPError("https://api.openai.com/v1/models", 401, "Unauthorized", {}, body)
    with tempfile.TemporaryDirectory() as directory, patch("llm_backends.request.urlopen", side_effect=http):
        reply = _handle({"provider": "openai", "model": "", "credentialOwner": "rust", "apiKey": secret, "connectionCheck": True}, Path(directory) / "data")
    assert reply["error"]["code"] == "AUTH_FAILED"
    assert secret not in json.dumps(reply), "the typed key must not come back in an error"
    print("PASS model_suitability.transport_codes_and_redaction")


if __name__ == "__main__":
    test_ids_and_modalities()
    test_annotate_marks_every_record_including_old_cache_entries()
    test_models_list_reports_suitability_and_hidden_count()
    test_connection_check_error_codes()
    test_connection_check_success_remembers_the_catalog()
    test_check_connection_requests_and_failures()
    test_transport_failures_have_codes_and_never_echo_the_key()
    print("ALL_MODEL_SUITABILITY_TESTS_PASSED")
