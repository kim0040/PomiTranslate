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
    print("PASS desktop_provider.public_catalog_no_credentials_no_settings_write_cache_and_retry")

if __name__ == "__main__":
    main_test()
    test_public_catalog()
