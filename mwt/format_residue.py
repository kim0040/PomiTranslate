"""Detect source letters a model left glued to a Minecraft format code.

Some lite models answer ``§lcrypt`` with ``§lc지하실``: the code is kept, the word is translated, but
the first letter(s) of the original word stay behind. The check only runs for targets written in
Hangul, kana or Han (chosen from an explicit language code or exact language name) (Latin-script targets legitimately have Latin letters after a code), and it never
changes the text. The caller decides what to do with a finding (retry once, then warn).
"""

from __future__ import annotations

import re
import unicodedata

from mwt.tokens import _OTHER  # {named} placeholders and § codes: the project's own format-code scanner

RESIDUE_WARNING = "format_residue"

_LETTERS = re.compile(r"[A-Za-z]{1,3}(?![A-Za-z])")
_WORD = re.compile(r"[A-Za-z]+")


# The target languages this check applies to, by language code (ISO 639-1/-2, with any region or script
# subtag: ko-KR, zh_Hant_TW, ja-JP) ...
_LANGUAGE_CODES = {
    "ko": "ko", "kor": "ko",
    "ja": "ja", "jpn": "ja",
    "zh": "zh", "zho": "zh", "chi": "zh", "cmn": "zh", "yue": "zh",
}
_LANGUAGE_TAG = re.compile(r"[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*")
# ... and by the whole name the settings screen offers or a user types for them. Only a name that is exactly
# one of these counts: a free-form description such as "English (not Korean)" never enables the check.
_LANGUAGE_NAMES = {
    "한국어": "ko", "한국말": "ko", "조선어": "ko", "korean": "ko",
    "日本語": "ja", "日本语": "ja", "日语": "ja", "일본어": "ja", "japanese": "ja",
    "中文": "zh", "汉语": "zh", "漢語": "zh", "简体中文": "zh", "簡體中文": "zh", "繁體中文": "zh", "繁体中文": "zh",
    "简体": "zh", "繁體": "zh", "중국어": "zh", "chinese": "zh", "simplified chinese": "zh",
    "traditional chinese": "zh", "mandarin": "zh",
}


def target_script(language: object) -> str:
    """``ko``, ``ja`` or ``zh`` for a configured target language, else an empty string.

    Recognised: a language code with optional region/script subtags, or the exact name of the language. Anything
    else (another language, an empty or free-form description) is "" and is never checked.
    """
    text = unicodedata.normalize("NFKC", str(language or "")).strip().casefold()
    if not text:
        return ""
    if _LANGUAGE_TAG.fullmatch(text):
        language, *subtags = re.split(r"[-_]", text)
        if "latn" in subtags:  # ja-Latn, ko-Latn: romanised text, Latin letters are expected
            return ""
        return _LANGUAGE_CODES.get(language, "")
    return _LANGUAGE_NAMES.get(text, "")


def _non_latin_letter(char: str) -> bool:
    return char.isalpha() and not unicodedata.name(char, "").startswith("LATIN")


def _source_words_after(source: str, code: str) -> list[str]:
    """Each run of ASCII letters that directly follows ``code`` in the source."""
    words: list[str] = []
    start = source.find(code)
    while start != -1:
        match = _WORD.match(source, start + len(code))
        if match:
            words.append(match.group(0))
        start = source.find(code, start + 1)
    return words


def find_residue(source: str, translated: str, language: object) -> list[dict]:
    """Findings ``{"code", "letters", "index"}`` for each format code in ``translated`` that is followed by
    1-3 ASCII letters and then a non-Latin letter, where ``source`` has the same code followed by a longer
    word starting with those letters.

    A Latin word the model kept on purpose (a brand, ``TNT``, ``NPC``) is a whole source word after the same
    code, so it is not residue even when another source word shares its code and letters (``§6CAT`` kept
    next to ``§6CATERPILLAR``). Each kept word excuses one occurrence: a second ``§6Cat`` followed by Hangul
    is judged on its own.
    """
    if not isinstance(source, str) or not isinstance(translated, str) or not target_script(language):
        return []
    if "§" not in translated or "§" not in source:
        return []
    found: list[dict] = []
    seen: dict[tuple[str, str], int] = {}
    for token in _OTHER.finditer(translated):
        code = token.group(0)
        if not code.startswith("§"):
            continue
        letters = _LETTERS.match(translated, token.end())
        if letters is None:
            continue
        following = translated[letters.end() : letters.end() + 1]
        if not following or not _non_latin_letter(following):
            continue
        prefix = letters.group(0)
        words = _source_words_after(source, code)
        seen[(code, prefix)] = seen.get((code, prefix), 0) + 1
        if seen[(code, prefix)] <= words.count(prefix):
            continue  # the model kept this source word as it was
        if any(word.startswith(prefix) and len(word) > len(prefix) for word in words):
            found.append({"code": code, "letters": prefix, "index": token.start()})
    return found
