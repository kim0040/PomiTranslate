"""Per-chunk DataVersion and coverage: what a scan saw, how it is reported, and the newer-version write gate."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from nbt import nbt  # noqa: E402

from mc_world_translator import WorldTranslator  # noqa: E402
from mwt import desktop_entry  # noqa: E402
from mwt.coverage import (  # noqa: E402
    MISSING,
    PROCESSED,
    SKIPPED_UNSUPPORTED,
    UNOBSERVED,
    ChunkCoverage,
    chunk_data_version,
    needs_newer_version_confirmation,
    public_summary,
)
from mwt.layout import region_dir_identity  # noqa: E402
from mwt.region import RegionFile, external_chunk_path  # noqa: E402
from mwt.support_matrix import NEWEST_COVERED_DATA_VERSION  # noqa: E402
from tests.test_release_fixtures import (  # noqa: E402
    compound,
    config_for,
    nbt_bytes,
    start_responder,
    string,
    write_region,
)

NEWER = NEWEST_COVERED_DATA_VERSION + 400


def chunk(version: int | None, text: str = "Hello sign") -> bytes:
    tags: list = [compound("sign", string("Text1", json.dumps({"text": text})))]
    if version is not None:
        tags.insert(0, nbt.TAG_Int(name="DataVersion", value=version))
    return nbt_bytes(*tags)


def write_level(world: Path, version: int = 4189) -> None:
    level = nbt.NBTFile()
    data = nbt.TAG_Compound(name="Data")
    data.tags.append(nbt.TAG_Int(name="DataVersion", value=version))
    level.tags.append(data)
    world.mkdir(parents=True, exist_ok=True)
    level.write_file(filename=str(world / "level.dat"))


def mixed_world(root: Path) -> Path:
    """Mixed versions, a chunk without DataVersion, a damaged chunk, an unknown compression and an entities file."""
    world = root / "mixed"
    write_level(world, 4189)
    write_region(
        world / "region" / "r.0.0.mca",
        {0: (2, chunk(4189), False), 1: (1, chunk(4556, "Front line"), False), 2: (3, chunk(None, "Back line"), False)},
    )
    damaged = RegionFile.read(world / "region" / "r.0.0.mca")
    damaged.put_raw_record(3, (6).to_bytes(4, "big") + bytes([2]) + b"\x01\x02\x03\x04\x05")
    data, _ = damaged.build()
    (world / "region" / "r.0.0.mca").write_bytes(data)
    unknown = RegionFile.empty()
    unknown.put_nbt(0, chunk(4189), compression=2)
    unknown.put_raw_record(1, (14).to_bytes(4, "big") + bytes([127]) + b"mystery-bytes")
    data, _ = unknown.build(allow_unsupported=True)
    (world / "region" / "r.1.0.mca").write_bytes(data)
    write_region(world / "entities" / "r.0.0.mca", {0: (2, chunk(4556), False)})
    write_region(world / "DIM-1" / "region" / "r.0.0.mca", {0: (2, chunk(4189), False)})
    return world


def scan_report(world: Path, tmp: Path, **scan_overrides) -> dict:
    config = config_for(world, tmp / "scan.json", "http://127.0.0.1:9", dry_run=True)
    config["scan"].update(scan_overrides)
    return WorldTranslator(config).run()


def totals(entries: list[dict], **match) -> int:
    return sum(item["count"] for item in entries if all(item[key] == value for key, value in match.items()))


def test_mixed_versions_and_unknown_compression(tmp: Path) -> None:
    world = mixed_world(tmp)
    report = scan_report(world, tmp)
    coverage = report["coverage"]
    assert coverage["level_data_version"] == 4189
    assert coverage["level_data_versions"] == [{"world": "mixed", "data_version": 4189}]
    assert coverage["newest_covered"] == NEWEST_COVERED_DATA_VERSION
    # processed: r.0.0 chunks 0-2, the readable chunk of r.1.0 (its file cannot be written, but it was searched),
    # entities and nether = 6. skipped: only the chunk with the unknown compression.
    assert coverage["counts"] == {
        "processed": 6, "skipped_unsupported": 1, "unreadable": 1, "not_inspected": 0, "total": 8,
    }
    versions = coverage["chunk_versions"]
    assert versions["min"] == 4189 and versions["max"] == 4556
    distribution = {(item["state"], item["data_version"]): item["count"] for item in versions["distribution"]}
    assert distribution == {("missing", None): 1, ("known", 4189): 3, ("known", 4556): 2}
    assert coverage["flags"] == {"mixed": True, "newer": False, "missing": True}
    groups = {(item["dimension"], item["kind"]): item for item in coverage["groups"]}
    assert set(groups) == {("overworld", "region"), ("overworld", "entities"), ("the_nether", "region")}
    overworld = groups[("overworld", "region")]
    assert overworld["counts"] == {"processed": 4, "skipped_unsupported": 1, "unreadable": 1, "not_inspected": 0}
    # The write blocker is a per-group file count of its own, not a chunk status.
    assert overworld["write_blocked_files"] == 1
    assert groups[("overworld", "entities")]["write_blocked_files"] == 0
    assert groups[("the_nether", "region")]["write_blocked_files"] == 0
    public_groups = {(item["dimension"], item["kind"]): item for item in public_summary(coverage)["groups"]}
    assert public_groups[("overworld", "region")]["writeBlockedFiles"] == 1
    assert public_groups[("overworld", "entities")]["writeBlockedFiles"] == 0
    assert overworld["min"] == 4189 and overworld["max"] == 4556
    entries = overworld["entries"]
    assert totals(entries, compression=127, status="skipped_unsupported", state="unobserved") == 1
    assert totals(entries, compression=2, status="processed", state="known", data_version=4189) == 2
    assert totals(entries, status="skipped_unsupported") == 1
    assert totals(entries, compression=1, status="processed", data_version=4556) == 1
    assert totals(entries, compression=3, status="processed", state="missing") == 1
    assert totals(entries, compression=2, status="unreadable") == 1
    assert groups[("overworld", "entities")]["max"] == 4556
    assert coverage["files"] == {"scanned": 4, "unreadable": 0, "not_inspected": 0, "detected_unsupported": {}}
    # The unknown compression keeps its whole file out of the candidates, as before.
    skipped = [item for item in report["changed_files"] if item.get("skipped") == "unsupported_compression"]
    assert len(skipped) == 1
    # The report file carries the same object.
    saved = json.loads((tmp / "scan.json").read_text(encoding="utf-8"))
    assert saved["coverage"] == coverage


def test_newer_chunks_are_flagged_and_oversize_distribution_is_bounded(tmp: Path) -> None:
    world = tmp / "newer"
    write_level(world, 4189)
    write_region(world / "region" / "r.0.0.mca", {0: (2, chunk(4189), False), 1: (2, chunk(NEWER), False)})
    flags = scan_report(world, tmp)["coverage"]["flags"]
    assert flags == {"mixed": True, "newer": True, "missing": False}

    # Counting never grows with the number of chunks: one file keeps a bounded number of keys.
    record = ChunkCoverage().file("region/r.0.0.mca", "overworld", "region")
    for index in range(1000):
        record.add("processed", compression=2, state="known", data_version=5000 + index)
    assert len(record.counts) <= 64
    assert sum(record.counts.values()) + sum(record.overflow.values()) == 1000
    assert (record.low, record.high) == (5000, 5999)


def test_level_version_alone_does_not_flag_chunks(tmp: Path) -> None:
    world = tmp / "level-newer"
    write_level(world, NEWER)
    write_region(world / "region" / "r.0.0.mca", {0: (2, chunk(4189), False)})
    coverage = scan_report(world, tmp)["coverage"]
    assert coverage["level_data_version"] == NEWER
    assert coverage["flags"] == {"mixed": False, "newer": False, "missing": False}


def test_skipped_scope_and_unreadable_files_are_counted(tmp: Path) -> None:
    world = tmp / "scope"
    write_level(world)
    write_region(world / "region" / "r.0.0.mca", {0: (2, chunk(4189), False)})
    write_region(world / "region" / "r.1.0.mca", {0: (2, chunk(4189), False), 5: (2, chunk(4189), False)})
    (world / "region" / "r.2.0.mca").write_bytes(b"\x00" * 8192 + b"")  # a header with no chunks
    coverage = scan_report(world, tmp, skip_patterns=["r.1.0.mca"])["coverage"]
    assert coverage["counts"]["not_inspected"] == 2 and coverage["counts"]["processed"] == 1
    assert coverage["files"]["not_inspected"] == 1 and coverage["files"]["scanned"] == 2
    # Chunks that were not opened say nothing about their version.
    assert coverage["chunk_versions"]["distribution"] == [{"data_version": 4189, "state": "known", "count": 1}]


def test_unsupported_containers_are_counted_by_file(tmp: Path) -> None:
    world = tmp / "linear"
    write_level(world)
    write_region(world / "region" / "r.0.0.mca", {0: (2, chunk(4189), False)})
    (world / "region" / "r.0.0.linear").write_bytes(b"linear")
    (world / "region" / "r.1.0.linear").write_bytes(b"linear")
    (world / "region" / "r.0.0.mcr").write_bytes(b"mcr")
    report = scan_report(world, tmp)
    assert report["status"] == "unsupported"
    assert report["coverage"]["files"]["detected_unsupported"] == {"mcr": 1, "linear": 2}
    assert report["coverage"]["counts"]["total"] == 0


def test_external_chunk_counts_its_own_compression(tmp: Path) -> None:
    world = tmp / "external"
    write_level(world)
    path = world / "region" / "r.0.0.mca"
    write_region(path, {0: (2, chunk(4189), True)})
    assert external_chunk_path(path, 0).is_file()
    coverage = scan_report(world, tmp)["coverage"]
    assert coverage["counts"]["processed"] == 1


def test_rescanning_a_file_replaces_its_counts_and_checkpoint_round_trips(tmp: Path) -> None:
    world = mixed_world(tmp)
    config = config_for(world, tmp / "scan.json", "http://127.0.0.1:9", dry_run=True)
    translator = WorldTranslator(config)
    path = world / "region" / "r.0.0.mca"
    translator.collect_region_file(path)
    once = translator.coverage_summary()["counts"]
    translator.collect_region_file(path)
    assert translator.coverage_summary()["counts"] == once

    exported = json.loads(json.dumps(translator.coverage.export()))
    restored = ChunkCoverage()
    assert restored.restore(exported)
    assert restored.summary() == translator.coverage.summary()
    # A malformed or missing record is refused whole, and nothing is taken from it.
    broken = json.loads(json.dumps(exported))
    next(iter(broken["files"].values()))["counts"] = [["known", 1, 2, "nonsense", 3]]
    empty = ChunkCoverage()
    assert not empty.restore(broken) and not empty.files
    assert not empty.restore(None) and not empty.restore({"files": []})


def write_overflow_region(path: Path, records: dict[int, tuple[str, int | None]]) -> None:
    """A region file with readable chunks (``("chunk", version)``) and unknown-compression records (``("raw", id)``)."""
    region = RegionFile.empty()
    for index, (kind, value) in records.items():
        if kind == "chunk":
            region.put_nbt(index, chunk(value), compression=2)
        else:
            region.put_raw_record(index, (14).to_bytes(4, "big") + bytes([value]) + b"mystery-bytes")
    data, _ = region.build(allow_unsupported=True)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def test_overflow_keeps_flags_and_ranges_exact(tmp: Path) -> None:
    # A file that meets more distinct keys than it keeps: the surplus is overflow, and the facts stay exact.
    record = ChunkCoverage().file("region/r.0.0.mca", "overworld", "region")
    for index in range(64):
        record.add("processed", compression=2, state="known", data_version=4000 + index)
    record.add("processed", compression=2, state="missing")
    record.add("processed", compression=2, state="known", data_version=5000)
    assert len(record.counts) == 64 and record.overflow == {"processed": 2}
    assert record.saw_missing and (record.low, record.high) == (4000, 5000)

    # Real region 1: 4000 first, 63 unknown compressions fill the keys, then 5000 is read.
    world = tmp / "mixed-world"
    write_level(world)
    records: dict[int, tuple[str, int | None]] = {0: ("chunk", 4000), 64: ("chunk", 5000)}
    records.update({index: ("raw", 4 + index) for index in range(1, 64)})  # compression ids 5..67
    write_overflow_region(world / "region" / "r.0.0.mca", records)
    coverage = scan_report(world, tmp / "mixed-scan")["coverage"]
    assert coverage["flags"] == {"mixed": True, "newer": True, "missing": False}
    versions = coverage["chunk_versions"]
    assert (versions["min"], versions["max"]) == (4000, 5000)
    assert versions["truncated"] is True and versions["overflow"] == 1
    assert [(item["data_version"], item["count"]) for item in versions["distribution"]] == [(4000, 1)]
    group = coverage["groups"][0]
    assert (group["min"], group["max"]) == (4000, 5000)
    assert group["overflow"] == 1 and group["write_blocked_files"] == 1
    # What the scan read is processed; only the unknown compressions were skipped. Nothing becomes "unobserved".
    assert coverage["counts"] == {
        "processed": 2, "skipped_unsupported": 63, "unreadable": 0, "not_inspected": 0, "total": 65,
    }
    assert totals(group["entries"], state="overflow", status="processed") == 1
    assert totals(group["entries"], state="unobserved", status="processed") == 0

    # Real region 2: 64 known versions fill the keys, the chunk without a DataVersion comes last.
    world = tmp / "missing-world"
    write_level(world)
    write_region(
        world / "region" / "r.0.0.mca",
        {**{index: (2, chunk(4000 + index), False) for index in range(64)}, 64: (2, chunk(None), False)},
    )
    coverage = scan_report(world, tmp / "missing-scan")["coverage"]
    assert coverage["flags"] == {"mixed": True, "newer": False, "missing": True}
    versions = coverage["chunk_versions"]
    assert versions["truncated"] is True and versions["overflow"] == 1
    assert sum(item["count"] for item in versions["distribution"]) == 64
    assert coverage["counts"]["processed"] == 65 and coverage["counts"]["total"] == 65
    assert (versions["min"], versions["max"]) == (4000, 4063)
    public = public_summary(coverage)
    assert public["chunkVersions"]["truncated"] is True and public["chunkVersions"]["overflow"] == 1
    assert public["groups"][0]["overflow"] == 1
    assert any(item["state"] == "overflow" for item in public["groups"][0]["entries"])

    # A complete file never says it is truncated.
    plain = ChunkCoverage()
    plain.file("region/r.0.0.mca", "overworld", "region").add("processed", compression=2, state="known", data_version=4189)
    shown = plain.summary()
    assert "truncated" not in shown["chunk_versions"] and "overflow" not in shown["groups"][0]
    assert "truncated" not in public_summary(shown)["chunkVersions"]

    # The checkpoint keeps the overflow, the exact flags and the write blocker, and reads back the same summary.
    translator = WorldTranslator(config_for(world, tmp / "rt.json", "http://127.0.0.1:9", dry_run=True))
    translator.run()
    exported = json.loads(json.dumps(translator.coverage.export()))
    restored = ChunkCoverage()
    assert restored.restore(exported)
    assert restored.summary() == translator.coverage.summary()
    assert restored.summary()["flags"]["missing"] is True
    # Every stored key still uses a state an earlier reader accepts; the overflow lives in its own field.
    for item in exported["files"].values():
        assert all(entry[0] in ("known", "missing", "unobserved") for entry in item["counts"])
    # A checkpoint written before these fields existed is still read, and what it held keeps its meaning.
    old = json.loads(json.dumps(exported))
    for item in old["files"].values():
        for name in ("overflow_by_status", "saw_missing", "write_blocked"):
            item.pop(name, None)
    legacy = ChunkCoverage()
    assert legacy.restore(old)
    assert legacy.summary()["flags"]["missing"] is False  # that chunk had overflowed: an old file cannot say
    small = ChunkCoverage()
    small.file("region/r.0.0.mca", "overworld", "region").add("processed", compression=2, state="missing")
    old_small = json.loads(json.dumps(small.export()))
    for item in old_small["files"].values():
        for name in ("overflow_by_status", "saw_missing", "write_blocked"):
            item.pop(name, None)
    legacy = ChunkCoverage()
    assert legacy.restore(old_small) and legacy.summary()["flags"]["missing"] is True
    broken = json.loads(json.dumps(exported))
    next(iter(broken["files"].values()))["overflow_by_status"] = {"nonsense": 1}
    assert not ChunkCoverage().restore(broken)


def earlier_reader() -> types.ModuleType:
    """mwt/coverage.py as 9add4d8 had it: it knows only ``counts``, folds an overflow into the unobserved key."""
    source = subprocess.check_output(["git", "show", "9add4d8:mwt/coverage.py"], cwd=ROOT).decode("utf-8")
    module = types.ModuleType("earlier_coverage")
    sys.modules[module.__name__] = module
    exec(compile(source, "9add4d8:mwt/coverage.py", "exec"), module.__dict__)
    return module


def test_checkpoint_counts_survive_an_earlier_reader() -> None:
    """New writer -> earlier reader -> new reader: the totals stay, and the new reader never double counts."""
    earlier = earlier_reader()
    current = ChunkCoverage()
    record = current.file("region/r.0.0.mca", "overworld", "region")
    for index in range(64):
        record.add(PROCESSED, compression=2, state="known", data_version=4000 + index)
    record.add(PROCESSED, compression=2, state=MISSING, count=5)  # no room left: overflow
    record.add(SKIPPED_UNSUPPORTED, compression=99, state="known", data_version=4005, count=2)
    record.add(PROCESSED, compression=2, state=UNOBSERVED, count=3)  # overflow too, beside the folded key of its status
    other = current.file("entities/r.0.0.mca", "overworld", "entities")
    other.add(PROCESSED, compression=2, state="known", data_version=4100, count=4)
    current.partial = True
    summary = current.summary()
    assert summary["counts"]["processed"] == 64 + 5 + 3 + 4 and summary["counts"]["skipped_unsupported"] == 2
    assert summary["counts"]["total"] == 78
    exported = json.loads(json.dumps(current.export()))

    # The new reader takes its own export back unchanged: the folded row is not a second observation.
    restored = ChunkCoverage()
    assert restored.restore(exported)
    assert restored.summary() == summary
    assert restored.files["region/r.0.0.mca"].overflow == {PROCESSED: 8, SKIPPED_UNSUPPORTED: 2}
    assert json.loads(json.dumps(restored.export())) == exported

    # The earlier reader accepts it and counts every chunk, with the overflow in the unobserved row as it always did.
    reader = earlier.ChunkCoverage()
    assert reader.restore(exported)
    seen = reader.summary()
    assert seen["counts"]["total"] == 78 and seen["counts"]["processed"] == 76 and seen["counts"]["skipped_unsupported"] == 2
    assert seen["flags"]["newer"] == summary["flags"]["newer"]

    # What the earlier reader writes back still holds every chunk when the new reader loads it again.
    again = ChunkCoverage()
    assert again.restore(json.loads(json.dumps(reader.export())))
    assert again.summary()["counts"] == summary["counts"]
    # (The earlier reader does not carry the additive partial marker; that is its format, not a count.)

    # A folded row that is larger than the counts it should sit in is not a checkpoint this reader wrote.
    broken = json.loads(json.dumps(exported))
    item = broken["files"]["region/r.0.0.mca"]
    item["counts"] = [entry for entry in item["counts"] if entry[0] != "unobserved"]
    assert not ChunkCoverage().restore(broken)
    # Without the marker (a record from before the fold existed) nothing is taken out of the counts.
    unmarked = json.loads(json.dumps(exported))
    unmarked["files"]["region/r.0.0.mca"].pop("overflow_folded")
    assert ChunkCoverage().restore(unmarked)


def test_readable_chunks_of_a_locked_file_are_processed(tmp: Path) -> None:
    world = tmp / "locked-world"
    write_level(world)
    path = world / "region" / "r.0.0.mca"
    write_region(path, {0: (2, chunk(4189, "Actually searched"), False)})
    region = RegionFile.read(path)
    region.put_raw_record(1, (14).to_bytes(4, "big") + bytes([127]) + b"mystery-bytes")
    data, _ = region.build(allow_unsupported=True)
    path.write_bytes(data)
    before = path.read_bytes()
    report = scan_report(world, tmp / "locked-scan")
    coverage = report["coverage"]
    # The readable chunk was read and searched; only the unknown compression was not.
    assert coverage["counts"]["processed"] == 1 and coverage["counts"]["skipped_unsupported"] == 1
    group = coverage["groups"][0]
    assert group["write_blocked_files"] == 1
    assert totals(group["entries"], compression=127, status="skipped_unsupported") == 1
    assert totals(group["entries"], compression=2, status="processed") == 1
    # The write blocker itself is unchanged: the file is not a candidate and nothing is written.
    changed = [item for item in report["changed_files"] if item.get("skipped") == "unsupported_compression"]
    assert len(changed) == 1 and changed[0]["unique_texts"] == 1
    assert any(item.get("code") == "file_unwritable" for item in report["warnings"])
    assert report["candidate_text_count"] == 0
    assert path.read_bytes() == before
    assert public_summary(coverage)["groups"][0]["writeBlockedFiles"] == 1


def test_partial_marker_survives_repeated_resumes_of_an_old_checkpoint(tmp: Path) -> None:
    world = mixed_world(tmp)
    report = tmp / "resume.json"
    config = config_for(world, report, "http://127.0.0.1:9", dry_run=True)
    config["runtime"].update(checkpoint_enabled=True, resume_from_checkpoint=True)
    checkpoint = Path(config["runtime"]["checkpoint_path"])
    first = WorldTranslator(config)
    first.collect_region_file(world / "region" / "r.0.0.mca")
    first.completed_region_files.add(str(world / "region" / "r.0.0.mca"))
    payload = first.checkpoint_payload()
    payload.pop("chunk_coverage")  # a checkpoint from before chunk coverage existed
    checkpoint.write_text(json.dumps(payload), encoding="utf-8")

    for _round in range(2):  # resume, checkpoint again, resume again
        resumed = WorldTranslator(config)
        assert resumed.checkpoint_loaded and resumed.coverage.partial
        assert resumed.coverage_summary()["partial"] is True
        resumed.save_checkpoint()
        stored = json.loads(checkpoint.read_text(encoding="utf-8"))
        assert stored["chunk_coverage"]["partial"] is True
        assert public_summary(resumed.coverage_summary())["partial"] is True

    # A coverage that never was partial does not become partial, and a checkpoint without the marker reads as before.
    clean = ChunkCoverage()
    assert "partial" not in clean.export()
    restored = ChunkCoverage()
    assert restored.restore({"version": 1, "files": {}}) and not restored.partial


def test_damaged_level_dat_does_not_stop_the_scan(tmp: Path) -> None:
    world = tmp / "damaged-level"
    world.mkdir(parents=True)
    (world / "level.dat").write_bytes(bytes([0x1F, 0x8B]) + b"not a gzip stream")
    write_region(world / "region" / "r.0.0.mca", {0: (2, chunk(4189), False)})
    report = scan_report(world, tmp)
    assert report["status"] == "completed"
    assert report["coverage"]["level_data_version"] is None
    assert report["coverage"]["level_data_versions"] == [{"world": "damaged-level", "data_version": None}]
    assert report["coverage"]["counts"]["processed"] == 1


def test_helpers() -> None:
    assert region_dir_identity("region") == ("overworld", "region")
    assert region_dir_identity("entities") == ("overworld", "entities")
    assert region_dir_identity("DIM-1/region") == ("the_nether", "region")
    assert region_dir_identity("DIM1/entities") == ("the_end", "entities")
    assert region_dir_identity("dimensions/mod/deep/region") == ("mod:deep", "region")
    assert region_dir_identity("world_a/DIM-1/region") == ("world_a/the_nether", "region")
    assert region_dir_identity("world_a/region") == ("world_a/overworld", "region")
    root = nbt.TAG_Compound()
    assert chunk_data_version(root) == ("missing", None)
    assert needs_newer_version_confirmation(None) is False
    assert needs_newer_version_confirmation({}) is False
    assert needs_newer_version_confirmation({"flags": {"newer": False}}) is False
    assert needs_newer_version_confirmation({"flags": {"newer": True}}) is True
    assert needs_newer_version_confirmation({"flags": {"newer": "yes"}}) is False
    public = public_summary(ChunkCoverage().summary([{"world": "w", "data_version": 5}]))
    assert public["levelDataVersion"] == 5 and public["files"]["notInspected"] == 0
    assert public["flags"] == {"mixed": False, "newer": False, "missing": False}


# --- desktop messages -----------------------------------------------------------------------------------


def send(kind: str, payload: dict, data_dir: Path) -> dict:
    replies: list[dict] = []
    previous = desktop_entry.emit
    desktop_entry.emit = replies.append
    try:
        desktop_entry.handle(
            {"v": 1, "id": kind, "type": kind, "payload": payload},
            report_dir=data_dir / "reports",
            data_dir=data_dir,
        )
    finally:
        desktop_entry.emit = previous
    final = [item for item in replies if item["type"].startswith("response.")]
    assert final, replies
    return final[-1]


def test_translate_start_needs_confirmation_for_newer_chunks(tmp: Path, base_url: str) -> None:
    world = tmp / "newer-world"
    write_level(world, NEWER)
    region = world / "region" / "r.0.0.mca"
    write_region(region, {0: (2, chunk(4189), False), 1: (2, chunk(NEWER, "Front line"), False)})
    data_dir = tmp / "userdata"
    environment = {"POMI_API_KEY": "test-key", "POMI_API_BASE": base_url, "POMI_MODEL": "fixture"}
    previous = {key: os.environ.get(key) for key in environment}
    os.environ.update(environment)
    try:
        scan = send("scan.start", {"worldDir": str(world)}, data_dir)
        assert scan["type"] == "response.ok"
        payload = scan["payload"]
        assert payload["chunkCoverage"]["flags"] == {"mixed": True, "newer": True, "missing": False}
        assert payload["chunkCoverage"]["levelDataVersion"] == NEWER
        assert payload["chunkCoverage"]["counts"]["processed"] == 2
        # The older list of what the scan was set to read is still there and still a list.
        assert isinstance(payload["coverage"], list)
        plan = json.loads((data_dir / "scans" / f"{payload['scanPlanId']}.json").read_text(encoding="utf-8"))
        assert plan["chunkCoverage"]["flags"]["newer"] is True

        before = region.read_bytes()
        request = {"worldDir": str(world), "fingerprint": payload["fingerprint"], "scanPlanId": payload["scanPlanId"]}
        refused = send("translate.start", request, data_dir)
        assert refused["type"] == "response.error"
        assert refused["error"]["code"] == "NEWER_VERSION_UNCONFIRMED" and refused["error"]["recoverable"] is True
        for wrong in (False, "true", 1, None):
            again = send("translate.start", {**request, "acceptNewerVersion": wrong}, data_dir)
            assert again["type"] == "response.error" and again["error"]["code"] == "NEWER_VERSION_UNCONFIRMED"
        resumed = send("translate.resume", request, data_dir)
        assert resumed["type"] == "response.error"  # nothing to resume, and never a silent start
        assert region.read_bytes() == before, "a refused start must not touch the world"
        assert not (data_dir / "backups").exists() or not any((data_dir / "backups").rglob("*.json"))

        # Other refusals still come first: a stale plan is reported as stale, not as unconfirmed.
        stale = send("translate.start", {**request, "fingerprint": "0" * 64}, data_dir)
        assert stale["error"]["code"] == "PLAN_INVALIDATED"

        accepted = send("translate.start", {**request, "acceptNewerVersion": True}, data_dir)
        assert accepted["type"] == "response.ok", accepted
        assert accepted["payload"]["status"] == "completed"
        assert region.read_bytes() != before
        assert accepted["payload"]["backupSetId"]
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_confirmation_is_not_asked_for_covered_versions_or_old_plans(tmp: Path, base_url: str) -> None:
    world = tmp / "covered"
    write_level(world, 4189)
    write_region(world / "region" / "r.0.0.mca", {0: (2, chunk(4189), False)})
    data_dir = tmp / "userdata"
    environment = {"POMI_API_KEY": "test-key", "POMI_API_BASE": base_url, "POMI_MODEL": "fixture"}
    previous = {key: os.environ.get(key) for key in environment}
    os.environ.update(environment)
    try:
        scan = send("scan.start", {"worldDir": str(world)}, data_dir)["payload"]
        assert scan["chunkCoverage"]["flags"]["newer"] is False
        plan_path = data_dir / "scans" / f"{scan['scanPlanId']}.json"
        # An old plan has no coverage field at all; that never asks and never fails.
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        plan.pop("chunkCoverage")
        plan_path.write_text(json.dumps(plan), encoding="utf-8")
        done = send(
            "translate.start",
            {"worldDir": str(world), "fingerprint": scan["fingerprint"], "scanPlanId": scan["scanPlanId"]},
            data_dir,
        )
        assert done["type"] == "response.ok" and done["payload"]["status"] == "completed", done
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_old_report_without_coverage_still_scans(tmp: Path) -> None:
    """A report from before chunk coverage (or from a stubbed core) has no ``coverage``; nothing breaks."""
    data_dir = tmp / "userdata"
    world = tmp / "old"
    write_level(world)
    write_region(world / "region" / "r.0.0.mca", {0: (2, chunk(4189), False)})
    old_report = {
        "status": "completed", "candidate_text_count": 0, "world_fingerprint": "f" * 64,
        "changed_files": [], "errors": [], "warnings": [], "_candidate_records": [], "candidate_preview": [],
    }
    previous = desktop_entry._run_translator
    desktop_entry._run_translator = lambda *_args, **_kwargs: dict(old_report)
    try:
        reply = send("scan.start", {"worldDir": str(world)}, data_dir)
    finally:
        desktop_entry._run_translator = previous
    assert reply["type"] == "response.ok"
    assert "chunkCoverage" not in reply["payload"]
    plan = json.loads((data_dir / "scans" / f"{reply['payload']['scanPlanId']}.json").read_text(encoding="utf-8"))
    assert "chunkCoverage" not in plan
    assert needs_newer_version_confirmation(plan.get("chunkCoverage")) is False


def main() -> None:
    server, base_url = start_responder()
    try:
        with tempfile.TemporaryDirectory(prefix="pomi-chunk-coverage-") as temporary:
            root = Path(temporary)
            test_mixed_versions_and_unknown_compression(root / "a")
            test_newer_chunks_are_flagged_and_oversize_distribution_is_bounded(root / "b")
            test_level_version_alone_does_not_flag_chunks(root / "c")
            test_skipped_scope_and_unreadable_files_are_counted(root / "d")
            test_unsupported_containers_are_counted_by_file(root / "e")
            test_external_chunk_counts_its_own_compression(root / "f")
            test_rescanning_a_file_replaces_its_counts_and_checkpoint_round_trips(root / "g")
            test_overflow_keeps_flags_and_ranges_exact(root / "l")
            test_checkpoint_counts_survive_an_earlier_reader()
            test_readable_chunks_of_a_locked_file_are_processed(root / "m")
            test_partial_marker_survives_repeated_resumes_of_an_old_checkpoint(root / "n")
            test_damaged_level_dat_does_not_stop_the_scan(root / "k")
            test_helpers()
            test_translate_start_needs_confirmation_for_newer_chunks(root / "h", base_url)
            test_confirmation_is_not_asked_for_covered_versions_or_old_plans(root / "i", base_url)
            test_old_report_without_coverage_still_scans(root / "j")
    finally:
        server.shutdown()
    print("PASS chunk coverage counts, flags, newer-version confirmation, old report shape")


if __name__ == "__main__":
    main()
