"""The sidecar's JSONL channel: UTF-8 both ways, nothing but protocol on stdout, no crash on bad input."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from mwt import desktop_entry  # noqa: E402

KOREAN = "한국어 번역 🗺️ 월드"

# Runs the real serve loop with handlers that misbehave on purpose.
MISBEHAVING = r"""
import os, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from mwt import desktop_entry as d

def handle(message, report_dir, data_dir, cancel_path=None):
    kind = message.get("type")
    if kind == "t.print":
        print("STRAY PRINT 한국어 🗺️")            # a library printing to stdout
        os.write(1, "RAW FD WRITE\n".encode())     # or writing to fd 1 directly
        d.emit({"v": 1, "id": message.get("id", ""), "type": "response.ok", "payload": {"ok": True}})
    elif kind == "t.nan":
        d.emit({"v": 1, "id": message["id"], "type": "response.ok",
                "payload": {"cost": float("nan"), "rate": float("inf"), "nested": [float("-inf"), 1.5], "text": "ok\udc80"}})
    elif kind == "t.boom":
        raise RuntimeError("provider said sk-SECRET-KEY-123 and 한국어")
    elif kind == "t.leak":
        key = message["payload"]["apiKey"]
        print("diagnostic with", key)           # a stray print that carries the request's credential
        raise RuntimeError("upstream echoed " + key + " in its error")
    else:
        d.emit({"v": 1, "id": message.get("id", ""), "type": "response.ok", "payload": {"echo": kind}})

d.handle = handle
d.prepare_stdio()
d.isolate_protocol_streams()
d.serve(Path(sys.argv[2]), Path(sys.argv[3]), None)
"""


class Sidecar:
    def __init__(self, tmp: Path, *, encoding: str | None = None, misbehaving: bool = False) -> None:
        env = os.environ.copy()
        env.pop("PYTHONUTF8", None)
        if encoding:
            env["PYTHONIOENCODING"] = encoding  # what a Windows ANSI console would impose
        env["PYTHONPATH"] = str(ROOT)
        if misbehaving:
            command = [sys.executable, "-B", "-c", MISBEHAVING, str(ROOT), str(tmp / "reports"), str(tmp / "data")]
        else:
            command = [sys.executable, "-B", "-m", "mwt.desktop_entry", "--jsonl",
                       "--report-dir", str(tmp / "reports"), "--data-dir", str(tmp / "data")]
        self.process = subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.hello = self.read()

    def send_raw(self, data: bytes) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(data)
        self.process.stdin.flush()

    def send(self, message: object) -> None:
        self.send_raw(json.dumps(message, ensure_ascii=False).encode("utf-8") + b"\n")

    def read(self) -> dict:
        assert self.process.stdout is not None
        line = self.process.stdout.readline()
        assert line, "sidecar closed stdout: " + (self.process.stderr.read() or b"").decode("utf-8", "replace")
        # Strict: every byte on stdout must be UTF-8 JSON with no NaN/Infinity.
        def refuse(token):
            raise AssertionError(f"non-standard JSON constant {token}")
        return json.loads(line.decode("utf-8"), parse_constant=refuse)

    def ask(self, message: object) -> dict:
        self.send(message)
        return self.read()

    def close(self) -> str:
        assert self.process.stdin is not None
        self.process.stdin.close()
        self.process.wait(timeout=60)
        assert self.process.stdout is not None and self.process.stderr is not None
        leftover = self.process.stdout.read()
        assert leftover == b"", leftover  # nothing but already-read protocol lines
        return self.process.stderr.read().decode("utf-8", "replace")


def test_korean_and_emoji_under_cp949(tmp: Path) -> None:
    side = Sidecar(tmp, encoding="cp949")
    try:
        assert side.hello["type"] == "system.hello"
        reply = side.ask({"v": 1, "id": KOREAN, "type": "notices.get", "payload": {}})
        assert reply["type"] == "response.ok" and reply["id"] == KOREAN, reply
        # The product text itself (Korean/emoji capable) survives the trip as UTF-8.
        text = json.dumps(reply, ensure_ascii=False)
        assert "PomiTranslate" in text
    finally:
        side.close()


def test_invalid_input_never_kills_the_loop(tmp: Path) -> None:
    side = Sidecar(tmp, encoding="cp949")
    try:
        for bad in ([1, 2], "just a string", 42, None, True, 3.5):
            reply = side.ask(bad)
            assert reply["type"] == "response.error" and reply["error"]["code"] == "INVALID_REQUEST", (bad, reply)
        side.send_raw(b"not json at all\n")
        assert side.read()["error"]["code"] == "INVALID_REQUEST"
        side.send_raw(b'{"v":1,"id":"\xff\xfe","type":"notices.get"}\n')  # not UTF-8
        assert side.read()["error"]["code"] == "INVALID_REQUEST"
        side.send({"v": 2, "id": "old", "type": "notices.get"})
        assert side.read()["error"]["code"] == "INVALID_REQUEST"
        side.send({"v": 1, "id": {"nested": 1}, "type": "notices.get"})  # an id that is not a string
        assert side.read()["type"].startswith("response.")
        side.send_raw(b"\n   \n")  # blank lines are ignored
        reply = side.ask({"v": 1, "id": "still-alive", "type": "notices.get", "payload": {}})
        assert reply["id"] == "still-alive" and reply["type"] == "response.ok"
    finally:
        side.close()


def test_stray_output_cannot_corrupt_the_protocol(tmp: Path) -> None:
    side = Sidecar(tmp, encoding="cp949", misbehaving=True)
    try:
        reply = side.ask({"v": 1, "id": "p", "type": "t.print"})
        assert reply == {"v": 1, "id": "p", "type": "response.ok", "payload": {"ok": True}}
        reply = side.ask({"v": 1, "id": "q", "type": "t.other"})
        assert reply["payload"] == {"echo": "t.other"}
    finally:
        stderr = side.close()
    assert "STRAY PRINT" in stderr and "RAW FD WRITE" in stderr, "stray output is diverted to stderr"


def test_non_finite_numbers_never_crash_emit(tmp: Path) -> None:
    side = Sidecar(tmp, misbehaving=True)
    try:
        reply = side.ask({"v": 1, "id": "n", "type": "t.nan"})
        payload = reply["payload"]
        assert payload["cost"] == 0 and payload["rate"] == 0 and payload["nested"] == [0, 1.5]
        assert "non_finite_number" in payload["protocolWarnings"]
        assert side.ask({"v": 1, "id": "after", "type": "t.x"})["id"] == "after"
    finally:
        side.close()


def test_unexpected_exception_is_contained(tmp: Path) -> None:
    side = Sidecar(tmp, encoding="cp949", misbehaving=True)
    try:
        reply = side.ask({"v": 1, "id": "b", "type": "t.boom"})
        error = reply["error"]
        assert reply["id"] == "b" and error["code"] == "OPERATION_FAILED", reply
        assert error["detail"] == "RuntimeError"
        assert "SECRET" not in json.dumps(reply), "the exception text never reaches the protocol"
        assert side.ask({"v": 1, "id": "next", "type": "t.x"})["id"] == "next"
    finally:
        stderr = side.close()
    assert "Traceback" in stderr and "RuntimeError" in stderr
    assert "sk-SECRET-KEY-123" not in stderr, "a key-shaped secret in an exception never reaches stderr"


def test_request_credentials_are_redacted_from_stderr(tmp: Path) -> None:
    secret = "opaque-credential-0123456789"  # no recognizable key shape: only the request tells us
    side = Sidecar(tmp, encoding="cp949", misbehaving=True)
    try:
        reply = side.ask({"v": 1, "id": "l", "type": "t.leak", "payload": {"apiKey": secret}})
        assert reply["error"]["code"] == "OPERATION_FAILED" and secret not in json.dumps(reply)
        assert side.ask({"v": 1, "id": "next", "type": "t.x"})["id"] == "next"
    finally:
        stderr = side.close()
    assert "Traceback" in stderr and "RuntimeError" in stderr and "diagnostic with" in stderr
    assert secret not in stderr, "the request's own credential must not appear in stderr"
    assert "[redacted]" in stderr


def test_wrong_shaped_persisted_files_do_not_abort_bootstrap(tmp: Path) -> None:
    from test_core_integrity import make_backup_via_desktop

    world, data_dir, result, _ = make_backup_via_desktop(tmp / "shapes")
    settings_file = data_dir / "settings.json"
    saved = json.loads(settings_file.read_text(encoding="utf-8"))
    saved["app_prefs"] = {"theme": ["not", "a", "string"], "onboarded": {"x": 1}, "unknown": [1]}
    saved["recent_worlds"] = ["text", 7, None, {"path": 5, "lastOpened": "yesterday"}, {"path": str(world), "lastOpened": [1]}]
    settings_file.write_text(json.dumps(saved), encoding="utf-8")
    manifests = list((data_dir / "backups").rglob("manifest.json"))
    assert manifests
    manifests[0].write_text("[]", encoding="utf-8")  # a manifest that is not an object
    body = desktop_entry._bootstrap_payload(data_dir, str(world), check_keyring=False)
    assert body["prefs"]["theme"] in {"system", "light", "dark"}
    assert isinstance(body["worlds"], list) and isinstance(body["backups"], list)
    assert "resume" in body
    for shape in ('{"files": "x"}', '{"files": [1, 2]}', "null", '"s"', "12"):
        manifests[0].write_text(shape, encoding="utf-8")
        desktop_entry._bootstrap_payload(data_dir, str(world), check_keyring=False)
    # And the whole settings file being the wrong type is not a crash either.
    settings_file.write_text("[1, 2]", encoding="utf-8")
    try:
        desktop_entry._bootstrap_payload(data_dir, str(world), check_keyring=False)
    except (ValueError, OSError):
        pass  # a clean, typed failure the caller can report; never an AttributeError


def main() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        tests = [
            test_korean_and_emoji_under_cp949,
            test_invalid_input_never_kills_the_loop,
            test_stray_output_cannot_corrupt_the_protocol,
            test_non_finite_numbers_never_crash_emit,
            test_unexpected_exception_is_contained,
            test_request_credentials_are_redacted_from_stderr,
            test_wrong_shaped_persisted_files_do_not_abort_bootstrap,
        ]
        for test in tests:
            (root / test.__name__).mkdir()
            test(root / test.__name__)
            print("PASS", test.__name__)
    print("JSONL_CHANNEL_PASSED")


if __name__ == "__main__":
    main()
