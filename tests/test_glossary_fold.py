"""The glossary's source folding, shared with the UI: the same fixture runs here and in tests/frontend/glossary.test.ts.

The UI checks duplicate sources on screen with its own copy of the core's rule (``fold_key`` plus the symmetric
case-sensitivity rule). This test pins the core side: the shared cases, and the table of characters whose
case folding differs from lowercase, which the UI uses to turn ``toLowerCase()`` into ``casefold()``.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mwt import glossary  # noqa: E402

FIXTURE = ROOT / "tests" / "fixtures" / "glossary_fold_cases.json"
TABLE = ROOT / "src" / "lib" / "glossary-casefold.json"


def test_fold_cases() -> None:
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["foldCases"]
    assert len(cases) > 20
    for case in cases:
        assert glossary.fold_key(case["text"]) == case["folded"], case


def first_clash(entries: list[dict]) -> int | None:
    try:
        glossary.normalize_entries([{**item, "target": "", "mode": "keep"} for item in entries])
    except glossary.GlossaryError as error:
        assert error.code == "GLOSSARY_INVALID", error
        match = re.match(r"entries\[(\d+)\]\.source:", error.message)
        assert match, error.message
        return int(match.group(1))
    return None


def test_clash_cases() -> None:
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["clashCases"]
    assert any(case["clashAt"] is None for case in cases) and any(case["clashAt"] is not None for case in cases)
    for case in cases:
        assert first_clash(case["entries"]) == case["clashAt"], case


def test_the_ui_table_is_every_character_where_casefold_differs_from_lower() -> None:
    table = json.loads(TABLE.read_text(encoding="utf-8"))["map"]
    expected = {}
    for code in range(0x110000):
        if 0xD800 <= code <= 0xDFFF:
            continue
        char = chr(code)
        if char.casefold() != char.lower():
            expected[char] = char.casefold()
    assert table == expected, sorted(set(table.items()) ^ set(expected.items()))[:10]


def main() -> None:
    tests = (test_fold_cases, test_clash_cases, test_the_ui_table_is_every_character_where_casefold_differs_from_lower)
    for test in tests:
        test()
        print("PASS", test.__name__)
    print(f"GLOSSARY_FOLD_PASSED ({len(tests)} tests)")


if __name__ == "__main__":
    main()
