"""Backups reach the disk before a world write, restores lock the world and never undo themselves.

Covers four review findings on synthetic worlds only:
* backup copies, manifests and their folders were never fsynced before the world was replaced;
* ``--restore-backup`` and the desktop ``--restore`` wrote without the world or session locks, and
  a restore published its recovery set as "latest", so restoring twice put the translation back;
* ``--no-backup`` skipped the resources.zip backup (regions were always backed up);
* a region named like ``r.0.0.old.mca`` was read as region 0, 0 and could be written.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
import zipfile
from contextlib import redirect_stderr
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from nbt import nbt  # noqa: E402

import mc_world_translator as core  # noqa: E402
import mwt.desktop_entry as desktop  # noqa: E402
import mwt.safety as safety  # noqa: E402
from llm_backends import LLMProviderClient  # noqa: E402
from mwt.locking import MinecraftSessionLocks, WorldWriteLock  # noqa: E402
from mwt.region import RegionError, RegionFile, external_chunk_path, region_coordinates  # noqa: E402
from mwt.safety import BackupSet, backup_store, file_sha256, list_backup_sets, world_fingerprint  # noqa: E402


def sign_bytes(text: str) -> bytes:
    root = nbt.NBTFile()
    root.name = ""
    sign = nbt.TAG_Compound(name="sign")
    sign.tags.append(nbt.TAG_String(name="Text1", value=json.dumps({"text": text})))
    root.tags.append(sign)
    buffer = io.BytesIO()
    root.write_file(buffer=buffer)
    return buffer.getvalue()


def write_region(path: Path, texts: list[str], *, external: bool = False) -> None:
    region = RegionFile.empty()
    for index, text in enumerate(texts):
        region.put_nbt(index, sign_bytes(text), compression=2, external=external)
    data, mcc_files = region.build()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    for index, payload in mcc_files.items():
        external_chunk_path(path, index).write_bytes(payload)


def make_world(root: Path, name: str = "world") -> Path:
    world = root / name
    write_region(world / "region" / "r.0.0.mca", ["Hello sign"])
    (world / "level.dat").write_bytes(b"\x1f\x8b")
    return world


def translate(_client, payload, *, system_prompt, temperature):
    LLMProviderClient.request_count += 1
    return {key: "번역 " + text for key, text in payload.items()}


def config_for(world: Path, root: Path, **extra) -> dict:
    runtime = {
        "checkpoint_enabled": False,
        "expected_world_fingerprint": world_fingerprint(world),
        "backup_store": str(backup_store(world, root / "data")),
        "data_dir": str(root / "data"),
        **extra.pop("runtime", {}),
    }
    return core.merge_nested(core.DEFAULT_CONFIG, {
        "world_dir": str(world), "dry_run": False, "report_path": str(root / "report.json"),
        "inherit_translate_py": False, "batch_size": 20,
        "api": {"provider": "openai", "api_key": "k", "model": "m"},
        "runtime": runtime,
        **extra,
    })


def run(config: dict) -> dict:
    with patch.object(LLMProviderClient, "translate_mapping", new=translate), \
            patch.object(LLMProviderClient, "try_refresh_text_models", return_value=None):
        return core.WorldTranslator(config).run()


def hold_session_lock(world: Path) -> subprocess.Popen:
    code = textwrap.dedent(f"""
        import fcntl, sys
        handle = open({str(world / "session.lock")!r}, "r+b")
        fcntl.lockf(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        print("held", flush=True)
        sys.stdin.read()
    """)
    process = subprocess.Popen([sys.executable, "-c", code], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    assert process.stdout.readline().strip() == "held"
    return process


def release(process: subprocess.Popen) -> None:
    process.stdin.close()
    process.wait(timeout=10)
    process.stdout.close()


class DurabilityTests(unittest.TestCase):
    def test_backup_copy_manifest_and_folders_are_flushed_before_the_world_write(self):
        with tempfile.TemporaryDirectory(prefix="pomi-durable-") as raw:
            root = Path(raw)
            world = make_world(root)
            region = world / "region" / "r.0.0.mca"
            synced_files: list[Path] = []
            synced_dirs: list[Path] = []
            real_file, real_dir = safety.fsync_path, safety.fsync_directory
            seen_at_write: list[tuple[set[Path], set[Path]]] = []
            real_write = core.write_bytes_atomic

            def file_spy(path):
                synced_files.append(Path(path).resolve())
                return real_file(path)

            def dir_spy(path):
                synced_dirs.append(Path(path).resolve())
                return real_dir(path)

            def guarded(path, content):
                if Path(path).resolve() == region.resolve():
                    seen_at_write.append((set(synced_files), set(synced_dirs)))
                return real_write(path, content)

            with patch.object(safety, "fsync_path", side_effect=file_spy), \
                    patch.object(safety, "fsync_directory", side_effect=dir_spy), \
                    patch.object(core, "write_bytes_atomic", side_effect=guarded):
                report = run(config_for(world, root))
            self.assertEqual(report["status"], "completed", report.get("errors"))
            self.assertEqual(len(seen_at_write), 1)
            files, dirs = seen_at_write[0]
            backup = BackupSet.find(world, report["backup_set_id"], [backup_store(world, root / "data")])
            copy = (backup.root / "region" / "r.0.0.mca").resolve()
            self.assertIn(copy, files, "the backup copy reached the disk before the world write")
            self.assertTrue(any(path.parent == backup.root.resolve() and path.name.startswith("manifest.json") for path in files),
                            "the manifest reached the disk before the world write")
            for folder in (copy.parent, backup.root.resolve(), backup.store.resolve()):
                self.assertIn(folder, dirs, f"{folder} was not flushed")
            self.assertTrue(any(path.name.startswith("latest.json") for path in files))
            # The world write itself flushes its folder after the rename.
            self.assertIn(region.parent.resolve(), set(synced_dirs))


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pomi-restore-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.world = make_world(self.root)
        (self.world / "session.lock").write_bytes(b"x")
        self.data = self.root / "data"
        self.region = self.world / "region" / "r.0.0.mca"
        self.original = self.region.read_bytes()
        report = run(config_for(self.world, self.root))
        self.assertEqual(report["status"], "completed", report.get("errors"))
        self.backup_id = report["backup_set_id"]
        self.translated = self.region.read_bytes()
        self.assertNotEqual(self.translated, self.original)
        self.config = config_for(self.world, self.root)

    def test_cli_restore_twice_stays_restored_and_recovery_restores_by_id(self):
        first = core.restore_backup_cli(self.config, self.data)
        self.assertEqual(self.region.read_bytes(), self.original)
        self.assertEqual(first["backupSetId"], self.backup_id)
        self.assertTrue(first["recoverySetId"].endswith("-recovery"))
        listed = list_backup_sets(self.world, [backup_store(self.world, self.data)])
        self.assertEqual(listed[0]["backupSetId"], first["recoverySetId"], "the recovery set is the newest one listed")
        pointer = json.loads((backup_store(self.world, self.data) / "latest.json").read_text(encoding="utf-8"))
        self.assertEqual(pointer["backupSetId"], self.backup_id, "a restore never makes its recovery set the latest")
        second = core.restore_backup_cli(self.config, self.data)
        self.assertEqual(second["backupSetId"], self.backup_id)
        self.assertEqual(self.region.read_bytes(), self.original, "a second restore must not bring the translation back")
        # The translated world is still one explicit step away.
        core.restore_backup_cli(self.config, self.data, first["recoverySetId"])
        self.assertEqual(self.region.read_bytes(), self.translated)

    def test_cli_main_restore_flag_prints_the_sets(self):
        out = io.StringIO()
        with patch("sys.stdout", out):
            core.main(["--world-dir", str(self.world), "--data-dir", str(self.data), "--restore-backup"])
        printed = json.loads(out.getvalue())
        self.assertEqual(printed["status"], "restored")
        self.assertEqual(printed["backupSetId"], self.backup_id)
        self.assertEqual(self.region.read_bytes(), self.original)

    def test_a_latest_pointer_left_on_a_recovery_set_is_not_followed(self):
        store = backup_store(self.world, self.data)
        recovery_id = core.restore_backup_cli(self.config, self.data)["recoverySetId"]
        (store / "latest.json").write_text(json.dumps({"backupSetId": recovery_id}), encoding="utf-8")
        self.assertEqual(BackupSet(self.world, "latest", store).backup_id, self.backup_id)
        core.restore_backup_cli(self.config, self.data)
        self.assertEqual(self.region.read_bytes(), self.original)

    def test_cli_restore_refuses_while_another_writer_holds_the_world(self):
        guard = WorldWriteLock(self.world)
        guard.acquire()
        try:
            with self.assertRaises(SystemExit):
                core.restore_backup_cli(self.config, self.data)
            with self.assertRaises(SystemExit):
                desktop.main(["--restore", str(self.world), "--data-dir", str(self.data), "--report-dir", str(self.root / "reports")])
        finally:
            guard.release()
        self.assertEqual(self.region.read_bytes(), self.translated)

    @unittest.skipIf(os.name == "nt", "POSIX record locks")
    def test_restore_refuses_while_minecraft_holds_the_session_lock(self):
        process = hold_session_lock(self.world)
        try:
            with self.assertRaises(SystemExit):
                core.restore_backup_cli(self.config, self.data)
            with self.assertRaises(SystemExit):
                desktop.main(["--restore", str(self.world), "--data-dir", str(self.data), "--report-dir", str(self.root / "reports")])
        finally:
            release(process)
        self.assertEqual(self.region.read_bytes(), self.translated)

    def test_restore_holds_both_locks_while_it_writes(self):
        held: list[bool] = []
        real = BackupSet.restore

        def checking(backup, *args, **kwargs):
            probe = WorldWriteLock(self.world)
            try:
                probe.acquire()
                probe.release()
                held.append(False)
            except Exception:
                held.append(True)
            with self.assertRaises(Exception):
                MinecraftSessionLocks(self.world).acquire()
            return real(backup, *args, **kwargs)

        with patch.object(BackupSet, "restore", new=checking):
            core.restore_backup_cli(self.config, self.data)
            desktop.main(["--restore", str(self.world), "--data-dir", str(self.data), "--report-dir", str(self.root / "reports")])
        self.assertEqual(held, [True, True])

    def test_desktop_restore_twice_stays_restored(self):
        out = io.StringIO()
        with patch("sys.stdout", out):
            desktop.main(["--restore", str(self.world), "--data-dir", str(self.data), "--report-dir", str(self.root / "reports")])
            desktop.main(["--restore", str(self.world), "--data-dir", str(self.data), "--report-dir", str(self.root / "reports")])
        lines = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
        self.assertEqual([line["backupSetId"] for line in lines], [self.backup_id, self.backup_id])
        self.assertEqual(self.region.read_bytes(), self.original)
        # restore.start without an id follows the same rule.
        replies: list[dict] = []
        with patch.object(desktop, "emit", side_effect=replies.append):
            desktop.dispatch(json.dumps({"v": 1, "id": "r", "type": "restore.start", "payload": {"worldDir": str(self.world)}}),
                             self.root / "reports", self.data)
        self.assertEqual(replies[-1]["type"], "response.ok", replies[-1])
        self.assertEqual(replies[-1]["payload"]["backupSetId"], self.backup_id)
        self.assertEqual(self.region.read_bytes(), self.original)
        # An explicit id still restores a recovery set.
        with patch.object(desktop, "emit", side_effect=replies.append):
            desktop.dispatch(json.dumps({"v": 1, "id": "r", "type": "restore.start", "payload": {
                "worldDir": str(self.world), "backupSetId": lines[0]["recoverySetId"]}}), self.root / "reports", self.data)
        self.assertEqual(replies[-1]["type"], "response.ok", replies[-1])
        self.assertEqual(self.region.read_bytes(), self.translated)


class NoBackupFlagTests(unittest.TestCase):
    def test_flag_is_accepted_ignored_and_warned_about(self):
        args = core.build_parser().parse_args(["--world-dir", "/tmp/x", "--no-backup"])
        err = io.StringIO()
        with redirect_stderr(err):
            config = core.apply_cli_overrides(core.merge_nested(core.DEFAULT_CONFIG, {}), args)
        self.assertTrue(config["backup"])
        self.assertIn("--no-backup is ignored", err.getvalue())

    def test_backup_off_in_config_still_backs_up_regions_and_resources_zip(self):
        with tempfile.TemporaryDirectory(prefix="pomi-nobackup-") as raw:
            root = Path(raw)
            world = make_world(root)
            pack = world / "resources.zip"
            with zipfile.ZipFile(pack, "w") as archive:
                archive.writestr("pack.mcmeta", json.dumps({"pack": {"pack_format": 15, "description": "x"}}))
                archive.writestr("assets/minecraft/lang/en_us.json", json.dumps({"block.test": "Hello pack"}))
            original_pack = pack.read_bytes()
            original_region = (world / "region" / "r.0.0.mca").read_bytes()
            config = config_for(world, root, backup=False,
                                resource_pack={"enabled": True, "zip_paths": [str(pack)]})
            report = run(config)
            self.assertEqual(report["status"], "completed", report.get("errors"))
            self.assertNotEqual(pack.read_bytes(), original_pack, "the pack was translated")
            backup = BackupSet.find(world, report["backup_set_id"], [backup_store(world, root / "data")])
            copies = {entry["path"]: entry["sha256"] for entry in backup.entries}
            self.assertEqual(copies.get("resources.zip"), file_sha256_bytes(original_pack))
            self.assertEqual(copies.get("region/r.0.0.mca"), file_sha256_bytes(original_region))
            self.assertIn("backup_always_on", {warning["code"] for warning in report["warnings"]})


def file_sha256_bytes(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


class RegionNameTests(unittest.TestCase):
    def test_only_standard_region_names_have_coordinates(self):
        self.assertEqual(region_coordinates(Path("r.-3.12.mca")), (-3, 12))
        for name in ("r.0.0.old.mca", "r.0.mca", "r.a.b.mca", "copy of r.0.0.mca", "r.0.0.mcr"):
            with self.assertRaises(RegionError, msg=name):
                region_coordinates(Path(name))

    def test_nonstandard_region_file_is_skipped_with_a_warning(self):
        with tempfile.TemporaryDirectory(prefix="pomi-region-name-") as raw:
            root = Path(raw)
            world = make_world(root)
            copy = world / "region" / "r.0.0.old.mca"
            write_region(copy, ["Copied line"], external=True)
            # Its external chunk would have been looked up as c.0.0.mcc, which belongs to r.0.0.mca.
            stray = world / "region" / "c.0.0.mcc"
            self.assertTrue(stray.exists())
            before_copy = copy.read_bytes()
            before_stray = stray.read_bytes()
            scan = core.WorldTranslator(core.merge_nested(config_for(world, root), {"dry_run": True}))
            scan_report = scan.run()
            self.assertNotIn("Copied line", scan._candidate_order)
            skipped = [item for item in scan_report["changed_files"] if item.get("skipped") == "nonstandard_region_name"]
            self.assertEqual([Path(item["file"]).name for item in skipped], ["r.0.0.old.mca"])
            report = run(config_for(world, root))
            self.assertIn(report["status"], {"completed", "partial"}, report.get("errors"))
            self.assertEqual(copy.read_bytes(), before_copy, "a non-standard region file is never written")
            self.assertEqual(stray.read_bytes(), before_stray)
            warnings = [w for w in report["warnings"] if w.get("reason") == "nonstandard_region_name"]
            self.assertEqual([w["code"] for w in warnings], ["file_unwritable"])
            self.assertNotEqual((world / "region" / "r.0.0.mca").read_bytes(), b"", "the standard file is still translated")
            written = RegionFile.read(world / "region" / "r.0.0.mca")
            text = core.WorldTranslator.parse_nbt_bytes(written.chunks[0].raw_nbt)["sign"]["Text1"].value
            self.assertEqual(json.loads(text)["text"], "번역 Hello sign")


if __name__ == "__main__":
    unittest.main()
