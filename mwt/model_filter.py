"""Which models of a provider's list are offered for translating text.

Providers list every model they serve: embedding, speech, image and video generators, moderation
classifiers, robotics and computer-use agents. None of them can translate a block of text, and a
person picking from a long list should not have to know that. This is the one place that decides.

Rules are written down here, not learned: a model is left out when

* the provider says its output is not text (``output_modalities`` without "text", or with an extra
  audio/image/video output), or
* its id contains one of ``SUBSTRINGS`` or has one of ``WORDS`` as a whole segment (segments are
  split at ``-``, ``_``, ``.``, ``/``, ``:`` and spaces), for any provider, or one of the provider's
  own entries in ``PROVIDER_SUBSTRINGS`` / ``PROVIDER_WORDS``.

A model the person configured is never removed. It stays in the list with ``unsuitable_reason`` set,
so the screen can mark it instead of hiding the choice they already made.

A missing rule only leaves a model in the list; it never blocks a model that works. Prices are not
part of this module.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

# Substrings of a lower-cased id, for any provider.
SUBSTRINGS: tuple[str, ...] = (
    "embed",  # text-embedding-3-small, gemini-embedding-001, voyage/cohere embeddings on gateways
    "moderation",  # omni-moderation-latest, text-moderation-stable
    "transcribe",  # gpt-4o-transcribe, gpt-4o-mini-transcribe
    "whisper",  # whisper-1
    "dall-e",  # dall-e-3
    "dalle",
    "gpt-image",  # gpt-image-1
    "imagen",  # imagen-4.0-generate-001
    "-image",  # gemini-2.5-flash-image, gemini-3-pro-image-preview
    "realtime",  # gpt-4o-realtime-preview, gpt-realtime
    "native-audio",  # gemini-2.5-flash-native-audio-preview
    "audio-preview",  # gpt-4o-audio-preview
    "audio-only",
    "computer-use",  # gemini-2.5-computer-use-preview, computer-use-preview
    "robotics",  # gemini-robotics-er-1.5-preview
    "deep-research",  # o3-deep-research: needs an agent harness, not a plain completion
    "llama-guard",  # classifiers that answer safe/unsafe
    "shieldgemma",
    "prompt-guard",
)

# Whole segments of an id: too short to be safe as substrings.
WORDS: tuple[str, ...] = (
    "tts",  # tts-1-hd, gemini-2.5-flash-preview-tts, gpt-4o-mini-tts
    "sora",  # sora-2
    "veo",  # veo-3.0-generate-preview
    "live",  # gemini-live-2.5-flash, gemini-2.0-flash-live-001 (Live API, not generateContent)
    "lyria",  # lyria-realtime
    "aqa",  # Gemini's attributed-QA model
    "guardian",  # granite-guardian
)

# Rules that only make sense for one provider's naming. Each entry says why.
PROVIDER_SUBSTRINGS: dict[str, tuple[str, ...]] = {
    "openai": ("-audio",),  # gpt-audio, gpt-audio-mini: speech in and out
    "gemini": (),  # generateContent support is checked when the list is read
    "anthropic": (),  # the list holds Claude chat models only
    "openrouter": ("-audio",),  # openai/gpt-audio, openai/gpt-4o-audio-preview
    "comet": ("-audio",),  # OpenAI-style gateway
}
PROVIDER_WORDS: dict[str, tuple[str, ...]] = {
    "openai": (),
    "gemini": (),
    "anthropic": (),
    "openrouter": (),
    "comet": (),
}

_SEGMENTS = re.compile(r"[-_./: ]+")
_NON_TEXT_OUTPUTS = ("audio", "image", "video", "embeddings", "embedding", "speech")


def _provider_rules(provider: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
    return PROVIDER_SUBSTRINGS.get(provider, ()), PROVIDER_WORDS.get(provider, ())


def unsuitable_reason(provider: str, model_id: str, record: dict[str, Any] | None = None) -> str:
    """Why this model cannot translate text, or an empty string when it can."""
    outputs = [str(part).lower() for part in ((record or {}).get("output_modalities") or [])]
    if outputs and "text" not in outputs:
        return f"output:{','.join(outputs)}"
    extra = [part for part in outputs if part in _NON_TEXT_OUTPUTS]
    if extra:
        return f"output:{','.join(extra)}"
    lowered = str(model_id).lower()
    extra_substrings, extra_words = _provider_rules(provider)
    for token in (*SUBSTRINGS, *extra_substrings):
        if token in lowered:
            return f"id:{token}"
    segments = set(_SEGMENTS.split(lowered))
    for word in (*WORDS, *extra_words):
        if word in segments:
            return f"id:{word}"
    return ""


def filter_translation_models(
    provider: str, models: Iterable[dict[str, Any]], configured: str = ""
) -> list[dict[str, Any]]:
    """The models a person can pick for translating, in the order given.

    ``configured`` is the model already chosen: it is kept even when unsuitable, with
    ``unsuitable_reason`` set on a copy of its record.
    """
    kept: list[dict[str, Any]] = []
    for record in models:
        model_id = str(record.get("id", ""))
        reason = unsuitable_reason(provider, model_id, record)
        if not reason:
            kept.append(record)
        elif configured and model_id == configured:
            kept.append({**record, "unsuitable_reason": reason})
    return kept
