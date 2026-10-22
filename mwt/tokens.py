"""Keep formatting tokens inside player-visible strings."""

from __future__ import annotations

import re
from collections import Counter

# java.util.Formatter, which Minecraft hands every translatable string: %[index$][flags][width][.precision]conversion.
# The space flag is left out on purpose: "50% sure" is prose, not a placeholder.
_FORMAT = re.compile(
    r"%(?:(?P<index>\d+)\$|(?P<relative><))?"
    r"(?P<flags>[-#+0,(]*)(?P<width>\d+)?(?:\.(?P<precision>\d+))?"
    r"(?P<conversion>[tT][A-Za-z]|[bBhHsScCdioxXeEfgGaA%n])"
)
# Conversions the previous token pattern already protected anywhere in a word ("%sx" is "%s" + "x").
_ALWAYS_TOKEN = frozenset("sdif%")
# {named} placeholders and Minecraft section-sign formatting codes (§6, §l, §r, §x...).
_OTHER = re.compile(r"\{[A-Za-z0-9_]+\}|§.")
_TOKEN = re.compile(_FORMAT.pattern + "|" + _OTHER.pattern)

Token = tuple


def _format_key(match: re.Match[str]) -> Token | None:
    """(argument identity, flags, width, precision, conversion), or None for what is just prose.

    A bare ``%b`` or ``%o`` glued to letters ("15%off", "20%bonus") is a percentage in a sentence,
    not a placeholder. Anything with an index, flag, width or precision is clearly a format spec.
    """
    conversion = match.group("conversion")
    bare = not (
        match.group("index") or match.group("relative") or match.group("flags")
        or match.group("width") or match.group("precision")
    )
    if bare and conversion not in _ALWAYS_TOKEN:
        following = match.string[match.end() : match.end() + 1]
        if following.isalnum():
            return None
    identity = match.group("index") or ("<" if match.group("relative") else "")
    return (
        "fmt",
        identity,
        "".join(sorted(set(match.group("flags")))),
        match.group("width") or "",
        match.group("precision") or "",
        conversion,
    )


def _tokens(text: str) -> Counter:
    found: Counter = Counter()
    for match in _TOKEN.finditer(text):
        if match.group("conversion"):
            key = _format_key(match)
            if key is not None:
                found[key] += 1
        else:
            found[("raw", match.group(0))] += 1
    return found


def tokens_preserved(original: str, translated: str) -> bool:
    """Every token survives exactly as often as in the original, and none is invented.

    A dropped token loses formatting or an argument; an added one recolours other words (a model
    once answered ``§6Merchant §rof ...`` with two ``§6``) or consumes an argument that is not there.
    Format placeholders are compared by what they bind, not where they sit: ``%1$s`` and ``%2$s`` may
    swap places in a translation, but ``%1$.2f`` must stay ``%1$.2f``.
    """
    return _tokens(original) == _tokens(translated)


def _without_trailing_reset(original: str, translated: str) -> str:
    """Drop a ``§r`` the model appended after the last character.

    Gemini 3.6–3.8 flash end most coloured lines with ``§r`` (measured 2026-10-01). A reset after
    the final character changes nothing on screen, so it is removed instead of costing the line
    its translation. A reset anywhere else would recolour the following words and is still refused.
    """
    stripped = translated.rstrip()
    trailing = translated[len(stripped):]
    # Only resets beyond those the original has; a moved original reset is a real token.
    while stripped.endswith("§r") and stripped.count("§r") > original.count("§r"):
        stripped = stripped[:-2].rstrip()
    return stripped + trailing if stripped else translated


def preserve_tokens(original: str, translated: str) -> str:
    if not isinstance(translated, str) or not translated:
        return original
    translated = _without_trailing_reset(original, translated)
    return translated if tokens_preserved(original, translated) else original
