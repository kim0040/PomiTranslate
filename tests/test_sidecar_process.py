"""The JSONL sidecar's process boundary: UTF-8 pipes, stop requests and parent loss.

Runs the real entry module as a child process. No provider, keychain or user data is touched.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.test_release_fixtures import compound, nbt_bytes, string, write_region  # noqa: E402

PY = sys.executable


def _world(path: Path) -> Path:
    from nbt import nbt

    write_region(path / "region" / "r.0.0.mca", {0: (2, nbt_bytes(compound("sign", string("Text1", '{"text":"안녕"}'))), False)})
    level = nbt.NBTFile()
    data = nbt.TAG_Compound(name="Data")
    data.tags.append(nbt.TAG_Int(name="DataVersion", value=4189))
    level.tags.append(data)
    level.write_file(filename=str(path / "level.dat"))
    return path


def _start(tmp: Path, env_extra: dict[str, str] | None = None, parent_pid: int = 0) -> subprocess.Popen[bytes]:
    env = {key: value for key, value in os.environ.items() if not key.startswith(("POMI_", "PYTHONIOENCODING", "PYTHONUTF8"))}
    env.update(env_extra or {})
    command = [
        PY, "-m", "mwt.desktop_entry", "--jsonl",
        "--report-dir", str(tmp / "reports"),
        "--data-dir", str(tmp / "userdata"),
        "--cancel-file", str(tmp / "reports" / "active-operation-test.cancel"),
    ]
    if parent_pid:
        command += ["--parent-pid", str(parent_pid)]
    # Binary pipes: the test checks the exact bytes, not whatever this process's locale decodes.
    return subprocess.Popen(command, cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def _read(proc: subprocess.Popen[bytes]) -> dict:
    assert proc.stdout is not None
    raw = proc.stdout.readline()
    if not raw:
        raise RuntimeError("sidecar closed stdout")
    return json.loads(raw.decode("utf-8"))  # strict: every line must be valid UTF-8


def test_non_utf8_locale_round_trips_korean_and_japanese_paths() -> None:
    with tempfile.TemporaryDirectory() as directory:
        tmp = Path(directory)
        world = _world(tmp / "월드 ワールド 世界")
        # A Windows pipe would default to the ANSI code page; force an equivalent here.
        proc = _start(tmp, {"PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"})
        try:
            assert _read(proc)["type"] == "system.hello"
            request = {"v": 1, "id": "remember", "type": "worlds.remember", "payload": {"worldDir": str(world)}}
            assert proc.stdin is not None
            proc.stdin.write((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
            proc.stdin.flush()
            reply = _read(proc)
            assert reply["type"] == "response.ok", reply
            assert reply["payload"]["worlds"][0]["path"] == str(world.resolve())
            inspect = {"v": 1, "id": "inspect", "type": "world.inspect", "payload": {"worldDir": str(world)}}
            proc.stdin.write((json.dumps(inspect, ensure_ascii=False) + "\n").encode("utf-8"))
            proc.stdin.flush()
            inspected = _read(proc)
            assert inspected["type"] == "response.ok", inspected
            assert inspected["payload"]["validJavaWorld"] is True
            proc.stdin.close()
            assert proc.wait(timeout=10) == 0
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)


def test_sigterm_while_idle_exits_without_reading_more_work() -> None:
    if os.name == "nt":
        return  # no SIGTERM delivery on Windows; the cancel file and watchdog cover it there
    with tempfile.TemporaryDirectory() as directory:
        tmp = Path(directory)
        proc = _start(tmp)
        try:
            assert _read(proc)["type"] == "system.hello"
            proc.send_signal(signal.SIGTERM)
            assert proc.wait(timeout=10) == 128 + signal.SIGTERM
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)


def test_losing_the_app_requests_a_cooperative_stop_and_no_new_work_starts() -> None:
    with tempfile.TemporaryDirectory() as directory:
        tmp = Path(directory)
        (tmp / "reports").mkdir()
        cancel = tmp / "reports" / "active-operation-test.cancel"
        stand_in = subprocess.Popen([PY, "-c", "import time; time.sleep(60)"])
        proc = _start(tmp, parent_pid=stand_in.pid)
        try:
            assert _read(proc)["type"] == "system.hello"
            stand_in.kill()
            stand_in.wait(timeout=5)
            deadline = time.monotonic() + 10
            while not cancel.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            assert cancel.read_bytes() == b"cancel", "the watchdog uses the existing cancel path"
            # A request that arrives after the app is gone is not started.
            assert proc.stdin is not None
            proc.stdin.write(b'{"v":1,"id":"late","type":"worlds.list","payload":{}}\n')
            proc.stdin.flush()
            proc.stdin.close()
            assert proc.wait(timeout=10) == 0
            assert proc.stdout is not None
            assert proc.stdout.read() == b""
        finally:
            for process in (proc, stand_in):
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)


def test_stop_request_reaches_the_cancel_check_and_a_lost_stdout_never_raises() -> None:
    import threading

    from mwt import desktop_entry as entry

    saved = (entry._STOP_EVENT, entry._CANCEL_FILE, entry._STDOUT_LOST, sys.stdout)
    with tempfile.TemporaryDirectory() as directory:
        cancel = entry._CancelSignal(Path(directory) / "active-operation-test.cancel")
        try:
            entry._STOP_EVENT = threading.Event()
            entry._CANCEL_FILE = None
            assert not cancel.is_file()
            entry._request_stop()
            assert cancel.is_file(), "an in-process stop request is a cancel even if the file is removed"

            class Broken:
                def write(self, _text: str) -> int:
                    raise BrokenPipeError

                def flush(self) -> None:
                    raise BrokenPipeError

            entry._STOP_EVENT = threading.Event()
            entry._STDOUT_LOST = False
            sys.stdout = Broken()  # type: ignore[assignment]
            entry.emit({"v": 1, "type": "translate.progress"})
            entry.emit({"v": 1, "type": "translate.progress"})
            assert entry._STDOUT_LOST and entry._stop_requested()
        finally:
            entry._STOP_EVENT, entry._CANCEL_FILE, entry._STDOUT_LOST, sys.stdout = saved


def test_jsonl_mode_never_falls_back_to_the_keyring() -> None:
    from mwt import desktop_entry as entry

    saved = entry._RUST_OWNS_CREDENTIALS
    try:
        entry._RUST_OWNS_CREDENTIALS = False
        assert entry._keyring_allowed({"credentialOwner": "python"})
        assert not entry._keyring_allowed({"credentialOwner": "rust"})
        entry._RUST_OWNS_CREDENTIALS = True
        assert not entry._keyring_allowed({})
        assert not entry._keyring_allowed({"credentialOwner": "python"})
    finally:
        entry._RUST_OWNS_CREDENTIALS = saved


def main() -> None:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print("PASS", test.__name__)
    print("SIDECAR_PROCESS_PASSED", len(tests))


if __name__ == "__main__":
    main()
