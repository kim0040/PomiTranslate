"""Formatting tokens survive translation: java.util.Formatter placeholders, {names} and section codes."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mwt.tokens import preserve_tokens, tokens_preserved  # noqa: E402

RESULTS: list[str] = []


def record(name: str) -> None:
    RESULTS.append(name)
    print(f"PASS {name}")


def test_each_placeholder_form_is_protected() -> None:
    # (original, a translation that keeps the placeholder, translations that lose or change it)
    cases = [
        ("Hi %s", "안녕 %s", ["안녕", "안녕 %d", "안녕 %s %s"]),
        ("Level %d", "레벨 %d", ["레벨", "레벨 %s"]),
        ("Level %02d", "레벨 %02d", ["레벨", "레벨 %d", "레벨 %03d", "레벨 %2d"]),
        ("Gold: %.2f", "금: %.2f", ["금", "금: %f", "금: %.1f", "금: %.3f"]),
        ("Gold: %1$.2f", "금: %1$.2f", ["금", "금: %1$.1f", "금: %.2f", "금: %2$.2f"]),
        ("Hex %x", "16진 %x", ["16진", "16진 %X", "16진 %d"]),
        ("Hex %08X", "16진 %08X", ["16진 %8X", "16진"]),
        ("Name: %s", "이름: %s", ["이름", "이름: %S"]),
        ("NAME %S", "이름 %S", ["이름 %s", "이름"]),
        ("Done 100%%", "완료 100%%", ["완료 100%", "완료 100"]),
        ("Line%n Next", "줄%n 다음", ["줄 다음", "줄\n 다음"]),
        ("Time %tY-%tm", "시간 %tY-%tm", ["시간 %tY", "시간 %tY-%td"]),
        ("%-10s|", "%-10s|", ["%10s|", "%s|"]),
        ("%+d points", "%+d 점", ["%d 점"]),
        ("%,d coins", "%,d 코인", ["%d 코인"]),
        ("%b flag", "%b 깃발", ["깃발"]),
        ("Hello {player}", "안녕 {player}", ["안녕", "안녕 {name}"]),
        ("§6Gold §rcoin", "§6금 §r동전", ["금 동전", "§c금 §r동전"]),
    ]
    for original, kept, broken in cases:
        assert tokens_preserved(original, kept), (original, kept)
        assert preserve_tokens(original, kept) == kept
        for answer in broken:
            assert not tokens_preserved(original, answer), (original, answer)
            assert preserve_tokens(original, answer) == original, (original, answer)
    record("tokens.placeholder_forms")


def test_indexed_arguments_may_swap_places_but_not_change() -> None:
    original = "%1$s killed %2$s with %3$d hits"
    assert tokens_preserved(original, "%2$s 처치 %1$s, %3$d 회")
    assert tokens_preserved(original, "%3$d 회 %1$s %2$s")
    assert not tokens_preserved(original, "%1$s 처치 %2$s")  # an argument dropped
    assert not tokens_preserved(original, "%1$s %2$s %3$s")  # 3rd argument changed from %d to %s
    assert not tokens_preserved(original, "%1$s %2$s %3$d %3$d")  # one invented
    assert not tokens_preserved(original, "%1$s %1$s %3$d")  # 2nd argument replaced by the 1st
    assert tokens_preserved("%2$.2f of %1$s", "%1$s 중 %2$.2f")
    record("tokens.indexed_reordering")


def test_prose_percentages_are_not_placeholders() -> None:
    # A percent sign next to a word is a sentence, not a format spec (and "% o" with a space is not one either).
    assert tokens_preserved("Save 50% now", "지금 50% 절약")
    assert tokens_preserved("50% sure", "50% 확신")
    assert tokens_preserved("15%off today", "오늘 15%할인")
    assert tokens_preserved("100% chance", "100% 확률")
    assert tokens_preserved("Drops 5% of the time", "5% 확률로 드롭")
    # The old token set still counts as a token inside a word, as before.
    assert not tokens_preserved("%shp", "hp")
    assert not tokens_preserved("Got %dxp", "경험치")
    record("tokens.prose_percent_is_not_a_placeholder")


def run_all() -> list[str]:
    RESULTS.clear()
    test_each_placeholder_form_is_protected()
    test_indexed_arguments_may_swap_places_but_not_change()
    test_prose_percentages_are_not_placeholders()
    return list(RESULTS)


if __name__ == "__main__":
    run_all()
    print("TEXT_TOKENS_PASSED")
