"""Source letters left next to a format code (``§lcrypt`` -> ``§lc지하실``): true and false positives."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mwt.format_residue import find_residue, target_script  # noqa: E402

KO, JA, ZH = "한국어", "Japanese", "中文"


def residue(source: str, translated: str, language: str = KO) -> list[str]:
    return [item["letters"] for item in find_residue(source, translated, language)]


def test_the_measured_case() -> None:
    assert residue("§lcrypt", "§lc지하실") == ["c"]
    assert residue("§6§lCrypt of Doom", "§6§lC파멸의 지하실") == ["C"]


def test_two_and_three_letters_left_behind() -> None:
    assert residue("§aElder Mira", "§aEl장로 미라") == ["El"]
    assert residue("§cSkeleton King", "§cSke해골 왕") == ["Ske"]


def test_japanese_and_chinese_targets() -> None:
    assert residue("§lcrypt", "§lcクリプト", "ja") == ["c"]
    assert residue("§lcrypt", "§lc地下室", ZH) == ["c"]


def test_a_kept_latin_word_is_not_residue() -> None:
    # The whole source word is what follows the code, so it is a brand/acronym kept on purpose.
    assert residue("§6TNT is dangerous", "§6TNT는 위험하다") == []
    assert residue("§lNPC", "§lNPC가") == []
    assert residue("§eVIP Room", "§eVIP룸") == []
    assert residue("§aA fine day", "§aA 좋은 날") == []


def test_longer_latin_words_and_spaced_words_are_not_residue() -> None:
    assert residue("§6Mojang Studios", "§6Mojang 스튜디오") == []
    assert residue("§6Mojang", "§6Mojang은") == []          # six letters, not a stray prefix
    assert residue("§lcrypt", "§l지하실") == []              # clean translation
    assert residue("§lcrypt", "§lc rypt") == []             # no non-Latin letter right after the letters


def test_no_matching_source_word_no_finding() -> None:
    assert residue("§lGood luck", "§lx행운을") == []         # "x" is not the start of the source word
    assert residue("Good luck", "§lc행운을") == []           # the source has no such code at all
    assert residue("§lcrypt", "§rc지하실") == []             # different code than in the source


def test_latin_script_targets_and_unknown_languages_are_never_checked() -> None:
    for language in ("English", "Español", "Deutsch", "", "Français"):
        assert residue("§lcrypt", "§lcéripta", language) == []
        assert residue("§lcrypt", "§lc지하실", language) == [], language


def test_ampersand_style_text_is_ignored_like_the_tokenizer_does() -> None:
    assert residue("&lcrypt", "&lc지하실") == []


def test_every_code_in_a_line_is_checked() -> None:
    found = find_residue("§6Elder §cMira", "§6장로 §cMi미라", KO)
    assert [(item["code"], item["letters"]) for item in found] == [("§c", "Mi")], found


def test_target_script_names() -> None:
    for name in ("한국어", "Korean", "ko", "ko-KR", " KO "):
        assert target_script(name) == "ko", name
    for name in ("日本語", "Japanese", "ja", "일본어"):
        assert target_script(name) == "ja", name
    for name in ("中文", "简体中文", "Chinese", "zh-CN", "zh", "繁體中文", "중국어"):
        assert target_script(name) == "zh", name
    for name in ("English", "", "Español", "Russian"):
        assert target_script(name) == "", name


def test_a_kept_brand_next_to_a_longer_word_with_the_same_prefix_is_not_residue() -> None:
    """M8: the brand is a whole source word after the same code, whatever else shares the code and prefix."""
    assert residue("§6CAT §6CATERPILLAR", "§6CAT는 §6캐터필러") == []
    assert residue("§6CATERPILLAR §6CAT", "§6캐터필러 §6CAT는") == []
    assert residue("§6CAT §6CATERPILLAR", "§6CAT는 §6CATERPILLAR가") == [], "a six-letter word is not a stray prefix"
    assert residue("§6CAT", "§6CAT는") == []
    # Each kept word excuses one occurrence only; the next one is judged on its own.
    assert residue("§6Cat §6Caterpillar", "§6Cat는 §6Cat이야기") == ["Cat"]
    # Without a kept word the leftover prefix is still residue, also next to other words.
    assert residue("§6CATERPILLAR §6DOG", "§6CAT필러 §6개") == ["CAT"]
    assert residue("§6CATERPILLAR", "§6CAT필러") == ["CAT"]


def test_the_check_is_enabled_by_language_code_or_exact_name_only() -> None:
    """L3: never by a name inside a longer description."""
    for code in ("ko", "KO", "ko-KR", "ko_KR", "kor"):
        assert target_script(code) == "ko", code
    for code in ("ja", "ja-JP", "ja_JP", "jpn"):
        assert target_script(code) == "ja", code
    for code in ("zh", "zh-CN", "zh_TW", "zh-Hans", "zh-Hant-TW", "zho", "cmn"):
        assert target_script(code) == "zh", code
    for text in ("English (not Korean)", "Korean romanization", "Japanese (romaji)", "Write Chinese pinyin", "English; 한국어 병기",
                 "한국어로 번역하되 영어 병기", "ko-Latn", "ja-Latn", "zh-Latn-pinyin", "en", "en-US", "es", "ru", "kok", "korea"):
        assert target_script(text) == "", text
    assert residue("§lcrypt", "§lc지하실", "English (not Korean)") == []
    assert residue("§lcrypt", "§lc지하실", "ko-Latn") == []
    assert residue("§lcrypt", "§lc지하실", "ko-KR") == ["c"]
    assert residue("§lcrypt", "§lc지하실", "zh-Hant-TW") == ["c"]


def main() -> None:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
        print("PASS", test.__name__)
    print(f"FORMAT_RESIDUE_PASSED ({len(tests)} tests)")


if __name__ == "__main__":
    main()
