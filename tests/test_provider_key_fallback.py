"""Implied API keys (environment and OS keyring) never cross providers or leave their endpoint."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import llm_backends  # noqa: E402
from llm_backends import resolve_api_key, resolve_base_url  # noqa: E402

KEY_VARS = [spec[name] for spec in llm_backends.PROVIDER_SPECS.values() for name in ("env_var", "base_url_env_var")]


def _clean_env(**values: str) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key not in KEY_VARS}
    env.update(values)
    return env


def _keyring(stored: dict[str, str]):
    return patch("mwt.secrets.load_api_key", side_effect=lambda account: stored.get(account))


def test_a_custom_endpoint_never_receives_another_providers_key() -> None:
    every_key = {spec["env_var"]: "leaked-" + name for name, spec in llm_backends.PROVIDER_SPECS.items() if name != "custom"}
    with patch.dict(os.environ, _clean_env(**every_key), clear=True), _keyring({"custom": "stored-custom", "openai": "stored-openai"}):
        assert resolve_api_key("custom", "", "https://attacker.example.test/v1") == ""
        assert resolve_api_key("custom_openai", "", "https://attacker.example.test/v1") == ""


def test_a_public_provider_key_stays_on_its_default_endpoint() -> None:
    with patch.dict(os.environ, _clean_env(OPENAI_API_KEY="env-openai"), clear=True), _keyring({"openai": "stored-openai"}):
        assert resolve_api_key("openai", "", "https://api.openai.com/v1") == "env-openai"
        assert resolve_api_key("openai", "", "https://api.openai.com/v1/") == "env-openai"
        assert resolve_api_key("openai", "", "https://attacker.example.test/v1") == ""
        assert resolve_api_key("openai", "", "http://127.0.0.1:9/v1") == ""
    with patch.dict(os.environ, _clean_env(), clear=True), _keyring({"openai": "stored-openai"}):
        assert resolve_api_key("openai", "", "https://api.openai.com/v1") == "stored-openai"
        assert resolve_api_key("openai", "", "https://proxy.example.test/v1") == ""


def test_no_cross_provider_fallback_even_on_a_default_endpoint() -> None:
    with patch.dict(os.environ, _clean_env(OPENAI_API_KEY="env-openai", COMET_API_KEY="env-comet"), clear=True), _keyring({}):
        assert resolve_api_key("gemini", "", "https://generativelanguage.googleapis.com/v1beta") == ""
        assert resolve_api_key("anthropic", "", "https://api.anthropic.com/v1") == ""


def test_same_provider_environment_pairs_keep_working() -> None:
    env = _clean_env(OPENAI_API_KEY="env-openai", OPENAI_BASE_URL="https://proxy.example.test/v1",
                     CUSTOM_API_KEY="env-custom", CUSTOM_BASE_URL="http://127.0.0.1:8080/v1")
    with patch.dict(os.environ, env, clear=True), _keyring({"openai": "stored-openai", "custom": "stored-custom"}):
        # Endpoint and key both come from the user's own environment.
        assert resolve_api_key("openai", "", "https://proxy.example.test/v1") == "env-openai"
        assert resolve_api_key("custom", "", "http://127.0.0.1:8080/v1") == "env-custom"
        # A keyring key is never sent to an endpoint other than the public default.
        with patch.dict(os.environ, {"CUSTOM_API_KEY": ""}):
            assert resolve_api_key("custom", "", "http://127.0.0.1:8080/v1") == ""
        # An explicit key always wins.
        assert resolve_api_key("custom", "typed", "https://anything.example.test") == "typed"


def test_the_config_path_checks_the_endpoint_it_just_resolved() -> None:
    from mc_world_translator import DEFAULT_CONFIG, merge_nested, normalize_config

    def normalized(provider: str, base_url: str) -> str:
        config = merge_nested(DEFAULT_CONFIG, {
            "inherit_translate_py": False,
            "api": {"provider": provider, "base_url": base_url, "api_key": "", "model": "m"},
        })
        return normalize_config(config, None)["api"]["api_key"]

    env = _clean_env(OPENAI_API_KEY="env-openai")
    with patch.dict(os.environ, env, clear=True), _keyring({"custom": "stored-custom"}):
        assert normalized("custom", "https://attacker.example.test/v1") == ""
        assert normalized("openai", "https://attacker.example.test/v1") == ""
        assert normalized("openai", "") == "env-openai"
    # A caller that never resolved an endpoint on this thread gets no implied key.
    import threading

    seen: list[str] = []
    with patch.dict(os.environ, env, clear=True), _keyring({}):
        resolve_base_url("openai", "")
        worker = threading.Thread(target=lambda: seen.append(resolve_api_key("openai", "")))
        worker.start()
        worker.join()
    assert seen == [""]


def test_the_desktop_entry_turns_implied_keys_off() -> None:
    saved = llm_backends._IMPLICIT_KEYS_ENABLED
    try:
        llm_backends.disable_implicit_api_keys()
        with patch.dict(os.environ, _clean_env(OPENAI_API_KEY="env-openai"), clear=True), _keyring({"openai": "stored"}):
            assert resolve_api_key("openai", "", "https://api.openai.com/v1") == ""
            assert resolve_api_key("openai", "explicit", "https://api.openai.com/v1") == "explicit"
    finally:
        llm_backends._IMPLICIT_KEYS_ENABLED = saved


def main() -> None:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print("PASS", test.__name__)
    print("PROVIDER_KEY_FALLBACK_PASSED", len(tests))


if __name__ == "__main__":
    main()
