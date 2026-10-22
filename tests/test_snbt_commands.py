"""Java 1.21.5+ commands write text components as SNBT, not JSON.

These cases come from the forms the game accepts in ``tellraw``/``title``: single and double quotes,
unquoted keys and words, escapes, nested ``extra``/``hover_event``/``click_event``, typed arrays and
numbers. Only visible strings may change; selectors, ids, numbers and layout must survive byte for byte.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

from mwt import snbt  # noqa: E402
from test_extraction import root, translator, w_compound, w_int, w_list_of_compounds, w_string  # noqa: E402

RESULTS: list[str] = []


def record(name: str) -> None:
    RESULTS.append(name)
    print(f"PASS {name}")


def test_parse_and_render_change_only_strings() -> None:
    source = "{text:'Hello',color:gold,bold:1b,extra:[\"World\",{text:Tail,italic:true}],n:[I;1,2]}"
    document = snbt.parse(source)
    value = document.value
    assert value["text"] == "Hello" and value["extra"][0] == "World" and value["extra"][1]["text"] == "Tail"
    assert isinstance(value["bold"], snbt.Literal) and isinstance(value["n"], snbt.Literal)
    assert document.render() == source, "an unedited document is the source itself"
    value["text"] = "안녕"
    value["extra"][1]["text"] = "꼬리 '따옴표'"
    rendered = document.render()
    assert rendered == "{text:'안녕',color:gold,bold:1b,extra:[\"World\",{text:\"꼬리 '따옴표'\",italic:true}],n:[I;1,2]}", rendered
    again = snbt.parse(rendered).value
    assert again["text"] == "안녕" and again["extra"][1]["text"] == "꼬리 '따옴표'"
    record("snbt.render_in_place")


def test_escapes_and_quotes_round_trip() -> None:
    document = snbt.parse("{text:'It\\'s a \\\"test\\\"\\nline \\u00e9 \\x41'}")
    assert document.value["text"] == "It's a \"test\"\nline é A"
    document.value["text"] = 'back\\slash "and" \'both\'\nnew'
    rendered = document.render()
    assert snbt.parse(rendered).value["text"] == 'back\\slash "and" \'both\'\nnew', rendered
    for bad in ("{text:'open", "{text:'x' extra}", "{text:'\\q'}", "{:'x'}", "[1,2"):
        try:
            snbt.parse(bad)
        except snbt.SnbtError:
            continue
        raise AssertionError(f"{bad!r} must not parse")
    record("snbt.escapes")


def _command_texts(command: str) -> tuple[set[str], str, int]:
    wt = translator()
    chunk = root(
        w_list_of_compounds(
            "block_entities",
            [[w_string("id", "minecraft:command_block"), w_int("x", 1), w_int("y", 64), w_int("z", 1), w_string("Command", command)]],
        )
    )
    tree = wt.parse_nbt_bytes(chunk)
    refs: list = []
    wt.collect_tag_refs(tree, refs, "r.0.0.mca#0")
    texts = {text for text, _ in wt.extract_occurrences(refs)}
    wt.apply_translations(refs, {text: f"[T] {text}" for text in texts})
    written = wt.parse_nbt_bytes(tree.dump())["block_entities"][0]["Command"].value
    return texts, written, getattr(wt, "unparsed_commands", 0)


def test_snbt_commands_are_found_and_patched() -> None:
    texts, written, unparsed = _command_texts("tellraw @a {text:'Hello hero',color:gold}")
    assert texts == {"Hello hero"} and unparsed == 0
    assert written == "tellraw @a {text:'[T] Hello hero',color:gold}", "the original quote style is kept"

    command = (
        "/execute as @a[tag=quest,distance=..5] at @s run tellraw @s "
        "[{text:\"Guard: \",color:\"#AA0000\"},{text:'Halt!',hover_event:{action:show_text,value:'Who goes there'}},"
        "{text:'[Talk]',click_event:{action:run_command,command:\"/tellraw @s {text:'Nice to meet you'}\"}}]"
    )
    texts, written, unparsed = _command_texts(command)
    assert texts == {"Guard: ", "Halt!", "Who goes there", "[Talk]", "Nice to meet you"}, texts
    assert written.startswith("/execute as @a[tag=quest,distance=..5] at @s run tellraw @s ["), written
    assert 'color:"#AA0000"' in written and "action:show_text" in written and "action:run_command" in written
    assert "[T] Nice to meet you" in written and "[T] Who goes there" in written

    texts, written, _ = _command_texts("title @a subtitle {text:Welcome}")
    assert texts == {"Welcome"} and written == 'title @a subtitle {text:"[T] Welcome"}', written

    texts, written, _ = _command_texts('tellraw @a "Plain string component"')
    assert texts == {"Plain string component"} and written == 'tellraw @a "[T] Plain string component"'
    record("snbt.command_blocks")
    record("text.snbt_commands")


def test_json_commands_keep_working_and_bad_ones_are_counted() -> None:
    texts, written, unparsed = _command_texts('/tellraw @a {"text":"Json hello"}')
    assert texts == {"Json hello"} and unparsed == 0
    assert written == '/tellraw @a {"text":"[T] Json hello"}', written

    texts, written, unparsed = _command_texts("tellraw @a {text:'broken")
    assert texts == set() and unparsed == 1
    assert written == "tellraw @a {text:'broken", "an unreadable command is left exactly as it was"

    texts, written, unparsed = _command_texts("give @p diamond 1")
    assert texts == set() and unparsed == 0 and written == "give @p diamond 1"
    record("snbt.json_and_unparsed")


def test_surrogate_escapes_and_duplicate_keys() -> None:
    # A valid UTF-16 pair written as two escapes is one character, the same as the 8-digit form.
    pair = snbt.parse(r'{text:"😀 hi"}')
    assert pair.value["text"] == "\U0001F600 hi"
    assert snbt.parse(r'{text:"\U0001F600 hi"}').value["text"] == "\U0001F600 hi"
    assert snbt.parse(r'{text:"é\x41"}').value["text"] == "éA"
    pair.value["text"] = "\U0001F600 안녕"
    assert pair.render() == '{text:"\U0001F600 안녕"}'
    for bad in (
        r'{text:"\uD83D"}',  # high surrogate alone
        r'{text:"\uD83D x"}',  # high surrogate followed by text
        r'{text:"\uDE00"}',  # low surrogate alone
        r'{text:"\uDE00\uD83D"}',  # pair in the wrong order
        r'{text:"\uD83DA"}',  # high surrogate followed by an ordinary character
        r'{text:"\U0000D83D"}',  # a surrogate through the 8-digit form
        r'{text:"\U00110000"}',  # beyond U+10FFFF
        r'{text:"\UFFFFFFFF"}',
    ):
        try:
            snbt.parse(bad)
        except snbt.SnbtError:
            pass
        else:
            raise AssertionError(f"{bad} must be refused")
    try:
        snbt.parse("{text:'Old text',text:'Visible text'}")
    except snbt.SnbtError:
        pass
    else:
        raise AssertionError("a duplicate key must be refused")
    snbt.parse("{a:{text:'x'},b:{text:'y'}}")  # the same key in different compounds is fine

    # In a world: the command is kept exactly, counted as unparsed, and the region is not skipped.
    for command in (
        r'tellraw @a {text:"\uD83D hello there"}',
        r"tellraw @a {text:'Old text',text:'Visible text'}",
    ):
        texts, written, unparsed = _command_texts(command)
        assert texts == set() and unparsed == 1 and written == command, (texts, written, unparsed)
    texts, written, unparsed = _command_texts(r'tellraw @a {text:"😀 hello there"}')
    assert texts == {"\U0001F600 hello there"} and unparsed == 0
    assert written == 'tellraw @a {text:"[T] \U0001F600 hello there"}', written
    record("snbt.surrogates_and_duplicate_keys")


def test_lone_surrogate_from_json_does_not_break_extraction() -> None:
    # json.loads accepts "\ud83d" and returns a string no UTF-8 encoder takes; it must not skip the region.
    texts, written, unparsed = _command_texts(r'tellraw @a [{"text":"\ud83d broken line"},{"text":"Fine line"}]')
    assert texts == {"Fine line"}, texts
    assert unparsed == 0 and "[T] Fine line" in written
    record("snbt.json_lone_surrogate_is_skipped")


def run_all(_tmp: Path) -> list[str]:
    RESULTS.clear()
    test_surrogate_escapes_and_duplicate_keys()
    test_lone_surrogate_from_json_does_not_break_extraction()
    test_parse_and_render_change_only_strings()
    test_escapes_and_quotes_round_trip()
    test_snbt_commands_are_found_and_patched()
    test_json_commands_keep_working_and_bad_ones_are_counted()
    return list(RESULTS)


def main() -> None:
    with tempfile.TemporaryDirectory() as raw:
        run_all(Path(raw))
    print("SNBT_COMMANDS_PASSED")


if __name__ == "__main__":
    main()
