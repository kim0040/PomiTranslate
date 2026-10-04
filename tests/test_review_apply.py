"""Desktop review/apply safety contracts, using synthetic NBT and an in-process provider only."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mc_world_translator as core
from llm_backends import LLMProviderClient, ProviderError
from mwt import desktop_entry as entry
from mwt.region import RegionFile
from mwt.safety import BackupSet, backup_store, file_sha256, world_fingerprint
from mwt.userdata import load_user_settings
from tests.test_desktop_parity import _synthetic_world
from tests.test_release_fixtures import compound, nbt_bytes, string, write_region


class ReviewApplyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="pomi-review-apply-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.world = _synthetic_world(self.root)
        self.data = self.root / "data"
        self.events = []
        self.calls = []
        self.behavior = lambda values: {key: "번역 " + value for key, value in values.items()}
        self.cost = None
        self.cancel = self.root / "cancel"
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {key: "" for key in (
            "POMI_API_KEY", "POMI_API_BASE", "POMI_PROVIDER", "POMI_MODEL", "POMI_WIRE_FORMAT",
            "POMI_TARGET_LANGUAGE", "POMI_STYLE_PRESET",
        )}).start()
        patch("mwt.secrets.load_api_key", side_effect=AssertionError("keychain must not be accessed")).start()
        patch.object(LLMProviderClient, "try_refresh_text_models", return_value=None).start()
        test = self

        def translate(_client, values, **kwargs):
            test.calls.append(list(values.values()))
            LLMProviderClient.request_count += 1
            usage = {"prompt_tokens": 100, "completion_tokens": 50}
            if test.cost is not None:
                usage["cost"] = test.cost
            LLMProviderClient.record_usage({"usage": usage})
            return test.behavior(values)

        patch.object(LLMProviderClient, "translate_mapping", new=translate).start()
        # No model-catalog GET, paid call, or other HTTP is permitted by this suite.
        patch("llm_backends.request.urlopen", side_effect=AssertionError("network disabled")).start()
        self.settings(provider="openai", model="fixture-model", batchSize=1, concurrency=1, maxBatchRetries=1)

    def call(self, kind, **body):
        replies = []
        with patch.object(entry, "emit", side_effect=replies.append):
            entry.dispatch(json.dumps({"v": 1, "id": "review-test", "type": kind, "payload": {
                "worldDir": str(self.world), "credentialOwner": "rust", **body,
            }}), self.data / "reports", self.data, self.cancel)
        self.events.extend(item for item in replies if item["type"].endswith(".progress"))
        self.assertTrue(replies)
        return replies[-1]

    def ok(self, kind, **body):
        response = self.call(kind, **body)
        self.assertEqual(response["type"], "response.ok", response)
        return response["payload"]

    def settings(self, **values):
        return self.ok("settings.set", **values)["settings"]

    def scan(self, texts=None):
        if texts is not None:
            write_region(self.world / "region" / "r.0.0.mca", {
                index: (2, nbt_bytes(compound("sign", string("Text1", json.dumps({"text": text})))), False)
                for index, text in enumerate(texts)
            })
        self.plan = self.ok("scan.start")
        self.ids = {row["source"]: row["id"] for row in self.plan["candidates"]}
        self.identity = {"scanPlanId": self.plan["scanPlanId"], "fingerprint": self.plan["fingerprint"]}
        return self.plan

    def start(self, **extra):
        return self.ok("translate.start", **self.identity, apiKey="synthetic-test-key", **extra)

    def page(self, **extra):
        return self.ok("translations.page", scanPlanId=self.plan["scanPlanId"], **extra)

    def job(self):
        return entry._load_job(self.data, self.plan["scanPlanId"], self.world)

    def hashes(self):
        return {path.relative_to(self.world).as_posix(): file_sha256(path)
                for path in self.world.rglob("*") if path.is_file()}

    def written(self):
        region = RegionFile.read(self.world / "region" / "r.0.0.mca")
        return [json.loads(core.WorldTranslator.parse_nbt_bytes(chunk.raw_nbt)["sign"]["Text1"].value)["text"]
                for chunk in region.chunks if not chunk.empty]

    def verified_backup(self, backup_id, original_region):
        backup = BackupSet.find(self.world, backup_id, [backup_store(self.world, self.data)])
        manifest = json.loads(backup.manifest_path.read_text())
        self.assertTrue(manifest["verified"])
        self.assertEqual((backup.root / "region/r.0.0.mca").read_bytes(), original_region)
        for row in manifest["files"]:
            if row.get("restoreAction") != "remove_created":
                self.assertEqual(file_sha256(backup.root / row["path"]), row["sha256"])
        return backup

    def test_default_review_writes_nothing_and_creates_no_backup(self):
        self.scan(["Hello sign", "Second sign"])
        before = self.hashes()
        result = self.start()
        self.assertEqual(result["status"], "awaiting_review")
        self.assertEqual(result["changedFileCount"], 0)
        self.assertFalse(result["backupSetId"])
        self.assertEqual(self.hashes(), before)
        self.assertFalse(backup_store(self.world, self.data).exists())
        self.assertEqual(len(self.job()["translation_cache"]), 2)
        resume = self.ok("resume.status")
        self.assertTrue(resume["available"])
        self.assertEqual(resume["status"], "awaiting_review")
        bootstrap = self.ok("app.bootstrap")
        self.assertEqual(bootstrap["resume"]["status"], "awaiting_review")

    def test_glossary_edit_blocks_apply_then_refreshes_only_affected_rows_without_a_new_scan(self):
        self.scan(["Elder Mira arrives", "Other row"])
        self.start()
        before = self.hashes()
        plan_id = self.plan["scanPlanId"]
        glossary = [{"source": "Elder Mira", "target": "장로 미라", "mode": "translate", "note": "", "caseSensitive": False}]
        self.ok("glossary.set", scope="world", world=str(self.world), entries=glossary)
        page = self.page()
        self.assertEqual(page["meta"]["glossaryStaleCount"], 1)
        self.assertEqual([row["source"] for row in page["rows"] if row["glossaryStale"]], ["Elder Mira arrives"])
        refused = self.call("translate.apply", **self.identity)
        self.assertEqual(refused["error"]["code"], "GLOSSARY_CHANGED")
        self.assertEqual(self.hashes(), before)
        self.assertFalse(backup_store(self.world, self.data).exists())
        self.calls.clear()
        self.behavior = lambda values: {key: "장로 미라 등장" for key in values}
        refreshed = self.ok("translate.retry_failed", scanPlanId=plan_id, refreshGlossary=True, apiKey="synthetic-test-key")
        self.assertEqual(refreshed["status"], "awaiting_review")
        self.assertEqual(self.calls, [["Elder Mira arrives"]])
        self.assertEqual(self.page()["meta"]["glossaryStaleCount"], 0)
        self.assertEqual(self.job()["translation_cache"]["Other row"], "번역 Other row")
        self.assertEqual(self.hashes(), before)
        self.assertTrue(entry._load_scan_plan(self.data, plan_id))
        self.ok("translate.apply", **self.identity)
        self.assertEqual(self.written(), ["장로 미라 등장", "번역 Other row"])

    def test_settings_glossary_edit_and_removal_are_guarded_in_the_same_session(self):
        glossary = [{"source": "Elder Mira", "target": "장로 미라", "mode": "translate", "note": "", "caseSensitive": False}]
        self.settings(glossary=glossary)
        self.scan(["Elder Mira"])
        self.behavior = lambda values: {key: "장로 미라" for key in values}
        self.start()
        before = self.hashes()
        self.settings(glossary=[])
        self.assertEqual(self.call("translate.apply", **self.identity)["error"]["code"], "GLOSSARY_CHANGED")
        self.assertEqual(self.page()["meta"]["glossaryStaleCount"], 1)
        self.assertEqual(self.hashes(), before)
        self.behavior = lambda values: {key: "미라 장로" for key in values}
        self.ok("translate.retry_failed", scanPlanId=self.plan["scanPlanId"], apiKey="synthetic-test-key")
        self.assertEqual(self.page()["meta"]["glossaryStaleCount"], 0)
        self.ok("translate.apply", **self.identity)
        self.assertEqual(self.written(), ["미라 장로"])

    def test_legacy_job_without_glossary_snapshot_refuses_removal(self):
        self.settings(glossary=[{"source": "Elder Mira", "target": "미라"}])
        self.scan(["Elder Mira"])
        self.behavior = lambda values: {key: "미라" for key in values}
        self.start()
        job = self.job()
        job["resume"].pop("glossary_hash")
        job["resume"].pop("glossary_row_hashes")
        entry._checkpoint_path(self.data, self.plan["scanPlanId"]).write_text(json.dumps(job))
        self.settings(glossary=[])
        self.assertEqual(self.call("translate.apply", **self.identity)["error"]["code"], "GLOSSARY_CHANGED")

    def test_glossary_edit_before_reapply_refuses_before_any_restore(self):
        self.scan(["Elder Mira"])
        self.start()
        self.ok("translate.apply", **self.identity)
        before = self.hashes()
        self.ok("glossary.set", scope="global", entries=[{"source": "Elder Mira", "target": "미라", "mode": "translate"}])
        with patch.object(entry, "_restore_backup", side_effect=AssertionError("no restore before glossary check")):
            refused = self.call("translate.reapply", **self.identity)
        self.assertEqual(refused["error"]["code"], "GLOSSARY_CHANGED")
        self.assertEqual(self.hashes(), before)
        self.behavior = lambda values: {key: "미라" for key in values}
        self.ok("translate.retry_failed", scanPlanId=self.plan["scanPlanId"], refreshGlossary=True, apiKey="synthetic-test-key")
        self.assertTrue(self.page()["meta"]["glossaryRefreshed"])
        self.ok("translate.reapply", **self.identity)
        self.assertEqual(self.written(), ["미라"])

    def test_unused_glossary_edit_does_not_block_apply_and_mismatch_requires_warning_acknowledgment(self):
        self.scan(["Elder Mira"])
        self.start()
        self.ok("glossary.set", scope="global", entries=[{"source": "Unused", "target": "미사용"}])
        self.assertEqual(self.page()["meta"]["glossaryStaleCount"], 0)
        self.ok("translate.apply", **self.identity)
        self.scan(["Elder Mira"])
        self.ok("glossary.set", scope="global", entries=[{"source": "Elder Mira", "target": "미라"}])
        self.start()
        before = self.hashes()
        self.assertEqual(self.page(state="glossary_mismatch")["total"], 1)
        self.assertEqual(self.call("translate.apply", **self.identity)["error"]["code"], "GLOSSARY_MISMATCH_UNCONFIRMED")
        self.assertEqual(self.hashes(), before)
        self.ok("translate.apply", **self.identity, acknowledgeGlossaryMismatch=True)

    def test_malformed_glossary_requests_are_atomically_rejected(self):
        self.ok("glossary.set", scope="global", entries=[{"source": "Mira", "target": "미라"}])
        saved = load_user_settings(self.data)
        for scope in [None, {}, [], True, "unknown"]:
            refused = self.call("glossary.set", scope=scope, entries=[])
            self.assertEqual(refused["error"]["code"], "INVALID_REQUEST")
        for entries in [None, {}, "wrong", [None], [{"source": "Mira", "target": "미라", "mode": []}], [{"source": "Mira", "target": "미라", "caseSensitive": "false"}]]:
            refused = self.call("glossary.set", scope="global", entries=entries)
            self.assertEqual(refused["error"]["code"], "GLOSSARY_INVALID")
            self.assertIn("rows", refused["error"]["details"])
        self.assertEqual(load_user_settings(self.data), saved)

    def test_manual_only_still_awaits_review_by_default(self):
        self.scan()
        before = self.hashes()
        result = self.start(candidateOverrides={self.ids["Hello sign"]: "직접 번역"})
        self.assertEqual(result["status"], "awaiting_review")
        self.assertEqual(result["providerRequests"], 0)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.hashes(), before)

    def test_paging_query_and_all_state_filters(self):
        self.scan(["Alpha", "Beta", "Gamma", "Delta"])
        def response(values):
            text = next(iter(values.values()))
            if text == "Beta":
                raise RuntimeError("invalid JSON")
            return {key: value if value == "Gamma" else "번역 " + value for key, value in values.items()}
        self.behavior = response
        self.start(candidateOverrides={self.ids["Delta"]: "직접"})
        page = self.page(offset=1, limit=2)
        self.assertEqual(page["total"], 4)
        self.assertEqual(len(page["rows"]), 2)
        self.assertTrue(page["hasMore"])
        self.assertEqual(page["counts"], {"all": 4, "translated": 1, "failed": 1, "kept": 1, "edited": 1, "unsent": 0, "errored": 1, "glossary_mismatch": 0})
        for state, expected in {"translated": "Alpha", "failed": "Beta", "kept": "Gamma", "edited": "Delta"}.items():
            row = self.page(state=state)["rows"]
            self.assertEqual(len(row), 1)
            self.assertEqual(row[0]["source"], expected)
        self.assertEqual(self.page(query="ALPHA")["total"], 1)
        self.assertEqual(self.page(query="직접")["total"], 1)
        self.assertEqual(self.page(offset=10)["rows"], [])
        self.assertEqual(self.page(state="failed")["rows"][0]["reason"], "invalid_response")

    def test_apply_edits_uses_no_provider_and_verifies_backup_before_write(self):
        self.scan(["Hello %s", "Hello second"])
        original = (self.world / "region/r.0.0.mca").read_bytes()
        self.start()
        paid_calls = len(self.calls)
        real_write = core.WorldTranslator._write_world_bytes
        checks = []
        test = self
        def guarded_write(translator, path, content):
            test.verified_backup(translator.report["backup_set_id"], original)
            checks.append(path)
            return real_write(translator, path, content)
        with patch.object(core.WorldTranslator, "_write_world_bytes", new=guarded_write):
            result = self.ok("translate.apply", **self.identity, edits={self.ids["Hello %s"]: "수정 %s"})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["providerRequests"], 0)
        self.assertEqual(LLMProviderClient.request_count, 0)
        self.assertEqual(len(self.calls), paid_calls)
        self.assertTrue(checks)
        self.assertEqual(self.written(), ["수정 %s", "번역 Hello second"])
        self.verified_backup(result["backupSetId"], original)
        self.assertTrue(self.job()["applied"])
        self.assertEqual(self.page(state="edited")["rows"][0]["translated"], "수정 %s")

    def test_invalid_edits_reject_every_bad_row_before_any_backup(self):
        self.scan(["Hello %s", "§6Gold", "Third", "Fourth"])
        self.start()
        before = self.hashes()
        response = self.call("translate.apply", **self.identity, edits={
            self.ids["Hello %s"]: "깨진 번역", self.ids["§6Gold"]: "§6금§6", self.ids["Third"]: " ",
            self.ids["Fourth"]: "x" * 32001,
        })
        self.assertEqual(response["error"]["code"], "EDITS_INVALID")
        self.assertEqual({row["reason"] for row in response["error"]["details"]["rows"]}, {"tokens", "empty", "too_long"})
        self.assertEqual(len(response["error"]["details"]["rows"]), 4)
        self.assertEqual(self.hashes(), before)
        self.assertFalse(backup_store(self.world, self.data).exists())

    def test_trailing_reset_uses_same_normalization_as_ai(self):
        self.scan(["§6Gold"])
        self.start()
        result = self.ok("translate.apply", **self.identity, edits={self.ids["§6Gold"]: "§6금§r"})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.written(), ["§6금"])

    def test_unchanged_ai_with_surplus_trailing_reset_is_kept(self):
        self.scan(["§6Gold"])
        self.behavior = lambda values: {key: value + "§r" for key, value in values.items()}
        self.start()
        self.assertEqual(self.page(state="failed")["total"], 0)
        self.assertEqual(self.page(state="kept")["total"], 1)
        self.assertNotIn("reason", self.page(state="kept")["rows"][0])

    def test_retry_only_sends_failed_rows_and_preserves_successful_rows(self):
        self.scan(["First", "Failed", "Third"])
        def fail(values):
            if "Failed" in values.values():
                raise TimeoutError("synthetic timeout")
            return {key: "번역 " + value for key, value in values.items()}
        self.behavior = fail
        self.start()
        before = self.hashes()
        self.assertEqual(self.page(state="failed")["total"], 1)
        self.behavior = lambda values: {key: "재시도 " + value for key, value in values.items()}
        self.calls.clear()
        result = self.ok("translate.retry_failed", scanPlanId=self.plan["scanPlanId"], apiKey="synthetic-test-key")
        self.assertEqual(result["status"], "awaiting_review")
        self.assertEqual(result["providerRequests"], 1)
        self.assertEqual(self.calls, [["Failed"]])
        self.assertEqual(self.hashes(), before)
        self.assertEqual(self.page(state="failed")["total"], 0)
        self.assertEqual(self.job()["translation_cache"]["First"], "번역 First")
        self.assertEqual(result["usage"]["prompt_tokens"], 400)
        # This call sent one request; the job, whose tokens are summed above, sent all of them.
        self.assertEqual(result["jobProviderRequests"], 4)
        self.assertEqual(result["usage"]["requests"], 4)

    def test_reapply_restores_own_backup_and_recovery_preserves_applied_bytes(self):
        self.scan(["First", "Second"])
        original = (self.world / "region/r.0.0.mca").read_bytes()
        self.start()
        applied = self.ok("translate.apply", **self.identity)
        applied_bytes = (self.world / "region/r.0.0.mca").read_bytes()
        paid_calls = len(self.calls)
        observed = []
        restore = entry._restore_backup
        def restore_first(*args, **kwargs):
            result = restore(*args, **kwargs)
            self.assertEqual((self.world / "region/r.0.0.mca").read_bytes(), original)
            observed.append(result)
            return result
        with patch.object(entry, "_restore_backup", side_effect=restore_first):
            result = self.ok("translate.reapply", **self.identity, edits={self.ids["First"]: "수정"})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["providerRequests"], 0)
        self.assertEqual(len(self.calls), paid_calls)
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0][0].backup_id, applied["backupSetId"])
        recovery = self.verified_backup(result["recoverySetId"], applied_bytes)
        self.assertTrue(recovery.backup_id.endswith("-recovery"))
        self.verified_backup(result["backupSetId"], original)
        self.assertEqual(self.written(), ["수정", "번역 Second"])
        self.ok("restore.start", backupSetId=result["backupSetId"])
        self.assertEqual((self.world / "region/r.0.0.mca").read_bytes(), original)

    def test_reapply_refuses_changed_world_without_restore(self):
        self.scan()
        self.start()
        self.ok("translate.apply", **self.identity)
        (self.world / "level.dat").write_bytes(b"synthetic player changed world")
        before = self.hashes()
        with patch.object(BackupSet, "restore", side_effect=AssertionError("must not restore")):
            refused = self.call("translate.reapply", **self.identity)
        self.assertEqual(refused["error"]["code"], "WORLD_CHANGED_SINCE_APPLY")
        self.assertEqual(self.hashes(), before)

    def test_apply_refuses_changed_world_and_preserves_job(self):
        self.scan()
        self.start()
        checkpoint = entry._checkpoint_path(self.data, self.plan["scanPlanId"])
        saved = checkpoint.read_bytes()
        (self.world / "level.dat").write_bytes(b"synthetic change")
        before = self.hashes()
        result = self.ok("translate.apply", **self.identity)
        self.assertEqual(result["status"], "invalidated")
        self.assertEqual(self.hashes(), before)
        self.assertEqual(checkpoint.read_bytes(), saved)

    def test_retry_after_apply_still_requires_reapply(self):
        self.scan(["Good", "Bad"])
        self.behavior = lambda values: ({key: "번역 " + value for key, value in values.items()}
                                      if "Bad" not in values.values() else {})
        # Missing entries are a failed provider reply, not a deliberate unchanged translation.
        def failing(values):
            if "Bad" in values.values():
                raise RuntimeError("invalid JSON")
            return {key: "번역 " + value for key, value in values.items()}
        self.behavior = failing
        self.start()
        result = self.ok("translate.apply", **self.identity)
        self.assertEqual(result["status"], "partial")
        self.behavior = lambda values: {key: "재시도 " + value for key, value in values.items()}
        self.ok("translate.retry_failed", scanPlanId=self.plan["scanPlanId"], apiKey="synthetic-test-key")
        self.assertTrue(self.page()["meta"]["applied"])
        self.assertEqual(self.call("translate.apply", **self.identity)["error"]["code"], "ALREADY_APPLIED")
        result = self.ok("translate.reapply", **self.identity)
        self.assertEqual(result["providerRequests"], 0)
        self.assertGreater(result["jobProviderRequests"], 0)
        self.assertEqual(result["jobProviderRequests"], result["usage"]["requests"])
        self.assertEqual(self.written(), ["번역 Good", "재시도 Bad"])

    def test_budget_provider_cost_stops_keeps_checkpoint_and_resumes_pending_only(self):
        self.settings(maxCostUsd=0.05)
        self.scan(["First", "Second", "Third"])
        before = self.hashes()
        self.cost = 0.05
        result = self.start()
        self.assertEqual(result["status"], "budget_stopped")
        self.assertEqual(result["providerRequests"], 1)
        self.assertEqual(self.hashes(), before)
        self.assertEqual(len(self.job()["translation_cache"]), 1)
        self.assertEqual(self.ok("resume.status")["status"], "budget_stopped")
        # Rows the cap kept from being sent are their own kind: not failures, but a retry sends them.
        stopped = self.page(state="failed")
        self.assertEqual({row["reason"] for row in stopped["rows"]}, {"budget_unsent"})
        self.assertEqual([row["detail"] for row in stopped["rows"]], ["", ""])
        self.assertEqual(stopped["counts"]["unsent"], 2)
        self.assertEqual(stopped["counts"]["errored"], 0)
        self.assertEqual(self.page(state="errored")["total"], 0)
        self.assertEqual(self.page(state="unsent")["total"], 2)
        self.assertEqual(stopped["meta"]["unsentCount"], 2)
        self.assertEqual(stopped["meta"]["failedCount"], 2)
        self.assertEqual(result["translation"]["failed"], 0)
        self.assertEqual(result["translation"]["pending"], 2)
        self.settings(maxCostUsd=0)
        self.calls.clear()
        resumed = self.ok("translate.resume", apiKey="synthetic-test-key")
        self.assertEqual(resumed["providerRequests"], 2)
        self.assertEqual(resumed["jobProviderRequests"], 3)
        self.assertEqual(resumed["status"], "awaiting_review")
        self.assertEqual(self.calls, [["Second"], ["Third"]])
        self.assertAlmostEqual(resumed["usage"]["cost"], 0.15)
        self.assertEqual(self.hashes(), before)

    def test_token_estimated_budget_and_one_run_override(self):
        self.settings(maxCostUsd=0.05)
        self.scan(["First", "Second"])
        with patch.object(entry, "_model_price", return_value={"input": .001, "output": .001}):
            result = self.start()
        self.assertEqual(result["status"], "budget_stopped")
        self.assertFalse(result["usage"]["cost_reported"])
        self.scan()
        self.calls.clear()
        with patch.object(entry, "_model_price", return_value={"input": .001, "output": .001}):
            result = self.start(budgetDisabled=True)
        self.assertEqual(result["status"], "awaiting_review")
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(load_user_settings(self.data)["max_cost_usd"], 0.05)

    def test_estimate_override_keeps_cap_and_disabled_is_one_run_on_start_resume_and_retry(self):
        self.settings(maxCostUsd=0.05)
        self.scan(["First", "Second", "Third"])
        baseline = self.hashes()
        self.cost = 0.05
        capped = self.start(budgetOverride=True)
        self.assertEqual(capped["status"], "budget_stopped")
        self.assertEqual(capped["providerRequests"], 1)
        self.assertAlmostEqual(capped["usage"]["cost"], 0.05)
        self.calls.clear()
        uncapped = self.start(budgetDisabled=True)
        self.assertEqual(uncapped["status"], "awaiting_review")
        self.assertEqual(uncapped["providerRequests"], 3)
        self.assertAlmostEqual(uncapped["usage"]["cost"], 0.15)
        self.assertEqual(self.calls, [["First"], ["Second"], ["Third"]])
        self.assertEqual(load_user_settings(self.data)["max_cost_usd"], 0.05)
        self.start(budgetOverride=True)
        resumed = self.ok("translate.resume", apiKey="synthetic-test-key", budgetDisabled=True)
        self.assertEqual(resumed["status"], "awaiting_review")
        self.assertEqual(resumed["providerRequests"], 2)
        self.start()
        retry = self.ok("translate.retry_failed", scanPlanId=self.plan["scanPlanId"],
                        apiKey="synthetic-test-key", budgetOverride=True)
        self.assertEqual(retry["status"], "budget_stopped")
        self.assertEqual(retry["providerRequests"], 1)
        retry = self.ok("translate.retry_failed", scanPlanId=self.plan["scanPlanId"],
                        apiKey="synthetic-test-key", budgetDisabled=True)
        self.assertEqual(retry["status"], "awaiting_review")
        self.assertEqual(self.hashes(), baseline)
        self.assertEqual(load_user_settings(self.data)["max_cost_usd"], 0.05)
        for kind in ("translate.start", "translate.resume", "translate.retry_failed"):
            refused = self.call(kind, **self.identity, apiKey="synthetic-test-key", budgetDisabled="true")
            self.assertEqual(refused["error"]["code"], "INVALID_REQUEST")

    def test_retry_metadata_estimates_exact_stale_failed_union_and_refresh_only(self):
        self.scan(["Mira", "Failed"])
        baseline = self.hashes()
        def fail(values):
            if "Failed" in values.values():
                raise RuntimeError("invalid JSON")
            return {key: "미라" for key in values}
        self.behavior = fail
        self.start()
        self.ok("glossary.set", scope="world", world=str(self.world), entries=[{"source": "Mira", "target": "미라"}])
        meta = self.page()["meta"]
        self.assertEqual(meta["failedCount"], 1)
        self.assertEqual(meta["retryCount"], 2)
        self.assertEqual(meta["retryEstimate"]["candidateCount"], 2)
        self.assertEqual(meta["retryEstimate"]["requests"], 2)
        self.assertEqual(meta["retryEstimate"]["requestRange"], {"low": 2, "high": 3})
        self.assertEqual(meta["glossaryRefreshCount"], 1)
        self.assertEqual(meta["glossaryRefreshEstimate"]["candidateCount"], 1)
        self.calls.clear()
        self.behavior = lambda values: {key: "미라" if value == "Mira" else "실패 문장" for key, value in values.items()}
        self.ok("translate.retry_failed", scanPlanId=self.plan["scanPlanId"], apiKey="synthetic-test-key")
        self.assertEqual(self.calls, [["Mira"], ["Failed"]])
        self.assertEqual(self.hashes(), baseline)
        meta = self.page()["meta"]
        self.assertEqual(meta["retryCount"], 0)
        self.assertIsNone(meta["retryEstimate"])
        self.assertEqual(meta["glossaryRefreshCount"], 0)
        self.assertIsNone(meta["glossaryRefreshEstimate"])

    def test_world_glossary_estimate_get_counts_each_selected_batch_without_transmission(self):
        self.scan(["Mira arrives", "Mira returns", "Other row"])
        baseline = self.hashes()
        before = self.ok("estimate.get", scanPlanId=self.plan["scanPlanId"])
        glossary = [{"source": "Mira", "target": "가" * 500}]
        self.ok("glossary.set", scope="world", world=str(self.world), entries=glossary)
        after = self.ok("estimate.get", scanPlanId=self.plan["scanPlanId"])
        self.assertGreater(after["inputTokens"], before["inputTokens"])
        self.assertEqual(after["requestRange"], {"low": 3, "high": 5})
        selected = self.ok("estimate.get", scanPlanId=self.plan["scanPlanId"],
                           excludedCandidateIds=[self.ids["Mira returns"]])
        self.assertEqual(selected["requestRange"], {"low": 2, "high": 3})
        self.assertEqual(after["glossaryPromptChars"], selected["glossaryPromptChars"] * 2)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.hashes(), baseline)

    def test_saved_edited_mismatch_keeps_origin_flag_even_with_a_draft_and_reverts(self):
        self.settings(glossary=[{"source": "Mira", "target": "미라"}])
        self.scan(["Mira"])
        self.behavior = lambda values: {key: "미라" for key in values}
        self.start()
        self.ok("translate.apply", **self.identity, edits={self.ids["Mira"]: "별칭"}, acknowledgeGlossaryMismatch=True)
        row = self.page()["rows"][0]
        self.assertEqual(row["status"], "glossary_mismatch")
        self.assertTrue(row["edited"])
        self.assertTrue(row["glossaryMismatch"])
        drafted = self.page(draftIds=[row["id"]])["rows"][0]
        self.assertEqual(drafted["status"], "edited")
        self.assertTrue(drafted["edited"])
        self.assertTrue(drafted["glossaryMismatch"])
        self.ok("translate.reapply", **self.identity, edits={row["id"]: None})
        reverted = self.page()["rows"][0]
        self.assertFalse(reverted["edited"])
        self.assertFalse(reverted["glossaryMismatch"])
        self.assertEqual(self.written(), ["미라"])

    def test_reapply_gap_failure_is_restart_visible_and_second_reapply_uses_baseline(self):
        self.scan(["First", "Second"])
        baseline = self.hashes()
        original = (self.world / "region/r.0.0.mca").read_bytes()
        self.start()
        self.ok("translate.apply", **self.identity)
        applied_hashes = self.hashes()
        applied_bytes = (self.world / "region/r.0.0.mca").read_bytes()
        with patch.object(entry, "_run_translator", side_effect=OSError("synthetic gap failure")):
            response = self.call("translate.reapply", **self.identity, edits={self.ids["First"]: "수정"})
        self.assertEqual(response["error"]["code"], "REAPPLY_INTERRUPTED")
        recovery_id = response["error"]["details"]["recoverySetId"]
        self.assertEqual(self.hashes(), baseline)
        self.verified_backup(recovery_id, applied_bytes)
        # Every read reloads disk, as a newly launched sidecar would, with no in-memory job.
        self.assertEqual(self.job()["report"]["status"], "reapply_interrupted")
        self.assertIsNone(self.job()["applied"])
        self.assertEqual(self.page()["meta"]["status"], "reapply_interrupted")
        self.assertEqual(self.page()["meta"]["recoverySetId"], recovery_id)
        self.assertEqual(self.ok("resume.status")["status"], "reapply_interrupted")
        self.assertEqual(self.ok("resume.status")["recoverySetId"], recovery_id)
        self.assertEqual(self.call("translate.resume")["error"]["code"], "REAPPLY_INTERRUPTED")
        self.assertEqual(self.call("translate.start", **self.identity)["error"]["code"], "REAPPLY_INTERRUPTED")
        self.assertEqual(self.call("translate.retry_failed", scanPlanId=self.plan["scanPlanId"])["error"]["code"], "REAPPLY_INTERRUPTED")
        result = self.ok("translate.reapply", **self.identity)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["recoverySetId"], recovery_id)
        self.assertEqual(self.written(), ["수정", "번역 Second"])
        self.verified_backup(result["backupSetId"], original)
        self.ok("restore.start", backupSetId=recovery_id)
        self.assertEqual(self.hashes(), applied_hashes)

    def test_reapply_partial_write_failure_keeps_recovery_and_refuses_nonbaseline_retry(self):
        self.scan(["First"])
        write_region(self.world / "region/r.1.0.mca", {0: (2, nbt_bytes(compound("sign", string("Text1", '{"text":"Second"}'))), False)})
        self.scan()
        baseline = self.hashes()
        self.start()
        self.ok("translate.apply", **self.identity)
        applied = self.hashes()
        write = core.WorldTranslator._write_world_bytes
        written = []
        def fail_second(writer, path, content):
            written.append(path)
            if len(written) == 2:
                raise OSError("synthetic partial-write failure")
            return write(writer, path, content)
        with patch.object(core.WorldTranslator, "_write_world_bytes", new=fail_second):
            response = self.call("translate.reapply", **self.identity, edits={self.ids["First"]: "수정"})
        self.assertEqual(response["error"]["code"], "REAPPLY_INTERRUPTED")
        self.assertEqual(len(written), 2)
        self.assertNotEqual(self.hashes(), baseline)
        self.assertNotEqual(self.hashes(), applied)
        recovery_id = response["error"]["details"]["recoverySetId"]
        self.assertEqual(self.ok("resume.status")["status"], "reapply_interrupted")
        before = self.hashes()
        self.assertEqual(self.call("translate.reapply", **self.identity)["error"]["code"], "WORLD_CHANGED_SINCE_APPLY")
        self.assertEqual(self.hashes(), before)
        self.ok("restore.start", backupSetId=recovery_id)
        self.assertEqual(self.hashes(), applied)
        self.assertTrue(self.page()["meta"]["applied"])
        self.ok("translate.reapply", **self.identity, edits={self.ids["First"]: "수정"})
        self.assertEqual(self.written(), ["수정"])

    def test_reapply_crash_after_restore_survives_old_checkpoint_on_restart(self):
        self.scan(["First", "Second"])
        baseline = self.hashes()
        self.start()
        self.ok("translate.apply", **self.identity)
        old_checkpoint = entry._checkpoint_path(self.data, self.plan["scanPlanId"]).read_bytes()
        applied = self.hashes()
        with patch.object(entry, "_run_translator", side_effect=SystemExit("synthetic process death")):
            with self.assertRaises(SystemExit):
                self.call("translate.reapply", **self.identity)
        self.assertEqual(self.hashes(), baseline)
        self.assertEqual(entry._checkpoint_path(self.data, self.plan["scanPlanId"]).read_bytes(), old_checkpoint)
        self.assertEqual(self.job()["report"]["status"], "reapply_interrupted")
        resume = self.ok("resume.status")
        self.assertEqual(resume["status"], "reapply_interrupted")
        self.ok("restore.start", backupSetId=resume["recoverySetId"])
        self.assertEqual(self.hashes(), applied)
        self.assertTrue(self.page()["meta"]["applied"])

    def test_reapply_crash_after_partial_write_survives_core_checkpoint_replacement(self):
        self.scan(["First"])
        write_region(self.world / "region/r.1.0.mca", {0: (2, nbt_bytes(compound("sign", string("Text1", '{"text":"Second"}'))), False)})
        self.scan()
        self.start()
        self.ok("translate.apply", **self.identity)
        applied = self.hashes()
        write = core.WorldTranslator._write_world_bytes
        attempted = []
        crashed = []
        def crash_second(writer, path, content):
            attempted.append(path)
            if len(attempted) == 2:
                crashed.append(writer)
                raise SystemExit("synthetic process death during write")
            return write(writer, path, content)
        with patch.object(core.WorldTranslator, "_write_world_bytes", new=crash_second):
            with self.assertRaises(SystemExit):
                self.call("translate.reapply", **self.identity, edits={self.ids["First"]: "수정"})
        # The real process's death releases OS session locks; this in-process simulation must
        # release only its synthetic-world locks before acting as the restarted sidecar.
        crashed[0].release_write_lock()
        raw_job = json.loads(entry._checkpoint_path(self.data, self.plan["scanPlanId"]).read_text())
        self.assertTrue(raw_job["completed_region_files"])
        self.assertNotEqual(raw_job["report"]["status"], "reapply_interrupted")
        self.assertEqual(self.job()["report"]["status"], "reapply_interrupted")
        self.assertIsNone(self.job()["applied"])
        self.assertEqual(self.page()["meta"]["status"], "reapply_interrupted")
        resume = self.ok("resume.status")
        self.assertEqual(resume["status"], "reapply_interrupted")
        self.ok("restore.start", backupSetId=resume["recoverySetId"])
        self.assertEqual(self.hashes(), applied)

    def test_reapply_cancel_after_restore_returns_interrupted_with_recovery(self):
        self.scan(["First", "Second"])
        self.start()
        self.ok("translate.apply", **self.identity)
        applied = self.hashes()
        self.cancel.write_text("synthetic cancellation")
        response = self.call("translate.reapply", **self.identity)
        self.assertEqual(response["error"]["code"], "REAPPLY_INTERRUPTED")
        self.cancel.unlink()
        self.ok("restore.start", backupSetId=response["error"]["details"]["recoverySetId"])
        self.assertEqual(self.hashes(), applied)

    def test_reapply_failure_to_commit_completion_keeps_recovery_after_successful_writes(self):
        self.scan(["First", "Second"])
        self.start()
        self.ok("translate.apply", **self.identity)
        applied = self.hashes()
        durable = entry._durable_json
        def fail_completion(path, value):
            if path == entry._reapply_path(self.data, self.plan["scanPlanId"]) and value.get("phase") == "completed":
                raise OSError("synthetic journal commit failure")
            return durable(path, value)
        with patch.object(entry, "_durable_json", side_effect=fail_completion):
            response = self.call("translate.reapply", **self.identity, edits={self.ids["First"]: "수정"})
        self.assertEqual(response["error"]["code"], "REAPPLY_INTERRUPTED")
        self.assertEqual(self.written(), ["수정", "번역 Second"])
        self.assertEqual(self.job()["report"]["status"], "reapply_interrupted")
        self.ok("restore.start", backupSetId=response["error"]["details"]["recoverySetId"])
        self.assertEqual(self.hashes(), applied)

    def test_reapply_journal_exists_before_first_restore_write_and_partial_restore_is_recoverable(self):
        self.scan(["First"])
        write_region(self.world / "region/r.1.0.mca", {0: (2, nbt_bytes(compound("sign", string("Text1", '{"text":"Second"}'))), False)})
        self.scan()
        self.start()
        self.ok("translate.apply", **self.identity)
        applied = self.hashes()
        replace = os.replace
        attempts = []
        def fail_restore(source, destination):
            target = Path(destination)
            if target.suffix == ".mca" and target.is_relative_to(self.world):
                journal = json.loads(entry._reapply_path(self.data, self.plan["scanPlanId"]).read_text())
                self.assertEqual(journal["phase"], "restoring")
                recovery = BackupSet.open_existing(self.world, journal["recoverySetId"], backup_store(self.world, self.data))
                for row in recovery.entries:
                    if row.get("restoreAction") != "remove_created":
                        self.assertEqual(file_sha256(recovery.root / row["path"]), applied[row["path"]])
                attempts.append(target)
                if len(attempts) == 2:
                    raise OSError("synthetic restore failure")
            return replace(source, destination)
        with patch.object(os, "replace", side_effect=fail_restore):
            response = self.call("translate.reapply", **self.identity)
        self.assertEqual(response["error"]["code"], "REAPPLY_INTERRUPTED")
        self.assertEqual(len(attempts), 2)
        self.assertNotEqual(self.hashes(), applied)
        self.ok("restore.start", backupSetId=response["error"]["details"]["recoverySetId"])
        self.assertEqual(self.hashes(), applied)

    def test_reapply_recovery_removes_new_external_chunk_after_partial_write(self):
        from mwt.region import SECTOR, external_chunk_path
        target = self.world / "region/r.0.0.mca"
        raw = nbt_bytes(compound("sign", string("Text1", '{"text":"Hello sign"}')))
        name = b"Padding"
        count = 255 * SECTOR - 5 - 32 - len(raw) - (1 + 2 + len(name) + 4)
        raw = raw[:-1] + b"\x07" + len(name).to_bytes(2, "big") + name + count.to_bytes(4, "big") + bytes(count) + raw[-1:]
        write_region(target, {0: (3, raw, False)})
        self.scan()
        self.behavior = lambda values: {key: "Short" for key in values}
        self.start()
        self.ok("translate.apply", **self.identity)
        mcc = external_chunk_path(target, 0)
        self.assertFalse(mcc.exists())
        applied = self.hashes()
        write = core.WorldTranslator._write_world_bytes
        def fail_region(writer, path, content):
            if path.suffix == ".mca":
                raise OSError("synthetic failure after new external chunk")
            return write(writer, path, content)
        with patch.object(core.WorldTranslator, "_write_world_bytes", new=fail_region):
            response = self.call("translate.reapply", **self.identity, edits={self.ids["Hello sign"]: "Long " + "x" * 200})
        self.assertEqual(response["error"]["code"], "REAPPLY_INTERRUPTED")
        self.assertTrue(mcc.exists())
        self.ok("restore.start", backupSetId=response["error"]["details"]["recoverySetId"])
        self.assertFalse(mcc.exists())
        self.assertEqual(self.hashes(), applied)

    def test_cancel_keeps_checkpoint_and_can_resume(self):
        self.scan(["First", "Second"])
        before = self.hashes()
        def cancelling(values):
            self.cancel.write_text("cancel")
            return {key: "번역 " + value for key, value in values.items()}
        self.behavior = cancelling
        result = self.start()
        self.assertEqual(result["status"], "cancelled")
        self.assertTrue(self.job())
        self.assertEqual(self.hashes(), before)
        self.cancel.unlink()
        self.behavior = lambda values: {key: "번역 " + value for key, value in values.items()}
        self.calls.clear()
        result = self.ok("translate.resume", apiKey="synthetic-test-key")
        self.assertEqual(result["status"], "awaiting_review")
        self.assertEqual(self.calls, [["Second"]])

    def test_cancelled_run_marks_unsent_rows_without_the_budget_reason(self):
        self.scan(["First", "Second"])
        def cancelling(values):
            self.cancel.write_text("cancel")
            return {key: "번역 " + value for key, value in values.items()}
        self.behavior = cancelling
        self.assertEqual(self.start()["status"], "cancelled")
        stopped = self.page(state="failed")
        self.assertEqual([row["reason"] for row in stopped["rows"]], ["unsent"])
        self.assertEqual(stopped["counts"]["errored"], 0)

    def test_older_checkpoint_without_additive_fields_resumes(self):
        self.scan()
        self.start()
        path = entry._checkpoint_path(self.data, self.plan["scanPlanId"])
        job = self.job()
        for key in ["failures", "edits", "usage_total", "stop_code", "applied"]:
            job.pop(key, None)
        path.write_text(json.dumps(job))
        self.calls.clear()
        result = self.ok("translate.resume", apiKey="synthetic-test-key")
        self.assertEqual(result["status"], "awaiting_review")
        self.assertEqual(self.calls, [])
        self.assertEqual(result["providerRequests"], 0)

    def test_review_off_preserves_single_pass_and_keeps_full_results(self):
        self.settings(review_before_apply=False)
        self.scan(["First", "Second"])
        result = self.start()
        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["backupSetId"])
        self.assertEqual(self.page()["total"], 2)
        self.assertTrue(self.page()["meta"]["applied"])

    def test_failure_codes_are_stable_for_all_categories(self):
        cases = [
            (TimeoutError("timeout"), "timeout"), (ProviderError("timed out"), "timeout"),
            (ProviderError("bad key", status=401), "auth"), (ProviderError("rate limited", status=429), "rate_limit"),
            (ProviderError("quota exceeded", status=429), "quota"), (ProviderError("no credit", status=402), "quota"),
            (RuntimeError("invalid JSON"), "invalid_response"), (RuntimeError("format tokens mismatch"), "invalid_response"),
            (RuntimeError("Gemini returned no text (finish reason SAFETY)."), "content_filter"),
            (ProviderError("content_filter", status=400), "content_filter"),
            (OSError("connection reset"), "network"), (ProviderError("network disconnected"), "network"),
            (ProviderError("internal", status=503), "provider_error"), (RuntimeError("unexpected"), "unknown"),
        ]
        self.assertEqual({expected for _, expected in cases}, set(core.FAILURE_CODES))
        for error, expected in cases:
            with self.subTest(code=expected, error=str(error)):
                self.assertEqual(core.classify_failure(error), expected)

    def test_fatal_failure_records_per_row_code_and_bounded_detail(self):
        self.scan()
        def fail(_values):
            raise ProviderError("denied " * 100, status=401)
        self.behavior = fail
        result = self.start()
        self.assertEqual(result["status"], "failed")
        row = self.page(state="failed")["rows"][0]
        self.assertEqual(row["reason"], "auth")
        self.assertLessEqual(len(row["detail"]), 300)
        self.assertEqual(result["translationFailures"][0]["reason"], "auth")
        self.assertEqual(self.ok("resume.status")["status"], "failed")

    def test_broken_ai_format_tokens_are_failed_and_can_be_retried(self):
        self.scan(["Hello %s", "Plain"])
        self.behavior = lambda values: {key: "번역 " + value.replace("%s", "") for key, value in values.items()}
        before = self.hashes()
        self.start()
        row = self.page(state="failed")["rows"][0]
        self.assertEqual(row["source"], "Hello %s")
        self.assertEqual(row["reason"], "invalid_response")
        self.assertEqual(self.hashes(), before)
        self.calls.clear()
        self.behavior = lambda values: {key: "정상 " + value for key, value in values.items()}
        resumed = self.ok("translate.resume", apiKey="synthetic-test-key")
        self.assertEqual(resumed["status"], "awaiting_review")
        self.assertEqual(self.calls, [["Hello %s"]])
        self.assertEqual(self.page(state="failed")["total"], 0)

    def test_estimate_reasoning_allowance_keeps_low_and_unknown_price(self):
        records = [{"source": "Hello sign"}]
        saved = {"provider": "openrouter", "model": "fixture", "openrouter_reasoning": "default"}
        price = {"input": .001, "output": .002}
        with patch.object(entry, "_model_price", return_value=price):
            default = entry._estimate(records, saved, self.data)
            disabled = entry._estimate(records, {**saved, "openrouter_reasoning": "disabled"}, self.data)
        self.assertTrue(default["reasoningIncluded"])
        self.assertFalse(disabled["reasoningIncluded"])
        self.assertEqual(default["cost"]["low"], disabled["cost"]["low"])
        self.assertGreater(default["cost"]["high"], disabled["cost"]["high"])
        with patch.object(entry, "_model_price", return_value=None):
            self.assertIsNone(entry._estimate(records, saved, self.data)["cost"])
        with patch("mwt.userdata.load_model_catalog", return_value=[{"id": "fixture"}]):
            self.assertTrue(entry._estimate(records, saved, self.data)["reasoningIncluded"])
        with patch("mwt.userdata.load_model_catalog", return_value=[{"id": "fixture", "reasoning": {"mandatory": True}}]):
            self.assertTrue(entry._estimate(records, {**saved, "openrouter_reasoning": "disabled"}, self.data)["reasoningIncluded"])

    def test_reapply_external_zip_accepts_own_write_but_refuses_later_changes(self):
        pack = self.root / "external.zip"
        with zipfile.ZipFile(pack, "w") as archive:
            archive.writestr("assets/demo/lang/en_us.json", json.dumps({"hello": "Pack hello"}))
        original = pack.read_bytes()
        self.settings(resourcePackEnabled=True, externalResourcePackPaths=[str(pack)])
        self.scan()
        self.start()
        first = self.ok("translate.apply", **self.identity)
        self.assertEqual(first["status"], "completed")
        first_bytes = pack.read_bytes()
        paid_calls = len(self.calls)
        result = self.ok("translate.reapply", **self.identity, edits={self.ids["Pack hello"]: "수정 팩"})
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["providerRequests"], 0)
        self.assertEqual(len(self.calls), paid_calls)
        with zipfile.ZipFile(pack) as archive:
            self.assertEqual(json.loads(archive.read("assets/demo/lang/ko_kr.json"))["hello"], "수정 팩")
        stores = [backup_store(self.world, self.data)]
        recovery = BackupSet.find(self.world, result["recoverySetId"], stores, external_files=[pack])
        recovery_entries = json.loads(recovery.manifest_path.read_text())["files"]
        external = next(row for row in recovery_entries if row.get("externalTarget"))
        self.assertEqual((recovery.root / external["path"]).read_bytes(), first_bytes)
        original_backup = BackupSet.find(self.world, result["backupSetId"], stores, external_files=[pack])
        external = next(row for row in json.loads(original_backup.manifest_path.read_text())["files"] if row.get("externalTarget"))
        self.assertEqual((original_backup.root / external["path"]).read_bytes(), original)
        pack.write_bytes(b"synthetic external changes")
        with patch.object(BackupSet, "restore", side_effect=AssertionError("must not restore changed ZIP")):
            refused = self.call("translate.reapply", **self.identity)
        self.assertEqual(refused["error"]["code"], "WORLD_CHANGED_SINCE_APPLY")
        self.assertEqual(pack.read_bytes(), b"synthetic external changes")

    def test_reapply_holds_world_lock_before_restoring(self):
        from mwt.locking import WorldWriteLock
        self.scan()
        self.start()
        self.ok("translate.apply", **self.identity)
        guard = WorldWriteLock(self.world)
        guard.acquire()
        try:
            with patch.object(BackupSet, "restore", side_effect=AssertionError("must not restore locked world")):
                refused = self.call("translate.reapply", **self.identity)
            self.assertEqual(refused["type"], "response.error")
        finally:
            guard.release()

    def test_full_results_exceed_sample_and_failure_caps(self):
        self.scan([f"Line {index}" for index in range(35)])
        self.start()
        self.assertEqual(len(self.page()["rows"]), 35)
        self.assertEqual(len(self.page(offset=20, limit=10)["rows"]), 10)
        # A halted job includes every unanswered row, rather than the report's 20-item preview.
        self.scan()
        def fail(values):
            raise RuntimeError("invalid JSON")
        self.behavior = fail
        self.start()
        self.assertEqual(self.page(state="failed")["total"], 35)
        self.assertEqual(len(self.page(state="failed", offset=20, limit=15)["rows"]), 15)

    def test_new_scan_prunes_finished_job_for_previous_plan(self):
        self.scan()
        self.start()
        self.ok("translate.apply", **self.identity)
        old_path = entry._checkpoint_path(self.data, self.plan["scanPlanId"])
        self.assertTrue(old_path.is_file())
        self.scan()
        self.assertFalse(old_path.exists())

    def test_translation_sample_events_are_truncated(self):
        text = "Long source " + "x" * 300
        self.scan([text])
        self.start()
        samples = [event["payload"] for event in self.events if event["payload"]["event"] == "translation_sample"]
        self.assertTrue(samples)
        for sample in samples:
            self.assertLessEqual(len(sample["source"]), 200)
            self.assertLessEqual(len(sample["translated"]), 200)

    def test_settings_validate_atomically(self):
        self.assertTrue(self.ok("settings.get")["settings"]["review_before_apply"])
        saved = load_user_settings(self.data)
        for value in [-1, 1001, True, "not a number", float("nan"), float("inf")]:
            self.assertEqual(self.call("settings.set", maxCostUsd=value)["type"], "response.error")
            self.assertEqual(load_user_settings(self.data), saved)
        self.assertEqual(self.call("settings.set", reviewBeforeApply="yes")["type"], "response.error")
        self.assertEqual(self.settings(reviewBeforeApply=False, max_cost_usd=1000)["max_cost_usd"], 1000)


if __name__ == "__main__":
    unittest.main()
