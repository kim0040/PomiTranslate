"""Core integrity: region slots, ZIP members, restore guards, absence, partial runs and resume."""
from __future__ import annotations

import json
import struct
import sys
import tempfile
import warnings
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import mc_world_translator as core  # noqa: E402
from mc_world_translator import DEFAULT_CONFIG, WorldTranslator, merge_nested  # noqa: E402
from mwt import desktop_entry  # noqa: E402
from mwt.locking import MinecraftWorldInUse, WorldWriteLock, WorldWriteLocked  # noqa: E402
from mwt.region import SECTOR, RegionFile, RegionLayoutUnsafe, decompress_payload, ChunkTooLarge  # noqa: E402
from mwt.safety import BackupSet  # noqa: E402
from test_desktop_parity import _files_under as _all_files, _request, _settings_set, _synthetic_world  # noqa: E402
from test_release_fixtures import compound, nbt_bytes, string, write_region  # noqa: E402


def _files_under(root: Path) -> dict[str, bytes]:
    """World files without the game's session.lock, which a holder keeps unreadable on Windows."""
    return {name: body for name, body in _all_files_safe(root).items()}


def _all_files_safe(root: Path) -> dict[str, bytes]:
    result = {}
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if path.is_file() and path.name != "session.lock" and ".pomi-translate" not in relative.parts:
            result[relative.as_posix()] = path.read_bytes()
    return result


def sign(text: str) -> bytes:
    return nbt_bytes(compound("sign", string("Text1", '{"text":"%s"}' % text)))


def translator_for(world: Path, root: Path, translations: dict[str, str], **runtime) -> WorldTranslator:
    translator = WorldTranslator(merge_nested(DEFAULT_CONFIG, {
        "world_dir": str(world), "dry_run": False, "inherit_translate_py": False,
        "report_path": str(root / "report.json"),
        "runtime": {"backup_store": str(root / "backups"), "checkpoint_enabled": False, **runtime},
    }))
    translator.final_translations = dict(translations)
    return translator


def slot_of(data: bytes, index: int) -> tuple[int, int]:
    offset = int.from_bytes(data[index * 4 : index * 4 + 3], "big")
    return offset, data[index * 4 + 3]


def region_with_odd_slots(path: Path, *, extra: str) -> tuple[bytes, bytes]:
    """A region with a translatable chunk 0 and an odd slot for chunk 1 right after it.

    Returns the bytes the odd slot has on disk and the whole region.
    """
    write_region(path, {0: (2, sign("Hello sign"), False)})
    data = bytearray(path.read_bytes())
    first, count = slot_of(data, 0)
    odd_offset = first + count
    if extra == "zero-two-sectors":
        odd = bytes(2 * SECTOR)  # length 0: not a chunk, but two sectors someone declared
        data[4:8] = odd_offset.to_bytes(3, "big") + bytes([2])
    elif extra == "overlong-length":
        # The length field claims far more bytes than the one-sector slot holds.
        odd = struct.pack(">IB", 9_000_000, 2) + bytes(range(251)) * 16
        odd = odd[:SECTOR].ljust(SECTOR, b"")
        data[4:8] = odd_offset.to_bytes(3, "big") + bytes([1])
    else:
        raise AssertionError(extra)
    data.extend(odd)
    path.write_bytes(bytes(data))
    return odd, bytes(data)


def test_malformed_slots_are_copied_untouched(root: Path) -> None:
    for kind in ("zero-two-sectors", "overlong-length"):
        base = root / kind
        world = base / "world"
        path = world / "region" / "r.0.0.mca"
        odd, _ = region_with_odd_slots(path, extra=kind)
        region = RegionFile.read(path)
        assert region.chunks[1].malformed and not region.layout_unsafe
        writer = translator_for(world, base, {"Hello sign": "Hola " + "x" * 50})
        result = writer.apply_region_file(path)
        assert result["changed_chunks"] == 1, result
        after = path.read_bytes()
        offset, count = slot_of(after, 1)
        assert count == len(odd) // SECTOR, "the slot keeps its declared size"
        assert after[offset * SECTOR : (offset + count) * SECTOR] == odd, "the odd slot is byte-identical"
        assert b"Hola" in RegionFile.read(path).chunks[0].raw_nbt
        # The malformed chunk is still reported, not silently dropped.
        assert RegionFile.read(path).chunks[1].malformed


def test_unsafe_layout_is_refused_and_unchanged(root: Path) -> None:
    cases = {}
    # A slot past the end of the file.
    path = root / "beyond" / "world" / "region" / "r.0.0.mca"
    write_region(path, {0: (2, sign("Hello sign"), False)})
    data = bytearray(path.read_bytes())
    data[8:12] = (900).to_bytes(3, "big") + bytes([1])
    path.write_bytes(bytes(data))
    cases["beyond"] = path
    # Two chunks claiming the same sectors.
    path = root / "overlap" / "world" / "region" / "r.0.0.mca"
    write_region(path, {0: (2, sign("Hello sign"), False)})
    data = bytearray(path.read_bytes())
    data[4:8] = data[0:4]
    path.write_bytes(bytes(data))
    cases["overlap"] = path
    # A slot inside the two header sectors.
    path = root / "header" / "world" / "region" / "r.0.0.mca"
    write_region(path, {0: (2, sign("Hello sign"), False)})
    data = bytearray(path.read_bytes())
    data[4:8] = (1).to_bytes(3, "big") + bytes([1])
    path.write_bytes(bytes(data))
    cases["header"] = path
    for name, path in cases.items():
        original = path.read_bytes()
        assert RegionFile.read(path).layout_unsafe, name
        world = path.parent.parent
        writer = translator_for(world, root / name, {"Hello sign": "Hola"})
        result = writer.apply_region_file(path)
        assert result["changed_chunks"] == 0 and result["skipped"] == "region_layout_unsafe", (name, result)
        assert path.read_bytes() == original, name
        assert not (root / name / "backups").exists() or not any((root / name / "backups").rglob("*.mca"))
        assert any(w["code"] == "region_layout_unsafe" for w in writer.report["warnings"]), name
        try:
            RegionFile.read(path).build()
            raise AssertionError("build() must refuse an unsafe layout")
        except RegionLayoutUnsafe:
            pass


def test_decompression_cap_streams(root: Path) -> None:
    import zlib

    bomb = zlib.compress(bytes(3_000_000), 9)
    assert len(bomb) < 5_000
    assert len(decompress_payload(2, bomb, limit=4_000_000)) == 3_000_000
    try:
        decompress_payload(2, bomb, limit=1_000_000)
        raise AssertionError("over-limit chunk was inflated")
    except ChunkTooLarge:
        pass
    # In a region: the chunk is treated as malformed and its slot is preserved.
    path = root / "bomb" / "world" / "region" / "r.0.0.mca"
    write_region(path, {0: (2, sign("Hello sign"), False)})
    data = bytearray(path.read_bytes())
    first, count = slot_of(data, 0)
    record = struct.pack(">IB", len(bomb) + 1, 2) + bomb
    data.extend(record + bytes(-len(record) % SECTOR))
    new_slot = (len(data) - (len(record) + (-len(record) % SECTOR))) // SECTOR
    data[4:8] = new_slot.to_bytes(3, "big") + bytes([(len(record) + SECTOR - 1) // SECTOR])
    path.write_bytes(bytes(data))
    with patch("mwt.region.MAX_CHUNK_BYTES", 1_000_000):
        region = RegionFile.read(path)
    assert region.chunks[1].malformed and region.chunks[1].oversize


def pack_with_duplicates(path: Path) -> list[tuple[str, bytes]]:
    path.parent.mkdir(parents=True, exist_ok=True)
    members = [
        ("assets/demo/lang/en_us.json", json.dumps({"demo.greeting": "Old duplicate"}).encode()),
        ("assets/demo/lang/ko_kr.json", json.dumps({"demo.greeting": "첫 번째"}).encode()),
        ("assets/other/readme.txt", b"unrelated"),
        ("assets/demo/lang/en_us.json", json.dumps({"demo.greeting": "Hello pack"}).encode()),
        ("assets/demo/lang/ko_kr.json", json.dumps({"demo.greeting": "두 번째"}).encode()),
    ]
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")  # zipfile warns about the duplicates on purpose
        with zipfile.ZipFile(path, "w") as archive:
            for name, body in members:
                archive.writestr(name, body)
    return members


def test_zip_duplicates_only_last_is_translated(root: Path) -> None:
    world = root / "zipworld"
    world.mkdir()
    pack = world / "resources.zip"
    members = pack_with_duplicates(pack)
    writer = translator_for(world, root, {"Hello pack": "팩 번역"}, backup_store=str(root / "zbackups"))
    writer.config["resource_pack"]["skip_if_target_exists"] = False
    result = writer.translate_resource_pack_zip(pack)
    assert result["translated_files"] == 1, result
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with zipfile.ZipFile(pack) as archive:
            infos = archive.infolist()
            bodies = [archive.read(info) for info in infos]
    names = [info.filename for info in infos]
    assert names[:5] == [name for name, _ in members], names
    expected = [body for _, body in members]
    # Every member keeps its own bytes except the last ko_kr.json.
    for index in range(5):
        if index == 4:
            assert json.loads(bodies[4]) == {"demo.greeting": "팩 번역"}
        else:
            assert bodies[index] == expected[index], (index, names[index])
    assert len(infos) == 5


def test_zip_member_size_cap(root: Path) -> None:
    world = root / "bigzip"
    world.mkdir()
    pack = world / "resources.zip"
    pack_with_duplicates(pack)
    original = pack.read_bytes()
    writer = translator_for(world, root, {"Hello pack": "x"}, backup_store=str(root / "bbackups"))
    with patch.object(core, "MAX_LANG_MEMBER_BYTES", 20):
        scanned = writer.scan_resource_pack_zip(pack)
        written = writer.translate_resource_pack_zip(pack)
    assert scanned["candidates"] == 0 and written["translated_files"] == 0
    assert pack.read_bytes() == original, "an over-limit pack is preserved byte for byte"
    codes = [w["code"] for w in writer.report["warnings"]]
    assert codes.count("resource_pack_member_too_large") == 1, codes  # reported once per member


def test_partial_commit_counts_written_mcc(root: Path) -> None:
    import test_external_chunk_restore as mcc

    writer, path, _ = mcc.fixture(root / "partial", 0)  # no spare room: the chunk goes to a .mcc
    mcc_path = path.with_name("c.0.0.mcc")  # replaced below with the real name
    from mwt.region import external_chunk_path

    mcc_path = external_chunk_path(path, 0)
    real = writer._write_world_bytes

    def fail_on_region(target, data):
        if target.suffix == ".mca":
            raise OSError("synthetic disk full")
        return real(target, data)

    with patch.object(writer, "_write_world_bytes", side_effect=fail_on_region):
        writer.runtime_config["continue_on_file_error"] = True
        result = writer._run_file_step(writer.apply_region_file, path)
    assert result["skipped"] == "file_error"
    assert result["written_files"] == [str(mcc_path)], result
    assert mcc_path.is_file()
    writer.report["changed_files"] = [result]
    writer.refresh_report_counts()
    assert writer.report["changed_file_count"] == 1, "the committed .mcc is a changed file"


def make_backup_via_desktop(root: Path) -> tuple[Path, Path, dict, dict]:
    world = _synthetic_world(root)
    data_dir = root / "userdata"
    _settings_set(data_dir, worldDir=str(world), targetLanguage="한국어")
    scan = _request(data_dir, "scan.start", {"worldDir": str(world)})["payload"]
    by_source = {item["source"]: item["id"] for item in scan["candidates"]}
    result = _request(data_dir, "translate.start", {
        "worldDir": str(world), "credentialOwner": "rust",
        "fingerprint": scan["fingerprint"], "scanPlanId": scan["scanPlanId"],
        "candidateOverrides": {by_source["Hello sign"]: "직접 번역"},
    })["payload"]
    assert result["status"] == "completed", result
    return world, data_dir, result, scan


def test_restore_under_guards(root: Path) -> None:
    world, data_dir, result, _ = make_backup_via_desktop(root / "guards")
    (world / "session.lock").write_bytes(bytes(8))  # the game's lock file; the holder below locks it
    translated = _files_under(world)
    # Another PomiTranslate operation holds the world.
    holder = WorldWriteLock(world)
    holder.acquire()
    try:
        reply = _request(data_dir, "restore.start", {"worldDir": str(world), "backupSetId": result["backupSetId"]})
        assert reply["type"] == "response.error" and reply["error"]["code"] == "WORLD_LOCKED", reply
        assert reply["error"]["recoverable"] is True
        assert _files_under(world) == translated, "a refused restore writes nothing"
        selected = BackupSet.find(world, result["backupSetId"], desktop_entry._backup_stores(world, data_dir))
        try:
            selected.restore()
            raise AssertionError("restore ran under a held write lock")
        except WorldWriteLocked:
            pass
    finally:
        holder.release()
    # The game holds the world: simulated with a held session lock in a second process.
    import subprocess

    from test_world_locking import start_holder

    holder_process = start_holder(world, "MinecraftSessionLocks")
    try:
        reply = _request(data_dir, "restore.start", {"worldDir": str(world), "backupSetId": result["backupSetId"]})
        assert reply["type"] == "response.error" and reply["error"]["code"] == "WORLD_IN_USE", reply
        assert _files_under(world) == translated
    finally:
        holder_process.kill()
        holder_process.wait()
    # Free again: the restore goes through and releases both guards.
    restored = _request(data_dir, "restore.start", {"worldDir": str(world), "backupSetId": result["backupSetId"]})
    assert restored["payload"]["status"] == "restored", restored
    assert _files_under(world) != translated
    again = WorldWriteLock(world)
    again.acquire()
    again.release()


def test_restore_records_absence_of_missing_targets(root: Path) -> None:
    world, data_dir, result, _ = make_backup_via_desktop(root / "absence")
    region = world / "region" / "r.0.0.mca"
    translated = region.read_bytes()
    region.unlink()  # the target is missing when the restore starts
    stores = desktop_entry._backup_stores(world, data_dir)
    selected = BackupSet.find(world, result["backupSetId"], stores)
    recovery_id = selected.restore(recovery_store=stores[0])
    assert region.is_file() and region.read_bytes() != translated
    # Undoing the restore puts the world back exactly as it was: without the file.
    BackupSet.find(world, recovery_id, stores).restore(recovery_store=stores[0])
    assert not region.exists(), "the recovery set must remember the file did not exist"


def failing_region_world(root: Path) -> tuple[Path, Path]:
    world = _synthetic_world(root)
    write_region(world / "region" / "r.1.0.mca", {
        0: (2, sign("Second region"), False),
    })
    data_dir = root / "userdata"
    return world, data_dir


def test_partial_run_keeps_checkpoint_and_offers_resume(root: Path) -> None:
    world, data_dir = failing_region_world(root / "partial-run")
    _settings_set(data_dir, worldDir=str(world), targetLanguage="한국어", continueOnFileError=True,
                  maxFileWriteRetries=1)
    scan = _request(data_dir, "scan.start", {"worldDir": str(world)})["payload"]
    by_source = {item["source"]: item["id"] for item in scan["candidates"]}
    original = world / "region" / "r.1.0.mca"
    before = original.read_bytes()
    real = WorldTranslator._write_world_bytes

    def fail_second(self, target, data):
        if Path(target).name == "r.1.0.mca":
            raise OSError("synthetic write failure")
        return real(self, target, data)

    with patch.object(WorldTranslator, "_write_world_bytes", fail_second):
        result = _request(data_dir, "translate.start", {
            "worldDir": str(world), "credentialOwner": "rust",
            "fingerprint": scan["fingerprint"], "scanPlanId": scan["scanPlanId"],
            "candidateOverrides": {by_source["Hello sign"]: "직접", by_source["Second region"]: "둘째"},
        })["payload"]
    assert result["status"] == "partial", result
    assert original.read_bytes() == before
    status = _request(data_dir, "resume.status", {"worldDir": str(world)})["payload"]
    assert status["available"] is True, "a partial run stays resumable"
    # Retrying finishes the rest and clears the checkpoint.
    resumed = _request(data_dir, "translate.resume", {
        "worldDir": str(world), "credentialOwner": "rust",
        "fingerprint": scan["fingerprint"], "scanPlanId": scan["scanPlanId"],
    })["payload"]
    assert resumed["status"] == "completed", resumed
    assert original.read_bytes() != before
    assert _request(data_dir, "resume.status", {"worldDir": str(world)})["payload"]["available"] is False


def test_discard_clears_checkpoint(root: Path) -> None:
    world, data_dir = failing_region_world(root / "discard")
    _settings_set(data_dir, worldDir=str(world), targetLanguage="한국어", continueOnFileError=True,
                  maxFileWriteRetries=1)
    scan = _request(data_dir, "scan.start", {"worldDir": str(world)})["payload"]
    by_source = {item["source"]: item["id"] for item in scan["candidates"]}
    real = WorldTranslator._write_world_bytes

    def fail_second(self, target, data):
        if Path(target).name == "r.1.0.mca":
            raise OSError("synthetic write failure")
        return real(self, target, data)

    with patch.object(WorldTranslator, "_write_world_bytes", fail_second):
        _request(data_dir, "translate.start", {
            "worldDir": str(world), "credentialOwner": "rust",
            "fingerprint": scan["fingerprint"], "scanPlanId": scan["scanPlanId"],
            "candidateOverrides": {by_source["Hello sign"]: "직접", by_source["Second region"]: "둘째"},
        })
    assert _request(data_dir, "resume.status", {"worldDir": str(world)})["payload"]["available"] is True
    discarded = _request(data_dir, "resume.discard", {"worldDir": str(world)})["payload"]
    assert discarded["discarded"] >= 1
    assert _request(data_dir, "resume.status", {"worldDir": str(world)})["payload"]["available"] is False


def test_preferences_failure_keeps_the_result(root: Path) -> None:
    world, data_dir = failing_region_world(root / "prefs")
    _settings_set(data_dir, worldDir=str(world), targetLanguage="한국어")
    scan = _request(data_dir, "scan.start", {"worldDir": str(world)})["payload"]
    by_source = {item["source"]: item["id"] for item in scan["candidates"]}
    with patch("mwt.userdata.remember_run_settings" if False else "mc_world_translator.remember_run_settings",
               side_effect=OSError("disk full"), create=True):
        result = _request(data_dir, "translate.start", {
            "worldDir": str(world), "credentialOwner": "rust",
            "fingerprint": scan["fingerprint"], "scanPlanId": scan["scanPlanId"],
            "candidateOverrides": {by_source["Hello sign"]: "직접", by_source["Second region"]: "둘째"},
        })
    payload = result["payload"]
    assert result["type"] == "response.ok" and payload["status"] == "completed", result
    assert payload["changedFileCount"] == 2
    assert {"code": "settings_not_saved", "message": "OSError"} in payload["warnings"]


def main() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        tests = [
            test_malformed_slots_are_copied_untouched,
            test_unsafe_layout_is_refused_and_unchanged,
            test_decompression_cap_streams,
            test_zip_duplicates_only_last_is_translated,
            test_zip_member_size_cap,
            test_partial_commit_counts_written_mcc,
            test_restore_under_guards,
            test_restore_records_absence_of_missing_targets,
            test_partial_run_keeps_checkpoint_and_offers_resume,
            test_discard_clears_checkpoint,
            test_preferences_failure_keeps_the_result,
        ]
        for test in tests:
            (root / test.__name__).mkdir()
            test(root / test.__name__)
            print("PASS", test.__name__)
    print("CORE_INTEGRITY_PASSED")


if __name__ == "__main__":
    main()
