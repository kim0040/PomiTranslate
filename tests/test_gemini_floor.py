"""The lowest Gemini thinking level a model takes is learned once, kept on disk and shared by concurrent batches."""

from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from llm_backends import LLMProviderClient
from mwt import gemini_floor
from mwt.reasoning import GEMINI_LEVELS
from mwt.userdata import (
    GEMINI_FLOOR_TTL_SECONDS,
    gemini_floor_endpoint,
    load_gemini_level_floors,
    remember_gemini_level_floor,
)

SECRET = "gemini-floor-test-key"
PROMPT = "Hello floor prompt"
MODEL = "gemini-3.8-flash"


class FakeGemini:
    """A local Gemini endpoint whose models refuse thinking levels below ``required``."""

    def __init__(self, required: dict[str, str], delay: float = 0.0) -> None:
        self.required = required
        self.delay = delay
        self.hold: threading.Event | None = None  # the first request waits until this is set
        self.first_status: int | None = None  # the first request is answered with this error status
        self.on_first: object = None  # called with no arguments when the first request has arrived
        self.arrived = threading.Event()
        self.requests: list[tuple[str, str]] = []  # (model, level) of every POST, in arrival order
        self.lock = threading.Lock()
        self.refused: list[tuple[str, str]] = []  # (model, level)
        self.accepted: list[tuple[str, str]] = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def _send(self, payload: dict, status: int = 200) -> None:
                raw = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self) -> None:  # noqa: N802
                models = [
                    {
                        "name": f"models/{name}",
                        "displayName": name,
                        "supportedGenerationMethods": ["generateContent"],
                        "thinking": True,
                    }
                    for name in ("gemini-3.8-flash", "gemini-3.5-flash")
                ]
                self._send({"models": models})

            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))).decode("utf-8"))
                model = self.path.split("/models/", 1)[1].split(":", 1)[0]
                level = body.get("generationConfig", {}).get("thinkingConfig", {}).get("thinkingLevel", "")
                with owner.lock:
                    owner.requests.append((model, level))
                    first = len(owner.requests) == 1
                if first:
                    owner.arrived.set()
                    if callable(owner.on_first):
                        owner.on_first()
                    if owner.hold is not None:
                        owner.hold.wait(20)
                    if owner.first_status:
                        self._send({"error": {"code": owner.first_status, "message": "synthetic failure"}}, owner.first_status)
                        return
                if owner.delay:
                    time.sleep(owner.delay)
                needed = owner.required.get(model)
                with owner.lock:
                    if needed and level and GEMINI_LEVELS.index(level) < GEMINI_LEVELS.index(needed):
                        owner.refused.append((model, level))
                        refuse = True
                    else:
                        owner.accepted.append((model, level))
                        refuse = False
                if refuse:
                    self._send(
                        {
                            "error": {
                                "code": 400,
                                "message": f"Thinking level {level.upper()} is not supported for this model. Please retry with other thinking level.",
                                "status": "INVALID_ARGUMENT",
                            }
                        },
                        400,
                    )
                    return
                self._send(
                    {
                        "candidates": [{"content": {"parts": [{"text": json.dumps({"0": "Hola"})}]}, "finishReason": "STOP"}],
                        "usageMetadata": {"promptTokenCount": 3, "candidatesTokenCount": 2},
                    }
                )

            def log_message(self, format: str, *args) -> None:  # noqa: A003
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        host, port = self.server.server_address[:2]
        self.base = f"http://{host}:{port}/v1beta"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def levels(self) -> list[str]:
        return [level for _, level in self.accepted]


def make_client(base: str, data_dir: Path | None, model: str = MODEL, reasoning: str = "disabled") -> LLMProviderClient:
    return LLMProviderClient(
        {
            "api": {
                "provider": "gemini",
                "api_key": SECRET,
                "base_url": base,
                "model": model,
                "request_timeout": 30,
                "openrouter_reasoning": reasoning,
            },
            "runtime": {"data_dir": str(data_dir) if data_dir else ""},
        }
    )


def translate(client: LLMProviderClient) -> dict:
    return client.translate_mapping({"0": PROMPT}, system_prompt="sys", temperature=0)


def floor_file(root: Path) -> Path:
    return root / "models" / "gemini-thinking-floors.json"


def test_second_job_sends_no_refused_request(tmp: Path) -> None:
    gemini_floor.reset_memory()
    origin = FakeGemini({MODEL: "low"})
    data = tmp / "second-job"
    try:
        assert translate(make_client(origin.base, data)) == {"0": "Hola"}
        assert origin.refused == [(MODEL, "minimal")], origin.refused
        saved = json.loads(floor_file(data).read_text(encoding="utf-8"))["floors"]
        assert len(saved) == 1 and saved[0]["level"] == "low"
        # A new process knows nothing in memory; the file is all it has.
        gemini_floor.reset_memory()
        assert translate(make_client(origin.base, data)) == {"0": "Hola"}
        assert len(origin.refused) == 1, "the second job must not be refused again"
        assert origin.levels() == ["low", "low"], origin.levels()
    finally:
        origin.close()
    print("PASS gemini_floor.second_job")


def test_stored_floor_holds_no_secret_or_prompt(tmp: Path) -> None:
    gemini_floor.reset_memory()
    origin = FakeGemini({MODEL: "low"})
    data = tmp / "no-secrets"
    try:
        translate(make_client(origin.base, data))
    finally:
        origin.close()
    raw = floor_file(data).read_text(encoding="utf-8")
    document = json.loads(raw)
    assert SECRET not in raw and PROMPT not in raw and "127.0.0.1" not in raw, raw
    assert set(document) == {"schema", "floors"}
    (entry,) = document["floors"]
    assert set(entry) == {"provider", "endpoint", "model", "level", "learned_at"}
    assert entry["provider"] == "gemini" and entry["model"] == MODEL
    assert entry["endpoint"] == gemini_floor_endpoint(origin.base)
    print("PASS gemini_floor.no_secrets")


def test_concurrent_batches_learn_once(tmp: Path) -> None:
    for shared in (False, True):
        gemini_floor.reset_memory()
        origin = FakeGemini({MODEL: "low"}, delay=0.15)
        data = tmp / f"concurrent-{shared}"
        try:
            first = make_client(origin.base, data)
            clients = [first] * 4 if shared else [make_client(origin.base, data) for _ in range(4)]
            for client in clients:
                client.try_refresh_text_models()
            gate = threading.Barrier(4)
            results: list[object] = []

            def run(client: LLMProviderClient) -> None:
                gate.wait()
                try:
                    results.append(translate(client))
                except Exception as exc:  # noqa: BLE001
                    results.append(exc)

            threads = [threading.Thread(target=run, args=(client,)) for client in clients]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(30)
            assert results == [{"0": "Hola"}] * 4, results
            assert len(origin.refused) <= 1, f"shared={shared}: {origin.refused}"
            assert origin.levels() == ["low"] * 4, origin.levels()
        finally:
            origin.close()
    print("PASS gemini_floor.concurrency")


def test_floor_stops_at_what_the_provider_required(tmp: Path) -> None:
    gemini_floor.reset_memory()
    origin = FakeGemini({MODEL: "medium"})
    data = tmp / "exact"
    try:
        translate(make_client(origin.base, data))
        assert origin.refused == [(MODEL, "minimal"), (MODEL, "low")], origin.refused
        assert origin.levels() == ["medium"]
        (stored,) = load_gemini_level_floors(data).values()
        assert stored == "medium", "the floor is the level that worked, not one above it"
        # A person who asked for more than the floor is not lowered, and "high" stays "high".
        gemini_floor.reset_memory()
        translate(make_client(origin.base, data, reasoning="high"))
        assert origin.levels()[-1] == "high"
        # Other models and other endpoints are not held to this model's floor.
        gemini_floor.reset_memory()
        translate(make_client(origin.base, data, model="gemini-3.5-flash"))
        assert origin.levels()[-1] == "minimal" and len(origin.refused) == 2
    finally:
        origin.close()
    other = FakeGemini({})
    try:
        gemini_floor.reset_memory()
        translate(make_client(other.base, data))
        assert other.levels() == ["minimal"], "a floor learned at one endpoint does not apply to another"
    finally:
        other.close()
    print("PASS gemini_floor.exact_level")


def test_expired_entry_is_ignored(tmp: Path) -> None:
    gemini_floor.reset_memory()
    origin = FakeGemini({MODEL: "low"})
    data = tmp / "expired"
    now = time.time()
    try:
        remember_gemini_level_floor("gemini", origin.base, MODEL, "low", root=data, now=now - GEMINI_FLOOR_TTL_SECONDS - 60)
        assert load_gemini_level_floors(data) == {}
        translate(make_client(origin.base, data))
        assert origin.refused == [(MODEL, "minimal")], "an expired floor is tried again"
        # Learning it again replaced the stale entry with a fresh one.
        assert list(load_gemini_level_floors(data).values()) == ["low"]
        # An entry inside the window is used.
        gemini_floor.reset_memory()
        fresh = tmp / "fresh"
        remember_gemini_level_floor("gemini", origin.base, MODEL, "low", root=fresh, now=now - GEMINI_FLOOR_TTL_SECONDS + 3600)
        translate(make_client(origin.base, fresh))
        assert len(origin.refused) == 1
        # A timestamp far in the future is not trusted either.
        gemini_floor.reset_memory()
        future = tmp / "future"
        remember_gemini_level_floor("gemini", origin.base, MODEL, "low", root=future, now=now + 30 * 24 * 3600)
        assert load_gemini_level_floors(future) == {}
    finally:
        origin.close()
    print("PASS gemini_floor.expiry")


def test_corrupt_file_is_ignored(tmp: Path) -> None:
    origin = FakeGemini({MODEL: "low"})
    try:
        for index, content in enumerate(
            (
                "{not json",
                "[]",
                json.dumps({"floors": "nope"}),
                json.dumps({"floors": [1, "x", {"provider": "gemini"}, {"provider": "gemini", "endpoint": "e", "model": MODEL, "level": "ultra", "learned_at": time.time()}]}),
                "",
            )
        ):
            gemini_floor.reset_memory()
            data = tmp / f"corrupt-{index}"
            path = floor_file(data)
            path.parent.mkdir(parents=True)
            path.write_text(content, encoding="utf-8")
            assert load_gemini_level_floors(data) == {}, content
            before = len(origin.refused)
            assert translate(make_client(origin.base, data)) == {"0": "Hola"}
            assert len(origin.refused) == before + 1, "no floor: the model is asked and refuses once"
            assert list(load_gemini_level_floors(data).values()) == ["low"], "the file is repaired by the next write"
        gemini_floor.reset_memory()
        missing = tmp / "missing"
        assert load_gemini_level_floors(missing) == {}
    finally:
        origin.close()
    print("PASS gemini_floor.corrupt_file")


def test_unwritable_file_does_not_fail_the_job(tmp: Path) -> None:
    gemini_floor.reset_memory()
    origin = FakeGemini({MODEL: "low"})
    data = tmp / "blocked"
    try:
        with patch("mwt.userdata.remember_gemini_level_floor", side_effect=OSError("disk full")):
            assert translate(make_client(origin.base, data)) == {"0": "Hola"}
            translate(make_client(origin.base, data))
        assert len(origin.refused) == 1, "the level is still kept in memory for the rest of the process"
    finally:
        origin.close()
    print("PASS gemini_floor.write_failure")


def test_non_finite_timestamps_are_ignored(tmp: Path) -> None:
    """P-7: NaN never expires and 10**400 does not convert; both entries are unusable, not fatal."""
    origin = FakeGemini({MODEL: "low"})
    try:
        for label, stamp in (("nan", float("nan")), ("huge", 10**400), ("inf", float("inf"))):
            gemini_floor.reset_memory()
            data = tmp / f"nonfinite-{label}"
            path = floor_file(data)
            path.parent.mkdir(parents=True)
            entry = {"provider": "gemini", "endpoint": gemini_floor_endpoint(origin.base), "model": MODEL, "level": "high", "learned_at": stamp}
            path.write_text(json.dumps({"schema": 1, "floors": [entry]}), encoding="utf-8")  # NaN is written as a bare token
            assert load_gemini_level_floors(data) == {}, label
            key = gemini_floor.key_for("gemini", origin.base, MODEL)
            assert gemini_floor.floor(key, data) is None, label
            before = len(origin.refused)
            assert translate(make_client(origin.base, data)) == {"0": "Hola"}
            assert len(origin.refused) == before + 1 and origin.levels()[-1] == "low", label
    finally:
        origin.close()
    print("PASS gemini_floor.non_finite_timestamps")


def test_in_memory_floor_expires(tmp: Path) -> None:
    """P-8: a floor held by a long-lived process ends with its 30 days like one read from the file."""
    gemini_floor.reset_memory()
    origin = FakeGemini({MODEL: "low"})
    data = tmp / "memory-expiry"
    try:
        translate(make_client(origin.base, data))
        key = gemini_floor.key_for("gemini", origin.base, MODEL)
        assert gemini_floor.floor(key, data) == "low"
        origin.required[MODEL] = "minimal"  # the provider relaxed its minimum
        later = time.time() + GEMINI_FLOOR_TTL_SECONDS + 60
        with patch.object(gemini_floor.time, "time", return_value=later):
            assert gemini_floor.floor(key, data) is None, "no reset_memory(), no restart"
            translate(make_client(origin.base, data))
        assert origin.levels()[-1] == "minimal", origin.levels()
        # An entry read from the file keeps the time it was learned, not the time it was read.
        gemini_floor.reset_memory()
        old = tmp / "memory-expiry-old"
        now = time.time()
        remember_gemini_level_floor("gemini", origin.base, MODEL, "high", root=old, now=now - 29 * 24 * 3600)
        assert gemini_floor.floor(key, old) == "high"
        with patch.object(gemini_floor.time, "time", return_value=now + 2 * 24 * 3600):
            assert gemini_floor.floor(key, old) is None
    finally:
        origin.close()
    print("PASS gemini_floor.memory_expiry")


def test_root_loading_is_complete_before_anyone_reads(tmp: Path) -> None:
    """P-9: a batch that finds the file being read waits for the merge; a failed read is not remembered as done."""
    gemini_floor.reset_memory()
    key = gemini_floor.key_for("gemini", "http://example.invalid/v1", MODEL)
    started, release = threading.Event(), threading.Event()
    answers: dict[str, object] = {}

    def slow(root):  # noqa: ANN001
        started.set()
        assert release.wait(5)
        return {key: ("high", time.time())}

    with patch("mwt.userdata.load_gemini_level_floor_entries", side_effect=slow):
        first = threading.Thread(target=lambda: answers.__setitem__("first", gemini_floor.floor(key, tmp / "load-race")), daemon=True)
        first.start()
        assert started.wait(5)
        second = threading.Thread(target=lambda: answers.__setitem__("second", gemini_floor.floor(key, tmp / "load-race")), daemon=True)
        second.start()
        second.join(0.3)
        assert second.is_alive(), "the second batch must wait for the merge instead of reading an empty table"
        release.set()
        first.join(5)
        second.join(5)
    assert answers == {"first": "high", "second": "high"}, answers
    # A read that failed leaves the folder unloaded; the next call reads it again.
    gemini_floor.reset_memory()
    calls: list[int] = []

    def flaky(root):  # noqa: ANN001
        calls.append(1)
        if len(calls) == 1:
            raise OSError("synthetic read error")
        return {key: ("medium", time.time())}

    with patch("mwt.userdata.load_gemini_level_floor_entries", side_effect=flaky):
        assert gemini_floor.floor(key, tmp / "load-fail") is None
        assert gemini_floor.floor(key, tmp / "load-fail") == "medium"
    assert len(calls) == 2
    print("PASS gemini_floor.root_loading")


def main() -> None:
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        test_second_job_sends_no_refused_request(tmp)
        test_stored_floor_holds_no_secret_or_prompt(tmp)
        test_concurrent_batches_learn_once(tmp)
        test_floor_stops_at_what_the_provider_required(tmp)
        test_expired_entry_is_ignored(tmp)
        test_corrupt_file_is_ignored(tmp)
        test_unwritable_file_does_not_fail_the_job(tmp)
        test_non_finite_timestamps_are_ignored(tmp)
        test_in_memory_floor_expires(tmp)
        test_root_loading_is_complete_before_anyone_reads(tmp)
    print("PASS gemini_floor")


if __name__ == "__main__":
    main()
