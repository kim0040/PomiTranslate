"""End-to-end checks of the provider/core retry contract (ProviderError.kind) in BatchTranslator.

Each scenario runs twice: with a fake client that raises exceptions carrying ``kind``, and (when the
provider layer has ``ProviderError.kind``) with the real HTTP client against a loopback server.
"""
from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from llm_backends import ProviderError  # noqa: E402
from mc_world_translator import (  # noqa: E402
    DEFAULT_CONFIG, MAX_CONSECUTIVE_REQUEST_FAILURES, BatchTranslator, ProviderUnavailable, classify_failure, merge_nested,
)

HAS_KIND = hasattr(ProviderError, "kind")


class KindError(Exception):
    """A provider failure as the provider layer reports it: a kind, a status and a code."""

    def __init__(self, kind: str, status: int | None = None, error_code: str | None = None, message: str = "failed") -> None:
        super().__init__(message)
        self.kind, self.status, self.error_code = kind, status, error_code
        self.retry_after = None

    @property
    def code(self) -> str:
        return self.error_code or "REQUEST_FAILED"

    @property
    def fatal(self) -> bool:
        return self.kind in {"redirect", "auth", "config"}


class Fake:
    def __init__(self, decide) -> None:
        self.decide = decide
        self.calls: list[int] = []

    def translate_mapping(self, payload: dict, **_kwargs) -> dict:
        self.calls.append(len(payload))
        error = self.decide(list(payload.values()))
        if error is not None:
            raise error
        return {key: f"T:{value}" for key, value in payload.items()}


def config(batch_size: int, retries: int = 3, base_url: str = "http://127.0.0.1:9/v1") -> dict:
    return merge_nested(DEFAULT_CONFIG, {
        "inherit_translate_py": False, "batch_size": batch_size,
        "runtime": {"max_batch_retries": retries, "request_timeout": 5},
        "api": {"provider": "openai", "api_key": "test-key", "model": "fixture", "base_url": base_url},
    })


def with_fake(decide, batch_size: int, retries: int = 3) -> tuple[BatchTranslator, Fake]:
    batch = BatchTranslator(config(batch_size, retries))
    fake = Fake(decide)
    batch.client = fake
    batch.wait = lambda _delay: None
    batch.sleep = lambda _delay: None
    return batch, fake


class Loopback:
    """A local provider whose answer is decided per request by ``decide(texts) -> (status, body) | None``."""

    def __init__(self, decide) -> None:
        owner = self
        self.calls: list[int] = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                self._send(200, {"data": []})

            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                payload = json.loads(body["messages"][1]["content"])
                owner.calls.append(len(payload))
                refused = decide(list(payload.values()))
                if refused is not None:
                    self._send(*refused)
                    return
                answer = {key: f"T:{value}" for key, value in payload.items()}
                self._send(200, {"choices": [{"message": {"content": json.dumps(answer)}}]})

            def _send(self, status: int, value: dict) -> None:
                raw = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def stop(self) -> None:
        self.server.shutdown()


def with_http(decide, batch_size: int, retries: int = 3) -> tuple[BatchTranslator, Loopback]:
    server = Loopback(decide)
    batch = BatchTranslator(config(batch_size, retries, server.url))
    batch.wait = lambda _delay: None
    batch.sleep = lambda _delay: None
    return batch, server


def texts(count: int) -> list[str]:
    return [f"text {i}" for i in range(count)]


def run_both(decide_fake, decide_http, batch_size: int, check, retries: int = 3) -> None:
    """``check(batch, calls, outcome)`` runs once per client; outcome is the result or the exception."""
    for mode in ("fake", "http"):
        if mode == "http" and not HAS_KIND:
            continue
        batch, client = with_fake(decide_fake, batch_size, retries) if mode == "fake" else with_http(decide_http, batch_size, retries)
        calls = client.calls
        try:
            outcome = batch.translate_texts(texts(40 if batch_size <= 40 else 200))
        except ProviderUnavailable as exc:
            outcome = exc
        finally:
            if mode == "http":
                client.stop()
        check(batch, calls, outcome, mode)


def test_persistent_400_costs_three_calls() -> None:
    def check(batch, calls, outcome, mode):
        assert isinstance(outcome, ProviderUnavailable) and outcome.fatal and outcome.code == "REQUEST_REJECTED", (mode, outcome)
        assert len(calls) == 3, (mode, calls)

    run_both(lambda _t: KindError("rejected", 400), lambda _t: (400, {"error": {"message": "bad field"}}), 40, check)


def test_413_at_batch_200_completes_through_singletons() -> None:
    def check(batch, calls, outcome, mode):
        assert isinstance(outcome, dict), (mode, outcome)
        assert all(outcome[text] == f"T:{text}" for text in texts(200)), mode
        assert not batch.failed and batch.consecutive_failures == 0 and batch.consecutive_rejections == 0, mode
        assert calls[0] == 200 and 1 in calls, (mode, calls[:5])

    run_both(
        lambda t: KindError("too_large", 413) if len(t) > 1 else None,
        lambda t: (413, {"error": {"message": "payload too large"}}) if len(t) > 1 else None,
        200, check,
    )


def test_one_filtered_string_among_40() -> None:
    def check(batch, calls, outcome, mode):
        assert isinstance(outcome, dict), (mode, outcome)
        translated = [text for text in texts(40) if outcome[text] == f"T:{text}"]
        assert len(translated) == 39, (mode, len(translated))
        assert batch.failed_codes == {"text 17": "bad_request"}, (mode, batch.failed_codes)
        assert batch.consecutive_rejections == 0 and batch.consecutive_failures == 0, mode

    run_both(
        lambda t: KindError("filtered", 400) if "text 17" in t else None,
        lambda t: (400, {"error": {"code": "content_filter", "message": "content filtered by safety policy"}}) if "text 17" in t else None,
        40, check,
    )


def test_persistent_408_is_an_outage_not_a_rejection() -> None:
    def check(batch, calls, outcome, mode):
        assert isinstance(outcome, ProviderUnavailable), (mode, outcome)
        assert outcome.code != "REQUEST_REJECTED" and not outcome.fatal, (mode, outcome.code, outcome.fatal)
        assert batch.consecutive_rejections == 0, mode
        assert len(calls) == MAX_CONSECUTIVE_REQUEST_FAILURES, (mode, calls)
        # Retried at the same size first (max_batch_retries), never split before that.
        assert calls[:3] == [40, 40, 40], (mode, calls)

    run_both(lambda _t: KindError("transient", 408), lambda _t: (408, {"error": {"message": "request timeout"}}), 40, check)


def test_deadline_timeout_is_classified_by_kind() -> None:
    error = KindError("timeout", None, "PROVIDER_TIMEOUT", "something unrelated to the words")
    assert classify_failure(error) == "timeout"
    batch, fake = with_fake(lambda _t: error, 1, retries=1)
    result = batch.translate_texts(["only"])
    assert result == {"only": "only"} and batch.failed_codes == {"only": "timeout"}, batch.failed_codes
    # Other kinds map without reading the message.
    cases = [
        (KindError("rate_limit", 429), "rate_limit"), (KindError("rate_limit", 429, "NO_CREDIT"), "quota"),
        (KindError("auth", 401), "auth"), (KindError("config", 404, "MODEL_NOT_FOUND"), "unsupported_model"),
        (KindError("config", 405), "bad_request"), (KindError("rejected", 400), "bad_request"),
        (KindError("too_large", 413), "bad_request"), (KindError("filtered", 400), "bad_request"),
        (KindError("transient", 503), "provider_unavailable"), (KindError("unknown"), "provider_unavailable"),
        (KindError("redirect", None, "PROVIDER_REDIRECT_REFUSED"), "auth"),
    ]
    for exc, expected in cases:
        assert classify_failure(exc) == expected, (exc.kind, classify_failure(exc), expected)


def test_fatal_kinds_stop_at_once_and_progress_carries_no_provider_text() -> None:
    events: list[dict] = []
    for kind, status in (("auth", 401), ("config", 404), ("redirect", None)):
        batch, fake = with_fake(lambda _t, k=kind, s=status: KindError(k, s, None, "SECRET-PROVIDER-TEXT echoing the prompt"), 40)
        batch.progress_callback = events.append
        try:
            batch.translate_texts(texts(40))
            raise AssertionError(f"{kind} must be fatal")
        except ProviderUnavailable as exc:
            assert exc.fatal
        assert len(fake.calls) == 1, (kind, fake.calls)
    errors = [event for event in events if event["event"] == "translation_batch_error"]
    assert len(errors) == 3
    assert all("SECRET-PROVIDER-TEXT" not in json.dumps(event) for event in events)
    assert all(event["kind"] and event["failure"] and event["message"] for event in errors)


def test_adaptation_retries_are_charged_to_the_batch_budget() -> None:
    from llm_backends import LLMProviderClient

    batch, fake = with_fake(lambda _t: KindError("transient", 503), 40, retries=3)
    original = fake.translate_mapping

    def costly(payload: dict, **kwargs):
        LLMProviderClient.request_count += 2  # the adapter made two extra HTTP calls on its own
        return original(payload, **kwargs)

    fake.translate_mapping = costly
    budget = {"left": 10, "error": "", "code": "other"}
    try:
        batch._translate_batch(["a", "b"], 2, budget)
    except ProviderUnavailable:
        pass
    assert budget["left"] <= 10 - 3 * 2, budget  # each failed attempt cost 3 HTTP calls, not 1


def main() -> None:
    tests = [
        test_persistent_400_costs_three_calls, test_413_at_batch_200_completes_through_singletons,
        test_one_filtered_string_among_40, test_persistent_408_is_an_outage_not_a_rejection,
        test_deadline_timeout_is_classified_by_kind, test_fatal_kinds_stop_at_once_and_progress_carries_no_provider_text,
        test_adaptation_retries_are_charged_to_the_batch_budget,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"RETRY_CONTRACT_PASSED ({len(tests)} tests, real-HTTP variants {'run' if HAS_KIND else 'skipped: ProviderError has no kind yet'})")


if __name__ == "__main__":
    main()
