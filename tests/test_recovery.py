"""Desktop protocol for interrupted jobs: bootstrap listing, recovery.start, interrupted restore, resume."""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from journal_fixtures import (  # noqa: E402
    Crash, SimulatedCrash, build_world, config_for, crash_job, hook, leftovers, run_job, snapshot, world_is_readable,
)
from mc_world_translator import BatchLog, WorldTranslator  # noqa: E402
from mwt import desktop_entry  # noqa: E402
from mwt.locking import hold_world  # noqa: E402
from mwt.safety import BackupSet, list_backup_sets  # noqa: E402


def request(data_dir: Path, kind: str, payload: dict | None = None) -> list[dict]:
    replies: list[dict] = []
    with patch.object(desktop_entry, "emit", side_effect=replies.append):
        desktop_entry.handle({"v": 1, "id": "r1", "type": kind, "payload": payload or {}},
                             report_dir=data_dir / "reports", data_dir=data_dir)
    return replies


def store_for(data_dir: Path, world: Path) -> str:
    return str(data_dir / "backups" / world.name)


def setup(root: Path, **runtime):
    data = root / "appdata"
    world, pack = build_world(root)
    request(data, "settings.set", {"credentialOwner": "rust", "provider": "openai", "model": "m",
                                   "worldDir": str(world), "resourcePackEnabled": True,
                                   "externalResourcePackPaths": [str(pack)]})
    return data, world, pack, dict(backup_store=store_for(data, world), data_dir=str(data), **runtime)


def test_bootstrap_lists_and_recovery_rolls_back() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        data, world, pack, runtime = setup(root)
        baseline = snapshot(world, pack)
        crash_job(world, root, pack, Crash("between_targets", 1), **runtime)
        boot = request(data, "app.bootstrap", {"credentialOwner": "rust"})[-1]["payload"]
        jobs = boot["interruptedJobs"]
        assert len(jobs) == 1, jobs
        job = jobs[0]
        assert set(job) >= {"jobId", "kind", "worldPath", "worldName", "createdAt", "unitsTotal", "unitsVerified",
                            "unitsUnknown", "needsAttention", "legacy"}
        assert job["kind"] == "translate" and job["legacy"] is False and job["needsAttention"] is True
        assert job["unitsTotal"] == 5 and job["unitsVerified"] < job["unitsTotal"]
        assert snapshot(world, pack) != baseline, "listing must not repair anything"

        replies = request(data, "recovery.start", {"jobId": job["jobId"], "mode": "rollback"})
        progress = [r for r in replies if r["type"] == "recovery.progress"]
        assert progress and all(r["payload"]["phase"] == "recovery" for r in progress)
        assert progress[-1]["payload"]["done"] == progress[-1]["payload"]["total"]
        result = replies[-1]
        assert result["type"] == "response.ok", result
        body = result["payload"]
        assert body["state"] == "rolled_back" and body["mode"] == "rollback" and body["conflicts"] == [], body
        assert body["restoredFiles"] > 0 and body["quarantineDir"] is None
        assert snapshot(world, pack) == baseline and not leftovers(world, pack)
        world_is_readable(world)
        assert request(data, "app.bootstrap", {"credentialOwner": "rust"})[-1]["payload"]["interruptedJobs"] == []


def test_recovery_keep_and_errors() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        data, world, pack, runtime = setup(root)
        crash_job(world, root, pack, Crash("after_verify", 3), **runtime)
        job_id = request(data, "app.bootstrap", {"credentialOwner": "rust"})[-1]["payload"]["interruptedJobs"][0]["jobId"]
        crashed = snapshot(world, pack)

        missing = request(data, "recovery.start", {"jobId": "20200101T000000Z-aaaaaaaaaaaa-translation", "mode": "keep"})[-1]
        assert missing["type"] == "response.error" and missing["error"]["code"] == "JOURNAL_NOT_FOUND", missing
        try:
            request(data, "recovery.start", {"jobId": job_id, "mode": "restore"})
            raise AssertionError("an unknown mode must be refused")
        except ValueError:
            pass  # serve() turns a ValueError into a response.error for the caller

        with hold_world(world, "translate"):
            busy = request(data, "recovery.start", {"jobId": job_id, "mode": "rollback"})[-1]
        assert busy["type"] == "response.error" and busy["error"]["code"] == "WORLD_LOCKED", busy
        assert snapshot(world, pack) == crashed

        from mwt.locking import target_lock_dir

        (root / "other-world").mkdir()
        with hold_world(root / "other-world", "translate", external_targets=[pack], lock_dir=target_lock_dir(data)):
            held = request(data, "recovery.start", {"jobId": job_id, "mode": "rollback"})[-1]
        assert held["type"] == "response.error" and held["error"]["code"] == "TARGET_LOCKED", held
        assert snapshot(world, pack) == crashed

        kept = request(data, "recovery.start", {"jobId": job_id, "mode": "keep"})[-1]
        assert kept["type"] == "response.ok" and kept["payload"]["state"] == "kept", kept
        assert snapshot(world, pack) == crashed
        assert request(data, "app.bootstrap", {"credentialOwner": "rust"})[-1]["payload"]["interruptedJobs"] == []
        again = request(data, "recovery.start", {"jobId": job_id, "mode": "rollback"})[-1]
        assert again["type"] == "response.error" and again["error"]["code"] == "JOURNAL_NOT_FOUND", again


def test_interrupted_restore_is_listed_and_recoverable() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        data, world, pack, runtime = setup(root)
        original = snapshot(world, pack)
        report = run_job(world, root, pack, **runtime)
        assert report["status"] == "completed"
        translated = snapshot(world, pack)
        stores = [data / "backups" / world.name]
        selected = BackupSet.find(world, report["backup_set_id"], stores, external_files=[pack])
        with hook(Crash("between_targets", 1, kind="restore")):
            try:
                selected.restore(recovery_store=stores[0], lock_dir=data / "locks")
                raise AssertionError("the restore should have been cut off")
            except SimulatedCrash:
                pass
        jobs = request(data, "app.bootstrap", {"credentialOwner": "rust"})[-1]["payload"]["interruptedJobs"]
        assert [j["kind"] for j in jobs] == ["restore"], jobs
        mid = snapshot(world, pack)
        assert mid not in (original, translated)
        # Recovery of the restore: rolling back returns the world to what it was before the restore began.
        result = request(data, "recovery.start", {"jobId": jobs[0]["jobId"], "mode": "rollback"})[-1]
        assert result["type"] == "response.ok" and result["payload"]["state"] == "rolled_back", result
        assert snapshot(world, pack) == translated
        # ...and a completed restore of the same set still works afterwards.
        BackupSet.find(world, report["backup_set_id"], stores, external_files=[pack]).restore(
            recovery_store=stores[0], lock_dir=data / "locks")
        assert snapshot(world, pack) == original


def test_listing_marks_legacy_sets() -> None:
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        data, world, pack, runtime = setup(root)
        run_job(world, root, pack, **runtime)
        next((data / "backups" / world.name).glob("*/journal.json")).unlink()
        entries = list_backup_sets(world, [data / "backups" / world.name])
        assert entries and entries[0]["legacy"] is True and entries[0]["journalState"] is None


class Recorder:
    """A loopback provider that answers every text with ``T:<text>`` and remembers what it was asked."""

    def __init__(self) -> None:
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        import threading

        self.asked: list[str] = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                self._send({"data": []})

            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                payload = json.loads(body["messages"][1]["content"])
                owner.asked.extend(payload.values())
                answer = {key: "T:" + text for key, text in payload.items()}
                self._send({"choices": [{"message": {"content": json.dumps(answer)}}]})

            def _send(self, value: dict) -> None:
                raw = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    def stop(self) -> None:
        self.server.shutdown()


def test_batch_log_survives_a_crash_and_resumes_without_paying_again() -> None:
    from mc_world_translator import merge_nested

    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        world, pack = build_world(root, external=False)
        checkpoint = root / "job.checkpoint.json"
        provider = Recorder()
        try:
            def config(resume: bool) -> dict:
                base = config_for(world, root, None, checkpoint_enabled=True, checkpoint_path=str(checkpoint),
                                  resume_from_checkpoint=resume)
                base["scan"]["overrides"] = {}
                base["batch_size"] = 2
                return merge_nested(base, {"api": {"provider": "openai", "api_key": "test-key", "model": "fixture",
                                                   "base_url": provider.url}})

            # The process dies right after the first answer was appended to the log.
            seen = {"received": 0}
            original = WorldTranslator._batch_sink

            def sink(self, kind, **details):
                original(self, kind, **details)
                if kind == "received":
                    seen["received"] += 1
                    if seen["received"] == 1:
                        raise SimulatedCrash("after the first paid batch")

            with patch.object(WorldTranslator, "_batch_sink", sink):
                try:
                    WorldTranslator(config(False)).run()
                    raise AssertionError("the run should have been cut off")
                except SimulatedCrash:
                    pass
            log_path = BatchLog.path_for(checkpoint)
            translations, counts = BatchLog.read(log_path)
            assert counts["sent"] >= 1 and counts["received"] == 1 and translations, (translations, counts)
            paid = list(translations)
            first_calls = list(provider.asked)
            assert set(paid) <= set(first_calls)
            baseline_now = snapshot(world)
            assert baseline_now  # nothing was written yet: the crash was before the write phase

            provider.asked.clear()
            report = WorldTranslator(config(True)).run()
            assert report["status"] == "completed", (report["status"], report["errors"])
            assert not set(paid) & set(provider.asked), "an answer that was already paid for was asked for again"
            assert not log_path.exists() and not checkpoint.exists()
            from test_release_fixtures import texts_in

            assert any("T:Second region" in blob for blob in texts_in(world / "region" / "r.1.0.mca"))
        finally:
            provider.stop()


def test_torn_log_line_is_ignored() -> None:
    with tempfile.TemporaryDirectory() as temp:
        path = Path(temp) / "x.checkpoint.json.batches.jsonl"
        log = BatchLog(path)
        log.append("sent", texts=["a", "b"])
        log.append("received", translations={"a": "A", "b": "B"})
        with open(path, "ab") as handle:
            handle.write(b'{"kind": "received", "translations": {"c"')  # cut off mid-write
        translations, counts = BatchLog.read(path)
        assert translations == {"a": "A", "b": "B"} and counts == {"sent": 1, "received": 1, "failed": 0}
        log.clear()
        assert not path.exists()


def main() -> None:
    tests = [
        test_bootstrap_lists_and_recovery_rolls_back, test_recovery_keep_and_errors,
        test_interrupted_restore_is_listed_and_recoverable, test_listing_marks_legacy_sets,
        test_batch_log_survives_a_crash_and_resumes_without_paying_again, test_torn_log_line_is_ignored,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"RECOVERY_PASSED ({len(tests)} tests)")


if __name__ == "__main__":
    main()
