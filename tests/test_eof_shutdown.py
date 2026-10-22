"""The core stops when the shell goes away: stdin EOF during a request cancels it and bounds the exit."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Runs the real serve loop with one test-only request type. ``mode`` decides how the handler behaves
# once it has started: "cooperative" polls the same cancel check the translator uses, "stuck" ignores
# it like a provider call that never returns.
CORE = r"""
import sys, tempfile, time
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from mwt import desktop_entry as entry

entry.EOF_EXIT_GRACE_SECONDS = 1.5
mode = sys.argv[2]

def handler(message, report_dir, data_dir, cancel_path):
    sys.stderr.write("started\n"); sys.stderr.flush()
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if mode == "cooperative" and entry._cancel_requested(cancel_path):
            entry.emit({"v": 1, "id": message["id"], "type": "response.error",
                        "error": {"code": "CANCELLED", "message": "cancelled"}})
            return
        time.sleep(0.05)

entry.REQUEST_HANDLERS["test.block"] = handler
temp = Path(tempfile.mkdtemp())
entry.serve(temp / "reports", temp / "data", None)
"""


def start(mode: str) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, "-B", "-c", CORE, str(ROOT), mode],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )


def send_and_wait_started(process: subprocess.Popen) -> None:
    assert process.stdin is not None and process.stderr is not None
    process.stdin.write((json.dumps({"v": 1, "id": "r1", "type": "test.block", "payload": {}}) + "\n").encode())
    process.stdin.flush()
    while True:
        line = process.stderr.readline()
        assert line, "the core ended before the request started"
        if line.strip() == b"started":
            return


def close_and_time(process: subprocess.Popen) -> tuple[int, float]:
    assert process.stdin is not None
    began = time.monotonic()
    process.stdin.close()
    code = process.wait(timeout=30)
    return code, time.monotonic() - began


def test_idle_eof_exits_cleanly() -> None:
    process = start("cooperative")
    code, elapsed = close_and_time(process)
    assert code == 0 and elapsed < 5, (code, elapsed)


def test_eof_cancels_running_work() -> None:
    process = start("cooperative")
    send_and_wait_started(process)
    code, elapsed = close_and_time(process)
    assert code == 0 and elapsed < 1.5, (code, elapsed)
    assert process.stdout is not None
    replies = [json.loads(line) for line in process.stdout.read().splitlines() if line.strip()]
    assert replies[-1]["error"]["code"] == "CANCELLED", replies


def test_stuck_work_is_ended_after_the_grace_period() -> None:
    process = start("stuck")
    send_and_wait_started(process)
    code, elapsed = close_and_time(process)
    assert code == 3 and 1.0 < elapsed < 10, (code, elapsed)


def main() -> None:
    for test in (test_idle_eof_exits_cleanly, test_eof_cancels_running_work, test_stuck_work_is_ended_after_the_grace_period):
        test()
        print("PASS", test.__name__)
    print("EOF_SHUTDOWN_PASSED")


if __name__ == "__main__":
    main()
