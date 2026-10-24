"""No paid API: prove Rust-owned JSONL ignores inherited provider credentials/routes."""
from __future__ import annotations
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from mwt.desktop_provider import resolve_desktop_provider
import mwt.desktop_entry as entry


def main_test():
    from mwt.userdata import remember_user_settings
    poison = {"POMI_PROVIDER": "custom", "POMI_MODEL": "poison-model", "POMI_API_BASE": "https://wrong-host.invalid/v1", "POMI_WIRE_FORMAT": "anthropic", "POMI_API_KEY": "poison-fixture"}
    seen = []
    class Client:
        def __init__(self, config):
            seen.append(config["api"].copy())
        def try_refresh_text_models(self):
            return []
    with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, poison), patch("llm_backends.LLMProviderClient", Client), patch.object(entry, "emit") as emit:
        data = Path(directory) / "data"
        remember_user_settings({"provider": "custom", "base_url": "https://old-host.invalid", "model": "saved-model"}, data)
        body = {"provider": "openrouter", "model": "selected-model", "credentialOwner": "rust", "apiKey": "selected-fixture"}
        entry.handle({"v": 1, "id": "owned", "type": "models.list", "payload": body}, Path(directory) / "reports", data)
        assert seen[-1]["provider"] == "openrouter"
        assert seen[-1]["base_url"] == "https://openrouter.ai/api/v1"
        assert seen[-1]["model"] == "selected-model"
        assert seen[-1]["api_key"] == "selected-fixture"
        body.pop("apiKey")
        entry.handle({"v": 1, "id": "no-key", "type": "models.list", "payload": body}, Path(directory) / "reports", data)
        assert seen[-1]["api_key"] == "", "owned request must not fall back to environment key"
        assert "selected-fixture" not in json.dumps([call.args for call in emit.call_args_list])
    configs = []
    class Translator:
        def __init__(self, config, **kwargs):
            configs.append(config)
        def run(self):
            return {"status": "completed"}
    with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, poison), patch("mc_world_translator.WorldTranslator", Translator), patch("mwt.secrets.load_api_key", side_effect=AssertionError("desktop must not read keyring")):
        data = Path(directory) / "data"
        remember_user_settings({"provider": "openrouter", "model": "saved-model", "target_language": "한국어"}, data)
        kwargs = dict(world=Path(directory), dry_run=False, report_path=Path(directory)/"report.json", fingerprint="fixture", data_dir=data, allow_keyring_fallback=False)
        entry._run_translator(**kwargs, desktop_context={"provider":"openrouter","model":"selected-model","apiKey":"selected-fixture"})
        assert configs[-1]["api"]["provider"] == "openrouter"
        assert configs[-1]["api"]["model"] == "selected-model"
        assert configs[-1]["api"]["base_url"] == "https://openrouter.ai/api/v1"
        assert configs[-1]["api"]["api_key"] == "selected-fixture"
        entry._run_translator(**kwargs)
        assert configs[-1]["api"]["provider"] == "custom", "non-Rust compatibility keeps intentional environment overrides"
        assert configs[-1]["api"]["base_url"] == poison["POMI_API_BASE"]
    for provider in ["openai", "openrouter", "gemini", "anthropic", "comet"]:
        try:
            resolve_desktop_provider({"provider": provider, "baseUrl": "https://wrong.invalid"}, {})
        except ValueError:
            pass
        else:
            raise AssertionError("public provider accepted another host")
    print("PASS desktop_provider.owned_context_and_no_environment_fallback")


def test_public_catalog() -> None:
    from llm_backends import LLMProviderClient
    from mwt.userdata import remember_user_settings, settings_path

    with tempfile.TemporaryDirectory() as directory:
        data = Path(directory) / "data"
        remember_user_settings({"provider": "custom", "model": "unsaved-fixture", "target_language": "한국어"}, data)
        before = settings_path(data).read_bytes()
        body = {"provider": "openrouter", "publicCatalog": True, "credentialOwner": "rust", "model": "", "apiKey": "synthetic-ignored-key"}
        request = {"v": 1, "id": "public", "type": "models.list", "payload": body}
        catalog = {"data": [{"id": "reasoning-fixture", "reasoning": {"default_enabled": True, "default_effort": "high", "supported_efforts": ["low", "high"]}}]}
        with patch.dict(os.environ, {"POMI_API_KEY": "synthetic-inherited-key"}), patch("mwt.secrets.load_api_key", side_effect=AssertionError("public lookup must not read keys")), patch.object(LLMProviderClient, "_request_json", return_value=catalog) as network, patch.object(entry, "emit") as emit:
            entry.handle(request, data / "reports", data)
            method, url = network.call_args.args
            assert method == "GET" and url == "https://openrouter.ai/api/v1/models"
            assert "Authorization" not in network.call_args.kwargs["headers"]
            reply = emit.call_args.args[0]
            assert reply["type"] == "response.ok" and reply["payload"]["cached"] is False
            assert reply["payload"]["models"][0]["reasoning"]["default_enabled"] is True
            assert "synthetic-ignored-key" not in json.dumps(reply)
        assert settings_path(data).read_bytes() == before
        with patch.object(LLMProviderClient, "_request_json", side_effect=RuntimeError("Synthetic offline")), patch.object(entry, "emit") as emit:
            entry.handle(request, data / "reports", data)
            assert emit.call_args.args[0]["payload"]["cached"] is True
            fresh = Path(directory) / "fresh"
            entry.handle(request, fresh / "reports", fresh)
            assert emit.call_args.args[0]["type"] == "response.error"
        assert settings_path(data).read_bytes() == before
    with tempfile.TemporaryDirectory() as directory:
        # A saved OpenRouter model that is not a text model stays in the list, marked, instead of vanishing.
        data = Path(directory) / "data"
        remember_user_settings({"provider": "openrouter", "model": "google/gemini-robotics-fixture", "target_language": "한국어"}, data)
        body = {"provider": "openrouter", "publicCatalog": True, "credentialOwner": "rust", "model": ""}
        catalog = {"data": [{"id": "text-fixture"}, {"id": "google/gemini-robotics-fixture"}, {"id": "other/robotics-fixture-2"}]}
        with patch.object(LLMProviderClient, "_request_json", return_value=catalog), patch.object(entry, "emit") as emit:
            entry.handle({"v": 1, "id": "kept", "type": "models.list", "payload": body}, data / "reports", data)
            models = emit.call_args.args[0]["payload"]["models"]
        ids = [item["id"] for item in models if item.get("suitable") is not False or item.get("unsuitable_reason")]
        assert "text-fixture" in ids and "google/gemini-robotics-fixture" in ids and "other/robotics-fixture-2" not in ids, ids
        assert next(item for item in models if item["id"] == "google/gemini-robotics-fixture").get("unsuitable_reason")
    print("PASS desktop_provider.public_catalog_no_credentials_no_settings_write_cache_and_retry")

def _models_list(data: Path, body: dict, *, network, saved: dict | None = None) -> dict:
    """The reply of a models.list request whose provider answers ``network`` (a value, or an exception)."""
    from llm_backends import LLMProviderClient
    from mwt.userdata import remember_user_settings

    if saved is not None:
        remember_user_settings(saved, data)
    patched = {"side_effect": network} if isinstance(network, BaseException) else {"return_value": network}
    with patch.object(LLMProviderClient, "_request_json", **patched), patch.object(entry, "emit") as emit:
        entry.handle({"v": 1, "id": "list", "type": "models.list", "payload": body}, data / "reports", data)
    return emit.call_args.args[0]


def _marks(reply: dict) -> dict:
    assert reply["type"] == "response.ok", reply
    return {item["id"]: item.get("unsuitable_reason") for item in reply["payload"]["models"] if item.get("suitable") is not False or item.get("unsuitable_reason")}


def test_saved_model_on_every_list_path() -> None:
    """The saved model comes back marked on authenticated lists too, though the request's model is blank (P-3, UX F3)."""
    with tempfile.TemporaryDirectory() as directory:
        data = Path(directory) / "data"
        openai = {"data": [{"id": "gpt-4o-mini"}, {"id": "gpt-4o-mini-tts"}, {"id": "gpt-image-1"}]}
        body = {"provider": "openai", "model": "", "wireFormat": "openai", "apiKey": "synthetic"}
        reply = _models_list(data, body, network=openai, saved={"provider": "openai", "model": "gpt-4o-mini-tts"})
        assert _marks(reply) == {"gpt-4o-mini": None, "gpt-4o-mini-tts": "id:tts"}, reply
        # Another provider's saved model is not carried over.
        reply = _models_list(data, {**body, "provider": "anthropic", "model": ""}, network={"data": [{"id": "claude-sonnet-4-5"}]})
        assert _marks(reply) == {"claude-sonnet-4-5": None}
        # Gemini: unsuitable by name, and one without generateContent.
        gemini = {"models": [
            {"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/gemini-robotics-er-1.5-preview", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/gemini-no-generate", "supportedGenerationMethods": ["countTokens"]},
        ]}
        gbody = {"provider": "gemini", "model": "", "credentialOwner": "rust", "apiKey": "synthetic"}
        reply = _models_list(data, gbody, network=gemini, saved={"provider": "gemini", "model": "gemini-robotics-er-1.5-preview"})
        assert _marks(reply) == {"gemini-2.5-flash": None, "gemini-robotics-er-1.5-preview": "id:robotics"}, reply
        reply = _models_list(data, gbody, network=gemini, saved={"provider": "gemini", "model": "gemini-no-generate"})
        assert _marks(reply) == {"gemini-2.5-flash": None, "gemini-no-generate": "method:generateContent"}, reply
        # A model the provider does not list at all is not invented.
        reply = _models_list(data, gbody, network=gemini, saved={"provider": "gemini", "model": "gone"})
        assert _marks(reply) == {"gemini-2.5-flash": None}, reply
        # The authenticated cache answers a failed request, filtered for the saved model of that moment.
        reply = _models_list(data, gbody, network=RuntimeError("offline"), saved={"provider": "gemini", "model": "gemini-no-generate"})
        assert _marks(reply) == {"gemini-2.5-flash": None, "gemini-no-generate": "method:generateContent"}, reply
    print("PASS desktop_provider.saved_model_on_authenticated_lists")


def test_public_catalog_keeps_and_refilters() -> None:
    """A model the text-only public query cannot return is retained when it is, and cached lists are filtered when read (P-3, P-4)."""
    with tempfile.TemporaryDirectory() as directory:
        data = Path(directory) / "data"
        body = {"provider": "openrouter", "publicCatalog": True, "credentialOwner": "rust", "model": ""}
        image = {"data": [
            {"id": "text-model", "architecture": {"output_modalities": ["text"]}},
            {"id": "openai/gpt-image-1", "architecture": {"output_modalities": ["image"]}},
            {"id": "openai/gpt-audio", "architecture": {"output_modalities": ["text", "audio"]}},
        ]}
        reply = _models_list(data, body, network=image, saved={"provider": "openrouter", "model": "openai/gpt-image-1"})
        assert _marks(reply) == {"text-model": None, "openai/gpt-image-1": "output:image", "openai/gpt-audio": None}, reply
        # Offline, the selection changed to a model the first answer dropped (it was only dropped from the view).
        reply = _models_list(data, body, network=RuntimeError("offline"), saved={"provider": "openrouter", "model": "text-model"})
        assert reply["payload"]["cached"] is True
        assert _marks(reply) == {"text-model": None, "openai/gpt-audio": None}, "the mark of the earlier selection is gone"
        reply = _models_list(data, body, network=RuntimeError("offline"), saved={"provider": "openrouter", "model": "openai/gpt-image-1"})
        assert _marks(reply)["openai/gpt-image-1"] == "output:image"
    with tempfile.TemporaryDirectory() as directory:
        # A cache written before the filter existed offers embeddings and unsuitable models; reading filters it.
        from mwt.userdata import remember_model_catalog

        data = Path(directory) / "data"
        remember_model_catalog("openrouter", [
            {"id": "text-model", "text": True},
            {"id": "google/gemini-robotics-er-1.5-preview", "text": True},
            {"id": "openai/text-embedding-3-small", "text": False},
        ], data)
        body = {"provider": "openrouter", "publicCatalog": True, "credentialOwner": "rust", "model": ""}
        reply = _models_list(data, body, network=RuntimeError("offline"), saved={"provider": "openrouter", "model": "x"})
        assert _marks(reply) == {"text-model": None}, reply
        reply = _models_list(data, body, network=RuntimeError("offline"), saved={"provider": "openrouter", "model": "google/gemini-robotics-er-1.5-preview"})
        assert _marks(reply) == {"text-model": None, "google/gemini-robotics-er-1.5-preview": "id:robotics"}, reply
        # A fresh list saved while A was selected does not decide what B's offline list shows.
        raw = {"data": [{"id": "text-model"}, {"id": "google/gemini-robotics-A"}, {"id": "google/gemini-robotics-B"}]}
        _models_list(data, body, network=raw, saved={"provider": "openrouter", "model": "google/gemini-robotics-A"})
        reply = _models_list(data, body, network=RuntimeError("offline"), saved={"provider": "openrouter", "model": "google/gemini-robotics-B"})
        assert _marks(reply) == {"text-model": None, "google/gemini-robotics-B": "id:robotics"}, reply
    print("PASS desktop_provider.public_catalog_keep_and_refilter")


if __name__ == "__main__":
    main_test()
    test_public_catalog()
    test_saved_model_on_every_list_path()
    test_public_catalog_keeps_and_refilters()
