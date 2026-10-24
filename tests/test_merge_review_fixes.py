"""Regressions for the review of the main-merge Python resolution (H1, M1-M5, L1-L7, L10).

Each test names the finding it pins. Synthetic worlds, loopback-free fakes and dummy keys only.
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import llm_backends as lb  # noqa: E402
import mc_world_translator as core  # noqa: E402
import tests.test_review_apply as review_apply  # noqa: E402  (the module, so its TestCase is not collected here)
from mwt import desktop_entry as entry  # noqa: E402
from mwt import glossary as terms  # noqa: E402
from mwt.desktop_review import translations_page  # noqa: E402
from mwt.desktop_settings import normalize_custom_prices  # noqa: E402
from mwt.userdata import remember_user_settings  # noqa: E402
from tests.test_batch_budget import translator  # noqa: E402


def many_entries(count: int = 50) -> list[dict]:
    return [{"id": f"{index:020x}", "source": f"Term{index}", "target": f"용어{index}", "mode": "translate",
             "note": "", "caseSensitive": False} for index in range(count)]


def many_texts(count: int = 5000) -> list[str]:
    return [f"line {index} mentions Term{index % 80} and more words" for index in range(count)]


class CountBuilds:
    """Counts how many ``Glossary`` objects get built inside the block."""

    def __init__(self, *, fresh: bool = True) -> None:
        self.fresh = fresh

    def __enter__(self):
        if self.fresh:
            terms._shared.clear()
        self.count = 0
        original = terms.Glossary.__init__
        outer = self

        def counting(glossary, *args, **kwargs):
            outer.count += 1
            original(glossary, *args, **kwargs)

        self._patch = patch.object(terms.Glossary, "__init__", counting)
        self._patch.start()
        return self

    def __exit__(self, *exc):
        self._patch.stop()


class GlossaryScaleTests(unittest.TestCase):
    """H1: one Glossary per call/run, so checkpoints, review pages and estimates do not rebuild it per text."""

    def test_row_hashes_builds_one_glossary_and_stays_fast(self):
        entries, texts = many_entries(), many_texts()
        with CountBuilds() as builds:
            start = time.perf_counter()
            hashes = terms.row_hashes(texts, entries)
            elapsed = time.perf_counter() - start
        self.assertEqual(len(hashes), len(set(texts)))
        self.assertLessEqual(builds.count, 1, "a Glossary per text is what made checkpoints O(rows x rebuild)")
        self.assertLess(elapsed, 1.0, f"5,000 texts x 50 entries took {elapsed:.2f}s")

    def test_row_hash_cache_matches_each_text_once_across_checkpoints(self):
        entries, texts = many_entries(), many_texts(600)
        cache: dict[str, str] = {}
        first = terms.row_hashes(texts, entries, cache=cache)
        calls = 0
        original = terms.Glossary.matching

        def counting(glossary, batch):
            nonlocal calls
            calls += 1
            return original(glossary, batch)

        with patch.object(terms.Glossary, "matching", counting):
            second = terms.row_hashes(texts + ["a brand new line with Term3"], entries, cache=cache)
        self.assertEqual(calls, 1, "only the text that was not in the cache is matched again")
        self.assertEqual({key: second[key] for key in first}, first)

    def test_checkpoint_payload_reuses_row_hashes_between_saves(self):
        config = core.merge_nested(core.DEFAULT_CONFIG, {
            "world_dir": str(ROOT / "tests"), "dry_run": True, "inherit_translate_py": False,
            "runtime": {"checkpoint_enabled": False, "glossary_entries": many_entries()},
        })
        worker = core.WorldTranslator(config)
        worker.candidate_texts.update(many_texts(400))
        with patch.object(core, "world_state_fingerprint", return_value="fixed"):
            first = worker.checkpoint_payload()["resume"]["glossary_row_hashes"]
            with CountBuilds(fresh=False) as builds, patch.object(terms.Glossary, "matching", side_effect=AssertionError("rematched")):
                second = worker.checkpoint_payload()["resume"]["glossary_row_hashes"]
        self.assertEqual(first, second)
        self.assertEqual(builds.count, 0)

    def test_review_page_and_estimate_build_the_glossary_once(self):
        entries, texts = many_entries(), many_texts(3000)
        plan = {"candidates": [{"id": str(index), "source": text, "kind": "sign", "occurrences": 1}
                               for index, text in enumerate(texts)]}
        job = {"version": 2, "translation_cache": {text: "번역 " + text for text in texts}, "report": {}}
        with CountBuilds() as builds:
            start = time.perf_counter()
            page = translations_page(plan, job, {}, {"limit": 100}, glossary=entries)
            page_seconds = time.perf_counter() - start
        self.assertEqual(page["counts"]["all"], len(texts))
        self.assertLessEqual(builds.count, 1)
        self.assertLess(page_seconds, 1.5, f"one translations.page of 3,000 rows took {page_seconds:.2f}s")
        saved = {"batch_size": 40, "provider": "openai", "model": "m"}
        with tempfile.TemporaryDirectory() as data, CountBuilds() as builds:
            start = time.perf_counter()
            estimate = entry._estimate([{"source": text} for text in texts], saved, Path(data), glossary=entries)
            seconds = time.perf_counter() - start
        self.assertEqual(estimate["candidateCount"], len(texts))
        self.assertLessEqual(builds.count, 1)
        self.assertLess(seconds, 1.5, f"estimating 3,000 texts took {seconds:.2f}s")

    def test_shared_glossary_still_judges_each_entry_list_by_its_own_rules(self):
        keep = [{"id": "a" * 20, "source": "Mira", "target": "", "mode": "keep", "caseSensitive": True}]
        translate = [{"id": "a" * 20, "source": "Mira", "target": "미라", "mode": "translate", "caseSensitive": True}]
        self.assertTrue(terms.output_matches("Hi Mira", "안녕 Mira", keep))
        self.assertFalse(terms.output_matches("Hi Mira", "안녕 Mira", translate))
        self.assertTrue(terms.output_matches("Hi Mira", "안녕 미라", translate))


class PriceProviderTests(unittest.TestCase):
    """M5: a price can exist for every provider the core knows."""

    def test_every_provider_spec_may_carry_a_custom_price(self):
        price = {"input": 1, "output": 2}
        for provider in lb.PROVIDER_SPECS:
            self.assertIn(f"{provider}/model-x", normalize_custom_prices({f"{provider}/model-x": dict(price)}))
        with self.assertRaises(ValueError):
            normalize_custom_prices({"nope/model-x": dict(price)})


class SpendingCapThreadTests(unittest.TestCase):
    """M4: pool threads read the job's own totals, so the cap stops them too."""

    def run_capped(self, concurrency: int, requests_allowed: int = 5) -> tuple[int, bool]:
        totals = lb._current_accounting()  # the job's totals: the thread that builds the client owns them
        totals.request_count, totals.usage = 0, dict(lb._EMPTY_USAGE)
        lock = threading.Lock()

        class Fake:
            requests = 0

            def translate_mapping(self, payload, **_kwargs):
                with lock:
                    Fake.requests += 1
                time.sleep(0.01)
                lb.LLMProviderClient.record_usage({"usage": {"prompt_tokens": 10, "completion_tokens": 10, "cost": 0.01}}, totals)
                raise RuntimeError("incomplete translation JSON mapping")  # every answer is paid for and then retried

        batch = translator(Fake(), batch_size=1, retries=3)
        batch.concurrency = concurrency
        batch.max_cost_usd = requests_allowed * 0.01 - 0.005  # exactly `requests_allowed` paid requests reach it
        stopped = False
        try:
            batch.translate_texts([f"text {index}" for index in range(120)])
        except core.BudgetStopped:
            stopped = True
        return Fake.requests, stopped

    def test_sixteen_workers_overshoot_by_at_most_the_requests_in_flight(self):
        for concurrency in (1, 4, 16):
            with self.subTest(concurrency=concurrency):
                requests, stopped = self.run_capped(concurrency)
                self.assertTrue(stopped)
                self.assertGreaterEqual(requests, 5)
                self.assertLessEqual(requests, 5 + concurrency - 1)


class LegacyGlossaryTests(unittest.TestCase):
    """M3 and L4: one writer, revisioned; old settings stay readable and their problems are shown."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.data = Path(self.temporary.name)

    def test_no_second_unrevisioned_writer_remains(self):
        from mwt import userdata
        for name in ("replace_legacy_scope", "normalize_legacy_entries", "GlossaryValidationError", "export_json", "import_json",
                     "export_csv", "import_csv", "contains_term", "MAX_TARGET_LENGTH", "MAX_NOTE_LENGTH"):
            self.assertFalse(hasattr(terms, name), name)
        for name in ("remember_world_glossary", "load_world_glossary"):
            self.assertFalse(hasattr(userdata, name), name)
        self.assertEqual((terms.MAX_TARGET_CHARS, terms.MAX_NOTE_CHARS), (200, 300))

    def test_old_long_rows_stay_readable_and_the_editor_sees_them_as_invalid(self):
        long_target, long_note = "가" * 350, "n" * 400
        remember_user_settings({"glossary": [
            {"source": "Mira", "target": "미라", "mode": "translate", "note": "", "caseSensitive": False},
            {"source": "Elder", "target": long_target, "mode": "translate", "note": "", "caseSensitive": False},
            {"source": "Crypt", "target": "지하실", "mode": "translate", "note": long_note, "caseSensitive": False},
            {"source": "", "target": "x", "mode": "translate"},
        ]}, self.data)
        used = terms.read_scope_entries(self.data, "global")
        self.assertEqual(sorted(item["source"] for item in used), ["Crypt", "Elder", "Mira"], "a translation still uses every readable row")
        view = terms.get_glossary({"scope": "global"}, self.data)
        self.assertEqual(view["revision"], 0)
        self.assertEqual([item["source"] for item in view["entries"]], ["Mira"], "only rows the store can save are editable")
        invalid = {item["source"]: item["reason"] for item in view["legacyInvalid"]}
        self.assertEqual(invalid, {"Elder": "too_long", "Crypt": "too_long", "": "source_invalid"})
        saved = terms.set_glossary({"scope": "global", "baseRevision": 0, "entries": view["entries"]}, self.data)
        self.assertEqual(saved["revision"], 1)
        self.assertNotIn("legacyInvalid", terms.get_glossary({"scope": "global"}, self.data))
        with self.assertRaises(terms.GlossaryError):
            terms.set_glossary({"scope": "global", "baseRevision": 1, "entries": [
                {"source": "Elder", "target": long_target, "mode": "translate"}]}, self.data)


class ExplicitEmptyGlossaryTests(unittest.TestCase):
    """L6: an explicitly empty glossary_entries stays empty."""

    def test_empty_runtime_list_is_not_replaced_by_the_config_glossary(self):
        rule = many_entries(1)
        config = core.merge_nested(core.DEFAULT_CONFIG, {
            "world_dir": str(ROOT / "tests"), "dry_run": True, "inherit_translate_py": False,
            "glossary": {"entries": rule},
            "runtime": {"checkpoint_enabled": False, "glossary_entries": []},
            "api": {"provider": "openai", "api_key": "dummy", "model": "m", "base_url": "http://127.0.0.1:9/v1"},
        })
        worker = core.WorldTranslator(config)
        self.assertEqual(worker.runtime_config["glossary_entries"], [])
        self.assertEqual(worker.runtime_config["glossary_hash"], terms.entries_hash([]))
        self.assertEqual(worker.glossary_fingerprint, "")
        batch = core.BatchTranslator(config)
        self.assertEqual(batch.glossary_entries, [])
        self.assertNotIn("Term0", batch.system_prompt(["Term0 here"]))
        del config["runtime"]["glossary_entries"]
        self.assertEqual(core.WorldTranslator(config).runtime_config["glossary_entries"], rule, "absent still means: use the config")


class RepositoryContractTests(unittest.TestCase):
    """L3 and L4: no new CI triggers, no placeholder that nothing fills."""

    def test_ci_has_no_webui_trigger_and_no_unused_token_meta(self):
        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        self.assertNotIn("webui/**", workflow)
        self.assertNotIn("__POMI_WEBUI_TOKEN__", (ROOT / "webui/index.html").read_text(encoding="utf-8"))

    def test_new_suite_is_registered_where_every_suite_is(self):
        for path in (".github/workflows/ci.yml", "scripts/verify-local.mjs"):
            self.assertIn("test_merge_review_fixes.py", (ROOT / path).read_text(encoding="utf-8"), path)


class CliRestoreTests(unittest.TestCase):
    """L5: a restore with nothing to restore is a message, not a traceback."""

    def test_missing_backup_is_a_clean_exit(self):
        with tempfile.TemporaryDirectory() as root:
            world, data = Path(root) / "world", Path(root) / "data"
            world.mkdir()
            (world / "level.dat").write_bytes(b"x")
            with self.assertRaises(SystemExit) as raised:
                core.restore_backup_cli({"world_dir": str(world), "runtime": {}}, data)
            self.assertIn("backup", str(raised.exception).lower())


class LevelDatVersionTests(unittest.TestCase):
    """L7: level.dat keeps DataVersion under Data."""

    def test_data_version_is_read_from_the_data_compound(self):
        from tests import test_text_components as tc
        from mwt import nbtio
        wt = tc.translator()
        modern = wt.parse_nbt_bytes(tc.root(tc.w_compound("Data", tc.w_int("DataVersion", tc.MODERN))))
        old = wt.parse_nbt_bytes(tc.root(tc.w_compound("Data", tc.w_int("DataVersion", tc.PRE_1_21_5))))
        none = wt.parse_nbt_bytes(tc.root(tc.w_compound("Data", tc.w_string("LevelName", "w"))))
        self.assertEqual(wt._data_version(modern), tc.MODERN)
        self.assertEqual(wt._data_version(old), tc.PRE_1_21_5)
        self.assertIsNone(wt._data_version(none))
        self.assertIsInstance(modern, nbtio.TAG_Compound)

    def test_quoted_literal_in_a_modern_level_dat_stays_literal(self):
        from tests import test_text_components as tc
        wt = tc.translator()
        sign = [
            tc.w_string("id", "minecraft:oak_sign"), tc.w_int("x", 1), tc.w_int("y", 64), tc.w_int("z", 2),
            tc.w_compound("front_text", tc.w_list_of_strings("messages", [tc.quoted("Quoted literal"), "", "", ""])),
        ]
        _tree, refs = tc.refs_of(wt, tc.root(tc.w_compound("Data", tc.w_int("DataVersion", tc.MODERN),
                                                           tc.w_list_of_compounds("block_entities", [sign]))))
        self.assertEqual({ref.kind for ref in refs}, {"plain_tag"})
        _tree, refs = tc.refs_of(wt, tc.root(tc.w_compound("Data", tc.w_int("DataVersion", tc.PRE_1_21_5),
                                                           tc.w_list_of_compounds("block_entities", [sign]))))
        self.assertEqual({ref.kind for ref in refs}, {"json_string_tag"})


class FinalisationTests(unittest.TestCase):
    """M1: only a run that committed files replaces the record of the write that is in the world."""

    def finish(self, changed_files: list[dict]) -> tuple[str, str]:
        from tests.test_desktop_parity import _synthetic_world
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            world = _synthetic_world(root)
            config = core.normalize_config(core.merge_nested(core.DEFAULT_CONFIG, {
                "world_dir": str(world), "report_path": str(root / "report.json"), "dry_run": False, "inherit_translate_py": False,
                "runtime": {"checkpoint_path": str(root / "job.json"), "keep_checkpoint": True},
                "api": {"provider": "openai", "api_key": "dummy", "model": "m", "base_url": "http://127.0.0.1:9/v1"},
            }), None)
            worker = core.WorldTranslator(config)
            worker.applied = {"backup_set_id": "OLD-SET", "world_fingerprint": "x", "at": 1, "external_pack_fingerprints": {}}
            worker.report["backup_set_id"] = "THIS-RUNS-DISCARDED-SET"
            worker.report["changed_files"] = changed_files
            worker._finish("completed")
            return worker.applied["backup_set_id"], json.loads((root / "job.json").read_text(encoding="utf-8"))["applied"]["backup_set_id"]

    def test_a_run_that_wrote_nothing_keeps_the_earlier_applied_record(self):
        self.assertEqual(self.finish([]), ("OLD-SET", "OLD-SET"))

    def test_a_run_that_committed_a_file_replaces_it(self):
        self.assertEqual(self.finish([{"file": "region/r.0.0.mca", "changed_chunks": 1}]), ("THIS-RUNS-DISCARDED-SET",) * 2)


class ReviewFixTests(review_apply.ReviewApplyTests):
    """The review/apply fixtures again, for the findings that need a whole job."""

    def test_m1_applied_job_is_not_offered_for_resume_and_keeps_its_backup_for_reapply(self):
        self.scan(["Good", "Bad"])

        def failing(values):
            if "Bad" in values.values():
                raise RuntimeError("invalid JSON")
            return {key: "번역 " + value for key, value in values.items()}

        self.behavior = failing
        self.start()
        self.assertEqual(self.ok("translate.apply", **self.identity)["status"], "partial")
        applied = self.job()["applied"]["backup_set_id"]
        self.assertTrue(applied)
        self.behavior = lambda values: {key: "재시도 " + value for key, value in values.items()}
        self.ok("translate.retry_failed", scanPlanId=self.plan["scanPlanId"], apiKey="synthetic-test-key")
        self.assertEqual(self.job()["applied"]["backup_set_id"], applied, "a run that wrote nothing keeps the record of the write")
        self.assertFalse(self.ok("resume.status")["available"], "an applied job is closed work, not a resume banner")
        self.assertEqual(self.ok("app.bootstrap")["resume"].get("available", False), False)
        self.settings(reviewBeforeApply=False)
        self.assertEqual(self.call("translate.resume", apiKey="synthetic-test-key")["type"], "response.error")
        self.assertEqual(self.job()["applied"]["backup_set_id"], applied)
        result = self.ok("translate.reapply", **self.identity)
        self.assertEqual(result["providerRequests"], 0)
        self.assertEqual(self.written(), ["번역 Good", "재시도 Bad"])

    def test_m2_interrupted_reapply_is_found_whichever_checkpoint_is_listed_last(self):
        self.scan(["First", "Second"])
        self.start()  # an ordinary awaiting-review job for the world, saved first
        first_id = self.plan["scanPlanId"]
        other_id = "b" * len(first_id)  # a second scan of this world, as its own saved plan and job
        for source in (entry._scan_plan_path(self.data, first_id), entry._checkpoint_path(self.data, first_id)):
            clone = source.with_name(source.name.replace(first_id, other_id))
            clone.write_text(source.read_text(encoding="utf-8").replace(first_id, other_id), encoding="utf-8")
        self.ok("translate.apply", **self.identity)
        with patch.object(entry, "_run_translator", side_effect=OSError("synthetic gap failure")):
            interrupted = self.call("translate.reapply", **self.identity)
        self.assertEqual(interrupted["error"]["code"], "REAPPLY_INTERRUPTED")
        listed = list((self.data / "jobs").glob("*.checkpoint.json"))
        self.assertEqual(len(listed), 2, "two checkpoints for this world")
        original = Path.glob
        for reverse in (False, True):
            def ordered(path, pattern, *args, **kwargs):
                found = list(original(path, pattern, *args, **kwargs))
                return iter(sorted(found, reverse=reverse)) if pattern == "*.checkpoint.json" else iter(found)

            with self.subTest(reverse=reverse), patch.object(Path, "glob", ordered):
                self.assertEqual(self.ok("resume.status")["status"], "reapply_interrupted")

    def test_m3_glossary_requests_need_the_revision_and_settings_do_not_write_terms(self):
        self.set_glossary("global", [{"source": "Mira", "target": "미라"}])
        revision = self.ok("glossary.get", scope="global")["revision"]
        refused = self.call("glossary.set", scope="global", entries=[])
        self.assertEqual(refused["type"], "response.error")
        self.assertEqual(refused["error"]["code"], "GLOSSARY_INVALID")
        self.assertEqual(self.call("glossary.get")["type"], "response.error", "no second response shape without a scope")
        self.settings(glossary=[])
        document = self.ok("glossary.get", scope="global")
        self.assertEqual((document["revision"], len(document["entries"])), (revision, 1), "settings.set cannot overwrite the glossary")

    def test_l1_a_restore_that_happened_is_not_reported_as_a_failure(self):
        self.scan(["First", "Second"])
        baseline = self.hashes()
        self.start()
        self.ok("translate.apply", **self.identity)
        self.assertNotEqual(self.hashes(), baseline)
        with patch.object(entry, "_settle_reapply_restore", side_effect=entry.RequestRefused("REAPPLY_INTERRUPTED", "cannot verify")):
            restored = self.ok("restore.start")
        self.assertEqual(restored["status"], "restored")
        self.assertEqual(restored["warnings"], ["REAPPLY_INTERRUPTED"])
        self.assertEqual(self.hashes(), baseline, "the files are back")

    def test_l2_a_restore_without_units_does_not_leave_the_reapply_without_a_journal(self):
        self.scan(["First", "Second"])
        self.start()
        self.ok("translate.apply", **self.identity)
        with patch("mwt.safety.BackupSet._restore_units", return_value=[]):
            response = self.call("translate.reapply", **self.identity)
        self.assertNotEqual(response.get("error", {}).get("code"), "OPERATION_FAILED", response)
        journal = entry._reapply_journal(self.data, self.plan["scanPlanId"])
        self.assertTrue(journal and journal.get("recoverySetId") == "", "the phase is journaled even without a recovery set")

    def test_l10_the_world_folder_only_ever_gets_the_write_lock(self):
        self.scan(["First", "Second"])
        before = self.hashes()
        self.start()
        self.ok("translate.apply", **self.identity)
        self.ok("restore.start")
        self.assertEqual(self.hashes(), before)
        extra = sorted(path.relative_to(self.world).as_posix() for path in self.world.rglob("*")
                       if path.is_file() and path.relative_to(self.world).parts[0] in {".pomi-translate", ".pomi-backups"})
        self.assertEqual(extra, [".pomi-translate/write.lock"])


# Only the findings of this file run in ReviewFixTests; the inherited suite is review_apply's own.
for _name in dir(review_apply.ReviewApplyTests):
    if _name.startswith("test_") and not hasattr(ReviewFixTests.__dict__.get(_name), "__call__"):
        setattr(ReviewFixTests, _name, None)

if __name__ == "__main__":
    unittest.main(verbosity=1)
