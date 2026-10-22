"""Subprocess half of the real-kill matrix (not a test).

Runs one write job on a synthetic world and kills the whole process, with ``os._exit``, the
``nth`` time a named boundary is reached: no ``finally``, no ``atexit``, no flush - what a power cut
or ``TerminateProcess`` leaves is what the caller then inspects.

    journal_kill_helper.py translate <root> <world> <pack>
    journal_kill_helper.py restore   <root> <world> <pack> <backup set id>
    journal_kill_helper.py recover   <root> <world> <pack> <journal.json> <rollback|keep>

The boundary comes from the environment: ``POMI_TEST_KILL_AT=<name>#<nth>[:<kind>]``.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from journal_fixtures import run_job, stores  # noqa: E402
from mwt import journal  # noqa: E402
from mwt.journal import recover_job  # noqa: E402
from mwt.safety import BackupSet  # noqa: E402

KILLED = 77


def install() -> None:
    spec = os.environ.get("POMI_TEST_KILL_AT", "")
    if not spec:
        return
    name, _, rest = spec.partition("#")
    nth_text, _, kind = rest.partition(":")
    nth = int(nth_text or "1")
    seen = {"n": 0}

    def hook(point: str, detail: dict) -> None:
        if point != name or (kind and detail.get("kind") != kind):
            return
        seen["n"] += 1
        if seen["n"] == nth:
            os._exit(KILLED)  # noqa: SLF001 - the point is to leave nothing behind

    journal.set_fault_hook(hook)


def main(argv: list[str]) -> int:
    scenario, root, world, pack = argv[0], Path(argv[1]), Path(argv[2]), Path(argv[3])
    install()
    if scenario == "translate":
        run_job(world, root, pack)
    elif scenario == "restore":
        selected = BackupSet.find(world, argv[4], stores(root), external_files=[pack])
        selected.restore(recovery_store=stores(root)[0], lock_dir=root / "locks")
    elif scenario == "recover":
        recover_job(Path(argv[4]), argv[5], authorized_external=[pack], lock_dir=root / "locks")
    else:
        raise SystemExit(f"unknown scenario {scenario}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
