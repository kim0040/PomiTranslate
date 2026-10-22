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
        ("Gold: %1$.2f", "금: %1$.2f", ["금", "금: %1$.1f", "금: %2$.2f"]),
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


def test_arguments_are_compared_by_what_they_bind() -> None:
    # Sequential (implicit) arguments: the order of types is part of the meaning.
    assert tokens_preserved("%s %d", "이름 %s, 수 %d")
    assert not tokens_preserved("%s %d", "%d %s")  # the two arguments would swap types
    assert not tokens_preserved("%s killed %s", "%s 처치 %d")
    assert tokens_preserved("%s killed %s", "%s 가 %s 를 처치")
    # Explicit indexes may be reordered freely, as long as each argument keeps its conversion.
    assert tokens_preserved("%1$s %2$d", "%2$d %1$s")
    assert not tokens_preserved("%1$s %2$d", "%1$d %2$s")
    # An explicit index and the same argument given implicitly are the same binding.
    assert tokens_preserved("%1$s %2$d", "%s %d")
    assert tokens_preserved("%1$.2f", "%.2f")
    # An explicit index does not move the ordinary counter: %s here is argument 1 again.
    assert tokens_preserved("%2$d %s", "%s %2$d")
    assert not tokens_preserved("%2$d %s", "%d %s")
    # Relative "<" reuses the previous spec's argument, so its position matters.
    assert tokens_preserved("%1$s %<s %2$s", "%1$s %<s %2$s")
    assert not tokens_preserved("%1$s %<s %2$s", "%1$s %2$s %<s")  # a different name would be repeated
    assert tokens_preserved("%s %<s", "%s %<s")
    assert tokens_preserved("%s %<S", "%s %<S")
    assert tokens_preserved("%s %<s", "%1$s %1$s")  # the same bindings spelled differently
    assert not tokens_preserved("%s %<s", "%<s %s")  # "%<s" first has nothing to reuse
    assert not tokens_preserved("%s %<d", "%s %<s")
    record("tokens.argument_bindings")


def test_all_formatter_flags_and_the_relative_index_anywhere_legal() -> None:
    # The space flag is a flag: "Value % d" has a placeholder and losing it is a defect.
    assert not tokens_preserved("Value % d", "Value")
    assert tokens_preserved("Value % d", "값 % d")
    assert not tokens_preserved("Value % d", "값 %d")  # a different flag formats the number differently
    assert tokens_preserved("% d points", "% d 점")
    # "<" may sit among the flags, not only in front of them.
    assert not tokens_preserved("%-<10s", "gone")
    assert tokens_preserved("%s %-<10s", "%s %-<10s")
    assert tokens_preserved("%s %<-10s", "%s %-<10s")  # the order of flags is not a meaning
    assert not tokens_preserved("%s %-<10s", "%s %<10s")  # "-" (left-justify) lost
    assert not tokens_preserved("%s %-<10s", "%s %<s")  # width lost
    assert tokens_preserved("%s %0<8d", "%s %0<8d") is True
    # Every flag in "-#+ 0,(" is kept as part of the identity.
    for flag in "-#+ 0,(":
        spec = f"%{flag}8x" if flag != "0" else "%08x"
        assert tokens_preserved(f"Hex {spec}", f"16진 {spec}"), spec
        assert not tokens_preserved(f"Hex {spec}", "16진 %x"), spec
    # "<" together with an explicit index: Java lets "<" win, and so do we.
    assert tokens_preserved("%1$s %2$s %1$<s", "%1$s %2$s %<s")  # "<" ignores the index and reuses argument 2
    assert not tokens_preserved("%1$s %2$s %1$<s", "%1$s %2$s %1$s")
    record("tokens.flags_and_relative_index")


def test_percent_signs_and_newlines_count_without_binding() -> None:
    assert tokens_preserved("100%% sure, %s", "확실히 100%%, %s")
    assert not tokens_preserved("100%% sure, %s", "확실히 100%, %s")
    assert not tokens_preserved("100%% sure, %s", "확실히 100%%%%, %s")
    assert tokens_preserved("a %n b %n c", "가 %n 나 %n 다")
    assert not tokens_preserved("a %n b %n c", "가 %n 나 다")
    # They do not consume an argument.
    assert tokens_preserved("%s%n%d", "%s %n %d")
    assert tokens_preserved("100% %s", "100% %s")  # a lone percent sign before a placeholder
    assert not tokens_preserved("100% %s", "100%")
    record("tokens.literal_percent_and_newline")


def test_prose_is_judged_separately_from_formatter_specs() -> None:
    for prose, translated in (
        ("50% off", "50% 할인"),
        ("50% sure", "50% 확신"),
        ("Save 50% on armor", "방어구 50% 할인"),
        ("A 5% discount", "5% 할인"),
        ("Drops 5% of the time", "5% 확률로 드롭"),
        ("100% done", "100% 완료"),
        ("20 % damage", "피해 20 %"),
        ("15%off today", "오늘 15%할인"),
        ("3% bonus", "3% 보너스"),
    ):
        assert tokens_preserved(prose, translated), (prose, translated)
        assert preserve_tokens(prose, translated) == translated
    # Prose beside a real placeholder does not shift the argument numbering.
    assert tokens_preserved("50% off for %s and %s", "%s 와 %s 는 50% 할인")
    assert not tokens_preserved("50% off for %s and %d", "%d 와 %s 는 50% 할인")
    # A percent sign + space + conversion at the end or before punctuation is a placeholder.
    assert not tokens_preserved("Cost: % d.", "비용.")
    record("tokens.prose_heuristics_are_separate")


def run_all() -> list[str]:
    RESULTS.clear()
    test_each_placeholder_form_is_protected()
    test_indexed_arguments_may_swap_places_but_not_change()
    test_prose_percentages_are_not_placeholders()
    test_arguments_are_compared_by_what_they_bind()
    test_all_formatter_flags_and_the_relative_index_anywhere_legal()
    test_percent_signs_and_newlines_count_without_binding()
    test_prose_is_judged_separately_from_formatter_specs()
    return list(RESULTS)


if __name__ == "__main__":
    run_all()
    print("TEXT_TOKENS_PASSED")
