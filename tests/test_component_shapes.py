"""COMP-02: current Java text-component shapes the extractor used to miss.

Every case here is a synthetic fixture written by hand, byte by byte, so the test does not share
a codec with the reader it checks. A shape counts as covered when a scan finds exactly its visible
strings, a write changes only those strings (the whole chunk equals the same fixture built with
translated strings), the written world reopens, and a restore returns the baseline SHA-256.

The shapes and where they were documented are listed in docs/compatibility-roadmap-2026-10-01.md.
None of this was checked in the game.
"""

from __future__ import annotations

import copy
import hashlib
import json
import struct
import sys
import tempfile
import threading
from collections.abc import Callable
from http.server import ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from mc_world_translator import DEFAULT_CONFIG, WorldTranslator, merge_nested  # noqa: E402
from mwt.extract import Scope  # noqa: E402
from mwt.region import RegionFile  # noqa: E402
from mwt.safety import BackupSet  # noqa: E402
from test_extraction import (  # noqa: E402
    _name,
    root,
    w_compound,
    w_doubles,
    w_int,
    w_list_of_compounds,
    w_list_of_strings,
    w_string,
)
from test_release_fixtures import TranslatorHandler, config_for, run_world, start_responder, write_region  # noqa: E402

RESULTS: list[str] = []

Tr = Callable[[str], str]


def record(name: str) -> None:
    RESULTS.append(name)
    print(f"PASS {name}")


def w_int_array(name: str, values: list[int]) -> bytes:
    return bytes([11]) + _name(name) + struct.pack(">i", len(values)) + b"".join(struct.pack(">i", v) for v in values)


def line(*children: bytes) -> list[bytes]:
    return list(children)


def empty_line() -> list[bytes]:
    return [w_string("text", "")]


def compact(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


# --- the fixture chunk; ``t`` is applied to every visible string, so it also builds the expected bytes ---


def object_sign(t: Tr) -> list[bytes]:
    """26.x sprite and player objects with a structured fallback, translate fallback, selector separator."""
    front = [
        line(
            w_string("object", "atlas"),
            w_string("atlas", "minecraft:blocks"),
            w_string("sprite", "block/stone"),
            w_compound("fallback", w_string("text", t("Stone glyph"))),
        ),
        line(
            w_string("text", t("Head line")),
            w_list_of_compounds(
                "extra",
                [
                    line(
                        w_string("type", "object"),
                        w_string("object", "player"),
                        w_string("player", "Notch"),
                        w_string("fallback", t("Head glyph")),
                    )
                ],
            ),
        ),
        line(
            w_string("translate", "chat.type.text"),
            w_string("fallback", t("Plain fallback")),
            w_list_of_compounds("with", [line(w_string("text", t("Arg one")))]),
        ),
        line(w_string("selector", "@e[type=pig]"), w_compound("separator", w_string("text", t(";then")))),
    ]
    filtered = [
        line(
            w_string("object", "atlas"),
            w_string("sprite", "block/stone"),
            w_compound("fallback", w_string("text", t("Stone glyph"))),
        ),
        line(w_string("text", t("Head line"))),
        empty_line(),
        empty_line(),
    ]
    back = [line(w_string("text", t("Back only"))), empty_line(), empty_line(), empty_line()]
    return [
        w_string("id", "minecraft:oak_sign"),
        w_int("x", 1), w_int("y", 64), w_int("z", 1),
        w_compound(
            "front_text",
            w_list_of_compounds("messages", front),
            w_list_of_compounds("filtered_messages", filtered),
            w_string("color", "black"),
        ),
        # No filtered_messages here: none may appear after a write.
        w_compound("back_text", w_list_of_compounds("messages", back)),
    ]


def hover_sign(t: Tr) -> list[bytes]:
    """1.21.5+ hover_event, the legacy hoverEvent contents form, and click events that are not text."""
    item_hover = line(
        w_string("text", t("Hover item")),
        w_compound(
            "hover_event",
            w_string("action", "show_item"),
            w_string("id", "minecraft:diamond_sword"),
            w_int("count", 1),
            w_compound(
                "components",
                w_compound("minecraft:custom_name", w_string("text", t("Hover blade"))),
                w_list_of_compounds("minecraft:lore", [line(w_string("text", t("Hover lore")))]),
                w_compound("minecraft:custom_data", w_string("text", "Not visible"), w_string("id", "quest:key")),
            ),
        ),
    )
    entity_hover = line(
        w_string("text", t("Hover entity")),
        w_compound(
            "hover_event",
            w_string("action", "show_entity"),
            w_string("id", "minecraft:pig"),
            w_int_array("uuid", [1, 2, 3, 4]),
            w_compound("name", w_string("text", t("Hover pig"))),
        ),
    )
    legacy_entity = line(
        w_string("text", t("Legacy hover")),
        w_compound(
            "hoverEvent",
            w_string("action", "show_entity"),
            w_compound(
                "contents",
                w_string("type", "minecraft:pig"),
                w_string("id", "00000000-0000-0001-0000-000000000002"),
                w_compound("name", w_string("text", t("Legacy pig"))),
            ),
        ),
    )
    clicks = line(
        w_string("text", t("Click lines")),
        w_compound("click_event", w_string("action", "copy_to_clipboard"), w_string("value", "Copy this phrase")),
        w_list_of_compounds(
            "extra",
            [
                line(
                    w_string("text", t("Open")),
                    w_compound("click_event", w_string("action", "open_url"), w_string("url", "https://example.com/page")),
                ),
                line(
                    w_string("text", t("Suggest")),
                    w_compound("click_event", w_string("action", "suggest_command"), w_string("command", "/say hello world")),
                ),
                line(w_string("keybind", "key.jump")),
                line(w_compound("score", w_string("name", "@p"), w_string("objective", "points"))),
                line(w_string("nbt", "CustomName"), w_string("entity", "@s")),
            ],
        ),
    )
    legacy_item = line(
        w_string("text", t("Legacy item")),
        w_compound(
            "hoverEvent",
            w_string("action", "show_item"),
            w_compound(
                "contents",
                w_string("id", "minecraft:stone"),
                w_int("count", 1),
                w_compound("components", w_string("minecraft:custom_name", t("Legacy item name"))),
            ),
        ),
    )
    string_name = line(
        w_string("text", t("String name")),
        w_compound(
            "hover_event",
            w_string("action", "show_entity"),
            w_string("id", "minecraft:cow"),
            w_string("uuid", "00000000-0000-0001-0000-000000000003"),
            w_string("name", t("Cow literal")),
        ),
    )
    return [
        w_string("id", "minecraft:oak_hanging_sign"),
        w_int("x", 2), w_int("y", 64), w_int("z", 1),
        w_compound("front_text", w_list_of_compounds("messages", [item_hover, entity_hover, legacy_entity, clicks])),
        w_compound("back_text", w_list_of_compounds("messages", [legacy_item, string_name, empty_line(), empty_line()])),
    ]


def book_lectern(t: Tr) -> list[bytes]:
    """written_book_content: raw and filtered are one text, so they get one translation."""
    return [
        w_string("id", "minecraft:lectern"),
        w_int("x", 3), w_int("y", 64), w_int("z", 1),
        w_compound(
            "Book",
            w_string("id", "minecraft:written_book"),
            w_int("count", 1),
            w_compound(
                "components",
                w_compound(
                    "minecraft:written_book_content",
                    w_compound("title", w_string("raw", t("Shared title")), w_string("filtered", t("Shared title"))),
                    w_list_of_compounds(
                        "pages",
                        [
                            [
                                w_compound("raw", w_string("text", t("Shared page"))),
                                w_compound("filtered", w_string("text", t("Shared page"))),
                            ],
                            [w_string("raw", t("Only raw page"))],
                        ],
                    ),
                    w_string("author", "Some Author"),
                ),
            ),
        ),
    ]


def command_blocks(t: Tr) -> tuple[list[bytes], list[bytes]]:
    snbt = (
        "tellraw @a [{object:atlas,sprite:'block/stone',fallback:{text:'%s'}},"
        "{text:'%s',hover_event:{action:show_item,id:'minecraft:stone',"
        "components:{'minecraft:custom_name':'%s'}},click_event:{action:copy_to_clipboard,value:'Do not touch'}}]"
    ) % (t("Cmd glyph"), t("Cmd hover"), t("Cmd item name"))
    plain_json = '/tellraw @a {"object":"atlas","sprite":"block/stone","fallback":"%s"}' % t("Json glyph")
    return (
        [w_string("id", "minecraft:command_block"), w_int("x", 4), w_int("y", 64), w_int("z", 1), w_string("Command", snbt)],
        [w_string("id", "minecraft:command_block"), w_int("x", 5), w_int("y", 64), w_int("z", 1), w_string("Command", plain_json)],
    )


def old_json_sign(t: Tr) -> list[bytes]:
    """Before 1.21.5 a hovered item keeps its name as JSON inside a JSON string."""
    nested = compact({"text": t("Old hover name")})
    component = {
        "text": t("Old sign"),
        "hoverEvent": {
            "action": "show_item",
            "contents": {"id": "minecraft:stone", "count": 1, "components": {"minecraft:custom_name": nested}},
        },
    }
    return [
        w_string("id", "minecraft:sign"),
        w_int("x", 6), w_int("y", 64), w_int("z", 1),
        w_string("Text1", compact(component)),
    ]


def mannequin(t: Tr) -> list[bytes]:
    return [
        w_string("id", "minecraft:mannequin"),
        w_doubles("Pos", [4.5, 65.0, 4.5]),
        w_compound("CustomName", w_string("text", t("Mannequin name"))),
        w_compound("description", w_string("text", t("Guide NPC"))),
        w_compound("profile", w_string("name", "Notch")),
    ]


def fixture_chunk(t: Tr = lambda text: text) -> bytes:
    snbt_block, json_block = command_blocks(t)
    return root(
        w_int("DataVersion", 4556),
        w_list_of_compounds(
            "block_entities",
            [object_sign(t), hover_sign(t), book_lectern(t), snbt_block, json_block, old_json_sign(t)],
        ),
        w_list_of_compounds("Entities", [mannequin(t)]),
    )


EXPECTED: dict[str, tuple[str, str]] = {
    "Stone glyph": ("sign", "front:1"),
    "Head line": ("sign", "front:2"),
    "Head glyph": ("sign", "front:2"),
    "Plain fallback": ("sign", "front:3"),
    "Arg one": ("sign", "front:3"),
    ";then": ("sign", "front:4"),
    "Back only": ("sign", "back:1"),
    "Hover item": ("sign", "front:1"),
    "Hover blade": ("item_name", "custom"),
    "Hover lore": ("item_lore", "line:1"),
    "Hover entity": ("sign", "front:2"),
    "Hover pig": ("sign", "front:2"),
    "Legacy hover": ("sign", "front:3"),
    "Legacy pig": ("sign", "front:3"),
    "Click lines": ("sign", "front:4"),
    "Open": ("sign", "front:4"),
    "Suggest": ("sign", "front:4"),
    "Legacy item": ("sign", "back:1"),
    "Legacy item name": ("item_name", "custom"),
    "String name": ("sign", "back:2"),
    "Cow literal": ("sign", "back:2"),
    "Shared title": ("book_title", ""),
    "Shared page": ("book_page", "page:1"),
    "Only raw page": ("book_page", "page:2"),
    "Cmd glyph": ("command", ""),
    "Cmd hover": ("command", ""),
    "Cmd item name": ("command", ""),
    "Json glyph": ("command", ""),
    "Old sign": ("sign", "line:1"),
    "Old hover name": ("sign", "line:1"),
    "Mannequin name": ("entity_name", ""),
    "Guide NPC": ("entity_name", "description"),
}

# Strings in the same fixture that are not player-visible text and must come through untouched.
NOT_TEXT = (
    "Not visible", "quest:key", "Copy this phrase", "https://example.com/page", "/say hello world",
    "Do not touch", "block/stone", "minecraft:blocks", "chat.type.text", "@e[type=pig]", "key.jump",
    "CustomName", "points", "Notch", "Some Author", "minecraft:diamond_sword",
)


def translator(**scan: bool) -> WorldTranslator:
    return WorldTranslator(
        merge_nested(
            DEFAULT_CONFIG,
            {
                "world_dir": "/tmp/pomi-comp02-test",
                "dry_run": True,
                "inherit_translate_py": False,
                "runtime": {"checkpoint_enabled": False},
                "scan": scan,
            },
        )
    )


def scan_chunk(wt: WorldTranslator, raw: bytes):
    tree = wt.parse_nbt_bytes(raw)
    refs: list = []
    wt.collect_tag_refs(tree, refs, "r.0.0.mca#0")
    return tree, refs


def prefixed(text: str) -> str:
    return f"[T] {text}"


def test_scan_finds_exactly_the_visible_text() -> None:
    wt = translator()
    raw = fixture_chunk()
    assert wt.parse_nbt_bytes(raw).dump() == raw
    _, refs = scan_chunk(wt, raw)
    occurrences = wt.extract_occurrences(refs)
    found = {text: (ref.category, ref.detail) for text, ref in occurrences}
    assert not (set(EXPECTED) - set(found)), f"missed: {sorted(set(EXPECTED) - set(found))}"
    assert not (set(found) - set(EXPECTED)), f"not visible text was collected: {sorted(set(found) - set(EXPECTED))}"
    for text, (category, detail) in EXPECTED.items():
        assert found[text][0] == category, f"{text!r} is {found[text][0]}, expected {category}"
        if detail:
            assert found[text][1] == detail, f"{text!r} is {found[text][1]}, expected {detail}"
    # raw and filtered of one sign line or book page are the same source, hence one translation.
    counts: dict[str, int] = {}
    for text, _ in occurrences:
        counts[text] = counts.get(text, 0) + 1
    assert counts["Stone glyph"] == 2 and counts["Head line"] == 2
    assert counts["Shared title"] == 2 and counts["Shared page"] == 2 and counts["Only raw page"] == 1
    assert len(wt.extract_unique_texts(refs)) == len(EXPECTED)
    record("comp02.scan_finds_exactly_the_visible_text")
    record("text.object_fallback")
    record("text.hover_item_entity")
    record("text.selector_separator")
    record("text.mannequin_description")


def test_write_changes_only_the_text() -> None:
    wt = translator()
    raw = fixture_chunk()
    tree, refs = scan_chunk(wt, raw)
    assert wt.apply_translations(refs, {text: prefixed(text) for text in EXPECTED}) > 0
    written = tree.dump()
    assert written == fixture_chunk(prefixed), "anything but the visible strings changed"
    for text in NOT_TEXT:
        assert text.encode() in written, f"{text!r} was changed"
    assert b"[T] Not visible" not in written
    # Reopen: the written chunk scans to the translated strings and nothing else.
    again = translator()
    _, refs2 = scan_chunk(again, written)
    assert {text for text, _ in again.extract_occurrences(refs2)} == {prefixed(text) for text in EXPECTED}
    # A back side without filtered_messages stays without them.
    back = again.parse_nbt_bytes(written)["block_entities"][0]["back_text"]
    assert "filtered_messages" not in back
    # Writing the same translations twice is a no-op (no doubled prefix).
    tree2, refs3 = scan_chunk(again, written)
    assert again.apply_translations(refs3, {text: prefixed(text) for text in EXPECTED}) == 0
    assert tree2.dump() == written
    record("comp02.write_changes_only_the_text")


def test_filtered_follows_raw() -> None:
    """One translation per source text, whichever side holds it; a missing side is not invented."""
    wt = translator()
    tree, refs = scan_chunk(wt, fixture_chunk())
    translations = {text: prefixed(text) for text in EXPECTED}
    translations["Stone glyph"] = "Pedra"
    translations["Shared page"] = "Pagina"
    wt.apply_translations(refs, translations)
    out = wt.parse_nbt_bytes(tree.dump())
    front = out["block_entities"][0]["front_text"]
    assert front["messages"][0]["fallback"]["text"].value == front["filtered_messages"][0]["fallback"]["text"].value == "Pedra"
    page = out["block_entities"][2]["Book"]["components"]["minecraft:written_book_content"]["pages"][0]
    assert page["raw"]["text"].value == page["filtered"]["text"].value == "Pagina"
    only_raw = out["block_entities"][2]["Book"]["components"]["minecraft:written_book_content"]["pages"][1]
    assert "filtered" not in only_raw
    record("comp02.filtered_follows_raw")


def test_scan_switches_apply_to_hover_items() -> None:
    texts = lambda wt: {text for text, _ in wt.extract_occurrences(scan_chunk(wt, fixture_chunk())[1])}  # noqa: E731
    assert "Hover lore" not in texts(translator(translate_lore=False))
    assert "Hover blade" in texts(translator(translate_lore=False))
    assert "Hover blade" not in texts(translator(translate_custom_names=False))
    assert "Guide NPC" not in texts(translator(translate_custom_names=False))
    assert "Legacy item name" not in texts(translator(translate_custom_names=False))
    assert "Stone glyph" not in texts(translator(translate_signs=False))
    assert "Cmd glyph" not in texts(translator(translate_command_output=False))
    record("comp02.scan_switches_apply")


def test_json_and_snbt_forms_keep_everything_else() -> None:
    from test_snbt_commands import _command_texts

    command = (
        "tellraw @a [{object:player,player:{name:Notch},fallback:{text:\"Head fallback\"}},"
        "{selector:'@a',separator:\" & \",extra:[{text:'Tail'}]},"
        "{translate:'k.v',fallback:'Tr fallback',with:[{object:atlas,sprite:'item/x',fallback:'With glyph'}]},"
        "{text:'Hi there',hover_event:{action:show_entity,id:'minecraft:pig',uuid:[I;1,2,3,4],name:'Pig name'}}]"
    )
    texts, written, unparsed = _command_texts(command)
    assert texts == {"Head fallback", "Tr fallback", "With glyph", "Hi there", "Pig name", "Tail"}, texts
    assert unparsed == 0
    assert written == (
        "tellraw @a [{object:player,player:{name:Notch},fallback:{text:\"[T] Head fallback\"}},"
        "{selector:'@a',separator:\" & \",extra:[{text:'[T] Tail'}]},"
        "{translate:'k.v',fallback:'[T] Tr fallback',with:[{object:atlas,sprite:'item/x',fallback:'[T] With glyph'}]},"
        "{text:'[T] Hi there',hover_event:{action:show_entity,id:'minecraft:pig',uuid:[I;1,2,3,4],name:'[T] Pig name'}}]"
    ), written

    texts, written, _ = _command_texts('tellraw @a {"object":"atlas","sprite":"a/b","fallback":{"text":"Json glyph","extra":["More"]}}')
    assert texts == {"Json glyph", "More"} and written.endswith('"fallback":{"text":"[T] Json glyph","extra":["[T] More"]}}'), written

    # A string separator is text; an id or a path next to it is not.
    texts, _, _ = _command_texts('tellraw @a {"nbt":"CustomName","entity":"@s","separator":"and also","interpret":true}')
    assert texts == {"and also"}, texts
    record("comp02.json_and_snbt_forms")


def test_non_text_object_parts_are_never_collected() -> None:
    wt = translator()
    chunk = root(
        w_list_of_compounds(
            "block_entities",
            [[
                w_string("id", "minecraft:oak_sign"),
                w_int("x", 1), w_int("y", 1), w_int("z", 1),
                w_compound(
                    "front_text",
                    w_list_of_compounds(
                        "messages",
                        [
                            line(w_string("object", "atlas"), w_string("sprite", "Stone Sprite Name")),
                            line(w_string("object", "player"), w_compound("player", w_string("name", "Some Player Name"))),
                            line(w_string("keybind", "Jump Key Binding")),
                            line(w_compound("score", w_string("name", "Score Holder"), w_string("objective", "Objective Name"))),
                        ],
                    ),
                ),
            ]],
        )
    )
    _, refs = scan_chunk(wt, chunk)
    assert wt.extract_occurrences(refs) == []
    record("comp02.non_text_parts_not_collected")


def test_world_scan_write_reopen_restore() -> None:
    class PrefixHandler(TranslatorHandler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(json.loads(self.rfile.read(length).decode("utf-8"))["messages"][1]["content"])
            raw = json.dumps(
                {"choices": [{"message": {"content": json.dumps({k: prefixed(v) for k, v in payload.items()})}}]}
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = ThreadingHTTPServer(("127.0.0.1", 0), PrefixHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base_url = "http://%s:%s/v1" % server.server_address[:2]
    try:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            world = tmp / "world"
            region_path = world / "region" / "r.0.0.mca"
            untouched = root(w_string("note", "Leave this chunk alone"))
            write_region(region_path, {0: (2, fixture_chunk(), False), 1: (2, untouched, False)})
            baseline = hashlib.sha256(region_path.read_bytes()).hexdigest()
            other_chunk = RegionFile.read(region_path).payload_fingerprint(1)

            scan = WorldTranslator(config_for(world, tmp / "scan.json", base_url, dry_run=True))
            scan.run()
            assert set(EXPECTED) <= set(scan.candidate_texts), sorted(set(EXPECTED) - set(scan.candidate_texts))
            assert not any(text in scan.candidate_texts for text in NOT_TEXT)
            assert hashlib.sha256(region_path.read_bytes()).hexdigest() == baseline, "a scan must not write"

            report = run_world(world, tmp / "write.json", base_url, dry_run=False)
            assert report["status"] == "completed", report
            written = hashlib.sha256(region_path.read_bytes()).hexdigest()
            assert written != baseline
            reopened = RegionFile.read(region_path)
            assert reopened.chunks[0].raw_nbt == fixture_chunk(prefixed), "the world holds the translated chunk and nothing else"
            assert reopened.payload_fingerprint(1) == other_chunk, "an untouched chunk keeps its stored bytes"

            BackupSet(world, "latest").restore()
            restored = hashlib.sha256(region_path.read_bytes()).hexdigest()
            assert restored == baseline, "restore must return the baseline SHA-256"
            print(f"comp02_baseline_sha256 {baseline}")
            print(f"comp02_restored_sha256 {restored}")
    finally:
        server.shutdown()
    record("comp02.world_scan_write_reopen_restore")


# --- review fixes: byte preservation (M1), legacy hover payloads (M2), object components (M3) ----------


def walked(wt: WorldTranslator, node: object) -> list[str]:
    found: list[str] = []
    wt._walk_json(copy.deepcopy(node), lambda container, key, source: found.append(source))
    return found


def nbt_texts(wt: WorldTranslator, *children: bytes) -> list[str]:
    _, refs = scan_chunk(wt, root(*children))
    return wt.extract_unique_texts(refs)


# The review's input: a noncompact embedded component with a Unicode escape in a token that stays.
EMBEDDED = '{ "text" : "Hover blade", "font" : "example:font", "color" : "\\u0072ed" }'


def embedded_hover(inner: str) -> dict:
    return {
        "text": "Outer text",
        "hoverEvent": {
            "action": "show_item",
            "contents": {"id": "minecraft:stone", "components": {"minecraft:custom_name": inner}},
        },
    }


def test_embedded_json_keeps_unchanged_bytes() -> None:
    wt = translator()
    node = embedded_hover(EMBEDDED)
    wt.patch_json_component(node, {"Hover blade": "Translated blade"})
    assert node["hoverEvent"]["contents"]["components"]["minecraft:custom_name"] == EMBEDDED.replace(
        "Hover blade", "Translated blade"
    ), "only the translated token changes: spaces, key order and the \\u0072 escape stay"

    # Lore lines, a bare string literal with outside whitespace, escapes in tokens that stay, and a
    # lone surrogate escape that must remain an escape.
    lore = ['[ "Line \\/ one" , {"text":"Line two","extra":["\\ud83d tail"]} ]', ' "Bare literal" ']
    node = {
        "text": "Outer text",
        "hover_event": {"action": "show_item", "id": "minecraft:stone", "components": {"minecraft:lore": list(lore)}},
    }
    wt.patch_json_component(node, {"Line / one": "ONE", "Line two": "TWO", "Bare literal": "BARE"})
    got = node["hover_event"]["components"]["minecraft:lore"]
    assert got == [
        '[ "ONE" , {"text":"TWO","extra":["\\ud83d tail"]} ]',
        ' "BARE" ',
    ], got

    # The same component as the outer string of a sign line is patched in place too.
    sign = '{ "text" : "Hello there" , "color" : "\\u0067old" }'
    tag = wt.parse_nbt_bytes(root(w_string("Text1", sign)))["Text1"]
    refs: list = []
    wt._collect_component(tag, refs, "t", Scope(), "sign", "line:1")
    assert wt.apply_translations(refs, {"Hello there": "Hi"}) == 1
    assert tag.value == '{ "text" : "Hi" , "color" : "\\u0067old" }', tag.value
    record("comp02.fix_embedded_json_bytes")


def test_embedded_json_unmappable_edit_falls_back_to_compact() -> None:
    wt = translator()
    spaced = '{ "text" : "A line", "extra" : [ "More" ] }'

    def swap_for_object(root_value: object) -> None:
        root_value["text"] = {"translate": "block.minecraft.stone"}  # type: ignore[index]

    assert getattr(wt, "json_span_fallbacks", 0) == 0
    got = wt._patch_json_string(spaced, swap_for_object)
    assert got == '{"text":{"translate":"block.minecraft.stone"},"extra":["More"]}', got
    assert wt.json_span_fallbacks == 1, "a fallback is counted"

    # Two spellings of one key cannot be mapped to one span either.
    duplicate = '{"text":"First","text":"Second"}'
    got = wt._patch_json_string(duplicate, lambda root_value: root_value.__setitem__("text", "Third"))
    assert got == '{"text":"Third"}', got
    assert wt.json_span_fallbacks == 2

    # Nothing to change: the text comes back as it was, spaces and all.
    assert wt._patch_json_string(spaced, lambda root_value: None) == spaced
    assert wt.json_span_fallbacks == 2
    record("comp02.fix_embedded_json_fallback")


def test_snbt_keeps_the_quote_of_the_replaced_string() -> None:
    from mwt import snbt

    wt = translator()
    for quote_char in ('"', "'"):
        literal = snbt.quote(EMBEDDED, quote_char, keep=True)
        assert literal[0] == quote_char
        command = (
            "tellraw @a {text:'Outer',hover_event:{action:show_item,id:'minecraft:stone',"
            "components:{'minecraft:custom_name':%s}}}"
        ) % literal
        expected_inner = EMBEDDED.replace("Hover blade", "Translated blade")
        expected = command.replace(literal, snbt.quote(expected_inner, quote_char, keep=True))
        got = wt.patch_command_component(command, {"Hover blade": "Translated blade"})
        assert got == expected, got
        assert got[got.index("custom_name") + len("custom_name':")] == quote_char, "the quote character stays"
        parsed = snbt.parse(got.split("tellraw @a ", 1)[1]).value
        assert parsed["hover_event"]["components"]["minecraft:custom_name"] == expected_inner

    # A translation that contains the quote character is escaped for it, not moved to the other quote.
    document = snbt.parse('{text:"Hello"}')
    document.value["text"] = 'Say "hi"'
    assert document.render() == '{text:"Say \\"hi\\""}', document.render()
    document = snbt.parse("{text:'Hello'}")
    document.value["text"] = "It's"
    assert document.render() == "{text:'It\\'s'}", document.render()
    document = snbt.parse("{text:Hello}")
    document.value["text"] = 'Say "hi"'
    assert document.render() == "{text:'Say \"hi\"'}", "an unquoted word had no quote to keep"
    record("comp02.fix_snbt_quote_kept")


# What the parent extractor (57c784b^1) collected from these inputs, recorded when it was checked.
LEGACY_JSON = {
    "value_entity": (
        {"text": "Outer text", "hoverEvent": {"action": "show_entity", "value": {"name": {"text": "Legacy entity label"}}}},
        ["Outer text", "Legacy entity label"],
    ),
    "value_component": (
        {"text": "Outer text", "hoverEvent": {"action": "show_entity", "value": {"text": "Legacy tooltip"}}},
        ["Outer text", "Legacy tooltip"],
    ),
    "value_item_component": (
        {"text": "Outer text", "hover_event": {"action": "show_item", "value": [{"text": "Item value"}, "Plain item value"]}},
        ["Outer text", "Item value", "Plain item value"],
    ),
    "contents_string_command": (
        {"text": "Outer text", "hoverEvent": {"action": "show_item", "contents": 'tellraw @a {"text":"Old nested command"}'}},
        ["Outer text", "Old nested command"],
    ),
    "name_string_command": (
        {"text": "Outer text", "hoverEvent": {"action": "show_entity", "name": 'tellraw @a {"text":"Name command"}'}},
        ["Outer text", "Name command"],
    ),
    "contents_list": (
        {"text": "Outer text", "hoverEvent": {"action": "show_entity", "contents": [{"text": "Listed one"}]}},
        ["Outer text", "Listed one"],
    ),
    "show_text_unchanged": (
        {"text": "Outer text", "hoverEvent": {"action": "show_text", "contents": {"text": "Tip"}, "value": "Plain tip"}},
        ["Outer text", "Plain tip", "Tip"],
    ),
    # A raw SNBT item or entity wrapper is not text that is sent for translation, before or now.
    "raw_item_wrapper": (
        {
            "text": "Outer text",
            "hoverEvent": {"action": "show_item", "value": "{id:\"minecraft:stone\",tag:{display:{Name:'{\"text\":\"Raw wrapper name\"}'}}}"},
        },
        ["Outer text"],
    ),
    "raw_entity_wrapper": (
        {
            "text": "Outer text",
            "hoverEvent": {"action": "show_entity", "contents": "{type:\"minecraft:pig\",name:'{\"text\":\"Raw pig\"}'}"},
        },
        ["Outer text"],
    ),
}


def test_legacy_hover_payloads_are_still_collected() -> None:
    wt = translator()
    for name, (node, expected) in LEGACY_JSON.items():
        got = walked(wt, node)
        assert sorted(got) == sorted(expected), (name, got)

    # Inline and compound show_item/show_entity fields stay narrowed to names and lore.
    narrowed = {
        "text": "Outer text",
        "hover_event": {
            "action": "show_entity",
            "id": "minecraft:pig",
            "name": {"text": "Pig name"},
            "custom_data": {"text": "Not a label"},
        },
    }
    assert walked(wt, narrowed) == ["Outer text", "Pig name"]
    narrowed = {
        "text": "Outer text",
        "hoverEvent": {
            "action": "show_item",
            "contents": {"id": "minecraft:stone", "components": {"minecraft:custom_data": {"text": "Not a label"}}},
        },
    }
    assert walked(wt, narrowed) == ["Outer text"]

    # The legacy value is written back where it was, together with the targeted fields.
    node = copy.deepcopy(LEGACY_JSON["value_entity"][0])
    node["hoverEvent"]["name"] = {"text": "Inline name"}
    wt.patch_json_component(node, {t: prefixed(t) for t in ("Outer text", "Legacy entity label", "Inline name")})
    assert node["text"] == "[T] Outer text"
    assert node["hoverEvent"]["value"]["name"]["text"] == "[T] Legacy entity label"
    assert node["hoverEvent"]["name"]["text"] == "[T] Inline name"

    # Embedded commands in hover strings are patched as before.
    wrote = wt.patch_command_component(
        'tellraw @a {"text":"Outer text","hoverEvent":{"action":"show_entity","value":{"text":"Legacy tooltip"}}}',
        {"Outer text": prefixed("Outer text"), "Legacy tooltip": prefixed("Legacy tooltip")},
    )
    assert wrote == (
        'tellraw @a {"text":"[T] Outer text","hoverEvent":{"action":"show_entity","value":{"text":"[T] Legacy tooltip"}}}'
    ), wrote
    record("comp02.fix_legacy_hover_json")


def test_legacy_hover_payloads_in_nbt_are_still_collected() -> None:
    wt = translator()
    # JSON inside an NBT string (a pre-1.21.5 sign line), and the same component as plain NBT.
    for entry in (LEGACY_JSON["value_component"][0], LEGACY_JSON["value_entity"][0]):
        sign = w_compound(
            "probe",
            w_string("id", "minecraft:sign"), w_int("x", 1), w_int("y", 1), w_int("z", 1),
            w_string("Text1", compact(entry)),
        )
        assert nbt_texts(wt, sign) == walked(wt, entry)
    direct = w_compound(
        "CustomName",
        w_string("text", "Outer text"),
        w_compound(
            "hoverEvent",
            w_string("action", "show_entity"),
            w_compound("value", w_string("text", "Legacy tooltip")),
        ),
    )
    assert nbt_texts(wt, direct) == ["Outer text", "Legacy tooltip"]
    direct_item = w_compound(
        "CustomName",
        w_string("text", "Outer text"),
        w_compound(
            "hover_event",
            w_string("action", "show_item"),
            w_compound("value", w_string("text", "Item value")),
            w_string("contents", "{id:\"minecraft:stone\",tag:{display:{Name:'{\"text\":\"Raw wrapper name\"}'}}}"),
        ),
    )
    assert nbt_texts(wt, direct_item) == ["Outer text", "Item value"], "a raw SNBT wrapper string is not collected"
    # Compound contents and inline fields are the targeted ones: names only.
    targeted = w_compound(
        "CustomName",
        w_string("text", "Outer text"),
        w_compound(
            "hoverEvent",
            w_string("action", "show_entity"),
            w_compound(
                "contents",
                w_string("id", "minecraft:pig"),
                w_compound("name", w_string("text", "Pig name")),
                w_compound("custom_data", w_string("text", "Not a label")),
            ),
            w_compound("value", w_string("text", "Legacy value")),
        ),
    )
    assert nbt_texts(wt, targeted) == ["Outer text", "Pig name", "Legacy value"]

    # A command component whose hover uses the legacy value, found through the command path.
    command = 'tellraw @a {"text":"Outer text","hoverEvent":{"action":"show_entity","value":{"text":"Legacy tooltip"}}}'
    chunk = root(
        w_list_of_compounds(
            "block_entities",
            [[w_string("id", "minecraft:command_block"), w_int("x", 1), w_int("y", 64), w_int("z", 1), w_string("Command", command)]],
        )
    )
    _, refs = scan_chunk(wt, chunk)
    assert wt.extract_unique_texts(refs) == ["Outer text", "Legacy tooltip"]
    record("comp02.fix_legacy_hover_nbt")


def test_explicit_type_wins_and_object_payloads_are_not_text() -> None:
    wt = translator()
    # An explicit type decides: this is a text component whatever else the compound holds.
    for extra in ({"player": "SafeName"}, {"sprite": "block/stone"}, {"object": "atlas"}):
        node = {"type": "text", "text": "Visible text", "fallback": {"text": "Not a component fallback"}, **extra}
        assert walked(wt, node) == ["Visible text"], (extra, walked(wt, node))
    for kind in ("translatable", "score", "selector", "keybind", "nbt"):
        node = {"type": kind, "fallback": {"text": "Not a component fallback"}, "player": "SafeName"}
        assert walked(wt, node) == [], kind
    assert walked(wt, {"type": "minecraft:object", "fallback": {"text": "Namespaced"}}) == [], "an unrecognised type is not the shape"
    assert walked(wt, {"type": 5, "object": "atlas", "fallback": {"text": "Bad type"}}) == []
    # Object by type, with or without its own key; and the shape alone when type is left out.
    assert walked(wt, {"type": "object", "fallback": {"text": "Typed"}}) == ["Typed"]
    assert walked(wt, {"type": "object", "sprite": "a/b", "fallback": "Typed string"}) == ["Typed string"]
    assert walked(wt, {"object": "atlas", "sprite": "a/b", "fallback": {"text": "Shaped"}}) == ["Shaped"]
    assert walked(wt, {"player": {"name": "N"}, "fallback": {"text": "Shaped player"}}) == ["Shaped player"]
    assert walked(wt, {"type": None, "sprite": "a/b", "fallback": {"text": "Null type"}}) == ["Null type"]
    # translate keeps its own fallback rule.
    assert walked(wt, {"translate": "k.v", "fallback": "Tr fallback"}) == ["Tr fallback"]

    # Nothing nested in the payload is text, only the fallback is.
    nested = {
        "object": "player",
        "player": {
            "name": "SafeName",
            "properties": [{"name": "textures", "value": "BASE64", "text": "Do not translate player property"}],
            "text": "Do not translate player text",
            "extra": [{"text": "Do not translate player extra"}],
        },
        "fallback": {"text": "Visible fallback"},
    }
    assert walked(wt, nested) == ["Visible fallback"]
    sprite = {"type": "object", "object": "atlas", "sprite": {"text": "Sprite text", "extra": ["Sprite extra"]}, "fallback": "Visible glyph"}
    assert walked(wt, sprite) == ["Visible glyph"]
    assert walked(wt, {"type": "object", "object": {"text": "Object payload"}, "fallback": "Glyph"}) == ["Glyph"]
    # A real component around an object is still read.
    around = {"text": "Around", "extra": [nested, {"text": "After"}]}
    assert walked(wt, around) == ["Around", "Visible fallback", "After"]
    # A patch changes the fallback and leaves the payload alone.
    node = copy.deepcopy(nested)
    wt.patch_json_component(node, {"Visible fallback": "Changed", "Do not translate player property": "Oops"})
    expected = copy.deepcopy(nested)
    expected["fallback"]["text"] = "Changed"
    assert node == expected

    # The same rules for plain NBT.
    def probe(*children: bytes) -> bytes:
        return w_compound("CustomName", *children)

    typed_text = probe(
        w_string("type", "text"),
        w_string("text", "Visible text"),
        w_string("player", "SafeName"),
        w_compound("fallback", w_string("text", "Not a component fallback")),
    )
    assert nbt_texts(wt, typed_text) == ["Visible text"]
    assert nbt_texts(wt, probe(w_string("type", "text"), w_string("sprite", "a/b"), w_string("fallback", "Not a fallback"))) == []
    shaped = w_compound(
        "CustomName",
        w_string("type", "object"),
        w_string("object", "player"),
        w_compound(
            "player",
            w_string("name", "SafeName"),
            w_string("text", "Do not translate player text"),
            w_list_of_compounds("extra", [[w_string("text", "Do not translate player extra")]]),
            w_list_of_compounds("properties", [[w_string("name", "textures"), w_string("text", "Do not translate property")]]),
        ),
        w_compound("fallback", w_string("text", "Visible fallback")),
    )
    assert nbt_texts(wt, shaped) == ["Visible fallback"]
    untyped = w_compound(
        "CustomName",
        w_string("object", "atlas"),
        w_string("sprite", "a/b"),
        w_compound("fallback", w_string("text", "Shaped fallback")),
    )
    assert nbt_texts(wt, untyped) == ["Shaped fallback"]
    contradictory = w_compound(
        "CustomName",
        w_string("type", "text"),
        w_string("text", "Visible text"),
        w_compound("player", w_string("name", "SafeName"), w_string("text", "Do not translate")),
        w_compound("fallback", w_string("text", "Not a component fallback")),
    )
    assert nbt_texts(wt, contradictory) == ["Visible text"]
    record("comp02.fix_explicit_type_and_payloads")


def test_effective_kind_is_decided_before_the_fallback() -> None:
    """R3: a recognised explicit type outranks the discriminator keys, in JSON and in direct NBT."""
    wt = translator()
    text_with_translate = {"type": "text", "text": "Visible label", "translate": "unused.key", "fallback": "Unused fallback"}
    object_with_translate = {
        "type": "object",
        "object": "player",
        "player": "SafeName",
        "translate": "unused.key",
        "fallback": {"text": "Visible object fallback"},
    }
    assert walked(wt, text_with_translate) == ["Visible label"]
    assert walked(wt, object_with_translate) == ["Visible object fallback"]
    # Without a type the keys still decide: translate, then the object keys.
    assert walked(wt, {"translate": "k.v", "fallback": "Tr fallback"}) == ["Tr fallback"]
    assert walked(wt, {"translate": "k.v", "player": "SafeName", "fallback": {"text": "Not read"}}) == []
    assert walked(wt, {"type": None, "translate": "k.v", "fallback": "Null type"}) == ["Null type"]
    assert walked(wt, {"type": "translatable", "translate": "k.v", "fallback": "Typed translatable"}) == ["Typed translatable"]
    # A type nobody recognises keeps the reading from before: translate marks a translatable component.
    assert walked(wt, {"type": "minecraft:text", "translate": "k.v", "fallback": "Other namespace"}) == ["Other namespace"]
    assert walked(wt, {"type": 5, "translate": "k.v", "fallback": "Not a string"}) == ["Not a string"]
    # The patcher follows the same decision: the inactive fallback stays as written.
    node = copy.deepcopy(text_with_translate)
    wt.patch_json_component(node, {"Visible label": "Changed", "Unused fallback": "Oops"})
    assert node == {**text_with_translate, "text": "Changed"}
    node = copy.deepcopy(object_with_translate)
    wt.patch_json_component(node, {"Visible object fallback": "Changed"})
    assert node == {**object_with_translate, "fallback": {"text": "Changed"}}

    assert nbt_texts(
        wt,
        w_compound(
            "CustomName",
            w_string("type", "text"),
            w_string("text", "Visible label"),
            w_string("translate", "unused.key"),
            w_string("fallback", "Unused fallback"),
        ),
    ) == ["Visible label"]
    assert nbt_texts(
        wt,
        w_compound(
            "CustomName",
            w_string("type", "object"),
            w_string("object", "player"),
            w_string("player", "SafeName"),
            w_string("translate", "unused.key"),
            w_compound("fallback", w_string("text", "Visible object fallback")),
        ),
    ) == ["Visible object fallback"]
    assert nbt_texts(
        wt, w_compound("CustomName", w_string("translate", "k.v"), w_string("player", "SafeName"), w_string("fallback", "Translate wins untyped"))
    ) == ["Translate wins untyped"]
    assert nbt_texts(wt, w_compound("CustomName", w_string("translate", "k.v"), w_string("fallback", "Tr fallback"))) == ["Tr fallback"]
    record("comp02.review_effective_component_kind")


def review_fix_sign_lines(t: Tr) -> list[bytes]:
    """JSON-in-string components as older worlds and command blocks write them, noncompact on purpose."""
    inner = '{ "text" : "%s", "font" : "example:font", "color" : "\\u0072ed" }' % t("Hover blade")
    outer = (
        '{ "text" : "%s" , "hoverEvent" : { "action" : "show_item" , "contents" : '
        '{ "id" : "minecraft:stone" , "components" : { "minecraft:custom_name" : %s } } } }'
    ) % (t("Outer sign"), json.dumps(inner))
    legacy_value = (
        '{ "text" : "%s" , "hoverEvent" : { "action" : "show_entity" , "value" : { "text" : "%s" } } }'
    ) % (t("Legacy sign"), t("Legacy tooltip"))
    return [
        w_string("id", "minecraft:sign"),
        w_int("x", 8), w_int("y", 64), w_int("z", 1),
        w_string("Text1", outer),
        w_string("Text2", legacy_value),
    ]


def review_fix_command_block(t: Tr) -> list[bytes]:
    inner = '{ "text" : "%s", "font" : "example:font", "color" : "\\u0072ed" }' % t("Cmd hover blade")
    command = (
        "tellraw @a {text:'%s',hover_event:{action:show_item,id:'minecraft:stone',"
        "components:{'minecraft:custom_name':\"%s\"}}}"
    ) % (t("Cmd outer"), inner.replace("\\", "\\\\").replace('"', '\\"'))
    return [w_string("id", "minecraft:command_block"), w_int("x", 9), w_int("y", 64), w_int("z", 1), w_string("Command", command)]


def review_fix_chunk(t: Tr = lambda text: text) -> bytes:
    plain_nbt = [
        w_string("id", "minecraft:sign"),
        w_int("x", 10), w_int("y", 64), w_int("z", 1),
        w_compound(
            "front_text",
            w_list_of_compounds(
                "messages",
                [
                    [
                        w_string("type", "text"),
                        w_string("text", t("Plain visible")),
                        w_compound("player", w_string("name", "SafeName"), w_string("text", "Not text")),
                        w_compound("fallback", w_string("text", "Not a component fallback")),
                    ],
                    [
                        w_string("object", "player"),
                        w_compound(
                            "player",
                            w_string("name", "SafeName"),
                            w_list_of_compounds("properties", [[w_string("text", "Not a property")]]),
                        ),
                        w_compound("fallback", w_string("text", t("Glyph fallback"))),
                    ],
                    [
                        w_string("text", t("Plain legacy outer")),
                        w_compound(
                            "hoverEvent",
                            w_string("action", "show_entity"),
                            w_compound("value", w_string("text", t("Plain legacy value"))),
                        ),
                    ],
                    empty_line(),
                ],
            ),
        ),
    ]
    return root(
        w_int("DataVersion", 4556),
        w_list_of_compounds("block_entities", [review_fix_sign_lines(t), review_fix_command_block(t), plain_nbt]),
    )


REVIEW_FIX_TEXTS = (
    "Hover blade", "Outer sign", "Legacy sign", "Legacy tooltip", "Cmd hover blade", "Cmd outer",
    "Plain visible", "Glyph fallback", "Plain legacy outer", "Plain legacy value",
)
REVIEW_FIX_NOT_TEXT = ("Not text", "Not a component fallback", "Not a property", "example:font", "SafeName")


def test_review_fixes_world_scan_write_reopen_restore() -> None:
    class PrefixHandler(TranslatorHandler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(json.loads(self.rfile.read(length).decode("utf-8"))["messages"][1]["content"])
            raw = json.dumps(
                {"choices": [{"message": {"content": json.dumps({k: prefixed(v) for k, v in payload.items()})}}]}
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    server = ThreadingHTTPServer(("127.0.0.1", 0), PrefixHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base_url = "http://%s:%s/v1" % server.server_address[:2]
    try:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            world = tmp / "world"
            region_path = world / "region" / "r.0.0.mca"
            write_region(region_path, {0: (2, review_fix_chunk(), False)})
            baseline = hashlib.sha256(region_path.read_bytes()).hexdigest()

            scan = WorldTranslator(config_for(world, tmp / "scan.json", base_url, dry_run=True))
            scan.run()
            assert set(REVIEW_FIX_TEXTS) == set(scan.candidate_texts), sorted(set(REVIEW_FIX_TEXTS) ^ set(scan.candidate_texts))
            assert hashlib.sha256(region_path.read_bytes()).hexdigest() == baseline, "a scan must not write"

            report = run_world(world, tmp / "write.json", base_url, dry_run=False)
            assert report["status"] == "completed", report
            assert hashlib.sha256(region_path.read_bytes()).hexdigest() != baseline
            reopened = RegionFile.read(region_path)
            assert reopened.chunks[0].raw_nbt == review_fix_chunk(prefixed), (
                "the written chunk equals the same fixture with translated strings: no other byte moved"
            )
            for text in REVIEW_FIX_NOT_TEXT:
                assert prefixed(text).encode() not in reopened.chunks[0].raw_nbt

            BackupSet(world, "latest").restore()
            restored = hashlib.sha256(region_path.read_bytes()).hexdigest()
            assert restored == baseline, "restore must return the baseline SHA-256"
            print(f"comp02_fix_baseline_sha256 {baseline}")
            print(f"comp02_fix_restored_sha256 {restored}")
    finally:
        server.shutdown()
    record("comp02.fix_world_scan_write_reopen_restore")


def run_all(_tmp: Path | None = None) -> list[str]:
    RESULTS.clear()
    test_scan_finds_exactly_the_visible_text()
    test_write_changes_only_the_text()
    test_filtered_follows_raw()
    test_scan_switches_apply_to_hover_items()
    test_json_and_snbt_forms_keep_everything_else()
    test_non_text_object_parts_are_never_collected()
    test_world_scan_write_reopen_restore()
    test_embedded_json_keeps_unchanged_bytes()
    test_embedded_json_unmappable_edit_falls_back_to_compact()
    test_snbt_keeps_the_quote_of_the_replaced_string()
    test_legacy_hover_payloads_are_still_collected()
    test_legacy_hover_payloads_in_nbt_are_still_collected()
    test_explicit_type_wins_and_object_payloads_are_not_text()
    test_effective_kind_is_decided_before_the_fallback()
    test_review_fixes_world_scan_write_reopen_restore()
    return list(RESULTS)


def main() -> None:
    run_all()
    print("COMPONENT_SHAPES_PASSED")


if __name__ == "__main__":
    main()
