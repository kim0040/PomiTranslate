"""Find and patch player-visible text in Minecraft data.

Two traversals used to describe the same text shapes, one to collect and one to patch, and they
drifted apart: text that was collected was never patched, and text that was patched was never
collected. Each shape is now described once. ``_walk_json`` visits the strings of a JSON text
component and serves both jobs, and the NBT collectors decide which fields hold a component.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, replace
from typing import Any, Callable

from mwt import nbtio as nbt

# Bump when the set of texts a scan finds changes, so saved scan plans stop matching.
# 4: a component stored as a JSON string literal ("\"Welcome home\"") is its inner text.
EXTRACTOR_VERSION = 6

# The DataVersion of 25w02a, the first 1.21.5 snapshot. From it on, text components in NBT are NBT
# (a plain string is literal text). Before it, every component is a JSON string, so the string
# "\"Welcome home\"" is the text Welcome home, and a translation must be written back as a JSON
# string again. Data without a DataVersion is read the older way: the value written back is still
# a JSON string literal, which shows the same quote-wrapped text if it was literal after all.
TEXT_COMPONENT_NBT_DATA_VERSION = 4298

# What a text is, in words the interface translates. One string per kind of place.
CATEGORIES = (
    "sign",
    "book_title",
    "book_page",
    "item_name",
    "item_lore",
    "entity_name",
    "block_name",
    "text_display",
    "command",
    "resource_pack",
    "other",
)


@dataclass(frozen=True)
class Scope:
    """Where the walker is: the block or entity being read, and whether it is inside an item."""

    holder: str = ""
    pos: tuple[int, int, int] | None = None
    entity: bool = False
    in_item: bool = False
    # The DataVersion of the chunk or file being read, when it records one.
    data_version: int | None = None

    @property
    def components_are_json(self) -> bool:
        """Whether a text component stored as a string is JSON (before 1.21.5) or literal text."""
        return self.data_version is None or self.data_version < TEXT_COMPONENT_NBT_DATA_VERSION


def json_string_text(raw: str) -> str | None:
    """The text of a component stored as a JSON string literal, such as ``"\"Welcome home\""``."""
    stripped = raw.strip()
    if len(stripped) < 2 or stripped[0] != '"' or stripped[-1] != '"':
        return None
    try:
        parsed = json.loads(stripped, strict=False)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, str) else None


def match_wrapping_quotes(source: str, answer: str) -> str:
    """Keep a translation's outer double quotes the way the source has them.

    A model often drops the quotes around a quoted line, or adds quotes to a line that had none.
    Only a pair that wraps the whole text is touched; quotes inside the text stay as written.
    """
    if not isinstance(answer, str) or not answer:
        return answer
    source_wrapped = len(source) >= 2 and source.startswith('"') and source.endswith('"')
    answer_wrapped = len(answer) >= 2 and answer.startswith('"') and answer.endswith('"')
    if source_wrapped and not answer.startswith('"') and not answer.endswith('"'):
        return f'"{answer}"'
    if answer_wrapped and not source.startswith('"') and not source.endswith('"') and '"' not in answer[1:-1]:
        return answer[1:-1]
    return answer


class TextRef:
    def __init__(
        self,
        kind: str,
        *,
        tag: Any = None,
        obj: Any = None,
        key: Any = "",
        path: str = "",
        category: str = "other",
        detail: str = "",
        scope: Scope | None = None,
    ) -> None:
        self.kind = kind
        self.tag = tag
        self.obj = obj
        self.key = key
        self.path = path
        self.category = category
        self.detail = detail
        self.scope = scope or Scope()


OnText = Callable[[Any, Any, str], None]

_LONE_SURROGATE = re.compile("[\ud800-\udfff]")

# The component may be JSON (before 1.21.5) or SNBT (1.21.5+), so a quoted string also starts one.
_COMMAND_JSON = (
    re.compile(r"^(/?(?:.*?\brun\s+)?tellraw\s+\S+\s+)([\[{'\"].*)$", re.DOTALL),
    re.compile(r"^(/?(?:.*?\brun\s+)?title\s+\S+\s+(?:title|subtitle|actionbar)\s+)([\[{'\"].*)$", re.DOTALL),
)


# --- JSON text with string positions -------------------------------------------------------------

_JSON_SPACE = " \t\n\r"
_JSON_STRING = re.compile(r'"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"')
_JSON_SCALAR = re.compile(r"-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?|true|false|null")


@dataclass
class _JsonSpan:
    container: Any
    key: Any
    start: int
    end: int
    original: str


class _JsonDocument:
    """JSON text read together with where each string value sits in it.

    Callers edit ``root`` like any parsed component, and ``render`` writes back only the string tokens
    that changed. Whitespace, key order and the escapes of every other token stay as written.
    """

    def __init__(self, source: str, holder: list, spans: list[_JsonSpan]) -> None:
        self.source = source
        self.holder = holder  # a bare top-level string sits in this one-item list so it can be replaced
        self._spans = spans

    @property
    def value(self) -> Any:
        return self.holder[0]

    @property
    def root(self) -> Any:
        """What ``_walk_json`` walks: the list holding a bare string literal, else the container."""
        return self.holder if isinstance(self.holder[0], str) else self.holder[0]

    def render(self) -> str | None:
        """The source with changed strings re-encoded in place, or ``None`` if the edits were not
        all string replacements (a string value swapped for an object, a key added) and so cannot
        be mapped back onto the original text."""
        out: list[str] = []
        cursor = 0
        for span in self._spans:
            try:
                current = span.container[span.key]
            except (KeyError, IndexError):
                return None
            if not isinstance(current, str) or current == span.original:
                continue
            out.append(self.source[cursor : span.start])
            out.append(_encode_json_string(current))
            cursor = span.end
        out.append(self.source[cursor:])
        text = "".join(out)
        try:
            return text if json.loads(text) == self.value else None
        except (json.JSONDecodeError, RecursionError):
            return None


def _encode_json_string(text: str) -> str:
    encoded = json.dumps(text, ensure_ascii=False)
    # Same rule as serialize_text_component: an escaped lone surrogate must stay an escape.
    return _LONE_SURROGATE.sub(lambda match: "\\u%04x" % ord(match.group()), encoded)


class _JsonScanner:
    def __init__(self, source: str) -> None:
        self.source = source
        self.pos = 0
        self.spans: list[_JsonSpan] = []

    def space(self) -> None:
        while self.pos < len(self.source) and self.source[self.pos] in _JSON_SPACE:
            self.pos += 1

    def string(self) -> str:
        match = _JSON_STRING.match(self.source, self.pos)
        if not match:
            raise ValueError("bad string")
        self.pos = match.end()
        return json.loads(match.group())

    def value(self, container: Any, key: Any) -> Any:
        self.space()
        if self.pos >= len(self.source):
            raise ValueError("unexpected end")
        char = self.source[self.pos]
        if char == "{":
            return self.compound()
        if char == "[":
            return self.array()
        if char == '"':
            start = self.pos
            text = self.string()
            self.spans.append(_JsonSpan(container, key, start, self.pos, text))
            return text
        match = _JSON_SCALAR.match(self.source, self.pos)
        if not match:
            raise ValueError("unexpected token")
        self.pos = match.end()
        return json.loads(match.group())

    def compound(self) -> dict:
        self.pos += 1
        result: dict[str, Any] = {}
        self.space()
        if self.source.startswith("}", self.pos):
            self.pos += 1
            return result
        while True:
            self.space()
            name = self.string()
            if name in result:
                raise ValueError("duplicate key")  # json.loads keeps the last; two spans would disagree
            self.space()
            if not self.source.startswith(":", self.pos):
                raise ValueError("expected :")
            self.pos += 1
            result[name] = self.value(result, name)
            self.space()
            char = self.source[self.pos : self.pos + 1]
            self.pos += 1
            if char == "}":
                return result
            if char != ",":
                raise ValueError("expected , or }")

    def array(self) -> list:
        self.pos += 1
        result: list[Any] = []
        self.space()
        if self.source.startswith("]", self.pos):
            self.pos += 1
            return result
        while True:
            result.append(None)
            result[-1] = self.value(result, len(result) - 1)
            self.space()
            char = self.source[self.pos : self.pos + 1]
            self.pos += 1
            if char == "]":
                return result
            if char != ",":
                raise ValueError("expected , or ]")


def _parse_json_spans(source: str) -> _JsonDocument | None:
    """``source`` as an object, array or string literal with string positions, or ``None`` for
    anything else (or any JSON dialect ``json.loads`` takes but this reader does not)."""
    scanner = _JsonScanner(source)
    holder: list[Any] = [None]
    try:
        holder[0] = scanner.value(holder, 0)
        scanner.space()
    except (ValueError, RecursionError):
        return None
    if scanner.pos != len(source) or not isinstance(holder[0], (dict, list, str)):
        return None
    return _JsonDocument(source, holder, scanner.spans)


# The 1.21.9+ object component keeps its payload (an atlas sprite, a player's name, id and skin
# properties) under these keys. None of it is text, whatever fields it nests.
_OBJECT_PAYLOAD_KEYS = ("object", "player", "sprite")
# The component types an explicit ``type`` can name (1.20.3+).
_COMPONENT_TYPES = ("text", "translatable", "score", "selector", "keybind", "nbt", "object")


class TextExtractionMixin:
    """Needs ``config``, ``scan_config``, ``runtime_config`` and ``component_prefixes``."""

    # --- which strings are worth translating -------------------------------------------------

    _SKIP_NAMESPACE_PREFIXES = (
        "minecraft:", "forge:", "neoforge:", "fabric:",
        "mod:", "kubejs:", "ftbquests:", "chipped:",
        "tconstruct:", "mekanism:", "thermal:", "botania:",
        "create:", "immersiveengineering:",
    )

    _NOISE_PATTERNS = re.compile(
        r"^(?:"
        r"[0-9]+(?:\.[0-9]+)?%?"       # pure numbers like "42", "3.14", "100%"
        r"|[ -⯿☀-➿︰-﹏￰-￿]+"  # symbols
        r"|\.{2,}"                      # ellipsis-like dots "..."
        r"|-{2,}"                       # dashes "---"
        r"|={2,}"                       # equals "=="
        r"|#{1,3}"                      # hash markers
        r")$",
    )

    _HANGUL = re.compile(r"[가-힣]")
    _KANA = re.compile(r"[぀-ヿ]")
    _LATIN = re.compile(r"[A-Za-z]")

    def _target_script(self) -> str:
        language = str(self.config.get("prompt", {}).get("target_language", "")).strip().casefold()
        if language in {"ko", "kr"} or language.startswith("ko-") or "한국" in language or "korean" in language:
            return "ko"
        if language in {"ja", "jp"} or language.startswith("ja-") or "日本" in language or "japanese" in language:
            return "ja"
        return ""

    def _already_in_target_language(self, text: str) -> bool:
        """Text already written in the target script is left alone, so a second run is not billed
        for what the first run translated."""
        if not self.scan_config.get("skip_target_language_text", True):
            return False
        script = getattr(self, "_script_cache", None)
        if script is None:
            script = self._script_cache = self._target_script()
        if script == "ko":
            return bool(self._HANGUL.search(text)) and not self._LATIN.search(text) and not self._KANA.search(text)
        if script == "ja":
            return bool(self._KANA.search(text)) and not self._LATIN.search(text) and not self._HANGUL.search(text)
        return False

    def _excluded_ids(self) -> frozenset[str]:
        """The excluded candidate ids as a set, rebuilt only when the configured list changes.

        The list form is what gets saved; looking an id up in it costs time linear in the number of
        exclusions for every string of the world.
        """
        raw = self.runtime_config.get("excluded_candidate_ids") or ()
        cached = getattr(self, "_excluded_cache", None)
        if cached is not None and cached[0] is raw and cached[1] == len(raw):
            return cached[2]
        ids = frozenset(item for item in raw if isinstance(item, str))
        self._excluded_cache = (raw, len(raw), ids)
        return ids

    def should_translate_text(self, text: str) -> bool:
        if not isinstance(text, str):
            return False
        stripped = text.strip()
        if not stripped:
            return False
        if not text.isascii():
            try:
                text.encode("utf-8")
            except UnicodeEncodeError:
                # A lone surrogate (a JSON "\ud83d" escape, say) cannot be hashed, sent or stored.
                return False
        excluded = self._excluded_ids()
        if excluded and hashlib.sha256(text.encode("utf-8")).hexdigest()[:20] in excluded:
            return False

        if stripped in ("@", "#", "!", "?", ".", ",", "-", "~", "/"):
            return False

        if stripped.startswith(self._SKIP_NAMESPACE_PREFIXES):
            return False

        if re.fullmatch(r"[a-z0-9_.-]+:[a-z0-9_./-]+", stripped):
            return False

        if self.scan_config["skip_command_like_text"] and stripped.startswith("/"):
            return False

        if stripped.startswith("@") and " " not in stripped:
            return False

        if all(not ch.isalpha() for ch in stripped):
            return False

        if self._NOISE_PATTERNS.match(stripped):
            return False

        has_alpha = any(ch.isalpha() for ch in stripped)
        has_cjk = any(
            "가" <= ch <= "힣"   # Hangul
            or "一" <= ch <= "鿿" # CJK Unified
            or "぀" <= ch <= "ゟ" # Hiragana
            or "゠" <= ch <= "ヿ" # Katakana
            for ch in stripped
        )

        if not has_alpha and not has_cjk:
            return False

        if len(stripped) == 1:
            return has_cjk

        if len(stripped) <= 3 and not has_cjk:
            if stripped.isupper():
                return False

        if len(stripped) <= 4 and not has_cjk:
            all_upper_alpha = all(ch.isupper() or ch in " .-" for ch in stripped)
            if all_upper_alpha and " " in stripped:
                return False
            is_roman = all(ch in "IVXLCDM " for ch in stripped)
            if is_roman and stripped.strip():
                return False

        if self._already_in_target_language(stripped):
            return False

        return True

    # --- text components -----------------------------------------------------------------------

    @staticmethod
    def parse_text_component(raw: str) -> Any:
        return json.loads(raw)

    @staticmethod
    def serialize_text_component(component: Any) -> str:
        text = json.dumps(component, ensure_ascii=False, separators=(",", ":"))
        # json.loads turns an escaped lone surrogate ("\ud83d") into a character no UTF-8 encoder takes.
        # Writing it back as the escape it came from keeps the text valid and unchanged.
        return _LONE_SURROGATE.sub(lambda match: "\\u%04x" % ord(match.group()), text)

    def extract_command_json(self, command: str) -> tuple[str, str] | None:
        """Split ``tellraw``/``title`` (also after ``execute ... run``) into command and JSON."""
        if not isinstance(command, str):
            return None
        for pattern in _COMMAND_JSON:
            match = pattern.match(command)
            if match:
                return match.group(1), match.group(2)
        return None

    def text_from_translate_key(self, key: str) -> str:
        for prefix in self.component_prefixes:
            if key.startswith(prefix):
                tail = key[len(prefix) :]
                return tail.replace("_", " ").replace(".", " ")
        return key

    def _is_prefixed_translate(self, value: Any) -> bool:
        return (
            isinstance(value, dict)
            and set(value.keys()) == {"translate"}
            and isinstance(value.get("translate"), str)
            and any(value["translate"].startswith(prefix) for prefix in self.component_prefixes)
        )

    def _walk_json(self, node: Any, on_text: OnText, patch: bool = False) -> None:
        """Call ``on_text(container, key, source)`` for every visible string of a JSON component.

        ``container[key]`` is the value to replace. With ``patch`` set, embedded commands are
        written back after their text has been replaced.
        """
        if isinstance(node, list):
            for index, item in enumerate(node):
                if isinstance(item, str):
                    if self.should_translate_text(item):
                        on_text(node, index, item)
                else:
                    self._walk_json(item, on_text, patch)
            return
        if not isinstance(node, dict):
            return
        text = node.get("text")
        if isinstance(text, str):
            if self.should_translate_text(text):
                on_text(node, "text", text)
        elif self._is_prefixed_translate(text):
            on_text(node, "text", self.text_from_translate_key(text["translate"]))
        fallback = node.get("fallback")
        kind = self._component_kind(node.get("type"), node)  # type None: left out (or null)
        if kind == "translatable":
            if isinstance(fallback, str) and self.should_translate_text(fallback):
                on_text(node, "fallback", fallback)
        elif kind == "object":
            # 26.1+: an object component's fallback is a whole text component, not only a string.
            if isinstance(fallback, str):
                if self.should_translate_text(fallback):
                    on_text(node, "fallback", fallback)
            elif isinstance(fallback, (dict, list)):
                self._walk_json(fallback, on_text, patch)
        handled = {"text", "fallback", "extra", "with", "hoverEvent", "hover_event", "clickEvent", "click_event"}
        if "selector" in node or "nbt" in node:
            separator = node.get("separator")
            if isinstance(separator, str):
                if self.should_translate_text(separator):
                    on_text(node, "separator", separator)
            elif isinstance(separator, (dict, list)):
                self._walk_json(separator, on_text, patch)
            handled.add("separator")
        for key in ("extra", "with"):
            if isinstance(node.get(key), list):
                self._walk_json(node[key], on_text, patch)
        for key in ("hoverEvent", "hover_event"):
            hover = node.get(key)
            if isinstance(hover, dict):
                self._walk_hover(hover, on_text, patch)
        if self.scan_config["translate_command_output"]:
            for key in ("clickEvent", "click_event"):
                click = node.get(key)
                if isinstance(click, dict):
                    for field in ("value", "command"):
                        if isinstance(click.get(field), str):
                            self._walk_command(click, field, on_text, patch)
        for key, value in node.items():
            if key not in handled and key not in _OBJECT_PAYLOAD_KEYS and isinstance(value, (dict, list)):
                self._walk_json(value, on_text, patch)

    @staticmethod
    def _component_kind(type_name: Any, node: Any) -> str:
        """The kind of a component that decides whose ``fallback`` is read: ``translatable``, ``object`` or ``other``.

        Decided once, before any fallback is dispatched. A recognised explicit ``type`` wins, whatever
        other fields the compound holds. Only when ``type`` is left out does a key stand in for it:
        ``translate`` for a translatable component, ``object``, ``sprite`` or ``player`` for an
        object one. A ``type`` that is not recognised (another namespace, not a string) keeps the
        reading from before: ``translate`` still marks a translatable component, nothing else counts.
        A translatable component has its fallback only beside its ``translate`` key.
        """
        if type_name is None:
            if "translate" in node:
                return "translatable"
            return "object" if any(key in node for key in _OBJECT_PAYLOAD_KEYS) else "other"
        if type_name == "object":
            return "object"
        if type_name == "translatable" or type_name not in _COMPONENT_TYPES:
            return "translatable" if "translate" in node else "other"
        return "other"

    def _walk_component_value(self, container: Any, key: Any, on_text: OnText, patch: bool) -> None:
        """A text component stored under ``container[key]``: a literal, JSON in a string (before
        1.21.5), a list or a compound."""
        value = container[key]
        if isinstance(value, str):
            parsed = self._json_component(value)
            if parsed is None:
                if self.should_translate_text(value):
                    on_text(container, key, value)
                return
            if not patch:
                self._walk_json(self._component_root(parsed), on_text, False)
                return
            patched = self._patch_json_string(value, lambda root: self._walk_json(root, on_text, True))
            if patched != value:
                container[key] = patched
        elif isinstance(value, (dict, list)):
            self._walk_json(value, on_text, patch)

    def _patch_json_string(self, raw: str, walk: Callable[[Any], None]) -> str:
        """``raw``, JSON text of a component, with the strings ``walk`` replaces written back.

        Only the replaced string tokens are re-encoded; whitespace, key order and the escapes of every
        other token stay as written. When the edits cannot be mapped onto the original text, the
        component is serialized compactly instead and ``json_span_fallbacks`` counts it. ``walk``
        gets what ``_walk_json`` takes: a bare string literal arrives in a one-item list.
        """
        document = _parse_json_spans(raw)
        if document is None:
            # A dialect only json.loads takes (NaN, say): the compact serializer is all there is.
            tree = json.loads(raw)
            root = self._component_root(tree)
            before = self.serialize_text_component(root)
            walk(root)
            after = self.serialize_text_component(root)
            if after == before:
                return raw
            self.json_span_fallbacks = getattr(self, "json_span_fallbacks", 0) + 1
            return self.serialize_text_component(root[0]) if root is not tree else after
        walk(document.root)
        patched = document.render()
        if patched is not None:
            return patched
        self.json_span_fallbacks = getattr(self, "json_span_fallbacks", 0) + 1
        return self.serialize_text_component(document.value)

    def _walk_item_components(self, components: dict, on_text: OnText, patch: bool) -> None:
        """The visible text of an item shown in a tooltip: its name and lore, nothing else."""
        for key in list(components):
            bare = key[len("minecraft:") :] if key.startswith("minecraft:") else key
            if bare == "custom_name" and self.scan_config["translate_custom_names"]:
                self._walk_component_value(components, key, on_text, patch)
            elif bare == "item_name" and self.scan_config["translate_item_names"]:
                self._walk_component_value(components, key, on_text, patch)
            elif bare == "lore" and self.scan_config["translate_lore"] and isinstance(components[key], list):
                for index in range(len(components[key])):
                    self._walk_component_value(components[key], index, on_text, patch)

    def _walk_hover(self, hover: dict, on_text: OnText, patch: bool) -> None:
        action = hover.get("action")
        targeted = action in ("show_item", "show_entity")
        if targeted:
            # 1.21.5+ writes the item or entity fields inline; before that they sit in ``contents``.
            for holder in (hover, hover.get("contents")):
                if not isinstance(holder, dict):
                    continue
                if action == "show_item" and isinstance(holder.get("components"), dict):
                    self._walk_item_components(holder["components"], on_text, patch)
                elif (
                    action == "show_entity"
                    and holder.get("name") is not None
                    and not self._is_command_string(holder["name"])
                ):
                    self._walk_component_value(holder, "name", on_text, patch)
        # What is left is the shape older versions wrote, which the walker has always read: a component
        # under ``value``, an embedded command in a string, a component list. The targeted fields
        # above are the only ones narrowed to names and lore.
        for key in ("value", "contents", "name"):
            value = hover.get(key)
            if isinstance(value, str):
                if self.scan_config["translate_command_output"] and self.extract_command_json(value):
                    self._walk_command(hover, key, on_text, patch)
                elif action == "show_text" and key in ("value", "contents") and self.should_translate_text(value):
                    on_text(hover, key, value)
            elif isinstance(value, (dict, list)):
                if targeted and ((key == "contents" and isinstance(value, dict)) or (key == "name" and action == "show_entity")):
                    continue
                self._walk_json(value, on_text, patch)

    def _is_command_string(self, value: Any) -> bool:
        return isinstance(value, str) and self.extract_command_json(value) is not None

    def _walk_command(self, container: dict, key: str, on_text: OnText, patch: bool) -> None:
        extracted = self.extract_command_json(container[key])
        if not extracted:
            return
        prefix, raw_component = extracted
        try:
            embedded = json.loads(raw_component)
        except json.JSONDecodeError:
            self._walk_snbt_command(container, key, prefix, raw_component, on_text, patch)
            return
        if not patch:
            self._walk_json([embedded], on_text, False)  # A bare string is a component too: tellraw @a "Hello".
            return
        patched = self._patch_json_string(raw_component, lambda root: self._walk_json(root, on_text, True))
        if patched != raw_component:
            container[key] = prefix + patched

    def _walk_snbt_command(
        self, container: dict, key: str, prefix: str, raw: str, on_text: OnText, patch: bool
    ) -> None:
        """1.21.5+ commands write components as SNBT. Only changed strings are rewritten."""
        from mwt import snbt

        try:
            document = snbt.parse(raw)
        except snbt.SnbtError:
            # Neither JSON nor SNBT this reader knows: keep it and say so instead of skipping quietly.
            if not patch:
                self.unparsed_commands = getattr(self, "unparsed_commands", 0) + 1
            return
        self._walk_json(document.root, on_text, patch)
        if patch:
            rendered = document.render()
            if rendered != raw:
                container[key] = prefix + rendered

    def collect_json_text_refs(self, node: Any, refs: list[TextRef], path: str) -> None:
        def add(container: Any, key: Any, source: str) -> None:
            translated_key = isinstance(container, dict) and isinstance(container.get(key), dict)
            refs.append(TextRef("translate_key" if translated_key else "json_text", obj=container, key=key, path=path))

        self._walk_json(node, add)

    def collect_command_refs(self, command: str, refs: list[TextRef], path: str) -> None:
        extracted = self.extract_command_json(command)
        if not extracted:
            return
        try:
            component = json.loads(extracted[1])
        except json.JSONDecodeError:
            return
        self.collect_json_text_refs(component, refs, path)

    def patch_json_component(self, node: Any, translations: dict[str, str]) -> None:
        def patch(container: Any, key: Any, source: str) -> None:
            translated = translations.get(source)
            if translated:
                container[key] = translated

        self._walk_json(node, patch, True)

    def patch_command_component(self, command: str, translations: dict[str, str]) -> str:
        def patch(container: Any, key: Any, source: str) -> None:
            translated = translations.get(source)
            if translated:
                container[key] = translated

        holder = {"command": command}
        self._walk_command(holder, "command", patch, True)
        return holder["command"]

    def _iter_json_nodes(self, node: Any):
        if isinstance(node, dict):
            yield node
            for value in node.values():
                yield from self._iter_json_nodes(value)
        elif isinstance(node, list):
            for item in node:
                yield from self._iter_json_nodes(item)

    # --- NBT: which fields hold a component ---------------------------------------------------------

    def _ref(self, kind: str, path: str, scope: Scope, category: str, detail: str = "", **fields: Any) -> TextRef:
        return TextRef(kind, path=path, category=category, detail=detail, scope=scope, **fields)

    def _json_component(self, raw: str) -> Any:
        """The parsed component when ``raw`` is a JSON object, array or string literal, else ``None``.

        Before 1.21.5 components are stored as JSON strings, and an unstyled one is a bare string
        literal such as ``"Hello there"`` (quotes included). From 1.21.5 a plain string is literal
        text, so a string is only read as JSON when it looks like a JSON container or a complete,
        non-empty JSON string literal. Re-quoting a translated literal keeps its quotes either way.
        """
        stripped = raw.strip()
        if not stripped or stripped[0] not in '{["':
            return None
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return None
        if isinstance(parsed, str):
            return parsed if parsed.strip() else None
        return parsed if isinstance(parsed, (dict, list)) else None

    @staticmethod
    def _component_root(component: Any) -> Any:
        """What ``_walk_json`` walks: a bare string literal sits in a one-item list so it can be replaced."""
        return [component] if isinstance(component, str) else component

    def _json_string_component(self, raw: str, scope: Scope) -> str | None:
        """The text of a pre-1.21.5 component stored as a JSON string literal, otherwise ``None``."""
        return json_string_text(raw) if scope.components_are_json else None

    def _collect_component_string(self, tag: Any, refs: list[TextRef], path: str, scope: Scope, category: str, detail: str) -> None:
        text = self._json_string_component(tag.value, scope)
        if text is not None:
            if self.should_translate_text(text):
                refs.append(self._ref("json_string_tag", path, scope, category, detail, tag=tag))
            return
        component = self._json_component(tag.value)
        if isinstance(component, str):
            component = None  # Modern TAG_String is literal text, including wrapping quotes.
        if component is not None:
            found: list[str] = []
            self._walk_json(component, lambda container, key, source: found.append(source))
            if found:
                refs.append(self._ref("json_tag", path, scope, category, detail, tag=tag))
        elif self.should_translate_text(tag.value):
            refs.append(self._ref("plain_tag", path, scope, category, detail, tag=tag))

    def _collect_component(self, value: Any, refs: list[TextRef], path: str, scope: Scope, category: str, detail: str = "") -> None:
        if isinstance(value, nbt.TAG_String):
            self._collect_component_string(value, refs, path, scope, category, detail)
        elif isinstance(value, nbt.TAG_Compound):
            self._collect_component_compound(value, refs, path, scope, category, detail)
        elif isinstance(value, nbt.TAG_List):
            for index, item in enumerate(value):
                self._collect_component(item, refs, f"{path}/{index}", scope, category, detail)

    def _collect_component_compound(self, comp: Any, refs: list[TextRef], path: str, scope: Scope, category: str, detail: str) -> None:
        text = comp.get("text")
        if isinstance(text, nbt.TAG_String) and self.should_translate_text(text.value):
            refs.append(self._ref("plain_tag", f"{path}/text", scope, category, detail, tag=text))
        fallback = comp.get("fallback")
        type_tag = comp.get("type")
        # A type that is not a string is still an explicit (and not a recognised) type.
        type_name = None if type_tag is None else type_tag.value if isinstance(type_tag, nbt.TAG_String) else ""
        kind = self._component_kind(type_name, comp)
        if kind == "translatable":
            if isinstance(fallback, nbt.TAG_String) and self.should_translate_text(fallback.value):
                refs.append(self._ref("plain_tag", f"{path}/fallback", scope, category, detail, tag=fallback))
        elif kind == "object" and fallback is not None:
            self._collect_component(fallback, refs, f"{path}/fallback", scope, category, detail)
        if "selector" in comp or "nbt" in comp:
            separator = comp.get("separator")
            if separator is not None:
                self._collect_component(separator, refs, f"{path}/separator", scope, category, detail)
        for key in ("extra", "with"):
            children = comp.get(key)
            if isinstance(children, nbt.TAG_List):
                for index, item in enumerate(children):
                    self._collect_component(item, refs, f"{path}/{key}/{index}", scope, category, detail)
        for key in ("hover_event", "hoverEvent"):
            hover = comp.get(key)
            if not isinstance(hover, nbt.TAG_Compound):
                continue
            action = hover.get("action")
            action_name = action.value if isinstance(action, nbt.TAG_String) else ""
            targeted = action_name in ("show_item", "show_entity")
            if targeted:
                self._collect_hover_target(hover, action_name, refs, f"{path}/{key}", scope, category, detail)
            # What the targeted pass does not take is the shape older versions wrote (a component under
            # ``value``, a component list), which has always been read as a whole component.
            for field in ("value", "contents", "name"):
                child = hover.get(field)
                if isinstance(child, nbt.TAG_String) and action_name != "show_text" and field != "name":
                    continue
                if targeted and (
                    (field == "contents" and isinstance(child, nbt.TAG_Compound))
                    or (field == "name" and action_name == "show_entity")
                ):
                    continue
                if child is not None:
                    self._collect_component(child, refs, f"{path}/{key}/{field}", scope, category, detail)
        if self.scan_config["translate_command_output"]:
            for key in ("click_event", "clickEvent"):
                click = comp.get(key)
                if not isinstance(click, nbt.TAG_Compound):
                    continue
                for field in ("value", "command"):
                    command = click.get(field)
                    if isinstance(command, nbt.TAG_String) and self.extract_command_json(command.value):
                        refs.append(self._ref("command_tag", f"{path}/{key}/{field}", scope, "command", detail, tag=command))

    def _collect_hover_target(
        self, hover: Any, action: str, refs: list[TextRef], path: str, scope: Scope, category: str, detail: str
    ) -> None:
        """A ``show_item`` or ``show_entity`` hover: the item's name and lore, or the entity's name.

        1.21.5+ writes the fields inline; ``contents`` holds them before that.
        """
        for holder, base in ((hover, path), (hover.get("contents"), f"{path}/contents")):
            if not isinstance(holder, nbt.TAG_Compound):
                continue
            if action == "show_item":
                components = holder.get("components")
                if isinstance(components, nbt.TAG_Compound):
                    item_scope = replace(scope, in_item=True)
                    for key, value in components.items():
                        bare = key[len("minecraft:") :] if key.startswith("minecraft:") else key
                        self._collect_tooltip_component(bare, value, refs, f"{base}/components/{key}", item_scope)
            elif holder.get("name") is not None:
                self._collect_component(holder["name"], refs, f"{base}/name", scope, category, detail)

    def _collect_tooltip_component(self, bare: str, value: Any, refs: list[TextRef], path: str, scope: Scope) -> bool:
        """The item components whose text an item's tooltip shows. Returns whether ``bare`` is one of them."""
        if bare == "custom_name":
            if self.scan_config["translate_custom_names"]:
                self._collect_component(value, refs, path, scope, "item_name", "custom")
        elif bare == "item_name":
            if self.scan_config["translate_item_names"]:
                self._collect_component(value, refs, path, scope, "item_name", "base")
        elif bare == "lore":
            if self.scan_config["translate_lore"] and isinstance(value, nbt.TAG_List):
                for index, line in enumerate(value):
                    self._collect_component(line, refs, f"{path}/{index}", scope, "item_lore", f"line:{index + 1}")
        else:
            return False
        return True

    def _name_category(self, scope: Scope) -> str:
        if scope.in_item:
            return "item_name"
        return "entity_name" if scope.entity else "block_name"

    @staticmethod
    def _position(tag: Any) -> tuple[int, int, int] | None:
        x, y, z = tag.get("x"), tag.get("y"), tag.get("z")
        if all(isinstance(axis, nbt.TAG_Number) for axis in (x, y, z)):
            return int(x.value), int(y.value), int(z.value)
        pos = tag.get("Pos")
        if isinstance(pos, nbt.TAG_List) and len(pos) == 3 and all(isinstance(axis, nbt.TAG_Number) for axis in pos):
            return tuple(int(axis.value // 1) for axis in pos)  # type: ignore[return-value]
        return None

    def _enter(self, tag: Any, scope: Scope) -> Scope:
        ident = tag.get("id")
        if not isinstance(ident, nbt.TAG_String):
            return scope
        pos = self._position(tag)
        if pos is not None:
            return replace(scope, holder=ident.value, pos=pos, entity="Pos" in tag, in_item=False)
        if "count" in tag or "Count" in tag:
            return replace(scope, in_item=True)
        return scope

    def _collect_sign_face(self, tag: Any, refs: list[TextRef], path: str, scope: Scope, side: str) -> None:
        if not self.scan_config["translate_signs"]:
            return
        for list_name in ("messages", "filtered_messages"):
            messages = tag.get(list_name)
            if isinstance(messages, nbt.TAG_List):
                for index, item in enumerate(messages):
                    self._collect_component(item, refs, f"{path}/{list_name}/{index}", scope, "sign", f"{side}:{index + 1}")

    def _collect_plain(self, tag: Any, refs: list[TextRef], path: str, scope: Scope, category: str, detail: str = "") -> None:
        if isinstance(tag, nbt.TAG_String) and self.should_translate_text(tag.value):
            refs.append(self._ref("plain_tag", path, scope, category, detail, tag=tag))

    def _collect_book_text(self, value: Any, refs: list[TextRef], path: str, scope: Scope, category: str, detail: str, *, plain: bool) -> None:
        if isinstance(value, nbt.TAG_String) and plain:
            self._collect_plain(value, refs, path, scope, category, detail)
        else:
            self._collect_component(value, refs, path, scope, category, detail)

    def _collect_book(self, book: Any, refs: list[TextRef], path: str, scope: Scope, *, writable: bool) -> None:
        title = book.get("title")
        if self.scan_config["translate_titles"] and title is not None:
            if isinstance(title, nbt.TAG_Compound):
                self._collect_plain(title.get("raw"), refs, f"{path}/title/raw", scope, "book_title")
                if self.scan_config["translate_filtered_titles"]:
                    self._collect_plain(title.get("filtered"), refs, f"{path}/title/filtered", scope, "book_title")
            else:
                self._collect_plain(title, refs, f"{path}/title", scope, "book_title")
        pages = book.get("pages")
        if not self.scan_config["translate_books"] or not isinstance(pages, nbt.TAG_List):
            return
        for index, page in enumerate(pages):
            child, detail = f"{path}/pages/{index}", f"page:{index + 1}"
            if isinstance(page, nbt.TAG_Compound) and ("raw" in page or "filtered" in page):
                for side in ("raw", "filtered"):
                    if page.get(side) is not None:
                        self._collect_book_text(page[side], refs, f"{child}/{side}", scope, "book_page", detail, plain=writable)
            else:
                self._collect_book_text(page, refs, child, scope, "book_page", detail, plain=writable)

    def _collect_components(self, comp: Any, refs: list[TextRef], path: str, scope: Scope) -> None:
        for key, value in comp.items():
            bare = key[len("minecraft:") :] if key.startswith("minecraft:") else key
            child = f"{path}/{key}"
            if self._collect_tooltip_component(bare, value, refs, child, scope):
                continue
            if bare in {"written_book_content", "writable_book_content"} and isinstance(value, nbt.TAG_Compound):
                self._collect_book(value, refs, child, scope, writable=bare.startswith("writable"))
            elif isinstance(value, (nbt.TAG_Compound, nbt.TAG_List)):
                # Containers, bundles and other components hold item stacks of their own.
                self.collect_tag_refs(value, refs, child, scope)

    def _collect_legacy_display(self, display: Any, refs: list[TextRef], path: str, scope: Scope) -> None:
        name = display.get("Name")
        if self.scan_config["translate_item_names"] and name is not None:
            self._collect_component(name, refs, f"{path}/Name", scope, "item_name", "base")
        lore = display.get("Lore")
        if self.scan_config["translate_lore"] and isinstance(lore, nbt.TAG_List):
            for index, line in enumerate(lore):
                self._collect_component(line, refs, f"{path}/Lore/{index}", scope, "item_lore", f"line:{index + 1}")

    @staticmethod
    def _data_version(tag: Any) -> int | None:
        if not isinstance(tag, nbt.TAG_Compound):
            return None
        version = tag.get("DataVersion")
        if version is None and isinstance(tag.get("Data"), nbt.TAG_Compound):
            version = tag["Data"].get("DataVersion")  # level.dat keeps it under Data
        if isinstance(version, nbt.TAG_Number) and isinstance(version.value, int):
            return int(version.value)
        return None

    def collect_tag_refs(self, tag: Any, refs: list[TextRef], path: str, scope: Scope | None = None) -> None:
        if scope is None:
            # A chunk or entity file names its DataVersion at the root, level.dat under Data.
            scope = Scope(data_version=self._data_version(tag))
        if isinstance(tag, nbt.TAG_List):
            for index, item in enumerate(tag):
                if isinstance(item, (nbt.TAG_Compound, nbt.TAG_List)):
                    self.collect_tag_refs(item, refs, f"{path}/{index}", scope)
            return
        if not isinstance(tag, nbt.TAG_Compound):
            return
        scope = self._enter(tag, scope)
        ident = tag.get("id")
        holder_id = ident.value if isinstance(ident, nbt.TAG_String) else ""
        for key, value in tag.items():
            child = f"{path}/{key}"
            if isinstance(value, nbt.TAG_Number):
                continue
            if key in {"front_text", "back_text"} and isinstance(value, nbt.TAG_Compound):
                self._collect_sign_face(value, refs, child, scope, "front" if key == "front_text" else "back")
            elif key in {"Text1", "Text2", "Text3", "Text4"} and isinstance(value, nbt.TAG_String):
                if self.scan_config["translate_signs"]:
                    self._collect_component(value, refs, child, scope, "sign", f"line:{key[-1]}")
            elif key == "components" and isinstance(value, nbt.TAG_Compound):
                self._collect_components(value, refs, child, replace(scope, in_item=True))
            elif key == "display" and isinstance(value, nbt.TAG_Compound):
                self._collect_legacy_display(value, refs, child, replace(scope, in_item=True))
            elif key in {"CustomName", "custom_name"}:
                if self.scan_config["translate_custom_names"]:
                    self._collect_component(value, refs, child, scope, self._name_category(scope))
            elif key == "item_name":
                if self.scan_config["translate_item_names"]:
                    self._collect_component(value, refs, child, scope, "item_name", "base")
            elif key == "description" and holder_id.endswith("mannequin"):
                if self.scan_config["translate_custom_names"]:
                    self._collect_component(value, refs, child, scope, "entity_name", "description")
            elif key == "text" and holder_id.endswith("text_display"):
                if self.scan_config["translate_text_displays"]:
                    self._collect_component(value, refs, child, scope, "text_display")
            elif key == "Command" and isinstance(value, nbt.TAG_String):
                if self.scan_config["translate_command_output"] and self.extract_command_json(value.value):
                    refs.append(self._ref("command_tag", child, scope, "command", tag=value))
            elif key == "title" and isinstance(value, nbt.TAG_String):
                if self.scan_config["translate_titles"]:
                    self._collect_plain(value, refs, child, scope, "book_title")
            elif key == "filtered_title" and isinstance(value, nbt.TAG_String):
                if self.scan_config["translate_filtered_titles"]:
                    self._collect_plain(value, refs, child, scope, "book_title")
            elif key == "pages" and isinstance(value, nbt.TAG_List) and value and isinstance(value[0], nbt.TAG_String):
                if self.scan_config["translate_books"]:
                    for index, page in enumerate(value):
                        self._collect_component(page, refs, f"{child}/{index}", scope, "book_page", f"page:{index + 1}")
            elif isinstance(value, (nbt.TAG_Compound, nbt.TAG_List)):
                self.collect_tag_refs(value, refs, child, scope)

    # --- turning refs into texts, and translations back into refs ------------------------------------------

    def extract_occurrences(self, refs: list[TextRef]) -> list[tuple[str, TextRef]]:
        """Every (text, place) pair. A text that appears in ten places appears ten times."""
        found: list[tuple[str, TextRef]] = []

        def add(source: str, ref: TextRef) -> None:
            if self.should_translate_text(source):
                found.append((source, ref))

        for ref in refs:
            if ref.kind == "plain_tag":
                add(ref.tag.value, ref)
            elif ref.kind == "json_string_tag":
                text = self._json_string_component(ref.tag.value, ref.scope)
                if text is not None:
                    add(text, ref)
            elif ref.kind == "json_text":
                add(ref.obj[ref.key], ref)
            elif ref.kind == "translate_key":
                add(self.text_from_translate_key(ref.obj[ref.key]["translate"]), ref)
            elif ref.kind == "json_tag":
                try:
                    component = json.loads(ref.tag.value)
                except json.JSONDecodeError:
                    continue
                self._walk_json(
                    self._component_root(component), lambda container, key, source, ref=ref: add(source, ref)
                )
            elif ref.kind == "command_tag":
                self._walk_command(
                    {"command": ref.tag.value}, "command", lambda container, key, source, ref=ref: add(source, ref), False
                )
        return found

    def extract_unique_texts(self, refs: list[TextRef]) -> list[str]:
        return list(dict.fromkeys(text for text, _ in self.extract_occurrences(refs)))

    @staticmethod
    def _get_item(container: Any, key: Any) -> Any:
        try:
            return container[key]
        except (KeyError, IndexError, TypeError):
            return None

    def apply_translations(self, refs: list[TextRef], translations: dict[str, str]) -> int:
        changed = 0
        for ref in refs:
            if ref.kind == "plain_tag":
                original = ref.tag.value
                translated = translations.get(original)
                if translated and translated != original:
                    ref.tag.value = translated
                    changed += 1
            elif ref.kind == "json_string_tag":
                original = self._json_string_component(ref.tag.value, ref.scope)
                if original is None:
                    continue
                translated = translations.get(original)
                if translated and translated != original:
                    # Still a JSON string, so the game reads it as before; quotes and backslashes
                    # in the translation are escaped instead of ending the string.
                    ref.tag.value = json.dumps(translated, ensure_ascii=False)
                    changed += 1
            elif ref.kind == "json_tag":
                try:
                    patched = self._patch_json_string(
                        ref.tag.value, lambda root: self.patch_json_component(root, translations)
                    )
                except json.JSONDecodeError:
                    continue
                if patched != ref.tag.value:
                    ref.tag.value = patched
                    changed += 1
            elif ref.kind == "command_tag":
                updated = self.patch_command_component(ref.tag.value, translations)
                if updated != ref.tag.value:
                    ref.tag.value = updated
                    changed += 1
            elif ref.kind == "json_text":
                original = self._get_item(ref.obj, ref.key)
                if isinstance(original, str):
                    translated = translations.get(original)
                    if translated and translated != original:
                        ref.obj[ref.key] = translated
                        changed += 1
            elif ref.kind == "translate_key":
                value = self._get_item(ref.obj, ref.key)
                if isinstance(value, dict) and "translate" in value:
                    translated = translations.get(self.text_from_translate_key(value["translate"]))
                    if translated:
                        ref.obj[ref.key] = translated
                        changed += 1
        return changed
