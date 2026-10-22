"""Glossary store and requests: round trip, conflicts, bad input, damaged files, limits, CSV/TSV."""

from __future__ import annotations

import io
import json
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mwt import glossary  # noqa: E402
from mwt.desktop_entry import REQUEST_HANDLERS, handle  # noqa: E402
from mwt.journal import world_key  # noqa: E402


def call(data: Path, kind: str, payload: dict) -> dict:
    out = io.StringIO()
    with redirect_stdout(out):
        handle({"v": 1, "id": "t", "type": kind, "payload": payload}, data / "reports", data)
    return [json.loads(line) for line in out.getvalue().splitlines() if line.strip()][-1]


def ok(data: Path, kind: str, payload: dict) -> dict:
    reply = call(data, kind, payload)
    assert reply["type"] == "response.ok", reply
    return reply["payload"]


def refused(data: Path, kind: str, payload: dict, code: str) -> str:
    reply = call(data, kind, payload)
    assert reply["type"] == "response.error" and reply["error"]["code"] == code, reply
    return reply["error"]["message"]


def entry(source: str, target: str = "", mode: str = "translate", **more) -> dict:
    return {"source": source, "target": target, "mode": mode, **more}


def test_requests_are_registered() -> None:
    for kind in ("glossary.get", "glossary.set", "glossary.import", "glossary.export"):
        assert kind in REQUEST_HANDLERS, kind


def test_round_trip_global_and_world(data: Path) -> None:
    empty = ok(data, "glossary.get", {"scope": "global"})
    assert empty["revision"] == 0 and empty["entries"] == [], empty
    saved = ok(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": [
        entry("Elder Mira", mode="keep", note="NPC 이름"),
        entry("crypt", "지하실", caseSensitive=True),
    ]})
    assert saved["revision"] == 1 and len(saved["entries"]) == 2, saved
    first = saved["entries"][0]
    assert len(first["id"]) == 20 and set(first) == {"id", "source", "target", "mode", "caseSensitive", "note"}, first
    assert first["note"] == "NPC 이름" and first["caseSensitive"] is False and saved["entries"][1]["caseSensitive"] is True
    assert ok(data, "glossary.get", {"scope": "global"})["entries"] == saved["entries"]
    assert (data / "glossary" / "global.json").is_file()

    world = data.parent / "world"
    world.mkdir()
    ok(data, "glossary.set", {"scope": "world", "worldDir": str(world), "baseRevision": 0, "entries": [entry("crypt", "묘실")]})
    assert (data / "glossary" / "worlds" / f"{world_key(world)}.json").is_file()
    # The other scope and other worlds are untouched.
    assert ok(data, "glossary.get", {"scope": "global"})["entries"][1]["target"] == "지하실"
    other = data.parent / "other"
    other.mkdir()
    assert ok(data, "glossary.get", {"scope": "world", "worldDir": str(other)})["entries"] == []
    merged = glossary.load_merged(data, world)
    assert {item["source"]: item["target"] for item in merged} == {"Elder Mira": "", "crypt": "묘실"}, merged
    assert glossary.load_merged(data, None)[1]["target"] == "지하실"


def test_set_keeps_ids_and_stale_revision_conflicts(data: Path) -> None:
    saved = ok(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": [entry("Mira", mode="keep")]})
    kept = saved["entries"][0]
    again = ok(data, "glossary.set", {"scope": "global", "baseRevision": 1, "entries": [kept, entry("Tom", "톰")]})
    assert again["revision"] == 2 and again["entries"][0]["id"] == kept["id"]
    message = refused(data, "glossary.set", {"scope": "global", "baseRevision": 1, "entries": []}, "GLOSSARY_CONFLICT")
    assert "revision 2" in message, message
    assert len(ok(data, "glossary.get", {"scope": "global"})["entries"]) == 2, "a conflicting write changes nothing"


def test_invalid_input_names_the_field(data: Path) -> None:
    def invalid(entries, path: str, **more) -> None:
        message = refused(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": entries, **more}, "GLOSSARY_INVALID")
        assert message.startswith(path + ":"), message

    invalid([entry("a", "b"), entry("")], "entries[1].source")
    invalid([entry("x" * 201, "b")], "entries[0].source")
    invalid([entry("a", "t" * 201)], "entries[0].target")
    invalid([entry("a", "b", note="n" * 301)], "entries[0].note")
    invalid([entry("a", "b", mode="skip")], "entries[0].mode")
    invalid([entry("a", "")], "entries[0].target")  # translate needs a target
    invalid([entry("a", "b", caseSensitive="yes")], "entries[0].caseSensitive")
    invalid([entry("a\nb", "c")], "entries[0].source")
    invalid([entry("Mira", "미라"), entry("mira", "마이라")], "entries[1].source")  # case-folded duplicate
    invalid([{"source": "a", "target": "b", "id": "nothex"}], "entries[0].id")
    invalid("nope", "entries")
    refused(data, "glossary.set", {"scope": "galaxy", "baseRevision": 0, "entries": []}, "GLOSSARY_INVALID")
    refused(data, "glossary.set", {"scope": "world", "baseRevision": 0, "entries": []}, "GLOSSARY_INVALID")  # no worldDir
    refused(data, "glossary.set", {"scope": "global", "baseRevision": "0", "entries": []}, "GLOSSARY_INVALID")
    # Case-sensitive entries may differ only by case.
    ok(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": [
        entry("Mira", "미라", caseSensitive=True), entry("mira", "마이라", caseSensitive=True)]})
    assert len(ok(data, "glossary.get", {"scope": "global"})["entries"]) == 2


def test_limits(data: Path) -> None:
    many = [entry(f"term{i}", f"용어{i}") for i in range(glossary.MAX_ENTRIES)]
    saved = ok(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": many})
    assert len(saved["entries"]) == 2000
    message = refused(data, "glossary.set", {"scope": "global", "baseRevision": 1, "entries": many + [entry("extra", "e")]}, "GLOSSARY_INVALID")
    assert message.startswith("entries:"), message
    edge = [entry("é" * 200, "t" * 200, note="n" * 300)]
    assert ok(data, "glossary.set", {"scope": "global", "baseRevision": 1, "entries": edge})["revision"] == 2


def test_damaged_file_is_kept_aside_and_treated_as_empty(data: Path) -> None:
    root = data / "glossary"
    root.mkdir(parents=True)
    path = root / "global.json"
    path.write_text('{"version":1,"revision":3,"entries":[', encoding="utf-8")
    assert glossary.load_merged(data, None) == [], "a translation is never stopped by a damaged glossary"
    asides = list(root.glob("global.damaged-*.json"))
    assert len(asides) == 1 and asides[0].read_text(encoding="utf-8").startswith('{"version"'), asides
    assert not path.exists()
    assert ok(data, "glossary.get", {"scope": "global"})["revision"] == 0
    # Valid JSON of the wrong shape, an unknown version and bytes that are not UTF-8 are damaged too.
    for number, content in enumerate((b'{"version":1,"revision":1,"updatedAt":1,"entries":[{"source":""}]}', b'{"version":2}', b"\xff\xfe\x00bad")):
        path.write_bytes(content)
        assert ok(data, "glossary.get", {"scope": "global"})["entries"] == [], content
        assert not path.exists(), content
    assert len(list(root.glob("global.damaged-*.json"))) == 4
    # The next save starts again at revision 1, beside the kept copies.
    assert ok(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": [entry("a", "b")]})["revision"] == 1


def test_job_config_carries_the_merged_glossary(data: Path) -> None:
    import mc_world_translator
    from mwt.desktop_entry import _run_translator

    world = data.parent / "world"
    world.mkdir()
    ok(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": [entry("crypt", "지하실"), entry("Zed", mode="keep")]})
    ok(data, "glossary.set", {"scope": "world", "worldDir": str(world), "baseRevision": 0, "entries": [entry("Crypt", "묘실")]})
    seen: list[dict] = []

    class Capture:
        def __init__(self, config, **_kwargs) -> None:
            seen.append(config)
            self.occurrences, self._candidate_order = {}, []

        def run(self) -> dict:
            return {"status": "completed", "warnings": []}

    original = mc_world_translator.WorldTranslator
    mc_world_translator.WorldTranslator = Capture
    try:
        _run_translator(world, dry_run=True, report_path=data / "reports" / "r.json", data_dir=data)
    finally:
        mc_world_translator.WorldTranslator = original
    entries = {item["source"]: item for item in seen[0]["glossary"]["entries"]}
    assert set(entries) == {"Crypt", "Zed"} and entries["Crypt"]["target"] == "묘실", "the world entry replaces the global one"


def test_import_csv_merge(data: Path) -> None:
    ok(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": [entry("Mira", "미라", note="old"), entry("Tom", "톰")]})
    base = ok(data, "glossary.get", {"scope": "global"})
    mira_id = base["entries"][0]["id"]
    text = (
        "﻿source,target,mode,note\r\n"
        'mira,"마이라, 장로",translate,"say ""hi""\nsecond line"\r\n'   # updates Mira (case-folded), keeps its id
        "Tom,톰,translate,\r\n"                                          # unchanged
        "Zed,,keep,\r\n"                                                # new keep entry
        "Quote \"Q\",큐,,\r\n"                                          # new, mode inferred, quote inside an unquoted field
        ",nothing,translate,\r\n"                                       # empty source
        "Bad,x,sideways,\r\n"                                           # invalid mode
        "NoTarget,,translate,\r\n"                                      # translate without target
        "zed,again,translate,\r\n"                                      # duplicate of Zed in the same file
        "\r\n"
    )
    result = ok(data, "glossary.import", {"scope": "global", "baseRevision": base["revision"], "format": "csv", "mode": "merge", "text": text})
    assert (result["added"], result["updated"], result["unchanged"]) == (2, 1, 1), result
    reasons = {item["reason"] for item in result["skipped"]}
    assert reasons == {"empty_source", "invalid_mode", "missing_target", "duplicate_in_file"} and result["skippedCount"] == 4, result
    assert all(item["row"] > 1 for item in result["skipped"]), result["skipped"]
    by_source = {item["source"]: item for item in result["entries"]}
    assert by_source["mira"]["id"] == mira_id, "an update keeps the entry (and takes the file's spelling)"
    assert by_source["mira"]["target"] == "마이라, 장로" and by_source["mira"]["note"] == 'say "hi"\nsecond line'
    assert by_source["Zed"]["mode"] == "keep" and by_source['Quote "Q"']["mode"] == "translate"
    assert result["revision"] == base["revision"] + 1
    refused(data, "glossary.import", {"scope": "global", "baseRevision": 0, "format": "csv", "text": "a,b"}, "GLOSSARY_CONFLICT")


def test_import_tsv_replace_and_no_header(data: Path) -> None:
    ok(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": [entry("Old", "옛"), entry("Keep", "유지")]})
    text = "Keep\t유지\ttranslate\t\nNew\t새것\ttranslate\t\"two\tcolumns\nand lines\"\n"
    result = ok(data, "glossary.import", {"scope": "global", "baseRevision": 1, "format": "tsv", "mode": "replace", "text": text})
    assert result["removed"] == 1 and result["added"] == 1 and result["unchanged"] == 1, result
    assert [item["source"] for item in result["entries"]] == ["Keep", "New"]
    assert result["entries"][1]["note"] == "two\tcolumns\nand lines"
    # A replace that would leave nothing is refused instead of wiping the glossary.
    message = refused(data, "glossary.import", {"scope": "global", "baseRevision": 2, "format": "tsv", "mode": "replace", "text": "source\ttarget\n"}, "GLOSSARY_INVALID")
    assert message.startswith("text:"), message
    assert len(ok(data, "glossary.get", {"scope": "global"})["entries"]) == 2
    refused(data, "glossary.import", {"scope": "global", "baseRevision": 2, "format": "xls", "text": ""}, "GLOSSARY_INVALID")


def test_import_respects_the_entry_limit(data: Path) -> None:
    rows = "".join(f"t{i},v{i}\n" for i in range(glossary.MAX_ENTRIES + 3))
    result = ok(data, "glossary.import", {"scope": "global", "baseRevision": 0, "format": "csv", "text": rows})
    assert result["added"] == 2000 and result["skippedCount"] == 3 and {item["reason"] for item in result["skipped"]} == {"limit"}, result


def test_export_round_trip(data: Path) -> None:
    entries = [
        entry("Elder, Mira", "장로 미라", note='She said "no"\nthen left', caseSensitive=True),
        entry("Zed", mode="keep"),
        entry("Tab", "탭", note="a\tb"),
    ]
    ok(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": entries})
    for fmt in ("csv", "tsv"):
        exported = ok(data, "glossary.export", {"scope": "global", "format": fmt})
        assert exported["count"] == 3 and exported["text"].startswith("﻿source"), exported
        with tempfile.TemporaryDirectory() as raw:
            second = Path(raw) / "data"
            result = ok(second, "glossary.import", {"scope": "global", "baseRevision": 0, "format": fmt, "text": exported["text"]})
            assert result["added"] == 3 and result["skippedCount"] == 0, result
            for before, after in zip(ok(data, "glossary.get", {"scope": "global"})["entries"], result["entries"]):
                assert {k: v for k, v in before.items() if k != "id"} == {k: v for k, v in after.items() if k != "id"}
    # Without a BOM the same text imports the same way.
    plain = exported["text"][1:]
    with tempfile.TemporaryDirectory() as raw:
        assert ok(Path(raw) / "d", "glossary.import", {"scope": "global", "baseRevision": 0, "format": "tsv", "text": plain})["added"] == 3


def main() -> None:
    test_requests_are_registered()
    print("PASS test_requests_are_registered")
    tests = (
        test_round_trip_global_and_world, test_set_keeps_ids_and_stale_revision_conflicts, test_invalid_input_names_the_field,
        test_limits, test_damaged_file_is_kept_aside_and_treated_as_empty, test_job_config_carries_the_merged_glossary,
        test_import_csv_merge,
        test_import_tsv_replace_and_no_header, test_import_respects_the_entry_limit, test_export_round_trip,
    )
    for test in tests:
        with tempfile.TemporaryDirectory() as raw:
            test(Path(raw) / "data")
        print("PASS", test.__name__)
    print(f"GLOSSARY_PASSED ({len(tests) + 1} tests)")


if __name__ == "__main__":
    main()
