"""Glossary contracts stay local: no real provider requests or sample-world writes."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import mc_world_translator as core
from llm_backends import LLMProviderClient
from mwt import desktop_entry
from mwt.glossary import (
    GlossaryValidationError,
    contains_term,
    export_csv,
    export_json,
    import_csv,
    import_json,
    matching_entries,
    merge_entries,
    normalize_entries,
    prompt_block,
)
from mwt.userdata import load_world_glossary, remember_user_settings, remember_world_glossary


def entry(source: str, target: str, *, mode: str = "translate", case_sensitive: bool = False) -> dict:
    return {"source": source, "target": target, "mode": mode, "note": "", "caseSensitive": case_sensitive}


class FakeProvider:
    def __init__(self, responses: list[dict[str, str]]) -> None:
        self.responses = list(responses)
        self.prompts: list[str] = []

    def translate_mapping(self, values: dict[str, str], *, system_prompt: str, temperature: float) -> dict[str, str]:
        self.prompts.append(system_prompt)
        LLMProviderClient.request_count += 1
        LLMProviderClient.record_usage({"usage": {"prompt_tokens": 100, "completion_tokens": 20}})
        return self.responses.pop(0)


class GlossaryTests(unittest.TestCase):
    def test_validation_reports_row_errors_and_allows_keep_with_ignored_target(self) -> None:
        valid = normalize_entries([entry("Elder Mira", "", mode="keep")])
        self.assertEqual(valid[0]["target"], "")
        with self.assertRaises(GlossaryValidationError) as raised:
            normalize_entries([
                entry("Elder Mira", "first"),
                entry("elder mira", "", mode="translate"),
                entry("§6Gold", "금"),
            ])
        rows = raised.exception.details["rows"]
        self.assertEqual([row["index"] for row in rows], [1, 2])
        self.assertIn("duplicates entry 1", rows[0]["message"])
        self.assertIn("Minecraft formatting codes are not allowed", rows[1]["message"])
        self.assertIn("keep formatting codes in the original text", rows[1]["message"])

    def test_case_sensitive_sources_can_differ_but_default_is_case_insensitive(self) -> None:
        rows = [entry("Mira", "미라", case_sensitive=True), entry("mira", "미라2", case_sensitive=True)]
        self.assertEqual(len(normalize_entries(rows)), 2)
        with self.assertRaises(GlossaryValidationError):
            normalize_entries([entry("Mira", "미라", case_sensitive=True), entry("mira", "미라2")])

    def test_world_entries_override_global_and_term_selection_handles_latin_and_cjk(self) -> None:
        merged = merge_entries(
            [entry("Elder Mira", "장로 미라"), entry("古代竜", "고대룡")],
            [entry("elder mira", "미라 장로")],
        )
        self.assertEqual([item["source"] for item in merged], ["古代竜", "elder mira"])
        self.assertEqual(matching_entries(["An Elder Mira arrives", "古代竜が現れる"], merged), merged)
        self.assertTrue(contains_term("An Elder Mira arrives", merged[1]))
        self.assertFalse(contains_term("Eldermira arrives", merged[1]))
        self.assertTrue(contains_term("古代竜が現れる", merged[0]))
        self.assertEqual(prompt_block([merged[1]]).count("elder mira"), 1)
        self.assertNotIn("古代竜", prompt_block([merged[1]]))

    def test_batch_prompt_omits_unused_terms_and_mismatch_retries_once_then_flags(self) -> None:
        glossary = [entry("Elder Mira", "장로 미라"), entry("unused phrase", "미사용 문구")]
        config = core.merge_nested(core.DEFAULT_CONFIG, {
            "runtime": {"glossary_entries": glossary, "max_batch_retries": 1, "concurrency": 1},
        })
        translator = core.BatchTranslator(config)
        LLMProviderClient.reset_counters()
        provider = FakeProvider([{"0": "미라 장로 등장"}, {"0": "장로 미라 등장"}])
        translator.client = provider
        answers = translator._translate_batch(["Elder Mira appears"], 1)
        self.assertEqual(answers["Elder Mira appears"], "장로 미라 등장")
        self.assertEqual(len(provider.prompts), 2)
        self.assertIn("Elder Mira", provider.prompts[0])
        self.assertNotIn("unused phrase", provider.prompts[0])
        self.assertIn("Reminder", provider.prompts[1])
        self.assertNotIn("unused phrase", provider.prompts[1])
        self.assertFalse(translator.glossary_mismatches)
        self.assertEqual(LLMProviderClient.request_count, 2)
        self.assertEqual(LLMProviderClient.usage["prompt_tokens"], 200)

        LLMProviderClient.reset_counters()
        provider = FakeProvider([{"0": "미라 장로 등장"}, {"0": "또 다르게 번역"}])
        translator.client = provider
        answers = translator._translate_batch(["Elder Mira appears"], 1)
        self.assertEqual(answers["Elder Mira appears"], "미라 장로 등장")
        self.assertEqual(translator.glossary_mismatches, {"Elder Mira appears"})
        self.assertEqual(LLMProviderClient.request_count, 2)

    def test_budget_hit_before_glossary_retry_keeps_first_answer_and_counts_user_price(self) -> None:
        config = core.merge_nested(core.DEFAULT_CONFIG, {
            "runtime": {
                "glossary_entries": [entry("Elder Mira", "장로 미라")],
                "max_batch_retries": 1,
                "concurrency": 1,
                "max_cost_usd": 0.05,
                "price": {"input": 0.0005, "output": 0.00025, "source": "user"},
            },
        })
        translator = core.BatchTranslator(config)
        provider = FakeProvider([{"0": "미라 장로 등장"}])
        translator.client = provider
        LLMProviderClient.reset_counters()
        with self.assertRaises(core.BudgetStopped):
            translator.translate_texts(["Elder Mira appears"])
        self.assertEqual(LLMProviderClient.request_count, 1)
        self.assertEqual(translator.cache["Elder Mira appears"], "미라 장로 등장")
        self.assertEqual(translator.glossary_mismatches, {"Elder Mira appears"})

    def test_translation_fingerprint_changes_with_glossary_but_scan_plan_does_not(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pomi-glossary-fingerprint-") as temporary:
            data_dir = Path(temporary) / "app-data"
            world = Path(temporary) / "world"
            world.mkdir()
            remember_user_settings({"glossary": [entry("Elder Mira", "장로 미라")]}, data_dir)
            first_translation = desktop_entry._settings_fingerprint(data_dir, world)
            first_scope = desktop_entry._scan_scope_fingerprint(data_dir)
            first_plan_id = desktop_entry._scan_plan_id("same-world", first_scope)
            remember_user_settings({"glossary": [entry("Elder Mira", "미라 장로")]}, data_dir)
            self.assertNotEqual(first_translation, desktop_entry._settings_fingerprint(data_dir, world))
            self.assertEqual(first_scope, desktop_entry._scan_scope_fingerprint(data_dir))
            self.assertEqual(first_plan_id, desktop_entry._scan_plan_id("same-world", desktop_entry._scan_scope_fingerprint(data_dir)))
            remember_world_glossary(world, [entry("Elder Mira", "장로 미라")], data_dir)
            self.assertEqual(load_world_glossary(world, data_dir)[0]["target"], "장로 미라")
            self.assertTrue((data_dir / "world-glossaries.json").exists())
            self.assertFalse((world / "world-glossaries.json").exists())

    def test_json_and_csv_round_trip_with_utf8_and_quoted_cells(self) -> None:
        rows = [entry("Elder, Mira", '장로 "미라"'), entry("古代竜", "고대룡", mode="translate", case_sensitive=True)]
        self.assertEqual(import_json(export_json(rows)), normalize_entries(rows))
        csv_text = export_csv(rows)
        self.assertTrue(csv_text.startswith("\ufeffsource,target,mode,note,caseSensitive\r\n"))
        self.assertEqual(import_csv(csv_text), normalize_entries(rows))

    def test_user_price_fallback_is_in_usd_per_million_and_catalog_still_wins(self) -> None:
        saved = {
            "provider": "openai", "model": "fixture-model", "batch_size": 40,
            "custom_prices": {"openai/fixture-model": {"input": 2.5, "output": 7.5}},
        }
        with tempfile.TemporaryDirectory(prefix="pomi-user-price-") as temporary:
            data_dir = Path(temporary)
            with patch("mwt.userdata.load_model_catalog", return_value=[]):
                price = desktop_entry._model_price(saved, data_dir)
                estimate = desktop_entry._estimate([{"source": "Hello"}], saved, data_dir)
            self.assertEqual(price["source"], "user")
            self.assertEqual(price["perMillionInput"], 2.5)
            self.assertEqual(price["perMillionOutput"], 7.5)
            self.assertAlmostEqual(price["input"], 2.5 / 1_000_000)
            self.assertEqual(estimate["priceSource"], "user")
            self.assertIsNotNone(estimate["cost"])
            with patch("mwt.userdata.load_model_catalog", return_value=[{
                "id": "fixture-model", "pricing_prompt": "0.000003", "pricing_completion": "0.000004",
            }]):
                catalog = desktop_entry._model_price(saved, data_dir)
            self.assertEqual(catalog["source"], "catalog")
            self.assertEqual(catalog["perMillionInput"], 3.0)


if __name__ == "__main__":
    unittest.main()
