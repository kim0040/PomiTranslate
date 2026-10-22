"""Which text a scan finds, where it says it found it, and that writing it back is exact.

Every text shape the first real-world review found missing is a fixture here: `text_display`,
`extra` children, `with` arguments, items nested in containers, and chunks whose strings hold
Java's modified UTF-8. The NBT is written by hand below so this test does not share a codec
with the reader it checks.
"""

from __future__ import annotations

import json
import struct
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mc_world_translator import DEFAULT_CONFIG, WorldTranslator, merge_nested  # noqa: E402
from mwt import nbtio  # noqa: E402
from mwt.desktop_entry import _candidate_page, _candidate_record, _coverage  # noqa: E402
from mwt.region import RegionFile  # noqa: E402
from mwt.safety import BackupSet, backup_store, list_backup_sets, world_fingerprint  # noqa: E402

RESULTS: list[str] = []


# --- a small NBT writer, independent of mwt.nbtio's reader --------------------------------------


def _name(text: str) -> bytes:
    raw = nbtio.mutf8_encode(text)
    return struct.pack(">H", len(raw)) + raw


def w_string(name: str, value: str) -> bytes:
    return bytes([8]) + _name(name) + _name(value)


def w_int(name: str, value: int) -> bytes:
    return bytes([3]) + _name(name) + struct.pack(">i", value)


def w_compound(name: str, *children: bytes) -> bytes:
    return bytes([10]) + _name(name) + b"".join(children) + b"\x00"


def w_list_of_compounds(name: str, items: list[list[bytes]]) -> bytes:
    body = b"".join(b"".join(children) + b"\x00" for children in items)
    return bytes([9]) + _name(name) + bytes([10]) + struct.pack(">i", len(items)) + body


def w_list_of_strings(name: str, values: list[str]) -> bytes:
    body = b"".join(_name(value) for value in values)
    return bytes([9]) + _name(name) + bytes([8]) + struct.pack(">i", len(values)) + body


def w_list_of_mixed(name: str, entries: list) -> bytes:
    """A list of components. Strings and compounds cannot share an NBT list, so use compounds
    with a ``text`` key for both, which is what 1.21.5+ writes for a formatted line."""
    return w_list_of_compounds(name, entries)


def w_doubles(name: str, values: list[float]) -> bytes:
    return bytes([9]) + _name(name) + bytes([6]) + struct.pack(">i", len(values)) + b"".join(
        struct.pack(">d", value) for value in values
    )


def root(*children: bytes) -> bytes:
    return bytes([10]) + _name("") + b"".join(children) + b"\x00"


def text_compound(*pieces: str) -> list[bytes]:
    """A component: the first piece is `text`, the rest are `extra` children."""
    children = [w_string("text", pieces[0])]
    if len(pieces) > 1:
        children.append(w_list_of_compounds("extra", [[w_string("text", piece)] for piece in pieces[1:]]))
    return children


# --- the fixture chunk ---------------------------------------------------------------------------


def block_entities() -> bytes:
    sign = [
        w_string("id", "minecraft:oak_sign"),
        w_int("x", 10), w_int("y", 64), w_int("z", 20),
        w_compound(
            "front_text",
            w_list_of_strings("messages", ['{"text":"Welcome"}', "Plain literal line", "", ""]),
        ),
        w_compound(
            "back_text",
            w_list_of_strings("messages", ['{"text":"Back side","extra":["tail text"]}', "", "", ""]),
        ),
    ]
    sword = [
        w_string("id", "minecraft:iron_sword"),
        w_int("count", 1),
        w_compound(
            "components",
            w_compound("minecraft:custom_name", *text_compound("Blade", "of doom")),
            w_list_of_compounds(
                "minecraft:lore",
                [text_compound("Lore line", "lore tail"), text_compound("Second lore")],
            ),
            w_list_of_compounds(
                "minecraft:container",
                [[
                    w_int("slot", 0),
                    w_compound(
                        "item",
                        w_string("id", "minecraft:stick"),
                        w_int("count", 1),
                        w_compound("components", w_string("minecraft:item_name", "Nested name")),
                    ),
                ]],
            ),
        ),
    ]
    chest = [
        w_string("id", "minecraft:chest"),
        w_int("x", 11), w_int("y", 64), w_int("z", 20),
        w_compound("CustomName", *text_compound("Treasure", "Box")),
        w_list_of_compounds("Items", [sword]),
    ]
    lectern = [
        w_string("id", "minecraft:lectern"),
        w_int("x", 12), w_int("y", 64), w_int("z", 20),
        w_compound(
            "Book",
            w_string("id", "minecraft:written_book"),
            w_int("count", 1),
            w_compound(
                "components",
                w_compound(
                    "minecraft:written_book_content",
                    w_compound("title", w_string("raw", "My Book")),
                    w_list_of_compounds(
                        "pages",
                        [[w_string("raw", "Page one text")], [w_string("raw", '{"text":"Json page"}')]],
                    ),
                ),
                w_compound("minecraft:writable_book_content", w_list_of_strings("pages", ["Writable page"])),
            ),
        ),
    ]
    command = [
        w_string("id", "minecraft:command_block"),
        w_int("x", 13), w_int("y", 64), w_int("z", 20),
        w_string("Command", 'execute as @a run tellraw @s {"text":"Run hello"}'),
        w_string("CustomName", '{"text":"Console"}'),
    ]
    return w_list_of_compounds("block_entities", [sign, chest, lectern, command])


def entities() -> bytes:
    display = [
        w_string("id", "minecraft:text_display"),
        w_doubles("Pos", [1.5, 64.0, 2.5]),
        w_compound("text", *text_compound("Display one", "Display two")),
    ]
    stand = [
        w_string("id", "minecraft:armor_stand"),
        w_doubles("Pos", [8.0, 65.0, 9.0]),
        w_string("CustomName", '{"text":"Statue"}'),
    ]
    talker = [
        w_string("id", "minecraft:villager"),
        w_doubles("Pos", [3.0, 70.0, 3.0]),
        w_compound(
            "CustomName",
            w_string("translate", "custom.greeting"),
            w_string("fallback", "Fallback text"),
            w_list_of_compounds("with", [[w_string("text", "Arg two")]]),
            w_compound(
                "hover_event",
                w_string("action", "show_text"),
                w_compound("value", w_string("text", "Tooltip text")),
            ),
            w_compound(
                "click_event",
                w_string("action", "run_command"),
                w_string("command", 'tellraw @a {"text":"Clicked"}'),
            ),
        ),
    ]
    return w_list_of_compounds("Entities", [display, stand, talker])


def fixture_chunk() -> bytes:
    return root(w_int("DataVersion", 4556), block_entities(), entities())


EXPECTED = {
    "Welcome": ("sign", "front:1"),
    "Plain literal line": ("sign", "front:2"),
    "Back side": ("sign", "back:1"),
    "tail text": ("sign", "back:1"),
    "Treasure": ("block_name", ""),
    "Box": ("block_name", ""),
    "Blade": ("item_name", "custom"),
    "of doom": ("item_name", "custom"),
    "Lore line": ("item_lore", "line:1"),
    "lore tail": ("item_lore", "line:1"),
    "Second lore": ("item_lore", "line:2"),
    "Nested name": ("item_name", "base"),
    "My Book": ("book_title", ""),
    "Page one text": ("book_page", "page:1"),
    "Json page": ("book_page", "page:2"),
    "Writable page": ("book_page", "page:1"),
    "Run hello": ("command", ""),
    "Console": ("block_name", ""),
    "Display one": ("text_display", ""),
    "Display two": ("text_display", ""),
    "Statue": ("entity_name", ""),
    "Fallback text": ("entity_name", ""),
    "Arg two": ("entity_name", ""),
    "Tooltip text": ("entity_name", ""),
    "Clicked": ("command", ""),
}


def translator() -> WorldTranslator:
    return WorldTranslator(
        merge_nested(
            DEFAULT_CONFIG,
            {
                "world_dir": "/tmp/pomi-extraction-test",
                "dry_run": True,
                "inherit_translate_py": False,
                "runtime": {"checkpoint_enabled": False},
            },
        )
    )


def record(name: str) -> None:
    RESULTS.append(name)
    print(f"PASS {name}")


def test_every_text_shape_is_found() -> None:
    wt = translator()
    raw = fixture_chunk()
    tree = wt.parse_nbt_bytes(raw)
    refs: list = []
    wt.collect_tag_refs(tree, refs, "r.0.0.mca#0")
    found = {text: (ref.category, ref.detail) for text, ref in wt.extract_occurrences(refs)}
    missing = sorted(set(EXPECTED) - set(found))
    assert not missing, f"texts the scan did not find: {missing}"
    extra = sorted(set(found) - set(EXPECTED))
    assert not extra, f"texts the scan found that are not player-visible: {extra}"
    for text, (category, detail) in EXPECTED.items():
        got_category, got_detail = found[text]
        assert got_category == category, f"{text!r} is {got_category}, expected {category}"
        if detail:
            assert got_detail == detail, f"{text!r} detail {got_detail}, expected {detail}"
    record("text.component_shapes")


def test_locations_name_the_block_or_entity() -> None:
    wt = translator()
    refs: list = []
    wt.collect_tag_refs(wt.parse_nbt_bytes(fixture_chunk()), refs, "r.0.0.mca#0")
    where = {text: (ref.scope.holder, ref.scope.pos) for text, ref in wt.extract_occurrences(refs)}
    assert where["Welcome"] == ("minecraft:oak_sign", (10, 64, 20))
    assert where["Treasure"] == ("minecraft:chest", (11, 64, 20))
    assert where["Blade"] == ("minecraft:chest", (11, 64, 20)), "an item is located by its container"
    assert where["My Book"] == ("minecraft:lectern", (12, 64, 20))
    assert where["Display one"] == ("minecraft:text_display", (1, 64, 2))
    assert where["Statue"] == ("minecraft:armor_stand", (8, 65, 9))
    record("extraction.locations")


def test_writing_back_changes_only_the_text() -> None:
    wt = translator()
    raw = fixture_chunk()
    assert wt.parse_nbt_bytes(raw).dump() == raw, "an unedited chunk must come back byte for byte"
    tree = wt.parse_nbt_bytes(raw)
    refs: list = []
    wt.collect_tag_refs(tree, refs, "r.0.0.mca#0")
    translations = {text: f"[T] {text}" for text in EXPECTED}
    assert wt.apply_translations(refs, translations) > 0
    written = tree.dump()
    again = wt.parse_nbt_bytes(written)
    refs2: list = []
    wt.collect_tag_refs(again, refs2, "r.0.0.mca#0")
    assert {text for text, _ in wt.extract_occurrences(refs2)} == {f"[T] {text}" for text in EXPECTED}
    # Nothing but strings moved: the same walk over both trees reaches the same numbers.
    before = wt.parse_nbt_bytes(raw)
    assert before["DataVersion"].value == again["DataVersion"].value == 4556
    assert [(d["x"].value, d["z"].value) for d in before["block_entities"] if "x" in d] == [
        (d["x"].value, d["z"].value) for d in again["block_entities"] if "x" in d
    ]
    record("extraction.write_back_exact")


def test_json_string_and_literal_string_are_told_apart() -> None:
    wt = translator()
    # Before 1.21.5 a component is a JSON string. From 1.21.5 a plain string is literal text,
    # including text that merely starts with a bracket.
    literal = root(w_compound("front_text", w_list_of_strings("messages", ["[Boss] Room", '{"text":"Json line"}'])))
    tree = wt.parse_nbt_bytes(literal)
    refs: list = []
    wt.collect_tag_refs(tree, [] or refs, "p")
    texts = {text for text, _ in wt.extract_occurrences(refs)}
    assert texts == {"[Boss] Room", "Json line"}, texts
    kinds = {ref.kind for ref in refs}
    assert kinds == {"plain_tag", "json_tag"}, kinds
    wt.apply_translations(refs, {"[Boss] Room": "[보스] 방", "Json line": "제이슨 줄"})
    out = wt.parse_nbt_bytes(tree.dump())
    messages = [tag.value for tag in out["front_text"]["messages"]]
    assert messages[0] == "[보스] 방"
    assert json.loads(messages[1]) == {"text": "제이슨 줄"}
    record("extraction.json_versus_literal")


def test_bare_json_string_components_stay_valid_json() -> None:
    """Before 1.21.5 an unstyled line is the JSON string "Hello there", quotes included."""
    wt = translator()
    quoted = json.dumps("Hello there")
    chunk = root(
        w_compound(
            "front_text",
            w_list_of_strings("messages", [quoted, '{"text":"Object line"}', '""', json.dumps("Say \"hi\"")]),
        ),
        w_compound(
            "back_text",
            w_list_of_strings("messages", [json.dumps("Back bare"), '{"text":"Back object"}', '""', '""']),
        ),
        w_string("CustomName", json.dumps("Old Guard")),
        w_string("OtherName", '{"text":"Old Guard"}'),
        w_compound(
            "display",
            w_string("Name", json.dumps("Plain Name")),
            w_list_of_strings("Lore", [json.dumps("Lore bare"), '{"text":"Lore object"}']),
        ),
    )
    tree = wt.parse_nbt_bytes(chunk)
    refs: list = []
    wt.collect_tag_refs(tree, refs, "p")
    texts = {text for text, _ in wt.extract_occurrences(refs)}
    assert texts == {
        "Hello there", "Object line", 'Say "hi"', "Back bare", "Back object", "Old Guard", "Plain Name",
        "Lore bare", "Lore object",
    }, texts
    assert all(ref.kind == "json_tag" for ref in refs if ref.tag.value.startswith('"')), "bare literals are components"
    # Translating returns text without the quotes: the stored value must still be a JSON string.
    translations = {text: f"[KO] {text}" for text in texts}
    answer = '[KO] 말해 "안녕"\n끝'
    translations['Say "hi"'] = answer
    assert wt.apply_translations(refs, translations) > 0
    out = wt.parse_nbt_bytes(tree.dump())
    front = [tag.value for tag in out["front_text"]["messages"]]
    assert json.loads(front[0]) == "[KO] Hello there" and front[0].startswith('"') and front[0].endswith('"')
    assert json.loads(front[1]) == {"text": "[KO] Object line"}
    assert front[2] == '""', "an empty-string literal is left exactly as it was"
    assert json.loads(front[3]) == answer
    back = [tag.value for tag in out["back_text"]["messages"]]
    assert json.loads(back[0]) == "[KO] Back bare" and back[2] == back[3] == '""'
    assert "[KO] 말해" in front[3], "non-ASCII stays readable (ensure_ascii off)"
    assert json.loads(out["CustomName"].value) == "[KO] Old Guard"
    assert json.loads(out["display"]["Name"].value) == "[KO] Plain Name"
    lore = [tag.value for tag in out["display"]["Lore"]]
    assert json.loads(lore[0]) == "[KO] Lore bare" and json.loads(lore[1]) == {"text": "[KO] Lore object"}
    # A model answer is plain text. Whatever it holds, quoting is the extractor's job and never the model's.
    again: list = []
    wt.collect_tag_refs(tree, again, "p")
    ref = next(item for item in again if item.kind == "json_tag" and item.tag.value.startswith('"[KO] Hello'))
    wt.apply_translations([ref], {"[KO] Hello there": "Bonjour"})
    assert json.loads(ref.tag.value) == "Bonjour"
    # Literal-string semantics of 1.21.5+ are untouched: a plain, unquoted string is still plain text.
    literal = wt.parse_nbt_bytes(root(w_compound("front_text", w_list_of_strings("messages", ["Plain literal line"]))))
    plain_refs: list = []
    wt.collect_tag_refs(literal, plain_refs, "p")
    assert [ref.kind for ref in plain_refs] == ["plain_tag"]
    wt.apply_translations(plain_refs, {"Plain literal line": "일반 줄"})
    assert wt.parse_nbt_bytes(literal.dump())["front_text"]["messages"][0].value == "일반 줄"
    record("extraction.bare_json_string_components")


def test_excluded_ids_are_a_set_and_follow_the_list() -> None:
    import hashlib
    import time

    wt = translator()
    text = "Hello adventurer"
    candidate = hashlib.sha256(text.encode("utf-8")).hexdigest()[:20]
    assert wt.should_translate_text(text)
    wt.runtime_config["excluded_candidate_ids"] = [candidate]
    assert not wt.should_translate_text(text)
    wt.runtime_config["excluded_candidate_ids"] = ["0" * 20]
    assert wt.should_translate_text(text), "a replaced list is read again"
    wt.runtime_config["excluded_candidate_ids"].append(candidate)
    assert not wt.should_translate_text(text), "a longer list is read again"
    assert isinstance(wt._excluded_ids(), frozenset)
    wt.runtime_config["excluded_candidate_ids"] = [f"{index:020x}" for index in range(50_000)]
    wt.runtime_config["excluded_candidate_ids"].append(candidate)
    started = time.perf_counter()
    for index in range(2000):
        wt.should_translate_text(f"Another sentence number {index}")
    per_call = (time.perf_counter() - started) / 2000
    # Linear scans of 50,000 ids cost ~0.9 ms per call; a set stays near the no-exclusion cost.
    assert per_call < 0.0002, f"{per_call * 1e6:.1f} us per call with 50,000 exclusions"
    record("extraction.exclusion_membership_is_a_set")


def test_modified_utf8_chunks_are_read_and_written() -> None:
    wt = translator()
    emoji = "Hello \U0001F600 world"
    nul = "line one\x00line two"
    chunk = root(
        w_compound("front_text", w_list_of_strings("messages", [emoji, nul])),
        w_string("Text1", '{"text":"kept"}'),
    )
    assert b"\xed\xa0\xbd\xed\xb8\x80" in chunk, "the fixture must hold a CESU-8 surrogate pair"
    assert b"\xc0\x80" in chunk, "and a two-byte NUL"
    tree = wt.parse_nbt_bytes(chunk)
    refs: list = []
    wt.collect_tag_refs(tree, refs, "p")
    texts = {text for text, _ in wt.extract_occurrences(refs)}
    assert emoji in texts and nul in texts and "kept" in texts, texts
    wt.apply_translations(refs, {emoji: "안녕 \U0001F600 세계", nul: "첫째 줄\x00둘째 줄"})
    written = tree.dump()
    assert "안녕 \U0001F600 세계" in [tag.value for tag in wt.parse_nbt_bytes(written)["front_text"]["messages"]]
    assert b"\xed\xa0\xbd\xed\xb8\x80" in written and b"\xc0\x80" in written
    assert b"\xf0\x9f\x98\x80" not in written, "Java would reject a real 4-byte sequence"
    record("text.modified_utf8")


def test_broken_nbt_fails_cleanly() -> None:
    good = fixture_chunk()
    for broken in (good[: len(good) // 2], good[:5], b"", b"\x0a", b"\x01\x00\x00"):
        try:
            nbtio.parse(broken)
        except nbtio.NbtError:
            continue
        raise AssertionError("truncated NBT must raise NbtError")
    deep = b"\x0a\x00\x00" + (b"\x0a\x00\x01a" * 300) + b"\x00" * 301
    try:
        nbtio.parse(deep)
    except nbtio.NbtError:
        pass
    else:
        raise AssertionError("absurd nesting must be refused")
    record("extraction.broken_nbt_rejected")


def test_scan_records_kind_location_and_count(tmp: Path) -> None:
    world = tmp / "scan-world"
    region = RegionFile.empty()
    region.put_nbt(0, fixture_chunk(), compression=2)
    region.put_nbt(1, root(w_compound("front_text", w_list_of_strings("messages", ["Welcome", "Only here"]))), compression=2)
    data, _ = region.build()
    path = world / "region" / "r.-1.2.mca"
    path.parent.mkdir(parents=True)
    path.write_bytes(data)
    (world / "level.dat").write_bytes(b"\x1f\x8b")
    wt = WorldTranslator(
        merge_nested(
            DEFAULT_CONFIG,
            {
                "world_dir": str(world),
                "dry_run": True,
                "report_path": str(tmp / "scan.json"),
                "inherit_translate_py": False,
                "runtime": {"checkpoint_enabled": False},
            },
        )
    )
    report = wt.run()
    assert report["status"] == "completed"
    welcome = _candidate_record("Welcome", wt.occurrences["Welcome"])
    assert welcome["occurrences"] == 2 and welcome["kind"] == "sign"
    assert welcome["locations"][0]["holder"] == "minecraft:oak_sign"
    assert welcome["locations"][0]["chunk"] == [-32, 64], welcome["locations"][0]
    assert welcome["location"] == "oak_sign (10, 64, 20)"
    only = _candidate_record("Only here", wt.occurrences["Only here"])
    assert only["occurrences"] == 1 and only["locations"][0]["chunk"] == [-31, 64]
    record("extraction.scan_metadata")


def test_candidate_page_count_and_rows_agree() -> None:
    records = [
        _candidate_record("Alpha", {"count": 3, "kinds": {"sign": 3}, "locations": []}),
        _candidate_record("Bravo", {"count": 1, "kinds": {"book_page": 1}, "locations": []}),
        _candidate_record("Charlie", {"count": 2, "kinds": {"sign": 2}, "locations": []}),
    ]
    plan = {"candidates": records}
    alpha, bravo = records[0]["id"], records[1]["id"]
    everything = _candidate_page(plan, {})
    assert everything["total"] == 3 and everything["kinds"] == {"sign": 2, "book_page": 1}
    assert _candidate_page(plan, {"kind": "sign"})["total"] == 2
    excluded = _candidate_page(plan, {"state": "excluded", "excludedCandidateIds": [alpha]})
    assert [item["source"] for item in excluded["candidates"]] == ["Alpha"] and excluded["total"] == 1
    nothing = _candidate_page(plan, {"state": "excluded"})
    assert nothing["total"] == 0 and nothing["candidates"] == [], "the count must match the rows"
    manual = _candidate_page(plan, {"state": "manual", "overrideCandidateIds": [bravo]})
    assert manual["total"] == 1
    assert [item["source"] for item in _candidate_page(plan, {"sort": "count"})["candidates"]] == ["Alpha", "Charlie", "Bravo"]
    assert _candidate_page(plan, {"query": "harl"})["total"] == 1
    page = _candidate_page(plan, {"limit": 2, "offset": 2})
    assert page["hasMore"] is False and len(page["candidates"]) == 1
    record("extraction.candidate_page")


def test_coverage_names_what_is_not_scanned(tmp: Path) -> None:
    world = tmp / "coverage"
    (world / "datapacks" / "pack").mkdir(parents=True)
    (world / "data").mkdir()
    (world / "data" / "command_storage_pomi.dat").write_bytes(b"x")
    (world / "level.dat").write_bytes(b"x")
    by_id = {item["id"]: item for item in _coverage(world, False)}
    assert by_id["regions"]["scanned"] and by_id["entities"]["scanned"]
    assert by_id["datapacks"] == {"id": "datapacks", "scanned": False, "present": True, "count": 1}
    assert by_id["command_storage"]["present"] and not by_id["command_storage"]["scanned"]
    assert not by_id["playerdata"]["present"]
    record("extraction.coverage")


def test_backups_live_outside_the_world(tmp: Path) -> None:
    world = tmp / "backup-world"
    path = world / "region" / "r.0.0.mca"
    region = RegionFile.empty()
    region.put_nbt(0, root(w_string("Text1", '{"text":"Hello"}')), compression=2)
    path.parent.mkdir(parents=True)
    data, _ = region.build()
    path.write_bytes(data)
    (world / "level.dat").write_bytes(b"\x1f\x8b")
    data_dir = tmp / "userdata"
    store = backup_store(world, data_dir)
    assert not str(store).startswith(str(world)), "backups must not sit inside the world folder"
    assert backup_store(tmp / "other" / "backup-world", data_dir) != store, "same name, different world"

    before = path.read_bytes()
    backup = BackupSet.new(world, store=store)
    backup.add(path)
    backup.publish_latest()
    path.write_bytes(b"changed")
    assert not (world / ".pomi-backups").exists()
    assert world_fingerprint(world) == world_fingerprint(world)

    # An older release put its backups inside the world. They still list and restore.
    legacy = BackupSet.new(world)
    path.write_bytes(before)
    legacy.add(path)
    listed = list_backup_sets(world, [store, world / ".pomi-backups"])
    assert {item["backupSetId"] for item in listed} == {backup.backup_id, legacy.backup_id}
    assert {item["inWorldFolder"] for item in listed} == {True, False}
    path.write_bytes(b"changed again")
    found = BackupSet.find(world, legacy.backup_id, [store, world / ".pomi-backups"])
    recovery_id = found.restore(recovery_store=store)
    assert path.read_bytes() == before
    assert (store / recovery_id / "manifest.json").is_file(), "the recovery set goes to the app store"
    record("safety.app_data_backups")


def run_all(tmp: Path) -> list[str]:
    RESULTS.clear()
    test_every_text_shape_is_found()
    test_locations_name_the_block_or_entity()
    test_writing_back_changes_only_the_text()
    test_json_string_and_literal_string_are_told_apart()
    test_bare_json_string_components_stay_valid_json()
    test_excluded_ids_are_a_set_and_follow_the_list()
    test_modified_utf8_chunks_are_read_and_written()
    test_broken_nbt_fails_cleanly()
    test_candidate_page_count_and_rows_agree()
    test_scan_records_kind_location_and_count(tmp)
    test_coverage_names_what_is_not_scanned(tmp)
    test_backups_live_outside_the_world(tmp)
    return list(RESULTS)


def main() -> None:
    with tempfile.TemporaryDirectory() as raw:
        run_all(Path(raw))
    print("EXTRACTION_PASSED")


if __name__ == "__main__":
    main()
