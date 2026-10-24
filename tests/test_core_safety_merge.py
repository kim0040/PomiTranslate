"""R8/R10 regressions: bounded hashing, saved write state, and one shared retry allowance."""
from __future__ import annotations
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mc_world_translator as core
import mwt.safety as safety
from llm_backends import LLMProviderClient, ProviderError
from tests.test_batch_budget import Fake, translator
from tests.test_release_fixtures import compound, nbt_bytes, string, write_region

class SafetyMergeRegressions(unittest.TestCase):
    def test_single_pass_baseline_and_checkpoints_only_read_changed_files(self):
        with tempfile.TemporaryDirectory() as raw:
            world = Path(raw) / "world"
            (world / "region").mkdir(parents=True)
            (world / "level.dat").write_bytes(b"level")
            for index in range(20):
                (world / "region" / f"r.{index}.0.mca").write_bytes(bytes([index]) * 200)
            cache = safety.DigestCache()
            opened = []
            original = Path.open
            def opening(path, *args, **kwargs):
                if args and args[0] == "rb" and path.is_relative_to(world):
                    opened.append(path)
                return original(path, *args, **kwargs)
            with patch.object(Path, "open", new=opening):
                baseline, files = safety.world_baseline(world, cache)
            self.assertEqual(len(opened), len(files))
            self.assertEqual(len(set(opened)), len(files))
            self.assertEqual(baseline, safety.world_fingerprint(world))
            with patch.object(safety, "file_sha256", wraps=safety.file_sha256) as hashing:
                first = safety.world_state_fingerprint(world, cache)
                for _ in range(30):
                    self.assertEqual(safety.world_state_fingerprint(world, cache), first)
                self.assertEqual(hashing.call_count, 0)
                changed = world / "region/r.0.0.mca"
                changed.write_bytes(b"changed")
                cache.forget(changed)
                self.assertNotEqual(safety.world_state_fingerprint(world, cache), first)
                self.assertEqual(hashing.call_count, 1)

    def test_backup_and_absence_markers_publish_one_manifest_per_batch(self):
        with tempfile.TemporaryDirectory() as raw:
            world = Path(raw) / "world"
            (world / "region").mkdir(parents=True)
            region = world / "region/r.0.0.mca"
            region.write_bytes(b"region")
            backup = safety.BackupSet.new(world, store=Path(raw) / "backups")
            with patch.object(backup, "_write_manifest", wraps=backup._write_manifest) as manifest:
                backup.add_many([region] * 40)
                self.assertEqual(manifest.call_count, 1)
                backup.record_new_external_chunks([world / "region" / f"c.{i}.0.mcc" for i in range(30)])
                self.assertEqual(manifest.call_count, 2)
                self.assertEqual(len(backup.entries), 31)

    def test_checkpoint_between_writes_resumes_without_repaying_for_answers(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            world = root / "world"
            for index in range(2):
                write_region(world / "region" / f"r.{index}.0.mca", {0: (2, nbt_bytes(compound("sign", string("Text1", json.dumps({"text": f"Line {index}"})))), False)})
            (world / "level.dat").write_bytes(b"level")
            checkpoint = root / "job.json"
            config = core.merge_nested(core.DEFAULT_CONFIG, {
                "world_dir": str(world), "report_path": str(root / "report.json"), "inherit_translate_py": False,
                "api": {"provider": "openai", "api_key": "synthetic", "model": "fixture"},
                "runtime": {"checkpoint_path": str(checkpoint), "checkpoint_enabled": True, "backup_store": str(root / "backups"), "max_batch_retries": 1},
            })
            stopped = [False]
            def progress(event):
                if event.get("event") == "file_done" and event.get("phase") == "write" and event.get("index") == 1:
                    stopped[0] = True
            def translate(_client, values, **kwargs):
                LLMProviderClient.request_count += 1
                return {key: "T " + value for key, value in values.items()}
            with patch.object(LLMProviderClient, "translate_mapping", new=translate), patch.object(LLMProviderClient, "try_refresh_text_models", return_value=[]):
                first = core.WorldTranslator(config, progress_callback=progress, cancel_check=lambda: stopped[0]).run()
            self.assertEqual(first["status"], "cancelled")
            saved = json.loads(checkpoint.read_text(encoding="utf-8"))
            self.assertEqual(saved["world_fingerprint_version"], 2)
            self.assertEqual(len(saved["completed_region_files"]), 1)
            resumed_config = core.merge_nested(config, {"runtime": {"resume_from_checkpoint": True}})
            with patch.object(LLMProviderClient, "translate_mapping", side_effect=AssertionError("cached answers must not be paid for again")), patch.object(LLMProviderClient, "try_refresh_text_models", return_value=[]):
                resumed = core.WorldTranslator(resumed_config).run()
            self.assertEqual(resumed["status"], "completed", resumed.get("errors"))
            self.assertEqual(resumed["provider_requests"], 0)

    def test_retries_and_splits_share_the_original_batch_allowance(self):
        for size in (1, 5, 40, 200):
            fake = Fake(RuntimeError("invalid JSON"))
            batch = translator(fake, batch_size=size)
            result = batch.translate_texts([f"text {i}" for i in range(size)])
            self.assertLessEqual(fake.requests, 3 + size)
            self.assertEqual(len(batch.failed), size)
            self.assertEqual(len(result), size)

    def test_transport_adaptations_cannot_exceed_the_batch_allowance(self):
        from tests.test_provider_hardening import Script
        server = Script(lambda handler, request, number: handler.reply(200, b"{}"))
        try:
            config = core.merge_nested(core.DEFAULT_CONFIG, {
                "inherit_translate_py": False, "batch_size": 1,
                "api": {"provider": "openai", "model": "fixture", "api_key": "synthetic", "base_url": server.base + "/v1"},
                "runtime": {"max_batch_retries": 1},
            })
            batch = core.BatchTranslator(config)
            batch.wait = lambda _seconds: None
            def adapt(values, **kwargs):
                for _ in range(10):
                    batch.client._request_json("POST", server.base + "/v1/chat/completions", headers={}, payload={})
                return {key: "T " + value for key, value in values.items()}
            batch.client.translate_mapping = adapt
            LLMProviderClient.reset_counters()
            batch.translate_texts(["Single string"])
            self.assertEqual(len(server.requests), 2, "one original string plus one configured attempt")
            self.assertEqual(LLMProviderClient.request_count, 2)
            self.assertIn("Single string", batch.failed)
        finally:
            server.close()

    def test_repeated_malformed_batches_trip_the_breaker_once_per_batch(self):
        fake = Fake(RuntimeError("invalid JSON"))
        batch = translator(fake, batch_size=1)
        with self.assertRaises(core.ProviderUnavailable):
            batch.translate_texts([f"text {i}" for i in range(20)])
        self.assertEqual(batch.consecutive_failures, core.MAX_CONSECUTIVE_REQUEST_FAILURES)
        self.assertLessEqual(fake.requests, (3 + 1) * core.MAX_CONSECUTIVE_REQUEST_FAILURES)

if __name__ == "__main__":
    unittest.main()
