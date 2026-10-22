"""Read the SNBT text components that Java 1.21.5+ commands use, and patch their strings in place.

``tellraw @a {text:'Hello',color:gold}`` is not JSON. Rather than re-serialize the whole value (and
risk changing numbers, key order, quoting or typed arrays the game reads), the parser records where
each string sits in the source. Callers edit the parsed tree, and ``SnbtDocument.render`` splices
only the strings that changed back into the original command text.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any

_BARE = re.compile(r"[0-9A-Za-z_\-.+]+")
# Unquoted words the game reads as numbers or booleans, never as text.
_NUMBER = re.compile(
    r"[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?(?:[bslfd]|[su]?[bsil])?\Z",
    re.IGNORECASE,
)
_ESCAPES = {"\\": "\\", "'": "'", '"': '"', "n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "s": " "}


class SnbtError(ValueError):
    pass


@dataclass(frozen=True)
class Literal:
    """A number, boolean or other non-text token, kept exactly as written."""

    raw: str


@dataclass
class _Span:
    container: Any
    key: Any
    start: int
    end: int
    original: str
    quote: str  # '"', "'" or "" for an unquoted word


class SnbtDocument:
    def __init__(self, source: str, value: Any, spans: list[_Span]) -> None:
        self.source = source
        # The root sits in a one-item list so a bare top-level string can be replaced like any other.
        self.root = [value]
        self._spans = spans

    @property
    def value(self) -> Any:
        return self.root[0]

    def render(self) -> str:
        """The source with every changed string re-quoted in place; everything else is untouched."""
        out: list[str] = []
        cursor = 0
        for span in sorted(self._spans, key=lambda item: item.start):
            current = span.container[span.key]
            if not isinstance(current, str) or current == span.original:
                continue
            out.append(self.source[cursor : span.start])
            out.append(quote(current, span.quote or '"'))
            cursor = span.end
        out.append(self.source[cursor:])
        return "".join(out)


def quote(text: str, preferred: str = '"') -> str:
    mark = preferred if preferred in ("'", '"') else '"'
    if mark in text and ("'" if mark == '"' else '"') not in text:
        mark = "'" if mark == '"' else '"'
    escaped = text.replace("\\", "\\\\").replace(mark, "\\" + mark)
    escaped = escaped.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return f"{mark}{escaped}{mark}"


def parse(source: str) -> SnbtDocument:
    parser = _Parser(source)
    holder: list[Any] = [None]
    holder[0] = parser.value(holder, 0)
    parser.skip_space()
    if parser.pos != len(source):
        raise SnbtError(f"unexpected text at {parser.pos}")
    document = SnbtDocument(source, holder[0], parser.spans)
    for span in document._spans:
        if span.container is holder:
            span.container = document.root
    return document


class _Parser:
    def __init__(self, source: str) -> None:
        self.source = source
        self.pos = 0
        self.spans: list[_Span] = []

    def skip_space(self) -> None:
        while self.pos < len(self.source) and self.source[self.pos].isspace():
            self.pos += 1

    def peek(self) -> str:
        self.skip_space()
        if self.pos >= len(self.source):
            raise SnbtError("unexpected end")
        return self.source[self.pos]

    def expect(self, char: str) -> None:
        if self.peek() != char:
            raise SnbtError(f"expected {char!r} at {self.pos}")
        self.pos += 1

    def value(self, container: Any, key: Any) -> Any:
        char = self.peek()
        if char == "{":
            return self.compound()
        if char == "[":
            return self.list()
        if char in "'\"":
            start = self.pos
            text = self.quoted()
            self.spans.append(_Span(container, key, start, self.pos, text, char))
            return text
        start = self.pos
        word = self.bare()
        if self.pos < len(self.source) and self.source[self.pos] == "(":
            # 1.21.5 operations such as bool(...) or uuid(...): keep the whole call as written.
            depth = 0
            while self.pos < len(self.source):
                if self.source[self.pos] == "(":
                    depth += 1
                elif self.source[self.pos] == ")":
                    depth -= 1
                    if depth == 0:
                        self.pos += 1
                        return Literal(self.source[start : self.pos])
                self.pos += 1
            raise SnbtError("unclosed operation")
        if word in ("true", "false") or _NUMBER.match(word):
            return Literal(word)
        self.spans.append(_Span(container, key, start, self.pos, word, ""))
        return word

    def bare(self) -> str:
        match = _BARE.match(self.source, self.pos)
        if not match:
            raise SnbtError(f"unexpected {self.source[self.pos]!r} at {self.pos}")
        self.pos = match.end()
        return match.group(0)

    def quoted(self) -> str:
        mark = self.source[self.pos]
        self.pos += 1
        out: list[str] = []
        while self.pos < len(self.source):
            char = self.source[self.pos]
            if char == mark:
                self.pos += 1
                return "".join(out)
            if char == "\\":
                self.pos += 1
                if self.pos >= len(self.source):
                    break
                code = self.source[self.pos]
                if code in _ESCAPES:
                    out.append(_ESCAPES[code])
                    self.pos += 1
                elif code in "xuU":
                    out.append(self.code_point(code))
                elif code == "N" and self.source.startswith("{", self.pos + 1):
                    close = self.source.find("}", self.pos + 2)
                    if close < 0:
                        raise SnbtError("bad escape")
                    try:
                        out.append(unicodedata.lookup(self.source[self.pos + 2 : close]))
                    except KeyError as exc:
                        raise SnbtError("bad escape") from exc
                    self.pos = close + 1
                else:
                    raise SnbtError(f"unknown escape \\{code}")
                continue
            out.append(char)
            self.pos += 1
        raise SnbtError("unclosed string")

    def hex_escape(self, code: str) -> int:
        """Read the hex digits of a numeric escape; ``self.pos`` is on its letter (x, u or U)."""
        width = {"x": 2, "u": 4, "U": 8}[code]
        digits = self.source[self.pos + 1 : self.pos + 1 + width]
        if len(digits) != width or not re.fullmatch(r"[0-9A-Fa-f]+", digits):
            raise SnbtError("bad escape")
        self.pos += 1 + width
        return int(digits, 16)

    def code_point(self, code: str) -> str:
        """One character from a numeric escape. A UTF-16 pair written as two 4-digit escapes is one character.

        A surrogate on its own is not text any encoder accepts, and it would make hashing the string
        fail for the whole region file, so it is refused here and the command is kept as it was.
        """
        value = self.hex_escape(code)
        if 0xD800 <= value <= 0xDBFF:
            if code == "u" and self.source.startswith("\\u", self.pos):
                self.pos += 1
                low = self.hex_escape("u")
                if 0xDC00 <= low <= 0xDFFF:
                    return chr(0x10000 + ((value - 0xD800) << 10) + (low - 0xDC00))
            raise SnbtError("unpaired surrogate escape")
        if 0xDC00 <= value <= 0xDFFF or value > 0x10FFFF:
            raise SnbtError("invalid code point escape")
        return chr(value)

    def key(self) -> str:
        char = self.peek()
        if char in "'\"":
            return self.quoted()
        return self.bare()

    def compound(self) -> dict:
        self.expect("{")
        result: dict[str, Any] = {}
        if self.peek() == "}":
            self.pos += 1
            return result
        while True:
            name = self.key()
            if name in result:
                # Two spans would edit one value; which of the two the game reads is its own business.
                raise SnbtError(f"duplicate key {name!r}")
            self.expect(":")
            result[name] = self.value(result, name)
            char = self.peek()
            self.pos += 1
            if char == "}":
                return result
            if char != ",":
                raise SnbtError(f"expected , or }} at {self.pos - 1}")
            if self.peek() == "}":  # trailing comma
                self.pos += 1
                return result

    def list(self) -> list:
        self.expect("[")
        result: list[Any] = []
        if re.match(r"[BIL]\s*;", self.source[self.pos :]):
            # Typed arrays hold numbers only; keep them verbatim.
            close = self.source.find("]", self.pos)
            if close < 0:
                raise SnbtError("unclosed array")
            literal = Literal("[" + self.source[self.pos : close + 1])
            self.pos = close + 1
            return literal  # type: ignore[return-value]
        if self.peek() == "]":
            self.pos += 1
            return result
        while True:
            result.append(None)
            result[-1] = self.value(result, len(result) - 1)
            char = self.peek()
            self.pos += 1
            if char == "]":
                return result
            if char != ",":
                raise SnbtError(f"expected , or ] at {self.pos - 1}")
            if self.peek() == "]":
                self.pos += 1
                return result
