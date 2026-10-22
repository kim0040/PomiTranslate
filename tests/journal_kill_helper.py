"""Subprocess half of the real-kill matrix (not a test).

Runs one write job on a synthetic world and kills the whole process, with ``os._exit``, the
``nth`` time a named boundary is reached: no ``finally``, no ``atexit``, no flush - what a power cut
or ``TerminateProcess`` leaves is what the caller then inspects.

    journal_kill_helper.py translate <root> <world> <pack>
    journal_kill_helper.py restore   <root> <world> <pack> <backup set id>
    journal_kill_helper.py recover   <root> <world> <pack> <journal.json> <rollback|keep>
    journal_kill_helper.py resume    <root> <world> <pack>

``resume`` continues the cancelled job whose checkpoint ``partial_job`` left in ``<root>``.

The boundary comes from the environment: ``POMI_TEST_KILL_AT=<name>#<nth>[:<kind>]``. The names are the
journal's fault points and the two cuts inside every durable replace (``durable_before_replace``: the
new file is complete and flushed beside its target; ``durable_after_replace``: the rename returned, the
directory entry is not flushed). ``POMI_TEST_KILL_TARGET=<file name>`` counts only replaces of that file.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from journal_fixtures import checkpoint_runtime, run_job, stores  # noqa: E402
from mwt import durable, journal  # noqa: E402
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
    target = os.environ.get("POMI_TEST_KILL_TARGET", "")
    seen = {"n": 0}

    def hook(point: str, detail: dict) -> None:
        if point != name or (kind and detail.get("kind") != kind):
            return
        if target and Path(detail.get("destination", "")).name != target:
            return
        seen["n"] += 1
        if seen["n"] == nth:
            os._exit(KILLED)  # noqa: SLF001 - the point is to leave nothing behind

    journal.set_fault_hook(hook)
    durable.set_fault_hook(hook)


def main(argv: list[str]) -> int:
    scenario, root, world, pack = argv[0], Path(argv[1]), Path(argv[2]), Path(argv[3])
    install()
    if scenario == "translate":
        run_job(world, root, pack)
    elif scenario == "restore":
        selected = BackupSet.find(world, argv[4], stores(root), external_files=[pack])
        selected.restore(recovery_store=stores(root)[0], lock_dir=root / "locks")
    elif scenario == "resume":
        run_job(world, root, pack, **checkpoint_runtime(root, resume=True))
    elif scenario == "recover":
        recover_job(Path(argv[4]), argv[5], authorized_external=[pack], lock_dir=root / "locks")
    else:
        raise SystemExit(f"unknown scenario {scenario}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
