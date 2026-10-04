"""Saved preferences survive damage, app state lives with them, and a reset keeps world backups."""

from __future__ import annotations

import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mwt.desktop_entry import handle  # noqa: E402
from mwt.userdata import (  # noqa: E402
    APP_PREF_DEFAULTS,
    load_app_prefs,
    load_last_job,
    load_user_settings,
    remember_app_prefs,
    remember_last_job,
    remember_model_catalog,
    remember_user_settings,
    settings_path,
)


def call(data_dir: Path, kind: str, payload: dict) -> dict:
    out = io.StringIO()
    with redirect_stdout(out):
        try:
            handle({"v": 1, "id": "t", "type": kind, "payload": payload}, data_dir / "reports", data_dir)
        except ValueError as error:
            return {"type": "error", "message": str(error)}
    lines = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
    return lines[-1]


def main() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw) / "PomiTranslate"

        # A damaged settings file falls back to the copy written with it, and is kept for inspection.
        remember_user_settings({"provider": "gemini", "model": "gemini-3.8-flash", "target_language": "한국어"}, root)
        settings_path(root).write_text('{"provider": "gem', encoding="utf-8")
        recovered = load_user_settings(root)
        assert recovered["model"] == "gemini-3.8-flash", recovered
        damaged = list(root.glob("settings.damaged-*.json"))
        assert len(damaged) == 1 and damaged[0].read_text(encoding="utf-8") == '{"provider": "gem'
        remember_user_settings({"temperature": 0.2}, root)
        assert load_user_settings(root)["model"] == "gemini-3.8-flash", "the next save keeps what the copy held"
        assert json.loads(settings_path(root).read_text(encoding="utf-8"))["temperature"] == 0.2

        # A missing main file (deleted by hand or a cleaner) also comes back from the copy.
        settings_path(root).unlink()
        assert load_user_settings(root)["provider"] == "gemini"
        assert not list(root.glob("*.tmp")), "no temporary files are left behind"

        # App state: validated, durable, merged with defaults; a settings save keeps it.
        assert load_app_prefs(root) == APP_PREF_DEFAULTS
        assert APP_PREF_DEFAULTS["notify_on_finish"] is True
        prefs = remember_app_prefs({"theme": "dark", "notice_accepted": True, "notify_on_finish": False}, root)
        assert prefs["theme"] == "dark" and prefs["notice_accepted"] and prefs["update_auto_check"] is True
        assert prefs["notify_on_finish"] is False
        remember_user_settings({"model": "other"}, root)
        assert load_app_prefs(root)["theme"] == "dark", "a settings save must not drop app state"
        for bad in ({"theme": "neon"}, {"notice_accepted": "yes"}, {"notify_on_finish": "yes"}, {"unknown": 1}, {"update_last_check": -1}):
            try:
                remember_app_prefs(bad, root)
            except ValueError:
                continue
            raise AssertionError(f"accepted invalid prefs {bad}")
        response = call(root, "prefs.set", {"prefs": {"tutorial_seen": True}})
        assert response["type"] == "response.ok" and response["payload"]["prefs"]["tutorial_seen"] is True
        boot = call(root, "app.bootstrap", {"credentialOwner": "rust"})
        assert boot["payload"]["prefs"]["theme"] == "dark" and boot["payload"]["prefs"]["tutorial_seen"] is True
        summary = remember_last_job(
            Path("/synthetic/world"),
            {"status": "partial", "translation": {"translated": 4, "failed": 2}, "changed_file_count": 3, "candidate_text_count": 8},
            root,
            now=1791064800,
        )
        assert summary == {"at": 1791064800.0, "status": "partial", "translated": 4, "failed": 2, "changedFiles": 3, "candidateCount": 8}
        assert load_last_job(Path("/synthetic/world"), root) == {
            "world": "world", "at": 1791064800.0, "status": "partial", "translated": 4,
            "failed": 2, "changedFiles": 3, "candidateCount": 8,
        }

        # Reset: needs an explicit confirmation, removes app state, keeps backups and damaged copies.
        remember_model_catalog("openrouter", [{"id": "m"}], root)
        for folder in ("scans", "jobs"):
            (root / folder).mkdir(exist_ok=True)
            (root / folder / "x.json").write_text("{}", encoding="utf-8")
        backup = root / "backups" / "world-123" / "set" / "region.mca"
        backup.parent.mkdir(parents=True)
        backup.write_bytes(b"backup bytes")
        outside = Path(raw) / "outside"
        outside.mkdir()
        (outside / "keep.txt").write_text("keep", encoding="utf-8")
        (root / "models").rename(root / "models-real")
        (root / "models").symlink_to(outside, target_is_directory=True)

        assert call(root, "app.reset", {})["type"] == "error", "a reset without confirmation is refused"
        assert load_user_settings(root)["provider"] == "gemini"
        response = call(root, "app.reset", {"confirm": "reset"})
        assert response["type"] == "response.ok", response
        assert set(response["payload"]["removed"]) >= {"settings.json", "settings.backup.json", "scans", "jobs", "models"}
        assert response["payload"]["kept"] == ["backups"]
        assert load_user_settings(root) == {} and load_app_prefs(root) == APP_PREF_DEFAULTS
        assert backup.read_bytes() == b"backup bytes", "world backups survive a reset"
        assert (outside / "keep.txt").read_text(encoding="utf-8") == "keep", "a link is removed, never followed"
        assert list(root.glob("settings.damaged-*.json")), "the damaged copy stays for the person to inspect"
    print("USER_DATA_DURABILITY_PASSED")


if __name__ == "__main__":
    main()
