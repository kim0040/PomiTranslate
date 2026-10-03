"""Desktop public write settings and persistent exact-source translations."""

from __future__ import annotations

import copy
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

from nbt import nbt

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import mc_world_translator as core  # noqa: E402
from mc_world_translator import DEFAULT_CONFIG  # noqa: E402
from mwt import desktop_entry  # noqa: E402
from mwt.desktop_settings import (  # noqa: E402
    DEFAULT_CONTINUE_ON_FILE_ERROR,
    DEFAULT_MAX_FILE_WRITE_RETRIES,
    MAX_SOURCE_OVERRIDES_BYTES,
    normalize_source_overrides,
)
from mwt.userdata import load_user_settings, public_settings_from_config, settings_path  # noqa: E402
from tests.test_release_fixtures import compound, nbt_bytes, string, write_region  # noqa: E402


def _request(data_dir: Path, kind: str, payload: dict | None = None) -> dict:
    replies: list[dict] = []
    with patch.object(desktop_entry, "emit", side_effect=replies.append):
        try:
            desktop_entry.handle(
                {
                    "v": 1,
                    "id": f"parity-{kind}",
                    "type": kind,
                    "payload": payload or {},
                },
                report_dir=data_dir / "reports",
                data_dir=data_dir,
            )
        except desktop_entry.RequestRefused as exc:
            # Match the public JSONL boundary for typed refusals, while leaving validation
            # ValueErrors visible to the existing atomic-settings tests below.
            replies.append({"type": "response.error", "error": {"code": exc.code, "message": str(exc)}})
    assert replies
    return replies[-1]


def _settings_set(data_dir: Path, **settings) -> dict:
    response = _request(
        data_dir,
        "settings.set",
        {
            "credentialOwner": "rust",
            "provider": "openai",
            "model": "fixture-model",
            "review_before_apply": False,
            **settings,
        },
    )
    assert response["type"] == "response.ok"
    return response["payload"]["settings"]


def _synthetic_world(root: Path) -> Path:
    world = root / "synthetic-world"
    world.mkdir(parents=True)
    level = nbt.NBTFile()
    data = nbt.TAG_Compound(name="Data")
    data.tags.append(nbt.TAG_Int(name="DataVersion", value=4189))
    level.tags.append(data)
    level.write_file(filename=str(world / "level.dat"))
    write_region(
        world / "region" / "r.0.0.mca",
        {0: (2, nbt_bytes(compound("sign", string("Text1", '{"text":"Hello sign"}'))), False)},
    )
    return world


def _expect_value_error(action) -> None:
    try:
        action()
    except ValueError:
        return
    raise AssertionError("expected ValueError")


def _files_under(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in root.rglob("*")
        if path.is_file()
    }


def test_public_settings_roundtrip_and_defaults(tmp_path: Path) -> None:
    config = copy.deepcopy(DEFAULT_CONFIG)
    config["scan"]["overrides"] = {"Hello sign": "  Hola sign  "}
    config["runtime"]["continue_on_file_error"] = False
    config["runtime"]["max_file_write_retries"] = 7
    public = public_settings_from_config(config)
    assert public["source_overrides"] == {"Hello sign": "Hola sign"}
    assert public["continue_on_file_error"] is False
    assert public["max_file_write_retries"] == 7

    defaults = _request(tmp_path, "settings.get", {"credentialOwner": "rust"})["payload"]["settings"]
    assert defaults["source_overrides"] == {}
    assert defaults["continue_on_file_error"] is DEFAULT_CONTINUE_ON_FILE_ERROR
    assert defaults["max_file_write_retries"] == DEFAULT_MAX_FILE_WRITE_RETRIES

    saved = _settings_set(
        tmp_path,
        sourceOverrides={"Hello sign": "  Hola sign  "},
        continueOnFileError=False,
        maxFileWriteRetries=7,
    )
    assert saved["source_overrides"] == {"Hello sign": "Hola sign"}
    assert saved["continue_on_file_error"] is False
    assert saved["max_file_write_retries"] == 7

    # Omitted fields preserve the saved values; an explicit empty object clears the map.
    preserved = _settings_set(tmp_path, model="another-model")
    assert preserved["source_overrides"] == {"Hello sign": "Hola sign"}
    assert preserved["continue_on_file_error"] is False
    assert preserved["max_file_write_retries"] == 7
    cleared = _settings_set(tmp_path, sourceOverrides={})
    assert cleared["source_overrides"] == {}

    bootstrap = _request(tmp_path, "app.bootstrap", {"credentialOwner": "rust"})["payload"]["settings"]
    assert bootstrap["source_overrides"] == {}
    assert bootstrap["continue_on_file_error"] is False
    assert bootstrap["max_file_write_retries"] == 7


def test_invalid_public_parity_settings_are_atomic(tmp_path: Path) -> None:
    _settings_set(
        tmp_path,
        sourceOverrides={"Known source": "Known target"},
        continueOnFileError=False,
        maxFileWriteRetries=5,
    )
    before = _files_under(tmp_path)

    oversized_map = {
        f"{index:02d}" + "s" * 16_000: "t" * 16_000
        for index in range(34)
    }
    assert len(str(oversized_map).encode("utf-8")) > MAX_SOURCE_OVERRIDES_BYTES
    too_many_entries = {f"source-{index}": "target" for index in range(5001)}
    invalid_payloads = (
        {"sourceOverrides": []},
        {"sourceOverrides": None},
        {"sourceOverrides": {"": "target"}},
        {"sourceOverrides": {"   ": "target"}},
        {"sourceOverrides": {"source": "   "}},
        {"sourceOverrides": {"source": 4}},
        {"sourceOverrides": {"s" * 32_001: "target"}},
        {"sourceOverrides": {"source": "x" * 32_001}},
        {"sourceOverrides": too_many_entries},
        {"sourceOverrides": oversized_map},
        {"continueOnFileError": "false"},
        {"continueOnFileError": 0},
        {"maxFileWriteRetries": 0},
        {"maxFileWriteRetries": 11},
        {"maxFileWriteRetries": 1.5},
        {"maxFileWriteRetries": True},
    )
    for invalid in invalid_payloads:
        _expect_value_error(lambda invalid=invalid: _settings_set(tmp_path, **invalid))
        assert _files_under(tmp_path) == before

    # New settings are checked before a provider credential write could be attempted.
    from mwt import secrets

    with patch.object(secrets, "remember_api_key", side_effect=AssertionError("unexpected key write")):
        _expect_value_error(
            lambda: _request(
                tmp_path,
                "settings.set",
                {
                    "credentialOwner": "python",
                    "provider": "openai",
                    "apiKey": "synthetic-invalid-payload-key",
                    "maxFileWriteRetries": 0,
                },
            )
        )
    assert _files_under(tmp_path) == before

    assert normalize_source_overrides({" Exact source ": "  Target value  "}) == {
        " Exact source ": "Target value"
    }


def test_model_and_translation_preferences_preserve_scan_scope(tmp_path: Path) -> None:
    initial_scope = desktop_entry._scan_scope_fingerprint(tmp_path)
    initial_translation = desktop_entry._settings_fingerprint(tmp_path)

    _settings_set(tmp_path, model="changed-model", batchSize=8)
    assert desktop_entry._scan_scope_fingerprint(tmp_path) == initial_scope
    after_model = desktop_entry._settings_fingerprint(tmp_path)

    _settings_set(tmp_path, sourceOverrides={"Hello sign": "Hola sign"})
    assert desktop_entry._scan_scope_fingerprint(tmp_path) == initial_scope
    after_overrides = desktop_entry._settings_fingerprint(tmp_path)
    assert after_overrides != after_model

    _settings_set(tmp_path, continueOnFileError=False, maxFileWriteRetries=4)
    assert desktop_entry._scan_scope_fingerprint(tmp_path) == initial_scope
    assert desktop_entry._settings_fingerprint(tmp_path) != after_overrides

    _settings_set(tmp_path, scanOptions={"translate_signs": False})
    assert desktop_entry._scan_scope_fingerprint(tmp_path) != initial_scope


def test_candidate_edit_wins_without_becoming_a_global_override(tmp_path: Path) -> None:
    _settings_set(
        tmp_path,
        sourceOverrides={"Hello sign": "Persistent target"},
        continueOnFileError=False,
        maxFileWriteRetries=6,
    )
    captured: dict = {}

    class CaptureTranslator:
        def __init__(self, config: dict, **_kwargs) -> None:
            captured["config"] = config
            self.occurrences = {}
            self._candidate_order = []

        def run(self) -> dict:
            return {"status": "completed", "candidate_text_count": 0}

    with patch.object(core, "WorldTranslator", CaptureTranslator):
        desktop_entry._run_translator(
            tmp_path / "synthetic-world",
            dry_run=True,
            report_path=tmp_path / "reports" / "scan.json",
            data_dir=tmp_path,
            manual_overrides={"Hello sign": "  Candidate target  "},
            allow_keyring_fallback=False,
        )

    config = captured["config"]
    assert config["scan"]["overrides"] == {"Hello sign": "Candidate target"}
    assert config["runtime"]["continue_on_file_error"] is False
    assert config["runtime"]["max_file_write_retries"] == 6
    assert load_user_settings(tmp_path)["source_overrides"] == {"Hello sign": "Persistent target"}


def test_estimate_and_manual_filter_use_persisted_overrides(tmp_path: Path) -> None:
    _settings_set(tmp_path, sourceOverrides={"Already translated": "Listo"})
    scan_plan_id = "a" * 64
    candidates = [
        {"id": "candidate-one-00001", "source": "Already translated", "kind": "sign", "occurrences": 1},
        {"id": "candidate-two-00002", "source": "Needs translation", "kind": "sign", "occurrences": 1},
    ]
    desktop_entry._save_scan_plan(
        tmp_path,
        scan_plan_id,
        world_fingerprint="synthetic-world-fingerprint",
        scope_fingerprint=desktop_entry._scan_scope_fingerprint(tmp_path),
        candidates=candidates,
    )

    estimate = _request(
        tmp_path,
        "estimate.get",
        {"scanPlanId": scan_plan_id},
    )["payload"]
    assert estimate["candidateCount"] == 1
    assert estimate["requests"] == 1

    manual_page = _request(
        tmp_path,
        "candidates.page",
        {"scanPlanId": scan_plan_id, "state": "manual", "offset": 0, "limit": 10},
    )["payload"]
    assert [item["id"] for item in manual_page["candidates"]] == ["candidate-one-00001"]
    assert manual_page["total"] == 1


def test_persisted_overrides_skip_provider_for_all_included_candidates(tmp_path: Path) -> None:
    world = _synthetic_world(tmp_path)
    data_dir = tmp_path / "userdata"
    _settings_set(data_dir, worldDir=str(world), sourceOverrides={"Hello sign": "Hola sign"})
    scan = _request(data_dir, "scan.start", {"worldDir": str(world)})["payload"]
    assert scan["candidateCount"] == 1
    assert scan["estimate"]["candidateCount"] == 0
    assert scan["requestEstimate"] == 0

    from llm_backends import LLMProviderClient
    from mwt import secrets

    LLMProviderClient.request_count = 0
    with patch.dict(os.environ, {"POMI_API_KEY": "", "POMI_API_BASE": "", "POMI_MODEL": ""}), patch.object(
        secrets, "load_api_key", return_value=""
    ):
        translated = _request(
            data_dir,
            "translate.start",
            {
                "worldDir": str(world),
                "fingerprint": scan["fingerprint"],
                "scanPlanId": scan["scanPlanId"],
            },
        )["payload"]
    assert translated["status"] == "completed"
    assert translated["providerRequests"] == 0
    assert LLMProviderClient.request_count == 0


def test_resume_respects_latest_review(tmp_path: Path) -> None:
    world = _synthetic_world(tmp_path)
    write_region(world / "region" / "r.1.0.mca", {
        0: (2, nbt_bytes(compound("sign", string("Text1", '{"text":"Keep original"}'))), False),
    })
    data_dir = tmp_path / "userdata"
    _settings_set(data_dir, worldDir=str(world), targetLanguage="한국어")
    scan = _request(data_dir, "scan.start", {"worldDir": str(world)})["payload"]
    original = _files_under(world)
    by_source = {item["source"]: item["id"] for item in scan["candidates"]}
    cancelled = False

    def stop_before_write(event):
        nonlocal cancelled
        if event.get("event") == "phase_start" and event.get("phase") == "write":
            cancelled = True

    seeded = desktop_entry._run_translator(
        world, dry_run=False, report_path=data_dir / "reports" / "seed.json",
        fingerprint=scan["fingerprint"], data_dir=data_dir, scan_plan_id=scan["scanPlanId"],
        manual_overrides={"Hello sign": "오래된 번역", "Keep original": "제외할 이전 번역"},
        skip_provider_validation=True, allow_keyring_fallback=False,
        progress_callback=stop_before_write, cancel_check=lambda: cancelled,
    )
    assert seeded["status"] == "cancelled", seeded["status"]
    assert _files_under(world) == original
    assert _request(data_dir, "resume.status", {"worldDir": str(world)})["payload"]["available"]
    with patch('mwt.secrets.load_api_key', side_effect=AssertionError('manual resume must not read keychain')):
        result = _request(data_dir, "translate.resume", {
            "worldDir": str(world), "credentialOwner": "rust",
            "fingerprint": scan["fingerprint"], "scanPlanId": scan["scanPlanId"],
            "excludedCandidateIds": [by_source["Keep original"]],
            "candidateOverrides": {by_source["Hello sign"]: "새 직접 번역"},
        })["payload"]
    assert result["status"] == "completed", result
    assert result["providerRequests"] == 0
    assert result["translation"]["translated"] == 1, result["translation"]
    assert result["translationSamples"] == [{"source": "Hello sign", "translated": "새 직접 번역"}]
    assert (world / "region" / "r.1.0.mca").read_bytes() == original["region/r.1.0.mca"]
    assert result["changedFileCount"] == 1
    restored = _request(data_dir, "restore.start", {
        "worldDir": str(world), "backupSetId": result["backupSetId"],
    })["payload"]
    assert restored["status"] == "restored"
    assert _files_under(world) == original

    # Explicitly clearing the review is distinct from omitting it for an older client.
    defaults = {"fingerprint": scan["fingerprint"], "scanPlanId": scan["scanPlanId"],
                "excludedCandidateIds": [by_source["Keep original"]],
                "candidateOverrides": {by_source["Hello sign"]: "이전 직접 번역"}}
    for supplied, expected_excluded, expected_manual in [
        ({}, defaults["excludedCandidateIds"], {"Hello sign": "이전 직접 번역"}),
        ({"excludedCandidateIds": [], "candidateOverrides": {}}, [], {}),
    ]:
        with patch.object(desktop_entry, "_resume_candidate", return_value=defaults), patch.object(
            desktop_entry, "_run_translator", return_value={"status": "completed"}
        ) as run:
            _request(data_dir, "translate.resume", {"worldDir": str(world), **supplied})
        assert run.call_args.kwargs["excluded_candidate_ids"] == expected_excluded
        assert run.call_args.kwargs["manual_overrides"] == expected_manual


def test_reasoning_settings_roundtrip(root: Path) -> None:
    from mwt.desktop_entry import _settings_fingerprint
    data = root / "data"
    default = _settings_set(data, provider="openrouter", openrouterReasoning="default")
    assert default["openrouter_reasoning"] == "default"
    old_fingerprint = _settings_fingerprint(data)
    path = settings_path(data)
    import json
    legacy = json.loads(path.read_text()); legacy.pop("openrouter_reasoning"); path.write_text(json.dumps(legacy))
    assert _settings_fingerprint(data) == old_fingerprint
    saved = _settings_set(data, provider="openrouter", openrouterReasoning="high")
    assert saved["openrouter_reasoning"] == "high"
    assert _settings_fingerprint(data) != old_fingerprint
    assert _request(data, "app.bootstrap", {"credentialOwner": "rust"})["payload"]["settings"]["openrouter_reasoning"] == "high"
    before = path.read_bytes()
    for invalid in [None, {}, True, "ultra"]:
        try:
            _settings_set(data, openrouterReasoning=invalid)
            raise AssertionError("invalid reasoning choice accepted")
        except ValueError:
            pass
        assert path.read_bytes() == before
    world = _synthetic_world(root / "world")
    with patch.object(core, "WorldTranslator") as translator:
        translator.return_value.run.return_value = {"status": "completed"}
        desktop_entry._run_translator(world, report_path=data / "reports" / "test.json", data_dir=data, dry_run=True)
        assert translator.call_args.args[0]["api"]["openrouter_reasoning"] == "high"


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="pomi-desktop-parity-") as temporary:
        root = Path(temporary)
        with patch('mwt.secrets.load_api_key', side_effect=AssertionError('Fresh native bootstrap must not read keychain')):
            bootstrap = _request(root / 'fresh', 'app.bootstrap', {'credentialOwner': 'rust'})['payload']
        assert bootstrap['settings']['provider'] == 'openai'
        assert bootstrap['apiKeyStored'] is False
        assert bootstrap['worlds'] == []
        test_reasoning_settings_roundtrip(root / "reasoning")
        test_public_settings_roundtrip_and_defaults(root / "roundtrip")
        test_invalid_public_parity_settings_are_atomic(root / "validation")
        test_model_and_translation_preferences_preserve_scan_scope(root / "fingerprints")
        test_candidate_edit_wins_without_becoming_a_global_override(root / "precedence")
        test_estimate_and_manual_filter_use_persisted_overrides(root / "estimate")
        test_persisted_overrides_skip_provider_for_all_included_candidates(root / "manual-only")
        test_resume_respects_latest_review(root / "resume-review")
    print("PASS desktop parity settings, exact-source overrides, estimates, manual-only translation")


if __name__ == "__main__":
    main()
