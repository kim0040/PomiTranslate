"""Glossary store and requests: round trip, conflicts, bad input, damaged files, limits, CSV/TSV."""

from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
import threading
import time
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


# ------------------------------------------------------------------ review fixes (H1, M1, M5, M6, M11, L2)

def test_a_full_limit_non_bmp_glossary_reads_back(data: Path) -> None:
    """H1: a glossary at every schema limit, in 4-byte characters, is larger than the old read limit."""
    sources = [chr(0x1F300 + i // 40) + chr(0x1F300 + i % 40) + chr(0x1F600) * 198 for i in range(glossary.MAX_ENTRIES)]
    assert len(set(sources)) == glossary.MAX_ENTRIES and all(len(source) == 200 for source in sources)
    entries = [entry(source, chr(0x1F680) * 200, note=chr(0x1F681) * 300) for source in sources]
    saved = glossary.set_glossary({"scope": "global", "baseRevision": 0, "entries": entries}, data)
    assert saved["revision"] == 1 and len(saved["entries"]) == glossary.MAX_ENTRIES
    size = (data / "glossary" / "global.json").stat().st_size
    assert size > 4 * 1024 * 1024, "the case the old 4 MiB limit refused"
    assert size <= glossary.MAX_DOCUMENT_BYTES
    again = glossary.get_glossary({"scope": "global"}, data)
    assert again["revision"] == 1 and [item["source"] for item in again["entries"]] == sources
    assert again["entries"][-1]["target"] == chr(0x1F680) * 200 and again["entries"][-1]["note"] == chr(0x1F681) * 300
    assert not list((data / "glossary").glob("*.damaged-*")), "a saved glossary is never moved aside"
    assert len(glossary.load_merged(data, None)) == glossary.MAX_ENTRIES
    # The worst case the schema allows (every character four bytes, a quote or newline two) fits with room.
    worst = len(json.dumps(
        {"version": 1, "revision": 2**53 - 1, "updatedAt": 1.7e9, "entries": [
            {"id": "f" * 20, "source": "𝒜" * 200, "target": "𝒜" * 200, "mode": "translate", "caseSensitive": False, "note": "𝒜" * 300}
        ] * glossary.MAX_ENTRIES}, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    assert worst <= glossary.MAX_DOCUMENT_BYTES, (worst, glossary.MAX_DOCUMENT_BYTES)


def test_the_writer_never_publishes_what_the_reader_refuses(data: Path) -> None:
    original = glossary.MAX_DOCUMENT_BYTES
    glossary.MAX_DOCUMENT_BYTES = 100
    try:
        message = refused(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": [entry("a", "b")]}, "GLOSSARY_INVALID")
    finally:
        glossary.MAX_DOCUMENT_BYTES = original
    assert message.startswith("entries:") and "too large" in message, message
    assert not (data / "glossary" / "global.json").exists()


def test_export_neutralizes_formulas_and_import_restores_them(data: Path) -> None:
    """M1: nothing a spreadsheet would run as a formula leaves export, and export then import is exact."""
    import csv

    entries = [
        entry("=1+1", "+1+1", note="@SUM(1,2)"),
        entry("-5 HP", "-5 체력", note="line\n=second line is fine"),
        entry("'=already quoted", "'+x"),
        entry("''@two quotes", "plain"),
        entry("fine", "it's -ok", note="'quoted text'"),
    ]
    ok(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": entries})
    stored = ok(data, "glossary.get", {"scope": "global"})["entries"]
    for fmt in ("csv", "tsv"):
        exported = ok(data, "glossary.export", {"scope": "global", "format": fmt})["text"]
        rows = list(csv.reader(io.StringIO(exported[1:], newline=""), delimiter="\t" if fmt == "tsv" else ","))
        assert rows[0] == ["source", "target", "mode", "note", "caseSensitive"]
        for row in rows[1:]:
            for cell in (row[0], row[1], row[3]):
                assert cell[:1] not in ("=", "+", "-", "@", "\t", "\r"), (fmt, row)
        assert rows[1][:2] == ["'=1+1", "'+1+1"] and rows[1][3] == "'@SUM(1,2)", rows[1]
        assert rows[3][0] == "''=already quoted", rows[3]
        assert rows[5][:2] == ["fine", "it's -ok"], "a text that merely contains a quote is left alone"
        with tempfile.TemporaryDirectory() as raw:
            result = ok(Path(raw) / "data", "glossary.import", {"scope": "global", "baseRevision": 0, "format": fmt, "text": exported})
            assert result["added"] == len(entries) and result["skippedCount"] == 0, result
            for before, after in zip(stored, result["entries"]):
                assert {k: v for k, v in before.items() if k != "id"} == {k: v for k, v in after.items() if k != "id"}, (fmt, before, after)
    for lead in ("=", "+", "-", "@", "\t", "\r"):
        assert glossary._guard_cell(lead + "x") == "'" + lead + "x" and glossary._unguard_cell("'" + lead + "x") == lead + "x"
    assert glossary._guard_cell("plain") == "plain" == glossary._unguard_cell("plain") and glossary._guard_cell("") == ""
    # A hand-written file with a protective apostrophe imports the way a spreadsheet user means it.
    imported = ok(data, "glossary.import", {"scope": "global", "baseRevision": 1, "format": "csv", "mode": "replace",
                                            "text": "source,target\n'=Sum,'+Total\n"})
    assert (imported["entries"][0]["source"], imported["entries"][0]["target"]) == ("=Sum", "+Total")


def test_sources_clash_under_one_folding_rule(data: Path) -> None:
    """M4/M5: duplicates are judged by the folded source, also across sensitivities and expanding folds."""
    def invalid(entries, path: str) -> None:
        message = refused(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": entries}, "GLOSSARY_INVALID")
        assert message.startswith(path + ":"), message

    invalid([entry("MIRA", "a", caseSensitive=True), entry("mira", "b")], "entries[1].source")
    invalid([entry("mira", "b"), entry("MIRA", "a", caseSensitive=True)], "entries[1].source")
    invalid([entry("Straße", "a"), entry("STRASSE", "b")], "entries[1].source")
    ok(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": [
        entry("MIRA", "a", caseSensitive=True), entry("Mira", "b", caseSensitive=True)]})
    # An import row that ignores case stands for both spellings, and replaces them.
    result = ok(data, "glossary.import", {"scope": "global", "baseRevision": 1, "format": "csv", "text": "mira,m,translate,,false\n"})
    assert (result["updated"], result["removed"], len(result["entries"])) == (1, 1, 1), result


def test_a_world_entry_replaces_the_global_entry_of_the_same_folded_source(data: Path) -> None:
    """M5 + M10 through the stored files: precedence ignores sensitivity, merged ids carry their scope."""
    world = data.parent / "world"
    world.mkdir()
    ok(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": [entry("Mira", "GLOBAL"), entry("only", "g")]})
    ok(data, "glossary.set", {"scope": "world", "worldDir": str(world), "baseRevision": 0, "entries": [entry("MIRA", "WORLD", caseSensitive=True)]})
    global_id = ok(data, "glossary.get", {"scope": "global"})["entries"][0]["id"]
    world_id = ok(data, "glossary.get", {"scope": "world", "worldDir": str(world)})["entries"][0]["id"]
    merged = glossary.load_merged(data, world)
    assert {item["source"]: item["target"] for item in merged} == {"only": "g", "MIRA": "WORLD"}, merged
    ids = {item["source"]: item["id"] for item in merged}
    only_id = ok(data, "glossary.get", {"scope": "global"})["entries"][1]["id"]
    assert ids == {"MIRA": f"world:{world_id}", "only": f"global:{only_id}"}, ids
    assert not any(item["id"] == f"global:{global_id}" for item in merged), "the replaced global entry is gone"
    # Two entries that happen to share an id in different files stay distinct.
    same = {"id": "a" * 20, "source": "x", "target": "1", "mode": "translate", "caseSensitive": False, "note": ""}
    both = glossary.merge_entries([same], [{**same, "source": "y"}])
    assert [item["id"] for item in both] == ["global:" + "a" * 20, "world:" + "a" * 20]


def test_invalid_unicode_and_malformed_metadata_get_stable_answers(data: Path) -> None:
    """M6: a lone surrogate or an odd stored number is GLOSSARY_INVALID / a kept-aside file, never a crash."""
    bad = "bad\ud800"
    for field in ("source", "target", "note"):
        item = entry("a", "b")
        item[field] = bad
        message = refused(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": [item]}, "GLOSSARY_INVALID")
        assert message.startswith(f"entries[0].{field}:"), message
    assert refused(data, "glossary.import", {"scope": "global", "baseRevision": 0, "format": "csv", "text": "a," + bad}, "GLOSSARY_INVALID").startswith("text:")
    assert refused(data, "glossary.get", {"scope": "world", "worldDir": "w" + bad}, "GLOSSARY_INVALID").startswith("worldDir:")
    assert refused(data, "glossary.export", {"scope": "world", "worldDir": "bad\0path", "format": "csv"}, "GLOSSARY_INVALID").startswith("worldDir:")
    assert not (data / "glossary" / "global.json").exists(), "nothing was written"
    # The same values inside a stored file: the file is kept aside, the answer is an empty glossary.
    stored = [
        '{"version":1,"revision":1,"updatedAt":' + "9" * 350 + ',"entries":[]}',
        '{"version":1,"revision":1,"updatedAt":NaN,"entries":[]}',
        '{"version":1,"revision":1,"updatedAt":Infinity,"entries":[]}',
        '{"version":1,"revision":' + str(2**60) + ',"updatedAt":1,"entries":[]}',
        '{"version":1,"revision":1,"updatedAt":1,"entries":[{"id":"' + "a" * 20 + '","source":"a\\ud800","target":"b","mode":"translate"}]}',
        "[" * 100000,
    ]
    for content in stored:
        with tempfile.TemporaryDirectory() as raw:
            other = Path(raw) / "data"
            (other / "glossary").mkdir(parents=True)
            path = other / "glossary" / "global.json"
            path.write_text(content, encoding="utf-8")
            result = ok(other, "glossary.get", {"scope": "global"})
            assert result["revision"] == 0 and result["entries"] == [], content[:60]
            assert not path.exists() and len(list(path.parent.glob("global.damaged-*.json"))) == 1, content[:60]
            assert glossary.load_merged(other, None) == []


def test_translate_mode_needs_a_target(data: Path) -> None:
    """L2: a translate entry without a target is refused with a message that names the alternative."""
    message = refused(data, "glossary.set", {"scope": "global", "baseRevision": 0, "entries": [entry("Mira", "")]}, "GLOSSARY_INVALID")
    assert message.startswith("entries[0].target:") and "keep" in message, message
    result = ok(data, "glossary.import", {"scope": "global", "baseRevision": 0, "format": "csv", "text": "Mira,,translate\nZed,,\n"})
    assert result["skipped"][0]["reason"] == "missing_target" and result["entries"][0]["mode"] == "keep", result


CHILD = r'''
import json, sys, time
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from mwt import glossary

data, mode, label = Path(sys.argv[2]), sys.argv[3], sys.argv[4]
if mode == "busy":
    glossary.LOCK_WAIT_SECONDS = 0.5
else:
    original = glossary._check_revision

    def slow(current, base):
        original(current, base)
        time.sleep(0.8)  # both writers are now inside the read-compare-write window

    glossary._check_revision = slow
    while time.time() < float(sys.argv[5]):
        time.sleep(0.005)
payload = {"scope": "global", "baseRevision": 0, "entries": [{"source": label, "target": label, "mode": "translate"}]}
try:
    print(json.dumps({"ok": glossary.set_glossary(payload, data)["revision"]}))
except glossary.GlossaryError as exc:
    print(json.dumps({"error": exc.code, "recoverable": exc.recoverable}))
'''


def child(data: Path, mode: str, label: str, *extra: str) -> "subprocess.Popen[str]":
    executable = getattr(sys, "_base_executable", None) or sys.executable
    return subprocess.Popen([executable, "-B", "-c", CHILD, str(ROOT), str(data), mode, label, *extra],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def finish(process: "subprocess.Popen[str]") -> dict:
    out, err = process.communicate(timeout=120)
    assert process.returncode == 0 and out.strip(), (process.returncode, out, err)
    return json.loads(out.strip().splitlines()[-1])


def test_another_process_waits_and_is_then_refused_as_busy(data: Path) -> None:
    """M11: the lock is an operating-system lock, so a second process really waits for it."""
    path = data / "glossary" / "global.json"
    started = time.monotonic()
    with glossary.document_lock(path):
        blocked = finish(child(data, "busy", "x"))
    assert blocked == {"error": "GLOSSARY_BUSY", "recoverable": True}, blocked
    assert time.monotonic() - started >= 0.5, "it waited before giving up"
    assert not path.exists(), "the refused writer wrote nothing"
    assert finish(child(data, "busy", "x")) == {"ok": 1}, "the lock was released"
    # Through the request handler, in this process: a second holder gets the new code, recoverable.
    original = glossary.LOCK_WAIT_SECONDS
    glossary.LOCK_WAIT_SECONDS = 0.3
    held, release = threading.Event(), threading.Event()

    def hold() -> None:
        with glossary.document_lock(path):
            held.set()
            release.wait(10)

    holder = threading.Thread(target=hold)
    holder.start()
    try:
        assert held.wait(10)
        reply = call(data, "glossary.set", {"scope": "global", "baseRevision": 1, "entries": []})
        assert reply["type"] == "response.error" and reply["error"]["code"] == "GLOSSARY_BUSY" and reply["error"]["recoverable"] is True, reply
    finally:
        release.set()
        holder.join()
        glossary.LOCK_WAIT_SECONDS = original
    assert "GLOSSARY_BUSY" in glossary.ERROR_CODES


def test_two_processes_cannot_both_accept_the_same_revision(data: Path) -> None:
    """M11: both writers are held inside the read-compare-write window; only one may get revision 1."""
    start = str(time.time() + 3.0)
    first, second = child(data, "race", "alpha", start), child(data, "race", "beta", start)
    answers = [finish(first), finish(second)]
    assert sorted(str(item.get("ok") or item.get("error")) for item in answers) == ["1", "GLOSSARY_CONFLICT"], answers
    stored = ok(data, "glossary.get", {"scope": "global"})
    winner = next(label for label, item in zip(("alpha", "beta"), answers) if "ok" in item)
    assert stored["revision"] == 1 and [item["source"] for item in stored["entries"]] == [winner], stored


def main() -> None:
    test_requests_are_registered()
    print("PASS test_requests_are_registered")
    tests = (
        test_round_trip_global_and_world, test_set_keeps_ids_and_stale_revision_conflicts, test_invalid_input_names_the_field,
        test_limits, test_damaged_file_is_kept_aside_and_treated_as_empty, test_job_config_carries_the_merged_glossary,
        test_import_csv_merge,
        test_import_tsv_replace_and_no_header, test_import_respects_the_entry_limit, test_export_round_trip,
        test_a_full_limit_non_bmp_glossary_reads_back, test_the_writer_never_publishes_what_the_reader_refuses,
        test_export_neutralizes_formulas_and_import_restores_them, test_sources_clash_under_one_folding_rule,
        test_a_world_entry_replaces_the_global_entry_of_the_same_folded_source,
        test_invalid_unicode_and_malformed_metadata_get_stable_answers, test_translate_mode_needs_a_target,
        test_another_process_waits_and_is_then_refused_as_busy, test_two_processes_cannot_both_accept_the_same_revision,
    )
    for test in tests:
        with tempfile.TemporaryDirectory() as raw:
            test(Path(raw) / "data")
        print("PASS", test.__name__)
    print(f"GLOSSARY_PASSED ({len(tests) + 1} tests)")


if __name__ == "__main__":
    main()
