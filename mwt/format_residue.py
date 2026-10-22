"""Detect source letters a model left glued to a Minecraft format code.

Some lite models answer ``§lcrypt`` with ``§lc지하실``: the code is kept, the word is translated, but
the first letter(s) of the original word stay behind. The check only runs for targets written in
Hangul, kana or Han (Latin-script targets legitimately have Latin letters after a code), and it never
changes the text. The caller decides what to do with a finding (retry once, then warn).
"""

from __future__ import annotations

import re
import unicodedata

from mwt.tokens import _OTHER  # {named} placeholders and § codes: the project's own format-code scanner

RESIDUE_WARNING = "format_residue"

_LETTERS = re.compile(r"[A-Za-z]{1,3}(?![A-Za-z])")
_WORD = re.compile(r"[A-Za-z]+")


def target_script(language: object) -> str:
    """``ko``, ``ja`` or ``zh`` for the configured target language name, else an empty string."""
    text = str(language or "").strip().casefold()
    if not text:
        return ""
    if text in {"ko", "kr"} or text.startswith(("ko-", "ko_")) or "한국" in text or "korean" in text or "조선" in text:
        return "ko"
    if text in {"ja", "jp"} or text.startswith(("ja-", "ja_")) or "日本" in text or "일본" in text or "japanese" in text:
        return "ja"
    if (
        text == "zh"
        or text.startswith(("zh-", "zh_"))
        or any(word in text for word in ("chinese", "mandarin", "中文", "汉语", "漢語", "简体", "簡體", "简中", "繁體", "繁体", "중국"))
    ):
        return "zh"
    return ""


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

    A Latin word the model kept on purpose (a brand, ``TNT``, ``NPC``) is the whole source word, so it is not
    longer than the letters seen and is not reported.
    """
    if not isinstance(source, str) or not isinstance(translated, str) or not target_script(language):
        return []
    if "§" not in translated or "§" not in source:
        return []
    found: list[dict] = []
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
        if any(word.startswith(prefix) and len(word) > len(prefix) for word in _source_words_after(source, code)):
            found.append({"code": code, "letters": prefix, "index": token.start()})
    return found
