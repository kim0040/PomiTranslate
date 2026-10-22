"""Review drafts and backup administration answer through the desktop JSONL dispatch."""

from __future__ import annotations

import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mwt.desktop_entry import REQUEST_HANDLERS, handle  # noqa: E402

PLAN = "a" * 64
C1, C2 = "1" * 20, "2" * 20


def call(data_dir: Path, kind: str, payload: dict) -> dict:
    out = io.StringIO()
    with redirect_stdout(out):
        handle({"v": 1, "id": "t", "type": kind, "payload": payload}, data_dir / "reports", data_dir)
    lines = [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]
    return lines[-1]


def test_every_new_request_type_is_registered() -> None:
    for kind in ("review.draft.get", "review.draft.set", "review.draft.clear", "backups.delete", "backups.prune", "recovery.start"):
        assert kind in REQUEST_HANDLERS, kind


def test_review_draft_round_trip(data: Path) -> None:
    (data / "scans").mkdir(parents=True)
    (data / "scans" / f"{PLAN}.json").write_text("{}", encoding="utf-8")
    empty = call(data, "review.draft.get", {"scanPlanId": PLAN})
    assert empty["type"] == "response.ok" and empty["payload"]["exists"] is False, empty
    saved = call(data, "review.draft.set", {"scanPlanId": PLAN, "excludedCandidateIds": [C1], "candidateOverrides": {C2: "번역"}})
    assert saved["type"] == "response.ok", saved
    loaded = call(data, "review.draft.get", {"scanPlanId": PLAN})["payload"]
    assert loaded["exists"] and loaded["excludedCandidateIds"] == [C1] and loaded["candidateOverrides"] == {C2: "번역"}, loaded
    assert call(data, "review.draft.clear", {"scanPlanId": PLAN})["type"] == "response.ok"
    assert call(data, "review.draft.get", {"scanPlanId": PLAN})["payload"]["exists"] is False


def test_refusals_come_back_as_coded_errors(data: Path) -> None:
    world = data.parent / "world"
    world.mkdir()
    (world / "level.dat").write_bytes(b"\x00")
    missing = call(data, "backups.delete", {"worldDir": str(world), "backupSetId": "20260101T000000Z-000000000000-translation"})
    assert missing["type"] == "response.error" and missing["error"]["code"] == "BACKUP_NOT_FOUND", missing
    listing = call(data, "backups.list", {"worldDir": str(world)})
    assert listing["type"] == "response.ok" and set(listing["payload"]["usage"]) >= {"worldBytes", "worldCount", "lastCopyIds"}, listing


def main() -> None:
    test_every_new_request_type_is_registered()
    print("PASS test_every_new_request_type_is_registered")
    for test in (test_review_draft_round_trip, test_refusals_come_back_as_coded_errors):
        with tempfile.TemporaryDirectory() as raw:
            test(Path(raw) / "data")
        print("PASS", test.__name__)
    print("DESKTOP_DISPATCH_PASSED")


if __name__ == "__main__":
    main()
