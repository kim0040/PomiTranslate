"""The estimate prices a model from the provider's own list, else from a dated list-price table."""

from __future__ import annotations

import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from mwt import desktop_entry as entry
from mwt import price_table
from mwt.price_table import EXPIRY_DAYS, PRICE_TABLES, TIER_NOTES, table_price, table_valid
from mwt.userdata import remember_model_catalog

OFFICIAL_PAGES = {
    "openai": "https://developers.openai.com/api/docs/pricing",
    "gemini": "https://ai.google.dev/gemini-api/docs/pricing",
    "anthropic": "https://platform.claude.com/docs/en/about-claude/pricing",
}
RECORDS = [{"source": "Hello there", "kind": "item_name"}] * 3


def fresh(provider: str) -> date:
    return date.fromisoformat(PRICE_TABLES[provider]["checked_on"])


def test_tables_are_dated_and_sourced() -> None:
    assert set(PRICE_TABLES) == set(OFFICIAL_PAGES)
    for provider, table in PRICE_TABLES.items():
        assert table["source_url"] == OFFICIAL_PAGES[provider], provider
        assert date.fromisoformat(table["checked_on"]).isoformat() == table["checked_on"]
        assert table["models"], provider
        for model, (price_in, price_out) in table["models"].items():
            assert model == model.strip() and model, (provider, model)
            assert price_in > 0 and price_out > 0, (provider, model)
        for model in TIER_NOTES[provider]:
            assert model in table["models"], (provider, model)
    print("PASS price_table.dated_and_sourced")


def test_exact_ids_only() -> None:
    today = fresh("gemini")
    price = table_price("gemini", "gemini-2.5-flash", today)
    assert price is not None and (price["perMillionInput"], price["perMillionOutput"]) == (0.30, 2.50)
    # Gemini's long form of the same id is the documented alias.
    assert table_price("gemini", "models/gemini-2.5-flash", today) == price
    lite = table_price("gemini", "gemini-2.5-flash-lite", today)
    assert lite is not None and lite["perMillionInput"] == 0.10
    for provider, model in [
        ("gemini", "gemini-2.5"),  # a prefix of a listed id
        ("gemini", "gemini-2.5-flash-lite-preview-09-2025"),  # a listed id plus a suffix
        ("gemini", "GEMINI-2.5-FLASH"),  # other case
        ("gemini", " gemini-2.5-flash"),
        ("gemini", "gemini-flash-latest"),  # an alias the page does not document
        ("gemini", "models/models/gemini-2.5-flash"),
        ("openai", "gpt-4o-2024-08-06"),  # a snapshot the page does not list
        ("openai", "gpt-4.1-mini-2025-04-14"),
        ("openai", "gpt-5.4-mini-high"),
        ("openai", "gpt-5.4-pro"),
        ("openai", "models/gpt-4o"),  # the models/ form belongs to Gemini only
        ("anthropic", "claude-sonnet-5"),
        ("anthropic", "claude-haiku-5-5-20260101"),
        ("anthropic", "claude-sonnet"),
        ("anthropic", ""),
    ]:
        assert table_price(provider, model, fresh(provider)) is None, (provider, model)
    for model in ("gpt-4o", "gpt-4o-mini", "gpt-5", "gpt-5-mini", "o3"):
        assert table_price("openai", model, fresh("openai")) is not None, model
    haiku = table_price("anthropic", "claude-haiku-5-5", fresh("anthropic"))
    assert haiku is not None and (haiku["perMillionInput"], haiku["perMillionOutput"]) == (0.10, 0.50)
    assert abs(haiku["input"] - 1e-7) < 1e-15 and abs(haiku["output"] - 5e-7) < 1e-15
    print("PASS price_table.exact_ids_only")


def test_expiry_at_120_days() -> None:
    assert EXPIRY_DAYS == 120
    for provider, table in PRICE_TABLES.items():
        checked = fresh(provider)
        model = next(iter(table["models"]))
        assert table_price(provider, model, checked) is not None
        assert table_price(provider, model, checked + timedelta(days=EXPIRY_DAYS)) is not None, "day 120 is still current"
        assert table_price(provider, model, checked + timedelta(days=EXPIRY_DAYS + 1)) is None, "day 121 is stale"
        assert not table_valid(provider, checked + timedelta(days=400))
        # A clock earlier than the day the table was read cannot vouch for it.
        assert table_price(provider, model, checked - timedelta(days=1)) is None
    # The default clock is today's date: a table checked long ago is unknown without being told the day.
    with patch.object(price_table, "_today", return_value=date(2030, 1, 1)):
        assert table_price("openai", "gpt-4o") is None
    with patch.object(price_table, "_today", return_value=fresh("openai")):
        assert table_price("openai", "gpt-4o") is not None
    print("PASS price_table.expiry")


def test_source_fields() -> None:
    for provider, table in PRICE_TABLES.items():
        model = next(iter(table["models"]))
        price = table_price(provider, model, fresh(provider))
        assert price is not None
        assert price["source"] == "table"
        assert price["checkedOn"] == table["checked_on"]
        assert price["sourceUrl"] == OFFICIAL_PAGES[provider]
        assert set(price) == {"input", "output", "perMillionInput", "perMillionOutput", "source", "checkedOn", "sourceUrl"}
    print("PASS price_table.source_fields")


def saved(provider: str, model: str) -> dict:
    return {"provider": provider, "model": model, "batch_size": 40}


def with_today(day: date):
    return patch.object(price_table, "_today", return_value=day)


def test_model_price_precedence(data_dir: Path) -> None:
    day = fresh("openai")
    with with_today(day):
        # The table prices a listed model when the provider's own list carries no price.
        remember_model_catalog("openai", [{"id": "gpt-4o"}], root=data_dir)
        table = entry._model_price(saved("openai", "gpt-4o"), data_dir)
        assert table and table["source"] == "table" and table["perMillionInput"] == 2.50
        assert table["checkedOn"] == "2026-10-23" and table["sourceUrl"] == OFFICIAL_PAGES["openai"]
        # The provider's own catalog price wins, and carries no table fields.
        remember_model_catalog("openai", [{"id": "gpt-4o", "pricing_prompt": "0.000001", "pricing_completion": "0.000002"}], root=data_dir)
        catalog = entry._model_price(saved("openai", "gpt-4o"), data_dir)
        assert catalog == {"input": 1e-6, "output": 2e-6, "perMillionInput": 1e-6 * 1e6, "perMillionOutput": 2e-6 * 1e6, "source": "catalog"}
        # A catalog row whose price cannot be read does not hide the table.
        for broken in ({"pricing_prompt": "free", "pricing_completion": "1"}, {"pricing_prompt": "-1", "pricing_completion": "1"}, {"pricing_prompt": "nan", "pricing_completion": "1"}):
            remember_model_catalog("openai", [{"id": "gpt-4o", **broken}], root=data_dir)
            fallback = entry._model_price(saved("openai", "gpt-4o"), data_dir)
            assert fallback and fallback["source"] == "table", broken
        # OpenRouter has no table: its own price, or unknown.
        remember_model_catalog("openrouter", [{"id": "openai/gpt-4o", "pricing_prompt": "0.0000025", "pricing_completion": "0.00001"}, {"id": "vendor/free"}], root=data_dir)
        router = entry._model_price(saved("openrouter", "openai/gpt-4o"), data_dir)
        assert router and router["source"] == "catalog" and "checkedOn" not in router
        assert entry._model_price(saved("openrouter", "vendor/free"), data_dir) is None
        # An unlisted model, a missing model and a missing provider stay unknown.
        assert entry._model_price(saved("openai", "gpt-4o-2024-08-06"), data_dir) is None
        assert entry._model_price(saved("openai", ""), data_dir) is None
        assert entry._model_price({"provider": "", "model": "gpt-4o"}, data_dir) is None
    # Past the expiry the same model is unknown, never a stale price.
    with with_today(day + timedelta(days=EXPIRY_DAYS + 1)):
        remember_model_catalog("openai", [{"id": "gpt-4o"}], root=data_dir)
        assert entry._model_price(saved("openai", "gpt-4o"), data_dir) is None
        # ... while a price the provider itself published is not affected by the table's age.
        remember_model_catalog("openai", [{"id": "gpt-4o", "pricing_prompt": "0.000001", "pricing_completion": "0.000002"}], root=data_dir)
        assert entry._model_price(saved("openai", "gpt-4o"), data_dir)["source"] == "catalog"
    print("PASS price_table.precedence")


def test_comet_and_custom_never_use_the_table(data_dir: Path) -> None:
    with with_today(fresh("openai")):
        for provider in ("comet", "custom"):
            for model in ("gpt-4o", "gemini-2.5-flash", "claude-sonnet-5-5"):
                assert table_price(provider, model) is None, (provider, model)
                assert entry._model_price(saved(provider, model), data_dir) is None, (provider, model)
        # Their own catalog price still counts when they publish one.
        remember_model_catalog("comet", [{"id": "gpt-4o", "pricing_prompt": "0.000003", "pricing_completion": "0.000012"}], root=data_dir)
        comet = entry._model_price(saved("comet", "gpt-4o"), data_dir)
        assert comet and comet["source"] == "catalog" and comet["perMillionInput"] == 3.0
        # A different provider's table never prices a model by its id alone.
        assert entry._model_price(saved("openai", "gemini-2.5-flash"), data_dir) is None
        assert entry._model_price(saved("gemini", "gpt-4o"), data_dir) is None
    print("PASS price_table.comet_and_custom")


def test_estimate_carries_the_source(data_dir: Path) -> None:
    with with_today(fresh("gemini")):
        estimate = entry._estimate(RECORDS, saved("gemini", "gemini-2.5-flash"), data_dir)
        price = estimate["price"]
        assert price and price["source"] == "table" and price["checkedOn"] == "2026-10-23"
        assert price["sourceUrl"] == OFFICIAL_PAGES["gemini"]
        cost = estimate["cost"]
        expected = estimate["inputTokens"] * 0.30e-6 + estimate["outputTokens"] * 2.50e-6
        assert cost and abs(cost["low"] - expected) < 1e-12 and abs(cost["high"] - 2 * expected) < 1e-12
        unknown = entry._estimate(RECORDS, saved("custom", "gemini-2.5-flash"), data_dir)
        assert unknown["price"] is None and unknown["cost"] is None
    with with_today(fresh("gemini") + timedelta(days=EXPIRY_DAYS + 1)):
        stale = entry._estimate(RECORDS, saved("gemini", "gemini-2.5-flash"), data_dir)
        assert stale["price"] is None and stale["cost"] is None
    print("PASS price_table.estimate")


def main() -> None:
    test_tables_are_dated_and_sourced()
    test_exact_ids_only()
    test_expiry_at_120_days()
    test_source_fields()
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        for index, check in enumerate((test_model_price_precedence, test_comet_and_custom_never_use_the_table, test_estimate_carries_the_source)):
            check(root / f"case{index}")
    print("PASS price_table")


if __name__ == "__main__":
    main()
