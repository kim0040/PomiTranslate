"""Launch the real desktop entry against a fixture world."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from nbt import nbt

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from tests.test_release_fixtures import compound, nbt_bytes, string, write_region

PY = sys.executable


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        raw = b'{"data":[]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        payload = json.loads(body["messages"][1]["content"])
        translated = {key: ("Hola sign" if text == "Hello sign" else text) for key, text in payload.items()}
        raw = json.dumps({"choices": [{"message": {"content": json.dumps(translated)}}]}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


def start_server() -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host, port = server.server_address[:2]
    return server, f"http://{host}:{port}/v1"


def hashes(world: Path) -> dict[str, str]:
    from mwt.safety import iter_data_files

    return {
        path.relative_to(world).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in iter_data_files(world)
    }


def listening(pid: int) -> str:
    """TCP listeners owned by ``pid``. Windows has no lsof, so read netstat there."""
    if sys.platform == "win32":
        completed = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True)
        return "\n".join(
            line
            for line in completed.stdout.splitlines()
            if "LISTENING" in line and line.split()[-1] == str(pid)
        )
    completed = subprocess.run(
        ["lsof", "-nP", "-a", "-p", str(pid), "-iTCP", "-sTCP:LISTEN"],
        capture_output=True,
        text=True,
    )
    return "\n".join(line for line in completed.stdout.splitlines() if str(pid) in line)


def exchange(proc: subprocess.Popen[str], message: dict | None = None, events: list[dict] | None = None) -> dict:
    if message is not None:
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(message) + "\n")
        proc.stdin.flush()
    assert proc.stdout is not None
    while True:
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError(proc.stderr.read() if proc.stderr else "desktop entry closed stdout")
        reply = json.loads(line)
        if reply.get("type", "").endswith(".progress"):
            if events is not None:
                events.append(reply)
            continue
        return reply


def main() -> None:
    server, base_url = start_server()
    try:
        with tempfile.TemporaryDirectory() as temp_dir:
            tmp = Path(temp_dir)
            world = tmp / "world"
            region = world / "region" / "r.0.0.mca"
            write_region(region, {0: (2, nbt_bytes(compound("sign", string("Text1", '{"text":"Hello sign"}'))), False)})
            level = nbt.NBTFile()
            data = nbt.TAG_Compound(name="Data")
            data.tags.append(nbt.TAG_Int(name="DataVersion", value=4189))
            level.tags.append(data)
            level.write_file(filename=str(world / "level.dat"))
            original = hashes(world)
            cancel_path = tmp / "operation.cancel"
            env = os.environ.copy()
            env.update({"POMI_API_KEY": "desktop-test-key", "POMI_API_BASE": base_url, "POMI_MODEL": "fixture"})
            command = [
                PY,
                "-m",
                "mwt.desktop_entry",
                "--jsonl",
                "--report-dir",
                str(tmp / "reports"),
                "--data-dir",
                str(tmp / "userdata"),
                "--cancel-file",
                str(cancel_path),
            ]
            proc = subprocess.Popen(
                command,
                cwd=ROOT,
                env=env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                hello = exchange(proc)
                assert hello["type"] == "system.hello"
                assert hello["payload"]["localhostServer"] is False
                assert hello["payload"]["productName"] == "PomiTranslate"
                assert listening(proc.pid) == ""
                remembered = exchange(
                    proc,
                    {"v": 1, "id": "remember", "type": "worlds.remember", "payload": {"worldDir": str(world)}},
                )
                assert remembered["payload"]["worlds"][0]["path"] == str(world.resolve())
                exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "bootstrap-settings",
                        "type": "settings.set",
                        "payload": {
                            "worldDir": str(world),
                            "provider": "openai",
                            "model": "fixture",
                            "review_before_apply": False,
                            "credentialOwner": "rust",
                        },
                    },
                )
                bootstrap = exchange(
                    proc,
                    {"v": 1, "id": "bootstrap", "type": "app.bootstrap", "payload": {"credentialOwner": "rust"}},
                )
                assert bootstrap["payload"]["settings"]["last_world_dir"] == str(world.resolve())
                assert bootstrap["payload"]["worlds"][0]["path"] == str(world.resolve())
                assert bootstrap["payload"]["worldInspection"]["validJavaWorld"] is True
                assert bootstrap["payload"]["worldInspection"]["dataVersions"] == [
                    {"world": "world", "dataVersion": 4189}
                ]
                assert bootstrap["payload"]["backups"] == []
                assert bootstrap["payload"]["resume"]["available"] is False
                assert bootstrap["payload"]["notices"]["firstLaunch"]
                inspected = exchange(
                    proc,
                    {"v": 1, "id": "inspect", "type": "world.inspect", "payload": {"worldDir": str(world)}},
                )
                assert inspected["payload"]["validJavaWorld"] is True
                assert inspected["payload"]["kind"] == "java_world"
                assert inspected["payload"]["dataVersions"] == [{"world": "world", "dataVersion": 4189}]
                listed_worlds = exchange(
                    proc,
                    {"v": 1, "id": "worlds", "type": "worlds.list", "payload": {}},
                )
                assert listed_worlds["payload"]["worlds"][0]["available"] is True
                scan_events: list[dict] = []
                scan = exchange(
                    proc,
                    {"v": 1, "id": "scan", "type": "scan.start", "payload": {"worldDir": str(world)}},
                    scan_events,
                )
                assert scan["payload"]["dryRun"] is True
                assert scan["payload"]["candidateCount"] > 0
                assert scan["payload"]["localhostServer"] is False
                assert "Back up your world" in scan["payload"]["preTranslate"]
                assert scan["payload"]["candidates"][0]["source"] == "Hello sign"
                assert scan["payload"]["writeBlockers"] == []
                assert scan["payload"]["scanPlanId"]
                assert any(item["type"] == "scan.progress" for item in scan_events)
                last_scan = scan["payload"]["lastScan"]
                assert last_scan["at"] > 0
                assert last_scan["candidateCount"] == scan["payload"]["candidateCount"]
                scan_plan_path = tmp / "userdata" / "scans" / f"{scan['payload']['scanPlanId']}.json"
                scan_summary_path = tmp / "userdata" / "scans" / f"{scan['payload']['scanPlanId']}.summary.json"
                saved_plan = json.loads(scan_plan_path.read_text(encoding="utf-8"))
                saved_summary = json.loads(scan_summary_path.read_text(encoding="utf-8"))
                assert saved_plan["createdAt"] > 0 and saved_plan["candidateCount"] == 1
                assert saved_summary["worldIdentity"] == saved_plan["worldIdentity"]

                # Scan Only has no job checkpoint. Restart the sidecar and load the saved scan summary.
                assert proc.stdin is not None
                proc.stdin.close()
                assert proc.wait(timeout=5) == 0
                proc = subprocess.Popen(
                    command,
                    cwd=ROOT,
                    env=env,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                hello = exchange(proc)
                assert hello["type"] == "system.hello"
                scan_only_bootstrap = exchange(
                    proc,
                    {"v": 1, "id": "scan-only-bootstrap", "type": "app.bootstrap", "payload": {"worldDir": str(world), "credentialOwner": "rust"}},
                )
                assert scan_only_bootstrap["payload"]["resume"]["available"] is False
                assert scan_only_bootstrap["payload"]["lastScan"] == last_scan
                assert scan_only_bootstrap["payload"]["resume"]["lastScan"] == last_scan
                scan_only_resume = exchange(
                    proc,
                    {"v": 1, "id": "scan-only-resume", "type": "resume.status", "payload": {"worldDir": str(world)}},
                )
                assert scan_only_resume["payload"]["lastScan"] == last_scan
                assert scan_only_resume["payload"]["lastJob"] is None
                page = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "page",
                        "type": "candidates.page",
                        "payload": {"scanPlanId": scan["payload"]["scanPlanId"], "offset": 0, "limit": 100},
                    },
                )
                assert page["payload"]["total"] == 1
                assert page["payload"]["candidates"][0]["source"] == "Hello sign"
                no_match = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "search",
                        "type": "candidates.page",
                        "payload": {"scanPlanId": scan["payload"]["scanPlanId"], "query": "absent"},
                    },
                )
                assert no_match["payload"]["total"] == 0
                assert hashes(world) == original
                cancel_path.write_text("cancel", encoding="utf-8")
                cancelled = exchange(
                    proc,
                    {"v": 1, "id": "cancelled-scan", "type": "scan.start", "payload": {"worldDir": str(world)}},
                )
                assert cancelled["payload"]["status"] == "cancelled"
                assert hashes(world) == original
                cancelled_translation = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "cancelled-translation",
                        "type": "translate.start",
                        "payload": {
                            "worldDir": str(world),
                            "fingerprint": scan["payload"]["fingerprint"],
                            "scanPlanId": scan["payload"]["scanPlanId"],
                        },
                    },
                )
                assert cancelled_translation["payload"]["status"] == "cancelled"
                resumable = exchange(
                    proc,
                    {"v": 1, "id": "resume-status", "type": "resume.status", "payload": {"worldDir": str(world)}},
                )
                assert resumable["payload"]["available"] is True
                assert resumable["payload"]["scanPlanId"] == scan["payload"]["scanPlanId"]
                assert resumable["payload"]["occurrenceCount"] == scan["payload"]["occurrenceCount"]
                assert resumable["payload"]["kinds"] == scan["payload"]["kinds"]
                assert resumable["payload"]["coverage"] == scan["payload"]["coverage"]
                cancel_path.unlink()
                resumed = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "resume-translation",
                        "type": "translate.resume",
                        "payload": {"worldDir": str(world)},
                    },
                )
                assert resumed["payload"]["status"] == "completed"
                assert resumed["payload"]["backupSetId"]
                assert hashes(world) != original
                resumed_restore = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "resume-restore",
                        "type": "restore.start",
                        "payload": {
                            "worldDir": str(world),
                            "backupSetId": resumed["payload"]["backupSetId"],
                        },
                    },
                )
                assert resumed_restore["payload"]["status"] == "restored"
                assert hashes(world) == original
                resume_gone = exchange(
                    proc,
                    {"v": 1, "id": "resume-gone", "type": "resume.status", "payload": {"worldDir": str(world)}},
                )
                assert resume_gone["payload"]["available"] is False
                rejected = exchange(
                    proc,
                    {"v": 1, "id": "no-scan", "type": "translate.start", "payload": {"worldDir": str(world)}},
                )
                assert rejected["type"] == "response.error"
                assert rejected["error"]["code"] == "SCAN_REQUIRED"
                assert hashes(world) == original
                excluded = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "excluded",
                        "type": "translate.start",
                        "payload": {
                            "worldDir": str(world),
                            "fingerprint": scan["payload"]["fingerprint"],
                            "scanPlanId": scan["payload"]["scanPlanId"],
                            "excludedCandidateIds": [scan["payload"]["candidates"][0]["id"]],
                        },
                    },
                )
                assert excluded["payload"]["candidateCount"] == 0
                assert hashes(world) == original
                manual = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "manual",
                        "type": "translate.start",
                        "payload": {
                            "worldDir": str(world),
                            "fingerprint": scan["payload"]["fingerprint"],
                            "scanPlanId": scan["payload"]["scanPlanId"],
                            "candidateOverrides": {
                                scan["payload"]["candidates"][0]["id"]: "Manual sign"
                            },
                        },
                    },
                )
                assert manual["payload"]["status"] == "completed"
                assert manual["payload"]["providerRequests"] == 0
                assert hashes(world) != original
                manual_restore = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "manual-restore",
                        "type": "restore.start",
                        "payload": {
                            "worldDir": str(world),
                            "backupSetId": manual["payload"]["backupSetId"],
                        },
                    },
                )
                assert manual_restore["payload"]["status"] == "restored"
                assert hashes(world) == original
                exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "model-change",
                        "type": "settings.set",
                        "payload": {"provider": "openai", "model": "changed-after-scan", "batchSize": 7},
                    },
                )
                # A model or batch-size change does not change which texts a scan finds, so the
                # reviewed scan stays valid and its review work is not thrown away.
                rescan = exchange(
                    proc,
                    {"v": 1, "id": "rescan-same-scope", "type": "scan.start", "payload": {"worldDir": str(world)}},
                )
                assert rescan["payload"]["scanPlanId"] == scan["payload"]["scanPlanId"]
                exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "settings-change",
                        "type": "settings.set",
                        "payload": {"provider": "openai", "model": "fixture", "targetLanguage": "日本語"},
                    },
                )
                invalidated = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "stale-plan",
                        "type": "translate.start",
                        "payload": {
                            "worldDir": str(world),
                            "fingerprint": scan["payload"]["fingerprint"],
                            "scanPlanId": scan["payload"]["scanPlanId"],
                        },
                    },
                )
                assert invalidated["type"] == "response.error"
                assert invalidated["error"]["code"] == "PLAN_INVALIDATED"
                assert hashes(world) == original
                exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "settings-restore",
                        "type": "settings.set",
                        "payload": {"provider": "openai", "model": "fixture", "targetLanguage": "한국어", "batchSize": 40},
                    },
                )
                translation_events: list[dict] = []
                translated = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "translate",
                        "type": "translate.start",
                        "payload": {
                            "worldDir": str(world),
                            "fingerprint": scan["payload"]["fingerprint"],
                            "scanPlanId": scan["payload"]["scanPlanId"],
                        },
                    },
                    translation_events,
                )
                assert translated["payload"]["status"] == "completed"
                assert translated["payload"]["backupSetId"]
                assert any(item["type"] == "translate.progress" for item in translation_events)
                assert hashes(world) != original
                job_bootstrap = exchange(
                    proc,
                    {"v": 1, "id": "last-job-bootstrap", "type": "app.bootstrap", "payload": {"worldDir": str(world), "credentialOwner": "rust"}},
                )
                last_job = job_bootstrap["payload"]["lastJob"]
                assert job_bootstrap["payload"]["lastScan"] == last_scan
                assert job_bootstrap["payload"]["resume"]["lastScan"] == last_scan
                assert last_job["world"] == world.name
                assert last_job["at"] > 0 and last_job["status"] == "completed"
                assert last_job["translated"] == 1 and last_job["failed"] == 0
                assert last_job["changedFiles"] == translated["payload"]["changedFileCount"]
                assert last_job["candidateCount"] == translated["payload"]["candidateCount"]
                backups = exchange(
                    proc,
                    {"v": 1, "id": "backups", "type": "backups.list", "payload": {"worldDir": str(world)}},
                )
                assert backups["payload"]["backups"][0]["backupSetId"] == translated["payload"]["backupSetId"]
                restored = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "restore",
                        "type": "restore.start",
                        "payload": {
                            "worldDir": str(world),
                            "backupSetId": translated["payload"]["backupSetId"],
                        },
                    },
                )
                assert restored["payload"]["status"] == "restored"
                assert restored["payload"]["recoverySetId"]
                assert hashes(world) == original
                resource_pack = world / "resources.zip"
                with zipfile.ZipFile(resource_pack, "w") as archive:
                    archive.writestr("assets/pomi/lang/en_us.json", json.dumps({"pomi.hello": "Pack hello"}))
                inspected_with_pack = exchange(
                    proc,
                    {"v": 1, "id": "inspect-pack", "type": "world.inspect", "payload": {"worldDir": str(world)}},
                )
                assert [str(Path(item).resolve()) for item in inspected_with_pack["payload"]["resourcePacks"]] == [
                    str(resource_pack.resolve())
                ]
                exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "resource-settings",
                        "type": "settings.set",
                        "payload": {
                            "provider": "openai",
                            "model": "fixture",
                            "resourcePackEnabled": True,
                            "temperature": 0.2,
                            "batchSize": 20,
                            "requestTimeout": 60,
                            "rpmLimit": 0,
                            "tpmLimit": 0,
                            "maxBatchRetries": 2,
                        },
                    },
                )
                pack_scan = exchange(
                    proc,
                    {"v": 1, "id": "resource-scan", "type": "scan.start", "payload": {"worldDir": str(world)}},
                )
                assert pack_scan["payload"]["candidateCount"] == 2
                pack_page = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "resource-candidates",
                        "type": "candidates.page",
                        "payload": {"scanPlanId": pack_scan["payload"]["scanPlanId"], "query": "Pack hello"},
                    },
                )
                assert pack_page["payload"]["total"] == 1
                all_pack_candidates = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "resource-all-candidates",
                        "type": "candidates.page",
                        "payload": {"scanPlanId": pack_scan["payload"]["scanPlanId"], "limit": 200},
                    },
                )["payload"]["candidates"]
                pack_original = hashes(world)
                pack_translation = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "resource-translate",
                        "type": "translate.start",
                        "payload": {
                            "worldDir": str(world),
                            "fingerprint": pack_scan["payload"]["fingerprint"],
                            "scanPlanId": pack_scan["payload"]["scanPlanId"],
                            "candidateOverrides": {
                                item["id"]: f"Manual {item['source']}" for item in all_pack_candidates
                            },
                        },
                    },
                )
                assert pack_translation["payload"]["status"] == "completed"
                assert pack_translation["payload"]["providerRequests"] == 0
                assert pack_translation["payload"]["backupSetId"]
                resource_backups = exchange(
                    proc,
                    {"v": 1, "id": "resource-backups", "type": "backups.list", "payload": {"worldDir": str(world)}},
                )
                translated_backup = next(
                    item for item in resource_backups["payload"]["backups"]
                    if item["backupSetId"] == pack_translation["payload"]["backupSetId"]
                )
                assert translated_backup["fileCount"] == 2, {
                    "backup": translated_backup,
                    "translation": pack_translation,
                }
                pack_restored = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "resource-restore",
                        "type": "restore.start",
                        "payload": {
                            "worldDir": str(world),
                            "backupSetId": pack_translation["payload"]["backupSetId"],
                        },
                    },
                )
                assert pack_restored["payload"]["status"] == "restored"
                assert hashes(world) == pack_original
                with zipfile.ZipFile(resource_pack, "w") as archive:
                    archive.writestr("assets/pomi/lang/en_us.json", json.dumps({"pomi.hello": "Pack changed"}))
                pack_invalidated = exchange(
                    proc,
                    {
                        "v": 1,
                        "id": "resource-stale",
                        "type": "translate.start",
                        "payload": {
                            "worldDir": str(world),
                            "fingerprint": pack_scan["payload"]["fingerprint"],
                            "scanPlanId": pack_scan["payload"]["scanPlanId"],
                        },
                    },
                )
                assert pack_invalidated["payload"]["status"] == "invalidated"
            finally:
                proc.kill()
                proc.wait(timeout=5)
        print("DESKTOP_ENTRY_PASSED")
        print("hello_protocol", hello["type"])
        print("scan_candidate_count", scan["payload"]["candidateCount"])
        print("localhost_server", False)
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
