"""Batches of one job that wait for the Gemini thinking-level learner keep watching the job (P-1, P-2).

The core (BatchTranslator) hands the client a stop guard: a cancelled job or a published abort stops every
request that has not been sent, including a request that is queued behind the learner and the step-up request
of the learner itself. The learner's outcome reaches its waiters, and the wait has a deadline of its own.
All endpoints are local fakes; nothing here calls a provider.
"""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from llm_backends import LLMProviderClient, ProviderError, RequestStopped
from mc_world_translator import DEFAULT_CONFIG, BatchTranslator, ProviderUnavailable, TranslationCancelled, merge_nested
from mwt import gemini_floor
from mwt.reasoning import GEMINI_LEVELS
from test_gemini_floor import MODEL, SECRET, FakeGemini, make_client, translate


def make_batch(origin: FakeGemini, stop: threading.Event) -> BatchTranslator:
    """The real core around a fake endpoint: its cancel check and breaker are what the client's stop guard reads."""
    config = merge_nested(
        DEFAULT_CONFIG,
        {
            "inherit_translate_py": False,
            "api": {
                "provider": "gemini", "base_url": origin.base, "model": MODEL, "api_key": SECRET,
                "openrouter_reasoning": "disabled", "request_timeout": 30, "rpm_limit": 0, "tpm_limit": 0,
            },
            "runtime": {"data_dir": "", "max_batch_retries": 1},
            "prompt": {"target_language": "English"},
        },
    )
    batch = BatchTranslator(config, cancel_check=stop.is_set)
    batch.client.try_refresh_text_models()
    return batch


def run_all(jobs: list) -> tuple[list[threading.Thread], list]:
    """Threads that each run ``jobs[i]()`` and store its result or exception."""
    outcomes: list = [None] * len(jobs)

    def run(index: int) -> None:
        try:
            outcomes[index] = jobs[index]()
        except BaseException as exc:  # noqa: BLE001
            outcomes[index] = exc

    return [threading.Thread(target=run, args=(i,), daemon=True) for i in range(len(jobs))], outcomes


def queued_behind_learner(origin: FakeGemini, jobs: list) -> tuple[list[threading.Thread], list]:
    """Start the first job, wait until its request is at the endpoint, then start the rest and let them queue."""
    threads, outcomes = run_all(jobs)
    threads[0].start()
    assert origin.arrived.wait(5), "the learner's request never arrived"
    for thread in threads[1:]:
        thread.start()
    time.sleep(0.3)
    return threads, outcomes


def test_cancel_reaches_a_waiting_batch() -> None:
    """A batch queued behind the learner stops when the job is cancelled, and nothing is sent after that."""
    gemini_floor.reset_memory()
    origin = FakeGemini({MODEL: "low"})
    origin.hold = threading.Event()
    stop = threading.Event()
    try:
        first, second = make_batch(origin, stop), make_batch(origin, stop)
        threads, outcomes = queued_behind_learner(
            origin, [lambda: first._translate_batch(["first"], 1), lambda: second._translate_batch(["second"], 1)]
        )
        stop.set()
        threads[1].join(3)
        assert not threads[1].is_alive(), "a waiting batch must notice the cancellation without waiting for the learner"
        assert isinstance(outcomes[1], TranslationCancelled), outcomes[1]
        origin.hold.set()
        threads[0].join(10)
        assert isinstance(outcomes[0], TranslationCancelled), outcomes[0]
        assert origin.requests == [(MODEL, "minimal")], f"no request after the cancellation: {origin.requests}"
    finally:
        origin.hold.set()
        origin.close()
    print("PASS provider_coordination.cancel_while_waiting")


def test_step_up_request_is_not_sent_after_cancel() -> None:
    """The step-up POST of the learner is one more request; the stop guard looks before it too."""
    gemini_floor.reset_memory()
    origin = FakeGemini({MODEL: "low"})
    stop = threading.Event()
    origin.on_first = stop.set  # cancelled while the refused request is in flight
    try:
        batch = make_batch(origin, stop)
        try:
            batch._translate_batch(["text"], 1)
        except TranslationCancelled:
            pass
        else:
            raise AssertionError("the job was cancelled; the batch must stop")
        assert origin.requests == [(MODEL, "minimal")], origin.requests
    finally:
        origin.close()
    print("PASS provider_coordination.step_up_after_cancel")


def test_fatal_learner_error_reaches_the_waiters() -> None:
    """The learner's bad-key answer is the waiters' answer; they send nothing."""
    gemini_floor.reset_memory()
    origin = FakeGemini({MODEL: "low"})
    origin.hold = threading.Event()
    origin.first_status = 401
    stop = threading.Event()
    try:
        first, second = make_batch(origin, stop), make_batch(origin, stop)
        threads, outcomes = queued_behind_learner(
            origin, [lambda: first._translate_batch(["first"], 1), lambda: second._translate_batch(["second"], 1)]
        )
        origin.hold.set()
        for thread in threads:
            thread.join(10)
        assert all(isinstance(outcome, ProviderUnavailable) and outcome.fatal for outcome in outcomes), outcomes
        assert origin.requests == [(MODEL, "minimal")], f"the waiter must not repeat a refused key: {origin.requests}"
    finally:
        origin.hold.set()
        origin.close()
    print("PASS provider_coordination.fatal_error_reaches_waiters.core")

    # The same through bare clients: the waiter raises the learner's error kind, once.
    gemini_floor.reset_memory()
    origin = FakeGemini({MODEL: "low"})
    origin.hold = threading.Event()
    origin.first_status = 403
    clients = [make_client(origin.base, None), make_client(origin.base, None)]
    for client in clients:
        client.try_refresh_text_models()
    try:
        threads, results = queued_behind_learner(origin, [lambda: translate(clients[0]), lambda: translate(clients[1])])
        origin.hold.set()
        for thread in threads:
            thread.join(10)
        assert all(isinstance(r, ProviderError) and r.kind == "auth" and r.status == 403 for r in results), results
        assert len(origin.requests) == 1, origin.requests
        # A later attempt (a corrected key) is not blamed for the old error.
        origin.first_status = None
        origin.hold = None
        assert translate(make_client(origin.base, None)) == {"0": "Hola"}
    finally:
        origin.close()
    print("PASS provider_coordination.fatal_error_reaches_waiters.client")


def test_retryable_learner_error_hands_over() -> None:
    """When the learner's request fails in a way that can be retried, a waiter becomes the next learner."""
    gemini_floor.reset_memory()
    origin = FakeGemini({MODEL: "low"})
    origin.hold = threading.Event()
    origin.first_status = 503
    clients = [make_client(origin.base, None), make_client(origin.base, None)]
    for client in clients:
        client.try_refresh_text_models()
    try:
        threads, results = queued_behind_learner(origin, [lambda: translate(clients[0]), lambda: translate(clients[1])])
        origin.hold.set()
        for thread in threads:
            thread.join(10)
        assert isinstance(results[0], ProviderError) and results[0].kind == "transient", results
        assert results[1] == {"0": "Hola"}, results
        assert origin.requests == [(MODEL, "minimal"), (MODEL, "minimal"), (MODEL, "low")], origin.requests
    finally:
        origin.hold.set()
        origin.close()
    print("PASS provider_coordination.retryable_error_hands_over")


class Interrupted(BaseException):
    pass


def test_slot_is_released_for_base_exceptions() -> None:
    """Whatever ends the learner, the next batch is not left waiting."""
    gemini_floor.reset_memory()
    origin = FakeGemini({MODEL: "low"})
    try:
        learner = make_client(origin.base, None)
        learner.try_refresh_text_models()
        with patch.object(learner, "_request_json", side_effect=Interrupted()):
            try:
                translate(learner)
            except Interrupted:
                pass
            else:
                raise AssertionError("the interrupt must propagate")
        started = time.monotonic()
        assert translate(make_client(origin.base, None)) == {"0": "Hola"}
        assert time.monotonic() - started < 5
    finally:
        origin.close()
    print("PASS provider_coordination.slot_released_on_base_exception")


def scripted(required: str, seconds: float, sent: list):
    """A fake transport for the POSTs: every request takes ``seconds`` and refuses levels below ``required``."""

    def request(self, method, url, *, headers, payload=None):  # noqa: ANN001
        level = payload["generationConfig"]["thinkingConfig"]["thinkingLevel"]
        sent.append(level)
        time.sleep(seconds)
        if GEMINI_LEVELS.index(level) < GEMINI_LEVELS.index(required):
            raise ProviderError(
                "refused", status=400, detail=f"Thinking level {level.upper()} is not supported for this model."
            )
        return {"candidates": [{"content": {"parts": [{"text": json.dumps({"0": "Hola"})}]}, "finishReason": "STOP"}]}

    return request


def test_a_slow_learning_sequence_is_waited_for() -> None:
    """The wait covers every level the learner tries, not one request timeout plus five seconds."""
    gemini_floor.reset_memory()
    sent: list[str] = []
    origin = FakeGemini({})  # only its model list is used
    try:
        clients = [make_client(origin.base, None), make_client(origin.base, None)]
        for client in clients:
            client.try_refresh_text_models()
            client.timeout = 2  # the old wait: 2 + 5 s; the learner needs four requests of two seconds
        with patch.object(LLMProviderClient, "_request_json", scripted("high", 2.0, sent)):
            threads, results = run_all([lambda: translate(clients[0]), lambda: translate(clients[1])])
            threads[0].start()
            time.sleep(0.2)
            threads[1].start()
            for thread in threads:
                thread.join(30)
        assert results == [{"0": "Hola"}] * 2, results
        assert sent == ["minimal", "low", "medium", "high", "high"], f"each level is refused once: {sent}"
    finally:
        origin.close()
    print("PASS provider_coordination.slow_learning_sequence")


def test_the_wait_has_a_deadline_and_no_uncoordinated_probe() -> None:
    """Past the learning deadline a waiter fails with a retryable timeout; it does not probe on its own."""
    gemini_floor.reset_memory()
    origin = FakeGemini({})  # only its model list is used
    clients = [make_client(origin.base, None), make_client(origin.base, None)]
    for client in clients:
        client.try_refresh_text_models()
        client.timeout = 1
    sent: list[str] = []
    stuck = threading.Event()
    release = threading.Event()

    def request(self, method, url, *, headers, payload=None):  # noqa: ANN001
        sent.append(payload["generationConfig"]["thinkingConfig"]["thinkingLevel"])
        if len(sent) == 1:  # the learner's sequence does not come back in time
            stuck.set()
            release.wait(20)
        return {"candidates": [{"content": {"parts": [{"text": json.dumps({"0": "Hola"})}]}, "finishReason": "STOP"}]}

    threads: list[threading.Thread] = []
    try:
        with patch.object(LLMProviderClient, "_request_json", request), patch.object(gemini_floor, "LEARNING_MARGIN_SECONDS", 0.2):
            threads, results = run_all([lambda: translate(clients[0]), lambda: translate(clients[1])])  # deadline: 4 x 1 s + 0.2 s
            threads[0].start()
            assert stuck.wait(5)
            threads[1].start()
            threads[1].join(5.2)  # the old bound was request timeout + 5 s = 6 s, and then a probe of its own
            assert not threads[1].is_alive(), "the waiter must give up at the learning deadline"
            error = results[1]
            assert isinstance(error, ProviderError) and error.kind == "timeout", error
            assert error.error_code == "PROVIDER_TIMEOUT"
            assert sent == ["minimal"], sent
            release.set()
            threads[0].join(10)
            assert results[0] == {"0": "Hola"}, results
    finally:
        release.set()
        for thread in threads:
            thread.join(10)
        origin.close()
    print("PASS provider_coordination.learning_deadline")


def test_stop_guard_covers_every_post() -> None:
    """The guard is looked at before the POST of every family, before anything is counted or sent."""
    for provider in ("openai", "anthropic", "gemini"):
        config = {
            "api": {"provider": provider, "api_key": "k", "base_url": "http://127.0.0.1:9/v1", "model": "m", "request_timeout": 5},
            "runtime": {"data_dir": ""},
        }
        client = LLMProviderClient(config, stop_guard=lambda: True)
        client._catalog_checked = True
        before = LLMProviderClient.request_count
        try:
            client.complete_text(system_prompt="s", user_prompt="u", temperature=0)
        except RequestStopped:
            pass
        else:
            raise AssertionError(f"{provider} sent a request after the stop")
        assert LLMProviderClient.request_count == before, provider
    print("PASS provider_coordination.stop_guard_every_post")


def main() -> None:
    test_cancel_reaches_a_waiting_batch()
    test_step_up_request_is_not_sent_after_cancel()
    test_fatal_learner_error_reaches_the_waiters()
    test_retryable_learner_error_hands_over()
    test_slot_is_released_for_base_exceptions()
    test_a_slow_learning_sequence_is_waited_for()
    test_the_wait_has_a_deadline_and_no_uncoordinated_probe()
    test_stop_guard_covers_every_post()
    print("PASS provider_coordination")


if __name__ == "__main__":
    main()
