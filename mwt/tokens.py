"""Keep formatting tokens inside player-visible strings."""

from __future__ import annotations

import re
from collections import Counter

# java.util.Formatter, which Minecraft hands every translatable string:
# %[argument_index$][flags][width][.precision]conversion, where the flags are "-#+ 0,(" and "<" (reuse the previous
# argument), which Java accepts anywhere among the flags. "%%" (a percent sign) is its own alternative so that
# "100% %s" is not read as one spec with a "%" conversion.
_FORMAT = re.compile(
    r"%(?:"
    r"(?P<literal>%)"
    r"|(?:(?P<index>\d+)\$)?(?P<flags>[-#+ 0,(<]*)(?P<width>\d+)?(?:\.(?P<precision>\d+))?"
    r"(?P<conversion>[tT][A-Za-z]|[bBhHsScCdioxXeEfgGaAn])"
    r")"
)
# Conversions the previous token pattern already protected anywhere in a word ("%sx" is "%s" + "x").
_ALWAYS_TOKEN = frozenset("sdif")
# Conversions that print something without taking an argument.
_NO_ARGUMENT = frozenset("n")
# {named} placeholders and Minecraft section-sign formatting codes (§6, §l, §r, §x...).
_OTHER = re.compile(r"\{[A-Za-z0-9_]+\}|§.")
_TOKEN = re.compile(_FORMAT.pattern + "|" + _OTHER.pattern)

Token = tuple


def _is_prose(match: re.Match[str]) -> bool:
    """A percent sign in a sentence that only looks like a spec: "15%off", "50% sure", "5% of the time".

    Anything with an index, width, precision or a flag other than a lone space is clearly a format spec.
    A bare spec ("%b", "%o") or a space-flagged one ("% d", "% s") followed by more letters or digits is a
    percentage next to a word. ``%s %d %i %f`` keep matching inside words ("%shp"), as they always did.
    """
    if match.group("index") or match.group("width") or match.group("precision"):
        return False
    flags = match.group("flags")
    if flags not in ("", " "):
        return False
    if not match.string[match.end() : match.end() + 1].isalnum():
        return False
    return flags == " " or match.group("conversion") not in _ALWAYS_TOKEN


def _tokens(text: str) -> Counter:
    """The multiset of tokens in ``text``, each format spec identified by the argument it is bound to.

    Ordinary specs take the next argument in order, ``%2$s`` takes argument 2 (and leaves the order alone) and
    ``%<s`` reuses whichever argument the previous spec used. ``%%`` and ``%n`` take none and count by number.
    """
    found: Counter = Counter()
    ordinary = 0  # the argument the next ordinary spec binds to is ordinary + 1
    previous = 0  # the argument the last spec used (0: none yet, so a leading "%<s" has nothing to reuse)
    for match in _TOKEN.finditer(text):
        if match.group("literal"):
            found[("fmt", None, "", "", "", "%")] += 1
            continue
        conversion = match.group("conversion")
        if conversion is None:
            found[("raw", match.group(0))] += 1
            continue
        if _is_prose(match):
            continue
        flags = match.group("flags")
        if conversion in _NO_ARGUMENT:
            bound = None
        else:
            if "<" in flags:  # Java gives "<" precedence over an explicit index
                bound = previous
            elif match.group("index"):
                bound = int(match.group("index"))
            else:
                ordinary += 1
                bound = ordinary
            previous = bound
        found[
            (
                "fmt",
                bound,
                "".join(sorted(set(flags) - {"<"})),
                match.group("width") or "",
                match.group("precision") or "",
                conversion,
            )
        ] += 1
    return found


def tokens_preserved(original: str, translated: str) -> bool:
    """Every token survives exactly as often as in the original, and none is invented.

    A dropped token loses formatting or an argument; an added one recolours other words (a model
    once answered ``§6Merchant §rof ...`` with two ``§6``) or consumes an argument that is not there.
    Format placeholders are compared by what they bind, not where they sit: ``%1$s %2$d`` may become
    ``%2$d %1$s``, but ``%s %d`` may not become ``%d %s`` (the arguments would swap types), and
    ``%1$s %<s %2$s`` may not become ``%1$s %2$s %<s`` (a different name would be repeated).
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
