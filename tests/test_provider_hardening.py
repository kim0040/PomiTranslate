"""Provider hardening: redirects, credential routing, redaction, error classes, caps, usage and time limits.

Everything talks to scripted servers on loopback; no provider is contacted.
"""

from __future__ import annotations

import json
import math
import os
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import llm_backends  # noqa: E402
from llm_backends import (  # noqa: E402
    MAX_CONSECUTIVE_REJECTIONS,
    MAX_RETRY_AFTER_SECONDS,
    LLMProviderClient,
    ProviderError,
    infer_provider,
    parse_retry_after,
    resolve_api_key,
)
from mc_world_translator import DEFAULT_CONFIG, BatchTranslator, ProviderUnavailable, merge_nested  # noqa: E402
from mwt.secrets import bounded_public_text, redact_log  # noqa: E402

RESULTS: list[str] = []
KEY = "sk-SYNTHETICKEY0123456789abcdefXYZ"


def record(name: str) -> None:
    RESULTS.append(name)
    print(f"PASS {name}")


class Script:
    """A loopback server whose behaviour is a function of (handler, parsed body, request number)."""

    def __init__(self, behave) -> None:  # noqa: ANN001
        self.behave = behave
        self.requests: list[dict] = []
        self.lock = threading.Lock()
        script = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length", "0") or 0)
                raw = self.rfile.read(length) if length else b""
                body = json.loads(raw) if raw else None
                headers = {key.lower(): value for key, value in self.headers.items()}
                with script.lock:
                    script.requests.append({"method": self.command, "path": self.path, "headers": headers, "body": body})
                    number = len(script.requests)
                script.behave(self, body, number)

            do_GET = do_POST = _handle  # noqa: N815

            def reply(self, status: int, payload, headers: dict | None = None) -> None:
                raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args) -> None:  # noqa: ANN002
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    @property
    def posts(self) -> list[dict]:
        return [item for item in self.requests if item["method"] == "POST"]


def ok_completion(handler, body, number) -> None:  # noqa: ANN001
    answers = {key: f"[T] {value}" for key, value in json.loads(body["messages"][1]["content"]).items()}
    handler.reply(
        200,
        {
            "choices": [{"message": {"content": json.dumps(answers, ensure_ascii=False)}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        },
    )


def make_client(base: str, provider: str = "openai", *, key: str = KEY, wire: str = "", **api) -> LLMProviderClient:
    LLMProviderClient.reset_counters()
    client = LLMProviderClient(
        {
            "api": {
                "provider": provider,
                "api_key": key,
                "base_url": base,
                "model": "fixture",
                "request_timeout": 5,
                "wire_format": wire,
                **api,
            },
            "runtime": {"data_dir": ""},
        }
    )
    client._catalog_checked = True  # the scripted servers have no model catalog
    return client


def make_batcher(base: str, **runtime) -> BatchTranslator:
    config = merge_nested(
        DEFAULT_CONFIG,
        {
            "inherit_translate_py": False,
            "api": {"provider": "openai", "api_key": KEY, "model": "fixture", "base_url": f"{base}/v1", "request_timeout": 5},
            "runtime": runtime,
        },
    )
    LLMProviderClient.reset_counters()
    batcher = BatchTranslator(config)
    batcher.client._catalog_checked = True
    waits: list[float] = []
    batcher.sleep = lambda seconds: waits.append(seconds)
    batcher.recorded_waits = waits  # type: ignore[attr-defined]
    return batcher


# --- SEC-01 ----------------------------------------------------------------------------------------


def test_redirects_never_carry_credentials() -> None:
    elsewhere = Script(lambda handler, body, number: handler.reply(200, {"data": [], "choices": [], "models": []}))
    try:
        target = f"http://localhost:{elsewhere.port}/stolen"  # another origin: different host name
        for status in (301, 302, 303, 307, 308):
            origin = Script(lambda handler, body, number, status=status: handler.reply(status, {}, {"Location": target}))
            try:
                for provider, wire, header in (
                    ("openai", "", "authorization"),
                    ("gemini", "", "x-goog-api-key"),
                    ("anthropic", "", "x-api-key"),
                    ("custom", "openai", "authorization"),
                ):
                    client = make_client(f"{origin.base}/v1", provider, wire=wire)
                    for call in (
                        lambda: client.complete_text(system_prompt="s", user_prompt="u", temperature=0),
                        client.list_models,
                    ):
                        try:
                            call()
                        except ProviderError as exc:
                            assert exc.code == "PROVIDER_REDIRECT_REFUSED", exc.code
                            assert exc.fatal and exc.status == status
                            assert KEY not in str(exc) and "stolen" not in str(exc)
                        else:
                            raise AssertionError("a redirect must be refused")
                assert all(item["headers"].get("host", "").endswith(str(origin.port)) for item in origin.requests)
            finally:
                origin.close()
        assert elsewhere.requests == [], f"the redirect target received {elsewhere.requests!r}"
    finally:
        elsewhere.close()

    # The prompt helper goes through the same client.
    origin = Script(lambda handler, body, number: handler.reply(302, {}, {"Location": "https://example.invalid/x"}))
    try:
        config = merge_nested(
            DEFAULT_CONFIG,
            {"inherit_translate_py": False, "api": {"provider": "openai", "api_key": KEY, "model": "m", "base_url": f"{origin.base}/v1"}},
        )
        client = LLMProviderClient(config)
        client._catalog_checked = True
        try:
            client.complete_text(system_prompt="s", user_prompt="u", temperature=0.2, max_output_tokens=700)
        except ProviderError as exc:
            assert exc.code == "PROVIDER_REDIRECT_REFUSED"
        else:
            raise AssertionError("prompt help must not follow redirects")
    finally:
        origin.close()
    record("provider.redirects_refused")


# --- SEC-03 ----------------------------------------------------------------------------------------


def test_only_the_selected_providers_key_is_used() -> None:
    names = ("OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "COMET_API_KEY", "CUSTOM_API_KEY")
    cleared = {name: "" for name in names}
    looked_up: list[str] = []

    def stored(account: str):  # noqa: ANN202
        looked_up.append(account)
        return None

    with patch.dict(os.environ, {**cleared, "OPENAI_API_KEY": "openai-env-key", "COMET_API_KEY": "comet-env-key"}), patch(
        "mwt.secrets.load_api_key", side_effect=stored
    ):
        for borrower in ("gemini", "anthropic", "openrouter", "custom", "custom_openai", "custom_anthropic"):
            assert resolve_api_key(borrower, "") == "", f"{borrower} borrowed a key"
        assert resolve_api_key("openai", "") == "openai-env-key"
        assert resolve_api_key("comet", "") == "comet-env-key"
        assert resolve_api_key("gemini", "given") == "given"
        assert set(looked_up) <= {"gemini", "anthropic", "openrouter", "custom", "custom_openai", "custom_anthropic"}
    with patch.dict(os.environ, {**cleared, "GEMINI_API_KEY": "gemini-env-key", "CUSTOM_API_KEY": "custom-env-key"}), patch(
        "mwt.secrets.load_api_key", return_value=None
    ):
        assert resolve_api_key("gemini", "") == "gemini-env-key"
        assert resolve_api_key("custom", "") == "custom-env-key"
        assert resolve_api_key("openai", "") == ""
    with patch.dict(os.environ, cleared), patch("mwt.secrets.load_api_key", side_effect=lambda account: f"stored-{account}"):
        assert resolve_api_key("gemini", "") == "stored-gemini"
        assert resolve_api_key("custom", "") == "stored-custom"
    # An address the app does not know is a Custom endpoint, so it can never be handed Comet's key.
    assert infer_provider("auto", "https://llm.example.internal/v1") == "custom"
    assert infer_provider(None, "") == "comet"
    assert infer_provider("auto", "https://api.cometapi.com/v1") == "comet"
    record("provider.credential_routing")


# --- SEC-04 ----------------------------------------------------------------------------------------


def longest_shared_run(message: str, secret: str) -> int:
    best = 0
    for start in range(len(secret)):
        length = best + 1
        while start + length <= len(secret) and secret[start : start + length] in message:
            best = length
            length += 1
    return best


def test_error_bodies_are_redacted_before_they_are_cut() -> None:
    for offset in (560, 585, 590, 595, 598, 600, 610):
        body = "e" * offset + KEY + " tail " + "z" * 400
        origin = Script(lambda handler, request, number, body=body: handler.reply(500, body.encode("utf-8")))
        try:
            client = make_client(f"{origin.base}/v1")
            try:
                client.complete_text(system_prompt="s", user_prompt="u", temperature=0)
            except ProviderError as exc:
                text = str(exc)
                assert longest_shared_run(text, KEY) < 8, f"offset {offset}: {text[-120:]!r}"
                assert "sk-SYNTH" not in text and len(text) < 760, len(text)
            else:
                raise AssertionError("expected an error")
        finally:
            origin.close()
    # Partial echoes and other keys: any 8+ character stretch of the key, and common key shapes.
    assert redact_log("bad key sk-SYNTHET", KEY) == "bad key [redacted]"
    assert redact_log("prefix 0123456789abcdef", KEY) == "prefix [redacted]"
    assert "AIzaSyD" not in redact_log("key AIzaSyD-abcdefghijklmnopqrstuvwxyz0123456 invalid", "")
    assert "sk-ant-api03" not in redact_log("x-api-key sk-ant-api03-AbCdEf123456", "")
    assert redact_log("Authorization: Bearer abcdef0123456789", "") == "Authorization: [redacted]"
    assert redact_log("short", "abc") == "short" and redact_log("it is a risk-free task", "") == "it is a risk-free task"
    cut = bounded_public_text("x" * 590 + KEY, KEY, 600)
    assert longest_shared_run(cut, KEY) < 8 and len(cut) <= 603
    record("provider.redaction_before_truncation")


# --- PROV-01 ---------------------------------------------------------------------------------------


def test_rejections_stop_after_a_bounded_number_of_calls() -> None:
    origin = Script(lambda handler, body, number: handler.reply(400, {"error": {"message": "bad request"}}))
    try:
        batcher = make_batcher(origin.base)
        texts = [f"Sentence number {index}" for index in range(40)]
        try:
            batcher.translate_texts(texts)
        except ProviderUnavailable as exc:
            assert exc.fatal and exc.code == "REQUEST_REJECTED"
        else:
            raise AssertionError("a request the provider always rejects must stop the job")
        calls = len(origin.posts)
        # The core decides from ProviderError.kind: a rejected batch is split, never repeated, and the third
        # rejection in a row (the batch, a fifth of it, one string) ends the job. Was 138 calls originally.
        assert calls == 3, calls
        print(f"      persistent HTTP 400, 40 strings: {calls} provider calls (before the fix: 138)")
    finally:
        origin.close()

    # 401/403/404/405/422: the same request cannot succeed later (422 is rejected like 400).
    for status, code in ((401, "AUTH_FAILED"), (403, "AUTH_FAILED"), (404, "MODEL_NOT_FOUND"), (405, "REQUEST_REJECTED")):
        origin = Script(lambda handler, body, number, status=status: handler.reply(status, {"error": "no"}))
        try:
            batcher = make_batcher(origin.base)
            try:
                batcher.translate_texts(["one", "two", "three"])
            except ProviderUnavailable as exc:
                assert exc.fatal and exc.code == code, (status, exc.code)
            assert len(origin.posts) == 1, (status, len(origin.posts))
        finally:
            origin.close()

    # One string a provider refuses is isolated by splitting: the rest are translated.
    def poison(handler, body, number) -> None:  # noqa: ANN001
        if "POISON" in body["messages"][1]["content"]:
            handler.reply(400, {"error": {"message": "invalid request"}})
        else:
            ok_completion(handler, body, number)

    origin = Script(poison)
    try:
        batcher = make_batcher(origin.base)
        done = batcher.translate_texts(["Hello there", "POISON line", "Front line"])
        assert done["Hello there"] == "[T] Hello there" and done["Front line"] == "[T] Front line"
        assert done["POISON line"] == "POISON line" and "POISON line" in batcher.failed
    finally:
        origin.close()

    # 408/409/425/5xx stay retryable, never fatal.
    for status in (408, 409, 425, 429, 500, 502, 503):
        assert not ProviderError("x", status=status).fatal, status
    for status in (400, 422):
        assert not ProviderError("x", status=status).fatal  # one rejection alone is not a verdict
        assert ProviderError("x", status=status, persistent=True).fatal
    record("provider.rejections_are_bounded")


def test_too_large_requests_are_split_not_abandoned() -> None:
    def size_limited(kind: str):  # noqa: ANN202
        def behave(handler, body, number) -> None:  # noqa: ANN001
            payload = json.loads(body["messages"][1]["content"])
            if len(payload) > 2:
                if kind == "413":
                    handler.reply(413, {"error": "payload too large"})
                elif kind == "context":
                    handler.reply(
                        400,
                        {"error": {"message": "This model's maximum context length is 8192 tokens.", "code": "context_length_exceeded"}},
                    )
                else:
                    handler.reply(400, {"error": {"message": "Blocked by the content filter", "code": "content_filter"}})
            else:
                ok_completion(handler, body, number)

        return behave

    for kind in ("413", "context", "filter"):
        origin = Script(size_limited(kind))
        try:
            batcher = make_batcher(origin.base, max_batch_retries=1)
            texts = [f"Passage {index}" for index in range(6)]
            done = batcher.translate_texts(texts)
            assert all(done[text] == f"[T] {text}" for text in texts), (kind, done)
            assert not batcher.failed
            assert len(origin.posts) > 1
        finally:
            origin.close()
    error = ProviderError("x", status=413)
    assert not error.fatal and error.too_large and error.code == "REQUEST_TOO_LARGE"
    record("provider.too_large_still_splits")


def test_unsupported_parameter_is_dropped_once_and_remembered() -> None:
    def picky(parameter: str):  # noqa: ANN202
        def behave(handler, body, number) -> None:  # noqa: ANN001
            if parameter in body:
                handler.reply(
                    400,
                    {
                        "error": {
                            "message": f"Unsupported value: '{parameter}' does not support this value with this model.",
                            "type": "invalid_request_error",
                            "param": parameter,
                            "code": "unsupported_value",
                        }
                    },
                )
            else:
                ok_completion(handler, body, number)

        return behave

    for parameter in ("temperature", "response_format"):
        origin = Script(picky(parameter))
        try:
            client = make_client(f"{origin.base}/v1")
            client.supports_json_response = True
            assert client.translate_mapping({"0": "Hello"}, system_prompt="s", temperature=0.3) == {"0": "[T] Hello"}
            assert len(origin.posts) == 2, (parameter, len(origin.posts))
            assert parameter in origin.posts[0]["body"] and parameter not in origin.posts[1]["body"]
            assert LLMProviderClient.usage["adapted_parameters"] == [parameter]
            client.translate_mapping({"0": "Again"}, system_prompt="s", temperature=0.3)
            assert len(origin.posts) == 3 and parameter not in origin.posts[2]["body"], "the drop is remembered"
        finally:
            origin.close()

    # A rejected output cap is moved to the field the model takes when the error says which.
    def cap_picky(handler, body, number) -> None:  # noqa: ANN001
        if "max_tokens" in body:
            handler.reply(
                400,
                {"error": {"message": "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", "param": "max_tokens"}},
            )
        else:
            ok_completion(handler, body, number)

    origin = Script(cap_picky)
    try:
        client = make_client(f"{origin.base}/v1")
        client.complete_text(system_prompt="s", user_prompt='{"0": "x"}', temperature=0, max_output_tokens=700)
        assert origin.posts[-1]["body"]["max_completion_tokens"] == 700 and "max_tokens" not in origin.posts[-1]["body"]
        client.complete_text(system_prompt="s", user_prompt='{"0": "x"}', temperature=0, max_output_tokens=700)
        assert len(origin.posts) == 3 and origin.posts[-1]["body"]["max_completion_tokens"] == 700
    finally:
        origin.close()

    # A 400 that does not name a field is not guessed at: nothing is dropped and no extra call is made.
    origin = Script(lambda handler, body, number: handler.reply(400, {"error": {"message": "something is wrong"}}))
    try:
        client = make_client(f"{origin.base}/v1")
        try:
            client.complete_text(system_prompt="s", user_prompt="u", temperature=0.3)
        except ProviderError:
            pass
        assert len(origin.posts) == 1 and "adapted_parameters" not in LLMProviderClient.usage
    finally:
        origin.close()

    # Anthropic and Gemini drop a refused temperature as well.
    def anthropic_picky(handler, body, number) -> None:  # noqa: ANN001
        if "temperature" in body:
            handler.reply(400, {"error": {"message": "`temperature` is deprecated for this model."}})
        else:
            handler.reply(200, {"content": [{"type": "text", "text": json.dumps({"0": "Hola"})}]})

    origin = Script(anthropic_picky)
    try:
        client = make_client(f"{origin.base}/v1", "anthropic")
        assert client.translate_mapping({"0": "Hello"}, system_prompt="s", temperature=0.3) == {"0": "Hola"}
        assert [("temperature" in item["body"]) for item in origin.posts] == [True, False]
    finally:
        origin.close()

    def gemini_picky(handler, body, number) -> None:  # noqa: ANN001
        if "temperature" in body["generationConfig"]:
            handler.reply(400, {"error": {"message": "Unsupported field: temperature is not supported by this model"}})
        else:
            handler.reply(200, {"candidates": [{"content": {"parts": [{"text": json.dumps({"0": "Hola"})}]}, "finishReason": "STOP"}]})

    origin = Script(gemini_picky)
    try:
        client = make_client(f"{origin.base}/v1beta", "gemini")
        assert client.translate_mapping({"0": "Hello"}, system_prompt="s", temperature=0.3) == {"0": "Hola"}
        assert [("temperature" in item["body"]["generationConfig"]) for item in origin.posts] == [True, False]
    finally:
        origin.close()
    record("provider.unsupported_parameter_adaptation")


# --- PROV-02 / PROV-03 -----------------------------------------------------------------------------


def test_output_caps_reach_every_adapter() -> None:
    sent: list[dict] = []

    def capture(self, method, url, *, headers, payload=None):  # noqa: ANN001, ANN202
        sent.append(payload)
        if "generateContent" in url:
            return {"candidates": [{"content": {"parts": [{"text": "ok"}]}, "finishReason": "STOP"}]}
        if url.endswith("/messages"):
            return {"content": [{"type": "text", "text": "ok"}]}
        return {"choices": [{"message": {"content": "ok"}}]}

    with patch.object(LLMProviderClient, "_request_json", capture):
        official = make_client("https://api.openai.com/v1", "openai")
        official.complete_text(system_prompt="s", user_prompt="u", temperature=0.2, max_output_tokens=700)
        assert sent[-1]["max_completion_tokens"] == 700 and "max_tokens" not in sent[-1]
        for provider in ("openrouter", "custom", "comet"):
            client = make_client("https://proxy.example/v1", provider, wire="openai")
            client.complete_text(system_prompt="s", user_prompt="u", temperature=0.2, max_output_tokens=700)
            assert sent[-1]["max_tokens"] == 700 and "max_completion_tokens" not in sent[-1], provider
        # An OpenAI-named provider behind another address is a compatible endpoint, not OpenAI's own models.
        proxied = make_client("https://proxy.example/v1", "openai")
        proxied.complete_text(system_prompt="s", user_prompt="u", temperature=0.2, max_output_tokens=700)
        assert sent[-1]["max_tokens"] == 700
        # No cap unless the caller or the configuration asks for one.
        official.complete_text(system_prompt="s", user_prompt="u", temperature=0.2)
        assert "max_tokens" not in sent[-1] and "max_completion_tokens" not in sent[-1]
        official.translate_mapping({"0": "x"}, system_prompt="s", temperature=0) if False else None
        configured = make_client("https://proxy.example/v1", "custom", wire="openai", max_output_tokens=900)
        configured.complete_text(system_prompt="s", user_prompt="u", temperature=0.2)
        assert sent[-1]["max_tokens"] == 900
        configured.complete_text(system_prompt="s", user_prompt="u", temperature=0.2, max_output_tokens=300)
        assert sent[-1]["max_tokens"] == 300, "a caller's cap wins over the configured one"
        for invalid in (0, -5, True, "abc", float("nan"), None):
            blank = make_client("https://proxy.example/v1", "custom", wire="openai", max_output_tokens=invalid)
            blank.complete_text(system_prompt="s", user_prompt="u", temperature=0.2)
            assert "max_tokens" not in sent[-1], invalid
        # Anthropic and Gemini keep their own semantics.
        anthropic = make_client("https://api.anthropic.com/v1", "anthropic")
        anthropic.complete_text(system_prompt="s", user_prompt="u", temperature=0.2, max_output_tokens=700)
        assert sent[-1]["max_tokens"] == 700
        anthropic.complete_text(system_prompt="s", user_prompt="u", temperature=0.2)
        assert sent[-1]["max_tokens"] == 4096
        gemini = make_client("https://generativelanguage.googleapis.com/v1beta", "gemini")
        gemini.complete_text(system_prompt="s", user_prompt="u", temperature=0.2, max_output_tokens=700)
        assert sent[-1]["generationConfig"]["maxOutputTokens"] == 32768
        gemini.complete_text(system_prompt="s", user_prompt="u", temperature=0.2, max_output_tokens=50_000)
        assert sent[-1]["generationConfig"]["maxOutputTokens"] == 50_000

    # The prompt helper asks for 700.
    from llm_backends import enhance_style_prompt

    with patch.object(LLMProviderClient, "_request_json", capture), patch.object(LLMProviderClient, "try_refresh_text_models"):
        config = merge_nested(
            DEFAULT_CONFIG,
            {"inherit_translate_py": False, "api": {"provider": "custom", "api_key": KEY, "model": "m", "base_url": "https://proxy.example/v1"}},
        )
        enhance_style_prompt(config, "pirates")
        assert sent[-1]["max_tokens"] == 700

    # A reasoning model can spend the whole cap on thinking and answer nothing: that is an error, not an empty text.
    def length_only(self, method, url, *, headers, payload=None):  # noqa: ANN001, ANN202
        return {"choices": [{"message": {"content": ""}, "finish_reason": "length"}]}

    with patch.object(LLMProviderClient, "_request_json", length_only):
        client = make_client("https://proxy.example/v1", "custom", wire="openai")
        try:
            client.complete_text(system_prompt="s", user_prompt="u", temperature=0, max_output_tokens=50)
        except RuntimeError as exc:
            assert "output token limit" in str(exc)
        else:
            raise AssertionError("an empty answer cut off by the cap must fail")
    record("provider.output_caps")


def test_usage_numbers_are_normalized() -> None:
    LLMProviderClient.reset_counters()
    for bad in (
        {"usage": {"prompt_tokens": -5, "completion_tokens": True, "cost": float("nan")}},
        {"usage": {"prompt_tokens": "7", "completion_tokens": 1.5, "cost": float("inf")}},
        {"usage": {"prompt_tokens": float("nan"), "completion_tokens": float("inf"), "cost": -1.0}},
        {"usage": {"prompt_tokens": 10**30, "completion_tokens": None, "cost": 10**30}},
        {"usage": {"cost": True}},
        {"usageMetadata": {"promptTokenCount": -1, "candidatesTokenCount": False, "thoughtsTokenCount": -3}},
        {"usage": []},
        [],
        None,
    ):
        LLMProviderClient.record_usage(bad)
    totals = LLMProviderClient.usage
    assert totals == {"prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0, "cost_reported": False}, totals
    LLMProviderClient.record_usage({"usage": {"prompt_tokens": 12, "completion_tokens": 3.0, "cost": 0.25}})
    LLMProviderClient.record_usage({"usage": {"input_tokens": 8, "output_tokens": 2}})
    LLMProviderClient.record_usage({"usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 4, "thoughtsTokenCount": 6}})
    totals = LLMProviderClient.usage
    assert totals["prompt_tokens"] == 25 and totals["completion_tokens"] == 3 + 2 + 10
    assert totals["cost"] == 0.25 and totals["cost_reported"] is True
    assert all(isinstance(totals[key], int) for key in ("prompt_tokens", "completion_tokens"))
    assert math.isfinite(totals["cost"])
    json.dumps(totals, allow_nan=False)
    record("provider.usage_normalized")


def test_usage_is_per_job() -> None:
    origin = Script(ok_completion)
    totals: dict[str, tuple[int, dict]] = {}
    a_started, b_done = threading.Event(), threading.Event()

    def request(client: LLMProviderClient, text: str) -> None:
        client.translate_mapping({"0": text}, system_prompt="s", temperature=0)

    def from_worker(client: LLMProviderClient) -> None:
        worker = threading.Thread(target=request, args=(client, "from a worker"))
        worker.start()
        worker.join()

    def job_a() -> None:
        client = make_client(f"{origin.base}/v1")  # resets this thread's totals only
        request(client, "first")
        a_started.set()
        assert b_done.wait(20)
        request(client, "second")
        from_worker(client)  # a pool worker writes to the job that owns the client
        totals["a"] = (LLMProviderClient.request_count, dict(LLMProviderClient.usage))

    def job_b() -> None:
        assert a_started.wait(20)
        client = make_client(f"{origin.base}/v1")  # starts while job a is in flight
        request(client, "only")
        from_worker(client)
        totals["b"] = (LLMProviderClient.request_count, dict(LLMProviderClient.usage))
        b_done.set()

    try:
        threads = [threading.Thread(target=job_a), threading.Thread(target=job_b)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        assert totals["a"][0] == 3 and totals["a"][1]["prompt_tokens"] == 30, totals["a"]
        assert totals["b"][0] == 2 and totals["b"][1]["prompt_tokens"] == 20, totals["b"]
    finally:
        origin.close()
    record("provider.usage_per_job")


# --- PROV-05 / JOB-05 ------------------------------------------------------------------------------


def test_retry_after_forms_and_cap() -> None:
    now = datetime(2026, 10, 23, 12, 0, 0, tzinfo=timezone.utc)
    assert parse_retry_after("7") == 7.0 and parse_retry_after(" 2.5 ") == 2.5
    assert parse_retry_after(format_datetime(now + timedelta(seconds=90), usegmt=True), now=now) == 90.0
    assert parse_retry_after(format_datetime(now - timedelta(seconds=90), usegmt=True), now=now) == 0.0
    for bad in (None, "", "soon", "nan", "inf", "-"):
        assert parse_retry_after(bad) is None, bad
    assert parse_retry_after("-4") == 0.0

    def limited(header: str):  # noqa: ANN202
        return Script(lambda handler, body, number: handler.reply(429, {"error": "slow down"}, {"Retry-After": header}))

    for header, expected in (("300", 300.0), ("3", 3.0)):
        origin = limited(header)
        try:
            client = make_client(f"{origin.base}/v1")
            try:
                client.complete_text(system_prompt="s", user_prompt="u", temperature=0)
            except ProviderError as exc:
                assert exc.status == 429 and not exc.fatal
                # Not shortened (the old cap was 120 s), and only ever lengthened by jitter.
                assert expected <= exc.retry_after <= expected + 2.0 + 1e-6, exc.retry_after
                assert exc.retry_after_requested == expected and not exc.retry_after_capped
        finally:
            origin.close()
    date = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=45), usegmt=True)
    origin = limited(date)
    try:
        try:
            make_client(f"{origin.base}/v1").complete_text(system_prompt="s", user_prompt="u", temperature=0)
        except ProviderError as exc:
            assert 40 <= exc.retry_after <= 49, exc.retry_after
    finally:
        origin.close()
    origin = limited("100000")
    try:
        try:
            make_client(f"{origin.base}/v1").complete_text(system_prompt="s", user_prompt="u", temperature=0)
        except ProviderError as exc:
            assert MAX_RETRY_AFTER_SECONDS <= exc.retry_after <= MAX_RETRY_AFTER_SECONDS + 2.0 + 1e-6
            assert exc.retry_after_capped and "capped at 600" in str(exc) and "100000" in str(exc)
    finally:
        origin.close()
    # Workers that were told the same wait do not come back in the same instant.
    waits = {llm_backends._retry_after_seconds({"Retry-After": "10"})[0] for _ in range(30)}
    assert len(waits) > 10 and min(waits) >= 10.0
    # The batch loop honours it instead of its own shorter back-off.
    origin = Script(lambda handler, body, number: handler.reply(429, {"error": "x"}, {"Retry-After": "90"}) if number == 1 else ok_completion(handler, body, number))
    try:
        batcher = make_batcher(origin.base)
        assert batcher.translate_texts(["Hello"]) == {"Hello": "[T] Hello"}
        assert sum(batcher.recorded_waits) >= 90.0, batcher.recorded_waits
    finally:
        origin.close()
    record("provider.retry_after")


def test_wall_clock_deadline_and_body_limit() -> None:
    def trickle(handler, body, number) -> None:  # noqa: ANN001
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", "100000")
        handler.end_headers()
        try:
            for _ in range(400):
                handler.wfile.write(b" ")
                handler.wfile.flush()
                time.sleep(0.25)
        except OSError:
            pass

    origin = Script(trickle)
    try:
        client = make_client(f"{origin.base}/v1", request_timeout=2)
        started = time.monotonic()
        try:
            client.complete_text(system_prompt="s", user_prompt="u", temperature=0)
        except ProviderError as exc:
            assert exc.code == "NETWORK_ERROR" and not exc.fatal and exc.status is None, exc.code
        else:
            raise AssertionError("a trickling server must hit the deadline")
        elapsed = time.monotonic() - started
        assert elapsed < 4.5, f"took {elapsed:.1f}s with a 2 s request_timeout (every byte arrived within the socket timeout)"
        print(f"      trickling response, request_timeout=2: gave up after {elapsed:.1f} s")
    finally:
        origin.close()

    def silent(handler, body, number) -> None:  # noqa: ANN001
        time.sleep(4)

    origin = Script(silent)
    try:
        client = make_client(f"{origin.base}/v1", request_timeout=1)
        started = time.monotonic()
        try:
            client.complete_text(system_prompt="s", user_prompt="u", temperature=0)
        except ProviderError as exc:
            assert exc.status is None
        assert time.monotonic() - started < 3.0
    finally:
        origin.close()

    big = b'{"choices":[{"message":{"content":"' + b"a" * 5000 + b'"}}]}'
    origin = Script(lambda handler, body, number: handler.reply(200, big))
    try:
        client = make_client(f"{origin.base}/v1")
        with patch.object(llm_backends, "MAX_RESPONSE_BYTES", 1000):
            try:
                client.complete_text(system_prompt="s", user_prompt="u", temperature=0)
            except ProviderError as exc:
                assert "larger than" in str(exc) and exc.status is None
            else:
                raise AssertionError("an oversized response must be refused")
        assert client.complete_text(system_prompt="s", user_prompt="u", temperature=0).startswith("aaaa")
    finally:
        origin.close()
    # Huge error bodies are read only up to a bound.
    origin = Script(lambda handler, body, number: handler.reply(500, b"x" * 3_000_000))
    try:
        client = make_client(f"{origin.base}/v1")
        try:
            client.complete_text(system_prompt="s", user_prompt="u", temperature=0)
        except ProviderError as exc:
            assert len(str(exc)) < 760
    finally:
        origin.close()
    record("provider.deadline_and_body_limits")


def run_all() -> list[str]:
    RESULTS.clear()
    test_redirects_never_carry_credentials()
    test_only_the_selected_providers_key_is_used()
    test_error_bodies_are_redacted_before_they_are_cut()
    test_rejections_stop_after_a_bounded_number_of_calls()
    test_too_large_requests_are_split_not_abandoned()
    test_unsupported_parameter_is_dropped_once_and_remembered()
    test_output_caps_reach_every_adapter()
    test_usage_numbers_are_normalized()
    test_usage_is_per_job()
    test_retry_after_forms_and_cap()
    test_wall_clock_deadline_and_body_limit()
    return list(RESULTS)


if __name__ == "__main__":
    run_all()
    print("PROVIDER_HARDENING_PASSED")
