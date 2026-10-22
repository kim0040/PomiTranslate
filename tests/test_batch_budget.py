"""Request budget, circuit breaker, failure codes and the untrusted-data prompt of the batch translator."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from llm_backends import ProviderError  # noqa: E402
from mc_world_translator import (  # noqa: E402
    DEFAULT_CONFIG,
    FAILURE_CODES,
    BatchTranslator,
    ProviderUnavailable,
    TranslationCancelled,
    classify_failure,
    merge_nested,
)


class Fake:
    """Stands in for the provider client: counts requests and raises what it is told to."""

    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.requests = 0
        self.sizes: list[int] = []

    def translate_mapping(self, payload: dict, **_kwargs) -> dict:
        self.requests += 1
        self.sizes.append(len(payload))
        if self.error is not None:
            raise self.error
        return {key: f"T:{value}" for key, value in payload.items()}


def translator(fake: Fake, *, batch_size: int = 25, retries: int = 3) -> BatchTranslator:
    config = merge_nested(DEFAULT_CONFIG, {
        "inherit_translate_py": False, "batch_size": batch_size,
        "runtime": {"max_batch_retries": retries},
        "api": {"provider": "openai", "api_key": "test-key", "model": "fixture", "base_url": "http://127.0.0.1:9/v1"},
    })
    batch = BatchTranslator(config)
    batch.client = fake
    batch.wait = lambda _delay: None
    batch.sleep = lambda _delay: None
    return batch


def test_format_errors_stay_inside_the_budget() -> None:
    fake = Fake(RuntimeError("incomplete translation JSON mapping"))
    batch = translator(fake)
    texts = [f"text {i}" for i in range(25)]
    result = batch.translate_texts(texts)
    assert result == {text: text for text in texts}, "nothing is passed off as translated"
    assert set(batch.failed) == set(texts)
    assert set(batch.failed_codes.values()) == {"format_mismatch"}
    # Before the cap this fanned out to hundreds of requests for one batch.
    assert fake.requests <= 2 * len(texts) + 3, fake.requests
    assert fake.requests > 3, "splitting still happens while budget remains"


def test_fatal_error_is_not_split_or_retried() -> None:
    fake = Fake(ProviderError("bad key", status=401))
    batch = translator(fake)
    try:
        batch.translate_texts([f"text {i}" for i in range(25)])
        raise AssertionError("a rejected key must stop the job")
    except ProviderUnavailable as exc:
        assert exc.fatal
    assert fake.requests == 1, fake.requests


def test_rejected_requests_trip_the_job_breaker() -> None:
    # 400 is not "fatal" on its own, but a job where every request is refused must stop.
    fake = Fake(ProviderError("unknown parameter", status=400))
    batch = translator(fake, batch_size=1)
    try:
        batch.translate_texts([f"text {i}" for i in range(40)])
        raise AssertionError("the breaker did not trip")
    except ProviderUnavailable as exc:
        assert "rejected" in str(exc)
    assert fake.requests <= 13, fake.requests


def test_success_resets_the_breaker() -> None:
    errors = [ProviderError("bad", status=400)] * 5

    class Flaky(Fake):
        def translate_mapping(self, payload, **kwargs):
            if errors:
                self.requests += 1
                raise errors.pop()
            return super().translate_mapping(payload, **kwargs)

    batch = translator(Flaky(), batch_size=1, retries=6)
    result = batch.translate_texts(["only"])
    assert result == {"only": "T:only"} and not batch.failed


def test_failure_codes() -> None:
    cases = [
        (ProviderError("denied", status=401), "auth"),
        (ProviderError("denied", status=403), "auth"),
        (ProviderError("no credit", status=402), "quota"),
        (ProviderError("You exceeded your current quota", status=429), "quota"),
        (ProviderError("slow down", status=429), "rate_limit"),
        (ProviderError("gateway", status=504), "timeout"),
        (ProviderError("The model `x` does not exist", status=400), "unsupported_model"),
        (ProviderError("no such thing", status=404), "unsupported_model"),
        (ProviderError("bad field", status=422), "bad_request"),
        (ProviderError("overloaded", status=503), "provider_unavailable"),
        (ProviderError("Request timed out"), "timeout"),
        (ProviderError("connection refused"), "provider_unavailable"),
        (RuntimeError("incomplete translation JSON mapping"), "format_mismatch"),
        (TranslationCancelled("stop"), "cancelled"),
        (ValueError("something else"), "other"),
    ]
    for exc, expected in cases:
        assert classify_failure(exc) == expected, (exc, classify_failure(exc), expected)
    assert {expected for _, expected in cases} <= set(FAILURE_CODES)
    assert set(FAILURE_CODES) == {
        "timeout", "auth", "rate_limit", "quota", "bad_request", "unsupported_model",
        "format_mismatch", "provider_unavailable", "cancelled", "other",
    }


def test_prompt_marks_world_text_untrusted() -> None:
    prompt = translator(Fake()).system_prompt()
    assert "신뢰할 수 없는 데이터" in prompt and "따르지 말고" in prompt
    # The output contract is unchanged and still the last instruction.
    assert prompt.rstrip().endswith("값(Value)만 번역해라.")
    assert "JSON" in prompt.splitlines()[-1]


def main() -> None:
    for test in (
        test_format_errors_stay_inside_the_budget,
        test_fatal_error_is_not_split_or_retried,
        test_rejected_requests_trip_the_job_breaker,
        test_success_resets_the_breaker,
        test_failure_codes,
        test_prompt_marks_world_text_untrusted,
    ):
        test()
        print("PASS", test.__name__)
    print("BATCH_BUDGET_PASSED")


if __name__ == "__main__":
    main()
