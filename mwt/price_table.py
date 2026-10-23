"""List prices for the providers whose model lists carry no price: OpenAI, Gemini and Anthropic.

OpenRouter publishes a price per model in its own list, and the estimate uses that. The three
providers here do not, so this module holds what their official pricing pages printed, with the day it
was read and the page it came from. It is a list price, never a bill.

Rules:

* Only text prices for the standard (not batch, not cached, not fast/priority) tier are listed.
  Where a model is priced by prompt length, the lowest tier is listed, because the app sends short
  prompts. Those models are named in ``TIER_NOTES``.
* A model is found by its exact id, or by a documented alias listed here. There is no prefix or fuzzy
  matching: a model that is not listed is unknown, never "close to" another one.
* A model with a price change already announced inside the validity window, or a promotional price,
  is left out rather than listed with a number that stops being true.
* The table expires ``EXPIRY_DAYS`` days after ``checked_on``. After that, every price is unknown, so
  an old table is never shown as current.
* CometAPI and Custom endpoints never use this table, even when a model id matches: their prices
  differ from the provider's own.

Prices are USD per 1M tokens. Update ``checked_on`` only together with a new read of the page.
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Mapping

EXPIRY_DAYS = 120

# (input, output) in USD per 1M tokens.
Prices = Mapping[str, tuple[float, float]]

PRICE_TABLES: dict[str, dict] = {
    "openai": {
        "checked_on": "2026-10-23",
        "source_url": "https://developers.openai.com/api/docs/pricing",
        # Flagship models have a short (<=272K input tokens) and a long tier; the short one is listed.
        "models": {
            "gpt-6-astra": (10.00, 50.00),
            "gpt-6.1-sol": (2.00, 10.00),
            "gpt-6-luna": (0.10, 0.50),
            "gpt-6-sol": (2.00, 10.00),
            "gpt-5.6-terra": (2.00, 12.00),
            "gpt-5.6-luna": (0.20, 1.20),
            "gpt-5.5": (5.00, 30.00),
            "gpt-5.4": (2.50, 15.00),
            "gpt-5.4-mini": (0.75, 4.50),
            "gpt-5.4-nano": (0.20, 1.25),
            "gpt-5.2": (1.75, 14.00),
            "gpt-5.1": (1.25, 10.00),
            "gpt-5": (1.25, 10.00),
            "gpt-5-mini": (0.25, 2.00),
            "gpt-5-nano": (0.05, 0.40),
            "gpt-4.1": (2.00, 8.00),
            "gpt-4.1-mini": (0.40, 1.60),
            "gpt-4.1-nano": (0.10, 0.40),
            "gpt-4o": (2.50, 10.00),
            "gpt-4o-mini": (0.15, 0.60),
            "o3": (2.00, 8.00),
            "o4-mini": (1.10, 4.40),
            "o3-mini": (1.10, 4.40),
        },
    },
    "gemini": {
        "checked_on": "2026-10-23",
        "source_url": "https://ai.google.dev/gemini-api/docs/pricing",
        # Paid tier, text input. Audio input is priced higher on some models; the app sends text only.
        "models": {
            "gemini-3.5-flash-lite": (0.30, 2.50),
            "gemini-3.1-flash-lite": (0.25, 1.50),
            "gemini-3-flash-preview": (0.50, 3.00),
            # Pro models have a <=200k and a >200k prompt tier; the lower one is listed.
            "gemini-3.1-pro-preview": (2.00, 12.00),
            "gemini-3.1-pro-preview-customtools": (2.00, 12.00),
            "gemini-2.5-pro": (1.25, 10.00),
            "gemini-2.5-flash": (0.30, 2.50),
            "gemini-2.5-flash-lite": (0.10, 0.40),
        },
    },
    "anthropic": {
        "checked_on": "2026-10-23",
        "source_url": "https://platform.claude.com/docs/en/about-claude/pricing",
        # Each id is also its own alias (the models overview lists the same string for both).
        "models": {
            "claude-fable-5-1": (10.00, 50.00),
            "claude-opus-5-5": (4.00, 20.00),
            "claude-sonnet-5-5": (2.00, 10.00),
            # Haiku 5.5 costs $0.50 / $2.50 for prompts over 100,000 tokens; the lower tier is listed.
            "claude-haiku-5-5": (0.10, 0.50),
        },
    },
}

# Models priced by prompt length, for the person reading the table: the listed price is the lowest tier.
TIER_NOTES: dict[str, tuple[str, ...]] = {
    "openai": ("gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna", "gpt-6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"),
    "gemini": ("gemini-3.1-pro-preview", "gemini-3.1-pro-preview-customtools", "gemini-2.5-pro"),
    "anthropic": ("claude-haiku-5-5",),
}


def _today() -> date:
    return datetime.now(timezone.utc).date()


def table_valid(provider: str, today: date | None = None) -> bool:
    """True while the provider's table is dated and no older than ``EXPIRY_DAYS``.

    A clock that reads earlier than the day the table was checked is not trusted either.
    """
    table = PRICE_TABLES.get(provider)
    if not table:
        return False
    try:
        checked = date.fromisoformat(table["checked_on"])
    except (KeyError, ValueError):
        return False
    age = ((today or _today()) - checked).days
    return 0 <= age <= EXPIRY_DAYS


def table_price(provider: str, model: str, today: date | None = None) -> dict | None:
    """The list price of exactly this model, or None when it is unlisted or the table has expired."""
    table = PRICE_TABLES.get(provider)
    if not table or not isinstance(model, str) or not table_valid(provider, today):
        return None
    # Gemini's own API names a model "models/<id>"; that prefix is the documented long form of the id.
    name = model.removeprefix("models/") if provider == "gemini" else model
    prices = table["models"].get(name)
    if prices is None:
        return None
    per_million_input, per_million_output = prices
    return {
        "input": per_million_input / 1e6,
        "output": per_million_output / 1e6,
        "perMillionInput": per_million_input,
        "perMillionOutput": per_million_output,
        "source": "table",
        "checkedOn": table["checked_on"],
        "sourceUrl": table["source_url"],
    }
