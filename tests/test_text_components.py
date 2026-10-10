"""A text component stored as a JSON string literal is its inner text, by DataVersion.

Before 1.21.5 (DataVersion 4298, snapshot 25w02a) every text component in NBT is JSON, so the
string ``"Welcome home"`` (quotes included) is the text Welcome home. It used to be treated as a
literal string: the quotes went to the model and the review, and a model that dropped them wrote
an invalid component. From 1.21.5 a plain string is literal text and must stay exactly that.
"""

from __future__ import annotations

import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import mc_world_translator as core  # noqa: E402
from llm_backends import LLMProviderClient  # noqa: E402
from mwt import nbtio  # noqa: E402
from mwt.extract import EXTRACTOR_VERSION, TEXT_COMPONENT_NBT_DATA_VERSION, json_string_text, match_wrapping_quotes  # noqa: E402
from mwt.region import RegionFile  # noqa: E402
from mwt.safety import world_fingerprint  # noqa: E402

PRE_1_21_5 = 4189  # 1.21.4
ITEM_COMPONENTS_ERA = 3953  # 1.21: item components, but text components are still JSON strings
MODERN = 4325  # 1.21.5


# --- a small NBT writer, independent of mwt.nbtio's reader ---------------------------------------


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


def root(*children: bytes) -> bytes:
    return bytes([10]) + _name("") + b"".join(children) + b"\x00"


def quoted(text: str) -> str:
    return json.dumps(text, ensure_ascii=False)


TRICKY = 'Say "hi" \\ café 🙂'


def chunk(data_version: int | None) -> bytes:
    """Signs (both faces and the pre-1.20 lines), a named entity, and items in both item formats."""
    sign = [
        w_string("id", "minecraft:oak_sign"), w_int("x", 1), w_int("y", 64), w_int("z", 2),
        w_compound("front_text", w_list_of_strings("messages", [quoted("Welcome home"), quoted(TRICKY), '""', '{"text":"Json line"}'])),
        w_compound("back_text", w_list_of_strings("messages", [quoted("Back side"), '""', '""', '""'])),
    ]
    old_sign = [
        w_string("id", "minecraft:sign"), w_int("x", 3), w_int("y", 64), w_int("z", 2),
        w_string("Text1", quoted("Old line")), w_string("Text2", '""'),
    ]
    legacy_item = [
        w_string("id", "minecraft:diamond_sword"), w_int("Count", 1),
        w_compound("tag", w_compound("display", w_string("Name", quoted("Sword")), w_list_of_strings("Lore", [quoted("Lore line")]))),
    ]
    component_item = [
        w_string("id", "minecraft:book"), w_int("count", 1),
        w_compound("components", w_string("minecraft:custom_name", quoted("Comp Name")),
                   w_string("minecraft:item_name", quoted("Item Name")),
                   w_list_of_strings("minecraft:lore", [quoted("Comp lore")])),
    ]
    chest = [
        w_string("id", "minecraft:chest"), w_int("x", 5), w_int("y", 64), w_int("z", 2),
        w_list_of_compounds("Items", [legacy_item, component_item]),
    ]
    entity = [
        w_string("id", "minecraft:villager"), w_string("CustomName", quoted("Bob")),
        bytes([9]) + _name("Pos") + bytes([6]) + struct.pack(">i", 3) + struct.pack(">ddd", 1.0, 65.0, 2.0),
    ]
    children = [w_list_of_compounds("block_entities", [sign, old_sign, chest]), w_list_of_compounds("Entities", [entity])]
    if data_version is not None:
        children.insert(0, w_int("DataVersion", data_version))
    return root(*children)


INNER = {"Welcome home", TRICKY, "Json line", "Back side", "Old line", "Sword", "Lore line", "Comp Name", "Item Name", "Comp lore", "Bob"}


def translator(world: str = "/tmp/pomi-text-components") -> core.WorldTranslator:
    return core.WorldTranslator(core.merge_nested(core.DEFAULT_CONFIG, {
        "world_dir": world, "dry_run": True, "inherit_translate_py": False, "runtime": {"checkpoint_enabled": False},
    }))


def refs_of(wt: core.WorldTranslator, raw: bytes) -> tuple[object, list]:
    tree = wt.parse_nbt_bytes(raw)
    refs: list = []
    wt.collect_tag_refs(tree, refs, "r.0.0.mca#0")
    return tree, refs


def all_strings(node) -> list[str]:
    out: list[str] = []
    if isinstance(node, nbtio.TAG_String):
        out.append(node.value)
    elif isinstance(node, dict):
        for value in node.values():
            out.extend(all_strings(value))
    elif isinstance(node, list):
        for value in node:
            out.extend(all_strings(value))
    return out


class TextComponentTests(unittest.TestCase):
    def test_extractor_version_was_bumped_and_boundary_is_25w02a(self):
        self.assertGreaterEqual(EXTRACTOR_VERSION, 4)
        self.assertEqual(TEXT_COMPONENT_NBT_DATA_VERSION, 4298)

    def test_pre_1_21_5_json_strings_are_found_as_inner_text(self):
        for version in (PRE_1_21_5, ITEM_COMPONENTS_ERA, None):
            with self.subTest(data_version=version):
                wt = translator()
                _tree, refs = refs_of(wt, chunk(version))
                found = {text for text, _ in wt.extract_occurrences(refs)}
                self.assertEqual(found, INNER)
                self.assertFalse(any(text.startswith('"') for text in found), found)
                self.assertIn("json_string_tag", {ref.kind for ref in refs})

    def test_pre_1_21_5_translation_is_written_back_as_a_json_string(self):
        wt = translator()
        tree, refs = refs_of(wt, chunk(PRE_1_21_5))
        translations = {text: f"T {text}" for text in INNER}
        translations[TRICKY] = '말해 "안녕" \\ 카페 🙂'
        translations["Welcome home"] = "어서 오세요"
        self.assertGreater(wt.apply_translations(refs, translations), 0)
        again = wt.parse_nbt_bytes(tree.dump())
        sign = again["block_entities"][0]
        front = [tag.value for tag in sign["front_text"]["messages"]]
        self.assertEqual(front[0], '"어서 오세요"')
        self.assertEqual(json.loads(front[1]), '말해 "안녕" \\ 카페 🙂', front[1])
        self.assertEqual(front[2], '""', "an empty line stays as it was")
        self.assertEqual(json.loads(front[3]), {"text": "T Json line"})
        self.assertEqual(json.loads(sign["back_text"]["messages"][0].value), "T Back side")
        self.assertEqual(json.loads(again["block_entities"][1]["Text1"].value), "T Old line")
        items = again["block_entities"][2]["Items"]
        self.assertEqual(json.loads(items[0]["tag"]["display"]["Name"].value), "T Sword")
        self.assertEqual(json.loads(items[0]["tag"]["display"]["Lore"][0].value), "T Lore line")
        components = items[1]["components"]
        self.assertEqual(json.loads(components["minecraft:custom_name"].value), "T Comp Name")
        self.assertEqual(json.loads(components["minecraft:item_name"].value), "T Item Name")
        self.assertEqual(json.loads(components["minecraft:lore"][0].value), "T Comp lore")
        self.assertEqual(json.loads(again["Entities"][0]["CustomName"].value), "T Bob")
        # Every component string that was JSON is still valid JSON.
        for value in all_strings(again):
            if value.startswith('"'):
                json.loads(value)
        # Reading it back finds the translated inner texts, again without quotes.
        _tree, refs2 = refs_of(wt, tree.dump())
        self.assertEqual({text for text, _ in wt.extract_occurrences(refs2)}, set(translations.values()))

    def test_1_21_5_plus_quoted_strings_stay_literal(self):
        wt = translator()
        raw = root(w_int("DataVersion", MODERN), w_list_of_compounds("block_entities", [[
            w_string("id", "minecraft:oak_sign"), w_int("x", 1), w_int("y", 64), w_int("z", 2),
            w_compound("front_text", w_list_of_strings("messages", [quoted("Quoted literal"), "Plain", "", ""])),
        ]]))
        tree, refs = refs_of(wt, raw)
        found = {text for text, _ in wt.extract_occurrences(refs)}
        self.assertEqual(found, {'"Quoted literal"', "Plain"})
        self.assertEqual({ref.kind for ref in refs}, {"plain_tag"})
        wt.apply_translations(refs, {'"Quoted literal"': '"인용"', "Plain": "평문"})
        messages = [tag.value for tag in wt.parse_nbt_bytes(tree.dump())["block_entities"][0]["front_text"]["messages"]]
        self.assertEqual(messages[:2], ['"인용"', "평문"], "a literal string is written exactly as translated")
        # Untranslated, a 1.21.5+ chunk round-trips byte for byte.
        self.assertEqual(wt.parse_nbt_bytes(raw).dump(), raw)

    def test_helpers(self):
        self.assertEqual(json_string_text('"a \\"b\\" \\\\ é 🙂"'), 'a "b" \\ é 🙂')
        self.assertIsNone(json_string_text("plain"))
        self.assertIsNone(json_string_text('"unterminated'))
        self.assertIsNone(json_string_text('{"text":"x"}'))
        self.assertEqual(match_wrapping_quotes("Welcome", '"환영"'), "환영", "the model added quotes")
        self.assertEqual(match_wrapping_quotes('"Quoted"', "인용"), '"인용"', "the model dropped quotes")
        self.assertEqual(match_wrapping_quotes('"Quoted"', '"인용"'), '"인용"')
        self.assertEqual(match_wrapping_quotes("Say", 'He said "hi" and "bye"'), 'He said "hi" and "bye"')
        self.assertEqual(match_wrapping_quotes("Say", '"hi" and "bye"'), '"hi" and "bye"', "inner quotes are not a wrapper")

    def test_model_keeping_or_dropping_quotes_never_breaks_the_component(self):
        config = core.merge_nested(core.DEFAULT_CONFIG, {
            "inherit_translate_py": False,
            "api": {"provider": "openai", "api_key": "k", "model": "m"},
            "runtime": {"max_batch_retries": 1, "concurrency": 1},
        })
        answers = {"Welcome home": '"어서 오세요"', '"Quoted literal"': "인용", "Plain": "평문"}

        class Client:
            def translate_mapping(self, payload, *, system_prompt, temperature):
                return {key: answers[text] for key, text in payload.items()}

        batch = core.BatchTranslator(config)
        batch.client = Client()
        batch.translate_texts(list(answers))
        self.assertEqual(batch.cache["Welcome home"], "어서 오세요", "added quotes are taken off")
        self.assertEqual(batch.cache['"Quoted literal"'], '"인용"', "dropped quotes are put back")
        self.assertEqual(batch.cache["Plain"], "평문")
        wt = translator()
        tree, refs = refs_of(wt, chunk(PRE_1_21_5))
        wt.apply_translations(refs, {"Welcome home": batch.cache["Welcome home"]})
        value = wt.parse_nbt_bytes(tree.dump())["block_entities"][0]["front_text"]["messages"][0].value
        self.assertEqual(value, '"어서 오세요"')

    def test_scan_and_write_through_a_region_file(self):
        with tempfile.TemporaryDirectory(prefix="pomi-json-string-") as raw:
            world = Path(raw) / "world"
            region = RegionFile.empty()
            region.put_nbt(0, chunk(PRE_1_21_5), compression=2)
            path = world / "region" / "r.0.0.mca"
            path.parent.mkdir(parents=True)
            path.write_bytes(region.build()[0])
            (world / "level.dat").write_bytes(b"\x1f\x8b")
            scan = translator(str(world))
            scan_report = scan.run()
            self.assertEqual(set(scan._candidate_order), INNER, "the scan and review list show the inner text")
            self.assertEqual(scan_report["status"], "completed")
            calls: list[list[str]] = []

            def fake(_client, payload, *, system_prompt, temperature):
                calls.append(list(payload.values()))
                LLMProviderClient.request_count += 1
                # Keep quotes on one answer, as a model sometimes does.
                return {key: (f'"번역 {text}"' if text == "Bob" else f"번역 {text}") for key, text in payload.items()}

            config = core.merge_nested(core.DEFAULT_CONFIG, {
                "world_dir": str(world), "dry_run": False, "report_path": str(Path(raw) / "report.json"),
                "inherit_translate_py": False, "batch_size": 50,
                "api": {"provider": "openai", "api_key": "k", "model": "m"},
                "runtime": {"checkpoint_enabled": False, "expected_world_fingerprint": world_fingerprint(world),
                            "backup_store": str(Path(raw) / "store")},
            })
            with patch.object(LLMProviderClient, "translate_mapping", new=fake), \
                    patch.object(LLMProviderClient, "try_refresh_text_models", return_value=None):
                report = core.WorldTranslator(config).run()
            self.assertEqual(report["status"], "completed", report.get("errors"))
            self.assertEqual(set(calls[0]), INNER, "the model sees the inner text only")
            written = RegionFile.read(path)
            tree = core.WorldTranslator.parse_nbt_bytes(written.chunks[0].raw_nbt)
            self.assertEqual(tree["block_entities"][0]["front_text"]["messages"][0].value, '"번역 Welcome home"')
            self.assertEqual(json.loads(tree["block_entities"][0]["front_text"]["messages"][1].value), f"번역 {TRICKY}")
            self.assertEqual(json.loads(tree["Entities"][0]["CustomName"].value), "번역 Bob")


if __name__ == "__main__":
    unittest.main()
