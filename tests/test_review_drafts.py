"""Review drafts: excluded candidates and manual translations saved per scan plan."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mwt import review_drafts  # noqa: E402
from mwt.review_drafts import ReviewDraftError, clear_draft, get_draft, prune_drafts, set_draft  # noqa: E402

PLAN = "ab" * 32
OTHER = "cd" * 32
IDS = [f"{n:020x}" for n in range(1, 8)]


def new_data(tmp: Path, name: str, *plans: str) -> Path:
    data = tmp / name
    (data / "scans").mkdir(parents=True)
    for plan in plans:
        (data / "scans" / f"{plan}.json").write_text("{}", encoding="utf-8")
    return data


def draft_file(data: Path, plan: str = PLAN) -> Path:
    return data / "review-drafts" / f"{plan}.json"


def raises(kind: type, function, *args):
    try:
        function(*args)
    except kind as exc:
        return exc
    raise AssertionError(f"{kind.__name__} was not raised")


def test_round_trip(tmp: Path) -> None:
    data = new_data(tmp, "round", PLAN)
    assert get_draft({"scanPlanId": PLAN}, data) == {
        "scanPlanId": PLAN, "exists": False, "savedAt": 0, "excludedCandidateIds": [], "candidateOverrides": {}}
    long_text = "가" * 32_000
    saved = set_draft({
        "scanPlanId": PLAN,
        "excludedCandidateIds": [IDS[3], IDS[0], IDS[3]],
        "candidateOverrides": {IDS[1]: "  안녕하세요 ☃ \U0001F600 \n", IDS[2]: long_text},
    }, data)
    assert saved["saved"] is True and saved["excludedCount"] == 2 and saved["overrideCount"] == 2
    assert abs(saved["savedAt"] - time.time()) < 60
    got = get_draft({"scanPlanId": PLAN}, data)
    assert got["exists"] is True and got["savedAt"] == saved["savedAt"]
    assert got["excludedCandidateIds"] == [IDS[0], IDS[3]]  # de-duplicated and sorted
    assert got["candidateOverrides"][IDS[1]] == "안녕하세요 ☃ \U0001F600"  # stripped, unicode intact
    assert got["candidateOverrides"][IDS[2]] == long_text
    document = json.loads(draft_file(data).read_text(encoding="utf-8"))
    assert document["version"] == 1 and document["scanPlanId"] == PLAN
    assert list((data / "review-drafts").iterdir()) == [draft_file(data)]  # no temp files left
    # A second save replaces the first.
    set_draft({"scanPlanId": PLAN, "excludedCandidateIds": [IDS[5]], "candidateOverrides": {}}, data)
    again = get_draft({"scanPlanId": PLAN}, data)
    assert again["excludedCandidateIds"] == [IDS[5]] and again["candidateOverrides"] == {}


def test_overrides_are_normalised(tmp: Path) -> None:
    data = new_data(tmp, "norm", PLAN)
    saved = set_draft({"scanPlanId": PLAN, "excludedCandidateIds": [],
                       "candidateOverrides": {IDS[0]: "   \n\t ", IDS[1]: "", IDS[2]: " ok "}}, data)
    assert saved["overrideCount"] == 1
    assert get_draft({"scanPlanId": PLAN}, data)["candidateOverrides"] == {IDS[2]: "ok"}
    # 32_000 after strip is fine even with padding around it.
    set_draft({"scanPlanId": PLAN, "candidateOverrides": {IDS[0]: "  " + "x" * 32_000 + "  "}}, data)
    raises(ValueError, set_draft, {"scanPlanId": PLAN, "candidateOverrides": {IDS[0]: "x" * 32_001}}, data)
    raises(ValueError, set_draft, {"scanPlanId": PLAN, "candidateOverrides": {IDS[0]: 5}}, data)
    raises(ValueError, set_draft, {"scanPlanId": PLAN, "candidateOverrides": [IDS[0]]}, data)
    raises(ValueError, set_draft, {"scanPlanId": PLAN, "excludedCandidateIds": "abc"}, data)
    raises(ValueError, set_draft, {"scanPlanId": PLAN, "candidateOverrides": {IDS[0]: "\ud800"}}, data)
    # The failed saves left the earlier draft alone.
    assert get_draft({"scanPlanId": PLAN}, data)["candidateOverrides"] == {IDS[0]: "x" * 32_000}


def test_bad_ids_rejected(tmp: Path) -> None:
    data = new_data(tmp, "ids", PLAN)
    for bad in ("short", "A" * 20, "g" * 20, IDS[0] + "0", "../" + "a" * 17, 7, None, ""):
        raises(ValueError, set_draft, {"scanPlanId": PLAN, "excludedCandidateIds": [bad]}, data)
        raises(ValueError, set_draft, {"scanPlanId": PLAN, "candidateOverrides": {bad: "x"}}, data)
    assert not (data / "review-drafts").exists()


def test_traversal_plan_ids_rejected(tmp: Path) -> None:
    data = new_data(tmp, "trav", PLAN)
    outside = tmp / "outside.json"
    for bad in ("../outside", "..\\..\\outside", PLAN + "/..", "../" + PLAN, PLAN[:-1], PLAN.upper(),
                PLAN + "x", "", None, 12, str(outside)):
        for function in (get_draft, set_draft, clear_draft):
            raises(ValueError, function, {"scanPlanId": bad}, data)
    raises(ValueError, get_draft, {}, data)
    raises(ValueError, get_draft, [PLAN], data)
    assert not outside.exists() and not (data / "review-drafts").exists()


def test_size_bounds(tmp: Path) -> None:
    data = new_data(tmp, "big", PLAN)
    many = [f"{n:020x}" for n in range(review_drafts.MAX_EXCLUDED + 1)]
    exc = raises(ReviewDraftError, set_draft, {"scanPlanId": PLAN, "excludedCandidateIds": many}, data)
    assert exc.code == "DRAFT_TOO_LARGE" and exc.recoverable is True and exc.message
    overrides = {f"{n:020x}": "x" for n in range(review_drafts.MAX_OVERRIDES + 1)}
    assert raises(ReviewDraftError, set_draft, {"scanPlanId": PLAN, "candidateOverrides": overrides}, data).code == "DRAFT_TOO_LARGE"
    # Within the counts but over 8 MiB serialised: 300 overrides of 32_000 CJK characters (3 bytes each).
    heavy = {f"{n:020x}": "가" * 32_000 for n in range(300)}
    assert raises(ReviewDraftError, set_draft, {"scanPlanId": PLAN, "candidateOverrides": heavy}, data).code == "DRAFT_TOO_LARGE"
    assert not draft_file(data).exists()
    # The bound itself is allowed.
    ok = [f"{n:020x}" for n in range(review_drafts.MAX_EXCLUDED)]
    assert set_draft({"scanPlanId": PLAN, "excludedCandidateIds": ok}, data)["excludedCount"] == review_drafts.MAX_EXCLUDED
    assert draft_file(data).stat().st_size <= review_drafts.MAX_DOCUMENT_BYTES


def test_plan_missing(tmp: Path) -> None:
    data = new_data(tmp, "noplan")
    exc = raises(ReviewDraftError, set_draft, {"scanPlanId": PLAN, "excludedCandidateIds": [IDS[0]]}, data)
    assert exc.code == "PLAN_NOT_FOUND"
    assert not (data / "review-drafts").exists()
    assert "PLAN_NOT_FOUND" in review_drafts.ERROR_CODES and "DRAFT_TOO_LARGE" in review_drafts.ERROR_CODES


def test_stale_draft_removed_on_get(tmp: Path) -> None:
    data = new_data(tmp, "stale", PLAN, OTHER)
    set_draft({"scanPlanId": PLAN, "excludedCandidateIds": [IDS[0]]}, data)
    set_draft({"scanPlanId": OTHER, "excludedCandidateIds": [IDS[1]]}, data)
    (data / "scans" / f"{PLAN}.json").unlink()
    got = get_draft({"scanPlanId": PLAN}, data)
    assert got["exists"] is False and got["excludedCandidateIds"] == []
    assert not draft_file(data).exists()
    assert get_draft({"scanPlanId": OTHER}, data)["exists"] is True


def test_damaged_file_handled(tmp: Path) -> None:
    data = new_data(tmp, "damaged", PLAN)
    path = draft_file(data)
    path.parent.mkdir(parents=True)
    bad_documents = [
        b"{not json",
        b"\xff\xfe\x00",
        b"[1, 2]",
        json.dumps({"version": 1, "scanPlanId": PLAN, "savedAt": 1.0, "excludedCandidateIds": ["nope"],
                    "candidateOverrides": {}}).encode(),
        json.dumps({"version": 1, "scanPlanId": OTHER, "savedAt": 1.0, "excludedCandidateIds": [],
                    "candidateOverrides": {}}).encode(),
        json.dumps({"version": 1, "scanPlanId": PLAN, "savedAt": "x", "excludedCandidateIds": [],
                    "candidateOverrides": {}}).encode(),
    ]
    for index, raw in enumerate(bad_documents):
        path.write_bytes(raw)
        got = get_draft({"scanPlanId": PLAN}, data)
        assert got["exists"] is False and got["excludedCandidateIds"] == [] and got["candidateOverrides"] == {}
        assert not path.exists(), index
        kept = sorted(path.parent.glob(f"{PLAN}.json.damaged-*"))
        assert kept and kept[-1].read_bytes() == raw
        for item in kept:
            item.unlink()
    # A draft from another version is reported as absent but left in place.
    path.write_text(json.dumps({"version": 2, "future": True}), encoding="utf-8")
    assert get_draft({"scanPlanId": PLAN}, data)["exists"] is False
    assert path.is_file() and not list(path.parent.glob("*.damaged-*"))
    # Saving over a damaged file works.
    path.write_bytes(b"{")
    set_draft({"scanPlanId": PLAN, "excludedCandidateIds": [IDS[0]]}, data)
    assert get_draft({"scanPlanId": PLAN}, data)["excludedCandidateIds"] == [IDS[0]]


def test_empty_draft_removes_file(tmp: Path) -> None:
    data = new_data(tmp, "empty", PLAN)
    set_draft({"scanPlanId": PLAN, "excludedCandidateIds": [IDS[0]]}, data)
    assert draft_file(data).is_file()
    result = set_draft({"scanPlanId": PLAN, "excludedCandidateIds": [], "candidateOverrides": {IDS[1]: "  "}}, data)
    assert result == {"saved": False, "savedAt": 0.0, "excludedCount": 0, "overrideCount": 0}
    assert not draft_file(data).exists()
    assert set_draft({"scanPlanId": PLAN}, data)["saved"] is False  # nothing to remove is fine too


def test_clear(tmp: Path) -> None:
    data = new_data(tmp, "clear", PLAN, OTHER)
    set_draft({"scanPlanId": PLAN, "excludedCandidateIds": [IDS[0]]}, data)
    set_draft({"scanPlanId": OTHER, "excludedCandidateIds": [IDS[0]]}, data)
    assert clear_draft({"scanPlanId": PLAN}, data) == {"cleared": True}
    assert clear_draft({"scanPlanId": PLAN}, data) == {"cleared": False}
    assert not draft_file(data).exists() and draft_file(data, OTHER).is_file()
    assert clear_draft({"scanPlanId": OTHER}, new_data(tmp, "clear2", OTHER)) == {"cleared": False}


def test_prune(tmp: Path) -> None:
    plans = [f"{n:064x}" for n in range(1, 7)]
    data = new_data(tmp, "prune", *plans)
    assert prune_drafts(tmp / "nowhere") == 0
    assert prune_drafts(data) == 0
    for number, plan in enumerate(plans):
        set_draft({"scanPlanId": plan, "excludedCandidateIds": [IDS[0]]}, data)
        stamp = time.time() - (len(plans) - number) * 100  # later plans are newer
        os.utime(draft_file(data, plan), (stamp, stamp))
    (data / "scans" / f"{plans[0]}.json").unlink()  # its plan is gone
    (data / "scans" / f"{plans[5]}.json").unlink()  # newest, but also gone
    folder = data / "review-drafts"
    (folder / "notes.txt").write_text("not ours", encoding="utf-8")
    old = time.time() - 40 * 24 * 3600
    damaged_old = folder / f"{plans[1]}.json.damaged-1"
    damaged_new = folder / f"{plans[1]}.json.damaged-2"
    for item in (damaged_old, damaged_new):
        item.write_text("x", encoding="utf-8")
    os.utime(damaged_old, (old, old))
    assert prune_drafts(data, keep=2) == 2 + 2  # two orphans, then the two oldest of the four left
    left = sorted(path.name for path in folder.glob("*.json"))
    assert left == sorted(f"{plan}.json" for plan in plans[3:5])
    assert not damaged_old.exists() and damaged_new.exists() and (folder / "notes.txt").exists()
    assert prune_drafts(data, keep=0) == 2
    assert not list(folder.glob("*.json"))
    assert prune_drafts(data) == 0


TESTS = [
    test_round_trip,
    test_overrides_are_normalised,
    test_bad_ids_rejected,
    test_traversal_plan_ids_rejected,
    test_size_bounds,
    test_plan_missing,
    test_stale_draft_removed_on_get,
    test_damaged_file_handled,
    test_empty_draft_removes_file,
    test_clear,
    test_prune,
]


def main() -> None:
    with tempfile.TemporaryDirectory() as temp:
        tmp = Path(temp)
        for test in TESTS:
            test(tmp)
            print("PASS", test.__name__)
    print(f"{len(TESTS)} review draft tests")
    print("REVIEW_DRAFTS_PASSED")


if __name__ == "__main__":
    main()
