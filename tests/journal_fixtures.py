"""Shared synthetic worlds and fault injection for the journal and recovery tests (not a test)."""
from __future__ import annotations

import hashlib
import json
import sys
import threading
import zipfile
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from mc_world_translator import DEFAULT_CONFIG, WorldTranslator, merge_nested  # noqa: E402
from mwt import journal  # noqa: E402
from mwt.region import SECTOR, RegionFile  # noqa: E402
from mwt.safety import world_fingerprint  # noqa: E402
from test_release_fixtures import compound, nbt_bytes, string, write_region  # noqa: E402

LONG = "Translated " + "x" * 100

OVERRIDES = {
    "Hello sign": LONG,  # too big for its slot: the translated chunk moves to a new .mcc
    "Second region": "Segunda region",
    "Existing mcc": "Mcc existente",
    "Welcome traveler": "Bienvenido viajero",
    "Open the shop door": "Abre la puerta de la tienda",
}


class SimulatedCrash(BaseException):
    """Stands in for a power cut or a kill: nothing in the code under test may catch it."""


def sign(text: str) -> bytes:
    return nbt_bytes(compound("sign", string("Text1", '{"text":"%s"}' % text)))


def _padded_sign(text: str) -> bytes:
    """A sign whose chunk fills its 255-sector slot completely, so a longer text must go to a .mcc."""
    raw = sign(text)
    name = b"Padding"
    overhead = 1 + 2 + len(name) + 4
    count = 255 * SECTOR - 5 - len(raw) - overhead
    raw = raw[:-1] + b"\x07" + len(name).to_bytes(2, "big") + name + count.to_bytes(4, "big") + bytes(count) + raw[-1:]
    assert len(raw) + 5 == 255 * SECTOR
    return raw


def _zip(path: Path, members: dict[str, bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as archive:
        for name, body in members.items():
            archive.writestr(name, body)


def build_world(root: Path, *, external: bool = True, name: str = "world") -> tuple[Path, Path | None]:
    """A world with: a region that gains a new .mcc, a plain region, a region with an existing
    .mcc, an in-world resources.zip and (optionally) a separate external pack ZIP."""
    world = root / name
    world.mkdir(parents=True)
    (world / "level.dat").write_bytes(b"\x1f\x8b")
    write_region(world / "region" / "r.0.0.mca", {0: (3, _padded_sign("Hello sign"), False)})
    write_region(world / "region" / "r.1.0.mca", {0: (2, sign("Second region"), False)})
    write_region(world / "region" / "r.2.0.mca", {0: (2, sign("Existing mcc"), True)})
    assert RegionFile.read(world / "region" / "r.2.0.mca").chunks[0].external
    _zip(world / "resources.zip", {"assets/demo/lang/en_us.json": json.dumps({"pack.a": "Welcome traveler"}).encode()})
    pack = None
    if external:
        pack = root / "packs" / f"shared-{name}.zip"
        _zip(pack, {"assets/demo/lang/en_us.json": json.dumps({"pack.b": "Open the shop door"}).encode()})
    return world, pack


def config_for(world: Path, root: Path, pack: Path | None, *, data_dir: Path | None = None, **runtime) -> dict:
    zips = [str(world / "resources.zip")] + ([str(pack)] if pack else [])
    return merge_nested(DEFAULT_CONFIG, {
        "world_dir": str(world), "dry_run": False, "inherit_translate_py": False,
        "report_path": str(root / f"{world.name}-report.json"), "backup": True,
        "api": {"provider": "openai", "api_key": "unused", "model": "manual-only"},
        "scan": {"overrides": dict(OVERRIDES)},
        "resource_pack": {"enabled": True, "zip_paths": zips},
        "runtime": {
            "checkpoint_enabled": False, "backup_store": str(root / "backups" / world.name),
            "data_dir": str(data_dir or root / "appdata"),
            "authorized_external_pack_paths": [str(pack)] if pack else [],
            "skip_provider_validation": True, "expected_world_fingerprint": world_fingerprint(world),
            "max_file_write_retries": 1, **runtime,
        },
    })


def run_job(world: Path, root: Path, pack: Path | None, **runtime) -> dict:
    return WorldTranslator(config_for(world, root, pack, **runtime)).run()


def snapshot(world: Path, pack: Path | None = None) -> dict[str, str]:
    """SHA-256 of every file a job may touch (the lock bookkeeping and the game's session.lock aside)."""
    result: dict[str, str] = {}
    for path in sorted(world.rglob("*")):
        relative = path.relative_to(world)
        if path.is_file() and ".pomi-translate" not in relative.parts and path.name != "session.lock":
            result[relative.as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    if pack is not None and pack.is_file():
        result[f"external:{pack.name}"] = hashlib.sha256(pack.read_bytes()).hexdigest()
    return result


def leftovers(world: Path, pack: Path | None = None) -> list[str]:
    """Temporary files a failed write must never leave behind."""
    folders = [world] + ([pack.parent] if pack else [])
    return sorted(
        str(path) for folder in folders for path in folder.rglob("*")
        if path.is_file() and path.name.endswith(".tmp") and ".pomi-translate" not in path.parts
    )


def world_is_readable(world: Path) -> None:
    """A world the game can open: every region parses, every chunk it holds decompresses with its own
    compression (an external chunk from its ``.mcc``) and is valid NBT, and no ``.mcc`` is orphaned."""
    from mwt import nbtio
    from mwt.region import external_chunk_path

    referenced: set[Path] = set()
    for path in sorted((world / "region").glob("*.mca")):
        region = RegionFile.read(path)
        assert not region.layout_unsafe, path
        for chunk in region.chunks:
            if chunk.empty:
                continue
            assert not chunk.malformed, f"{path.name}[{chunk.index}]: a region points at a missing, empty or undecodable chunk"
            assert not chunk.unsupported and chunk.raw_nbt is not None, f"{path.name}[{chunk.index}]: not decodable"
            nbtio.parse(chunk.raw_nbt)  # raises on anything that is not NBT
            if chunk.external:
                referenced.add(external_chunk_path(path, chunk.index))
    for mcc in (world / "region").glob("c.*.mcc"):
        assert mcc in referenced, f"{mcc.name} is not referenced by any region"


def partial_job(world: Path, root: Path, pack: Path | None) -> dict:
    """A translation cancelled after its first written file: a consistent ``partial`` job with a checkpoint."""
    cancelled = {"now": False}

    def progress(event: dict) -> None:
        if event.get("event") == "file_done" and event.get("phase") == "write":
            cancelled["now"] = True

    report = WorldTranslator(config_for(world, root, pack, **checkpoint_runtime(root)),
                             progress_callback=progress, cancel_check=lambda: cancelled["now"]).run()
    assert report["status"] == "cancelled", report["status"]
    return report


def checkpoint_runtime(root: Path, *, resume: bool = False) -> dict:
    return dict(checkpoint_enabled=True, checkpoint_path=str(root / "job.checkpoint.json"), scan_plan_id="a" * 64,
                **({"resume_from_checkpoint": True} if resume else {}))


def journal_files(root: Path) -> list[Path]:
    return sorted((root / "backups").glob("*/*/journal.json"))


def stores(root: Path) -> list[Path]:
    return sorted(path for path in (root / "backups").glob("*") if path.is_dir())


# ---------------------------------------------------------------- fault injection

class Crash:
    """Raise ``SimulatedCrash`` at the ``nth`` time the named boundary is reached."""

    def __init__(self, point: str, nth: int = 1, kind: str | None = None, thread: str | None = None) -> None:
        self.point, self.nth, self.kind, self.thread = point, nth, kind, thread
        self.seen = 0
        self.fired = False

    def __call__(self, name: str, detail: dict) -> None:
        if name != self.point or (self.kind is not None and detail.get("kind") != self.kind):
            return
        if self.thread is not None and threading.current_thread().name != self.thread:
            return
        self.seen += 1
        if self.seen == self.nth:
            self.fired = True
            raise SimulatedCrash(f"{name}#{self.nth}")


class Census:
    """Count how often each boundary is reached, so a matrix can visit every occurrence."""

    def __init__(self) -> None:
        self.counts: dict[tuple[str, str | None], int] = {}

    def __call__(self, name: str, detail: dict) -> None:
        key = (name, detail.get("kind"))
        self.counts[key] = self.counts.get(key, 0) + 1


@contextmanager
def hook(callback):
    previous = journal.set_fault_hook(callback)
    try:
        yield callback
    finally:
        journal.set_fault_hook(previous)


def crash_job(world: Path, root: Path, pack: Path | None, crash: Crash, **runtime) -> None:
    """Run a translation until the crash fires. The caller checks that it did."""
    with hook(crash):
        try:
            run_job(world, root, pack, **runtime)
        except SimulatedCrash:
            pass
    assert crash.fired, f"{crash.point}#{crash.nth} was never reached"
