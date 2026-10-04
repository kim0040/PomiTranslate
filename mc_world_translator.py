from __future__ import annotations

import argparse
import ast
import fnmatch
import hashlib
import io
import json
import math
import os
import re
import shutil
import tempfile
import threading
import time
import tomllib
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from pathlib import Path
from typing import Any

from env_utils import load_dotenv_chain
from llm_backends import (
    LLMProviderClient,
    ModelCatalogError,
    PROVIDER_SPECS,
    ProviderError,
    default_base_url,
    enhance_style_prompt,
    infer_provider,
    provider_choices,
    resolve_api_key,
    resolve_base_url,
    resolve_model,
)

from mwt import nbtio as nbt
from mwt.extract import TextExtractionMixin, TextRef
from mwt.safety import PlanInvalidated, file_sha256


STYLE_PRESETS: dict[str, str] = {
    "neutral": """
당신은 마인크래프트(Minecraft) 월드 및 맵 현지화 전문 번역가입니다.
입력된 텍스트를 게임 맥락에 자연스러운 {target_language}로 번역하세요.

[번역 지침]
1. 인게임 상황(표지판, 책, 대화, 퀘스트 안내문)에 적합하고 명료한 어휘를 사용합니다.
2. 퍼즐 힌트와 시스템 규칙 등 게임 진행에 직결된 핵심 정보는 플레이어가 명확하게 이해할 수 있도록 번역합니다.
3. 고유명사, 인명, 제작자 닉네임, SNS 계정, 브랜드명은 임의로 번역하지 않고 원문을 유지하거나 널리 쓰이는 음역을 사용합니다.
4. 서식 코드(§0~§f, §k~§r 등), 줄바꿈(\\n), 포맷 스트링({0}, %s 등), JSON 구조는 절대 훼손하거나 누락하지 말고 원형 그대로 보존합니다.
5. 해설, 인사말, 부가 설명 없이 오직 번역된 결과 텍스트만 반환합니다.
""".strip(),
    "casual": """
당신은 마인크래프트(Minecraft) 월드 및 맵 현지화 전문 번역가입니다.
입력된 텍스트를 친근하고 생동감 있는 대화체의 {target_language}로 번역하세요.

[번역 지침]
1. NPC 대사와 스토리 텍스트는 실제 인물이 말하는 것처럼 자연스럽고 매끄러운 구어체로 표현합니다.
2. 퍼즐 힌트나 게임 시스템 안내문은 친절하면서도 핵심 의미가 왜곡 없이 전달되도록 합니다.
3. 고유명사, 인명, 제작자 닉네임, 브랜드명은 함부로 번역하지 않고 원문을 보존합니다.
4. 서식 코드(§ 및 서식 문자), 줄바꿈(\\n), 자리표시자({0}, %s 등), JSON 구조는 절대 변경하지 마세요.
5. 해설이나 인사말 없이 오직 번역 결과만 반환합니다.
""".strip(),
    "formal": """
당신은 마인크래프트(Minecraft) 월드 및 맵 현지화 전문 번역가입니다.
입력된 텍스트를 격식 있고 단정한 문체의 {target_language}로 번역하세요.

[번역 지침]
1. 기록물, 일지, 비석, 공식 안내문 등에 어울리는 차분하고 절제된 문체를 유지합니다.
2. 문장의 일관성을 지키며, 모호한 표현을 피하고 의미를 명확하고 간결하게 전달합니다.
3. 고유명사, 인명, 제작자 닉네임 등은 원문을 보존합니다.
4. 서식 코드(§ 및 서식 문자), 줄바꿈(\\n), 자리표시자({0}, %s 등), JSON 구조는 엄격히 보존합니다.
5. 해설이나 부가 설명 없이 오직 번역 결과만 반환합니다.
""".strip(),
    "polite": """
당신은 마인크래프트(Minecraft) 월드 및 맵 현지화 전문 번역가입니다.
입력된 텍스트를 플레이어에게 정중하게 안내하는 다정한 존댓말의 {target_language}로 번역하세요.

[번역 지침]
1. '~해요', '~합니다' 등 예의 바르고 부드러운 어미를 사용하여 플레이어를 친절하게 안내합니다.
2. 퀘스트 설명이나 튜토리얼 텍스트의 가독성과 가이드 효과를 극대화합니다.
3. 고유명사와 인명, 특수 서식 기호는 의미와 형태를 훼손하지 않습니다.
4. 서식 코드(§), 줄바꿈(\\n), 자리표시자({0}, %s 등), JSON 구조는 절대 누락하지 마세요.
5. 해설이나 인사말 없이 번역 결과 텍스트만 반환합니다.
""".strip(),
    "story": """
당신은 마인크래프트(Minecraft) 월드 및 맵 현지화 전문 번역가입니다.
입력된 텍스트를 한 편의 판타지/어드벤처 소설을 읽는 듯한 몰입감 넘치는 문체의 {target_language}로 번역하세요.

[번역 지침]
1. 단순 직역을 철저히 지양하고, 세계관의 분위기와 상황 속 긴장감, 인물의 감정이 생생히 전달되도록 윤문합니다.
2. 서사적이고 풍부한 어휘를 활용하되, 퍼즐 힌트나 시스템 규칙 같은 필수 정보가 묻히지 않도록 균형을 잡습니다.
3. 고유명사나 세계관 고유 명칭은 원작의 분위기를 살려 신중하게 처리합니다.
4. 서식 코드(§ 및 서식 문자), 줄바꿈(\\n), 자리표시자({0}, %s 등), JSON 구조는 원형 그대로 완벽히 유지합니다.
5. 해설이나 주석 없이 번역 결과만 반환합니다.
""".strip(),
    "custom": """
당신은 마인크래프트(Minecraft) 월드 및 맵 현지화 전문 번역가입니다.
입력된 텍스트를 {target_language}로 번역하되, 사용자의 추가 지침을 충실히 반영하세요.
서식 코드(§), 줄바꿈(\\n), 자리표시자({0}, %s 등)는 절대 훼손하지 마세요.
""".strip(),
}


DEFAULT_CONFIG: dict[str, Any] = {
    "world_dir": "",
    "report_path": "",
    "dry_run": False,
    "backup": True,
    "backup_suffix": ".bak_translate",
    "batch_size": 40,
    "temperature": 0.3,
    "inherit_translate_py": True,
    "translate_py_path": "./translate.py",
    "api": {
        "provider": "comet",
        "api_key": "",
        "base_url": "",
        "model": "",
        "wire_format": "",
        "request_timeout": 120,
        "rpm_limit": 0,
        "tpm_limit": 0,
    },
    "prompt": {
        "target_language": "한국어",
        "style_preset": "neutral",
        "style_prompt": "",
        "custom_system_prompt": "",
    },
    "scan": {
        "region_dirs": [
            "region",
            "entities",
            "DIM-1/region",
            "DIM-1/entities",
            "DIM1/region",
            "DIM1/entities",
        ],
        "skip_patterns": ["*.bak_translate"],
        "translate_signs": True,
        "translate_books": True,
        "translate_custom_names": True,
        "translate_item_names": True,
        "translate_lore": True,
        "translate_titles": True,
        "translate_filtered_titles": True,
        "translate_command_output": True,
        "translate_text_displays": True,
        "skip_command_like_text": True,
        "skip_target_language_text": True,
        "component_translate_key_prefixes": [],
        "overrides": {},
    },
    "resource_pack": {
        "enabled": False,
        "zip_paths": [],
        "source_lang_files": ["en_us.json", "zh_cn.json"],
        "target_lang_file": "ko_kr.json",
        "skip_if_target_exists": False,
    },
    "runtime": {
        "checkpoint_enabled": True,
        "checkpoint_path": "",
        "resume_from_checkpoint": False,
        "continue_on_file_error": True,
        "max_batch_retries": 3,
        "concurrency": 1,
        "max_file_write_retries": 2,
        "expected_world_fingerprint": "",
        "backup_store": "",
        "authorized_external_pack_paths": [],
        "expected_external_pack_fingerprints": {},
        "translation_settings_fingerprint": "",
        "excluded_candidate_ids": [],
        "skip_provider_validation": False,
    },
}


class TranslationCancelled(RuntimeError):
    pass


class BudgetStopped(TranslationCancelled):
    """The run's spending reached the user's cap. Finished batches stay in the checkpoint."""

    def __init__(self, spent: float, cap: float) -> None:
        super().__init__(f"Spending reached the cap of ${cap:g} (${spent:.4f} so far).")
        self.spent = spent
        self.cap = cap


# Why one string failed to translate, as a stable code the interface turns into plain language.
FAILURE_CODES = (
    "timeout",
    "auth",
    "rate_limit",
    "quota",
    "invalid_response",
    "content_filter",
    "network",
    "provider_error",
    "unknown",
)
_FAILURE_FOR_STOP = {
    "AUTH_FAILED": "auth",
    "NO_CREDIT": "quota",
    "RATE_LIMITED": "rate_limit",
    "NETWORK_ERROR": "network",
    "PROVIDER_ERROR": "provider_error",
    "MODEL_NOT_FOUND": "provider_error",
    "REQUEST_REJECTED": "provider_error",
}
_CONTENT_FILTER_HINTS = ("content_filter", "content filter", "safety", "blocked", "prohibited", "blocklist", "moderation", "policy violation")
_QUOTA_HINTS = ("quota", "billing", "insufficient", "credit", "exceeded your current")
_TIMEOUT_HINTS = ("timed out", "timeout", "time out")
_INVALID_HINTS = ("incomplete translation json", "invalid json", "no choices", "output token limit", "no candidates", "no text", "format tokens", "format-token")


def failure_code_for_stop(code: str) -> str:
    """The failure code for a provider error code that stopped the whole run."""
    return _FAILURE_FOR_STOP.get(str(code or ""), "unknown")


def classify_failure(exc: BaseException | str | None) -> str:
    """Sort a translation failure into one of FAILURE_CODES from its type and HTTP status."""
    message = str(exc or "").lower()
    status = getattr(exc, "status", None)
    if isinstance(exc, TimeoutError) or (status is None and any(hint in message for hint in _TIMEOUT_HINTS)):
        return "timeout"
    if any(hint in message for hint in _INVALID_HINTS) and not isinstance(status, int):
        # A reply that arrived but could not be used; a content filter often shows up the same way.
        return "content_filter" if any(hint in message for hint in _CONTENT_FILTER_HINTS) else "invalid_response"
    if isinstance(status, int):
        if status in (401, 403):
            return "auth"
        if status == 402:
            return "quota"
        if status == 429:
            return "quota" if any(hint in message for hint in _QUOTA_HINTS) else "rate_limit"
        if status in (408, 504):
            return "timeout"
        if any(hint in message for hint in _CONTENT_FILTER_HINTS):
            return "content_filter"
        return "provider_error"
    if any(hint in message for hint in _CONTENT_FILTER_HINTS):
        return "content_filter"
    if isinstance(exc, (json.JSONDecodeError,)):
        return "invalid_response"
    if isinstance(exc, ProviderError):
        return "network"
    if isinstance(exc, OSError):
        return "network"
    return "unknown"


def _clip(text: Any, limit: int = 200) -> str:
    text = str(text or "")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def merge_nested(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge_nested(result[key], value)
        else:
            result[key] = value
    return result


def load_toml_config(path: Path | None) -> dict[str, Any]:
    if path is None:
        return {}
    with path.open("rb") as f:
        return tomllib.load(f)


def write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=str(path.parent)) as tmp:
            tmp.write(content)
            tmp.flush()
            os.fsync(tmp.fileno())
            tmp_path = Path(tmp.name)
        if path.exists():
            shutil.copymode(path, tmp_path)
        os.replace(tmp_path, path)
    except Exception:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
        raise


def write_bytes_atomic(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile("wb", delete=False, dir=str(path.parent)) as tmp:
            tmp.write(content)
            tmp.flush()
            os.fsync(tmp.fileno())
            tmp_path = Path(tmp.name)
        if path.exists():
            shutil.copymode(path, tmp_path)
        os.replace(tmp_path, path)
    except Exception:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
        raise


def load_json_file(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def load_legacy_translate_defaults(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}

    try:
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
    except (OSError, SyntaxError, UnicodeDecodeError):
        return {}
    names = {"API_KEY", "BASE_URL", "MODEL", "SYSTEM_PROMPT"}
    values: dict[str, str] = {}

    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name) or target.id not in names:
            continue
        try:
            values[target.id] = ast.literal_eval(node.value)
        except Exception:
            continue

    return values


def apply_cli_overrides(config: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    result = deepcopy(config)

    if args.world_dir:
        result["world_dir"] = args.world_dir
    if args.report_path:
        result["report_path"] = args.report_path
    if args.provider:
        result["api"]["provider"] = args.provider
    if args.api_key:
        result["api"]["api_key"] = args.api_key
    if args.base_url:
        result["api"]["base_url"] = args.base_url
    if args.model:
        result["api"]["model"] = args.model
    if getattr(args, "wire_format", ""):
        result["api"]["wire_format"] = args.wire_format
    if getattr(args, "data_dir", ""):
        result["runtime"]["data_dir"] = args.data_dir
    if args.target_language:
        result["prompt"]["target_language"] = args.target_language
    if args.style_preset:
        result["prompt"]["style_preset"] = args.style_preset
    if args.style_prompt:
        result["prompt"]["style_prompt"] = args.style_prompt
    if args.custom_system_prompt:
        result["prompt"]["custom_system_prompt"] = args.custom_system_prompt
    if args.batch_size is not None:
        result["batch_size"] = args.batch_size
    if args.temperature is not None:
        result["temperature"] = args.temperature
    if args.dry_run:
        result["dry_run"] = True
    if args.no_backup:
        result["backup"] = False
    if args.resource_pack_zip:
        result["resource_pack"]["zip_paths"] = args.resource_pack_zip
        result["runtime"]["authorized_external_pack_paths"] = args.resource_pack_zip
        result["resource_pack"]["enabled"] = True
    if args.enable_resource_pack_translation:
        result["resource_pack"]["enabled"] = True
    if args.disable_resource_pack_translation:
        result["resource_pack"]["enabled"] = False
    if getattr(args, "resume", False):
        result["runtime"]["resume_from_checkpoint"] = True

    return result


def apply_remembered_defaults(config: dict[str, Any], data_dir: Path | None) -> dict[str, Any]:
    """Fill still-default public fields from the user data directory. Explicit values win."""
    from mwt.userdata import load_user_settings

    saved = load_user_settings(data_dir)
    if not saved:
        return config
    result = deepcopy(config)
    api = result["api"]
    if api.get("provider") == DEFAULT_CONFIG["api"]["provider"] and saved.get("provider"):
        api["provider"] = saved["provider"]
    if not api.get("model") and saved.get("model"):
        api["model"] = saved["model"]
    if not api.get("base_url") and saved.get("base_url"):
        api["base_url"] = saved["base_url"]
    if not api.get("wire_format") and saved.get("wire_format"):
        api["wire_format"] = saved["wire_format"]
    prompt = result["prompt"]
    if (
        prompt.get("target_language") == DEFAULT_CONFIG["prompt"]["target_language"]
        and saved.get("target_language")
    ):
        prompt["target_language"] = saved["target_language"]
    if prompt.get("style_preset") == DEFAULT_CONFIG["prompt"]["style_preset"] and saved.get("style_preset"):
        prompt["style_preset"] = saved["style_preset"]
    if not prompt.get("style_prompt") and saved.get("style_prompt"):
        prompt["style_prompt"] = saved["style_prompt"]
    if not prompt.get("custom_system_prompt") and saved.get("custom_system_prompt"):
        prompt["custom_system_prompt"] = saved["custom_system_prompt"]
    if result.get("temperature") == DEFAULT_CONFIG["temperature"] and saved.get("temperature") not in ("", None):
        result["temperature"] = saved["temperature"]
    if result.get("batch_size") == DEFAULT_CONFIG["batch_size"] and saved.get("batch_size") not in ("", None):
        result["batch_size"] = saved["batch_size"]
    return result


def remember_run_settings(config: dict[str, Any], data_dir: Path | None, api_key: str | None = None) -> None:
    from mwt.secrets import remember_api_key
    from mwt.userdata import public_settings_from_config, remember_recent_world, remember_user_settings

    remember_user_settings(public_settings_from_config(config), root=data_dir)
    world_dir = str(config.get("world_dir") or "")
    if world_dir and Path(world_dir).expanduser().is_dir():
        remember_recent_world(Path(world_dir), root=data_dir)
    if api_key:
        remember_api_key(config["api"]["provider"], api_key)


def normalize_config(config: dict[str, Any], config_path: Path | None) -> dict[str, Any]:
    result = deepcopy(config)
    project_dir = Path(__file__).resolve().parent
    load_dotenv_chain(
        project_dir / ".env",
        project_dir.parent / ".env",
    )

    translate_py_path = Path(result["translate_py_path"])
    if not translate_py_path.is_absolute() and config_path is not None:
        translate_py_path = (config_path.parent / translate_py_path).resolve()
    else:
        translate_py_path = translate_py_path.resolve()

    if result.get("inherit_translate_py", True):
        legacy = load_legacy_translate_defaults(translate_py_path)
        if not result["api"]["api_key"]:
            result["api"]["api_key"] = legacy.get("API_KEY", "")
        if not result["api"]["base_url"]:
            result["api"]["base_url"] = legacy.get("BASE_URL", "")
        if not result["api"]["model"]:
            result["api"]["model"] = legacy.get("MODEL", "")
        if not result["prompt"]["custom_system_prompt"] and not result["prompt"]["style_prompt"]:
            legacy_prompt = legacy.get("SYSTEM_PROMPT", "").strip()
            if legacy_prompt and result["prompt"]["style_preset"] == "custom":
                result["prompt"]["custom_system_prompt"] = legacy_prompt

    provider = infer_provider(result["api"].get("provider"), result["api"].get("base_url", ""))
    if provider not in PROVIDER_SPECS:
        raise ValueError(f"Unsupported provider: {provider}")
    result["api"]["provider"] = provider

    result["api"]["base_url"] = resolve_base_url(provider, result["api"]["base_url"])
    result["api"]["model"] = resolve_model(provider, result["api"]["model"])

    result["api"]["api_key"] = resolve_api_key(provider, result["api"]["api_key"])

    world_dir_raw = str(result["world_dir"]).strip()
    if world_dir_raw:
        world_dir = Path(world_dir_raw).expanduser()
        if not world_dir.is_absolute() and config_path is not None:
            world_dir = (config_path.parent / world_dir).resolve()
        else:
            world_dir = world_dir.resolve()
        result["world_dir"] = str(world_dir)

        report_path = result["report_path"] or str(world_dir / "translation_report.json")
        report_path = Path(report_path).expanduser()
        if not report_path.is_absolute():
            report_path = (world_dir / report_path).resolve()
        result["report_path"] = str(report_path)
        checkpoint_path = result["runtime"]["checkpoint_path"] or str(world_dir / ".translation_checkpoint.json")
        checkpoint_path = Path(checkpoint_path).expanduser()
        if not checkpoint_path.is_absolute():
            checkpoint_path = (world_dir / checkpoint_path).resolve()
        else:
            checkpoint_path = checkpoint_path.resolve()
        result["runtime"]["checkpoint_path"] = str(checkpoint_path)
    else:
        result["world_dir"] = ""
        result["report_path"] = result["report_path"] or ""
        result["runtime"]["checkpoint_path"] = result["runtime"]["checkpoint_path"] or ""

    zip_paths: list[str] = []
    for zip_path in result["resource_pack"]["zip_paths"]:
        path_obj = Path(zip_path).expanduser()
        if not path_obj.is_absolute() and result["world_dir"]:
            path_obj = (world_dir / path_obj).absolute()
        zip_paths.append(str(path_obj))
    result["resource_pack"]["zip_paths"] = zip_paths
    selected_paths = result["runtime"].get("authorized_external_pack_paths", [])
    if not isinstance(selected_paths, list) or any(not isinstance(path, str) for path in selected_paths):
        raise ValueError("External ZIP selections must be a list of paths")
    result["runtime"]["authorized_external_pack_paths"] = [
        str((world_dir / path).absolute()) if not Path(path).expanduser().is_absolute() and result["world_dir"]
        else str(Path(path).expanduser().absolute()) for path in selected_paths
    ]

    return result


MAX_CONSECUTIVE_REQUEST_FAILURES = 6


class ProviderUnavailable(RuntimeError):
    """Translation cannot continue: a fatal provider error or too many failures in a row."""

    def __init__(self, message: str, *, code: str = "PROVIDER_ERROR", fatal: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.fatal = fatal


class BatchTranslator:
    def __init__(
        self,
        config: dict[str, Any],
        progress_callback: Any = None,
        cancel_check: Any = None,
        initial_cache: dict[str, str] | None = None,
    ) -> None:
        self.config = config
        self.progress_callback = progress_callback
        self.cancel_check = cancel_check
        self.cache: dict[str, str] = dict(initial_cache or {})
        self.overrides: dict[str, str] = dict(config["scan"]["overrides"])
        self.client = LLMProviderClient(config)
        self.rpm_limit = int(config["api"].get("rpm_limit", 0))
        self.tpm_limit = int(config["api"].get("tpm_limit", 0))
        self.last_request_time = 0.0
        self.failed: dict[str, str] = {}
        self.failed_codes: dict[str, str] = {}
        runtime = config.get("runtime") or {}
        self.max_cost_usd = max(0.0, float(runtime.get("max_cost_usd") or 0))
        self.price = runtime.get("price") if isinstance(runtime.get("price"), dict) else None
        self.consecutive_failures = 0
        self.sleep = time.sleep
        self.concurrency = max(1, int(config["runtime"].get("concurrency", 1) or 1))
        self._lock = threading.RLock()
        self._throttle_lock = threading.Lock()
        self._abort: BaseException | None = None

    def throttle(self, batch_size: int) -> None:
        if self.rpm_limit <= 0 and self.tpm_limit <= 0:
            return
        # One clock for every worker, so the limits hold however many batches run at once.
        with self._throttle_lock:
            self._throttle(batch_size)

    def _throttle(self, batch_size: int) -> None:
        now = time.time()
        delay = 0.0
        if self.rpm_limit > 0:
            delay = max(delay, 60.0 / self.rpm_limit)

        if self.tpm_limit > 0:
            estimated_tokens = batch_size * 50
            delay = max(delay, (estimated_tokens / self.tpm_limit) * 60.0)

        elapsed = now - self.last_request_time
        if elapsed < delay:
            self.wait(delay - elapsed)

        self.last_request_time = time.time()

    def wait(self, seconds: float) -> None:
        """Sleep in short slices so a cancel request is noticed during long back-offs."""
        remaining = max(0.0, seconds)
        while remaining > 0:
            self.ensure_not_cancelled()
            step = min(0.5, remaining)
            self.sleep(step)
            remaining -= step

    def emit(self, event: str, **payload: Any) -> None:
        if self.progress_callback is not None:
            self.progress_callback({"event": event, **payload})

    def ensure_not_cancelled(self) -> None:
        if self._abort is not None:
            raise self._abort  # another worker already gave up: stop this one too
        if self.cancel_check is not None and self.cancel_check():
            raise TranslationCancelled("Translation was cancelled by the user.")

    def system_prompt(self) -> str:
        prompt_config = self.config["prompt"]
        if prompt_config["custom_system_prompt"]:
            base = prompt_config["custom_system_prompt"].strip()
        else:
            preset = STYLE_PRESETS[prompt_config["style_preset"]]
            base = preset.replace("{target_language}", prompt_config["target_language"])

        extra = prompt_config["style_prompt"].strip()
        if extra:
            base = f"{base}\n\n[추가 스타일 지시]\n{extra}"

        return (
            f"{base}\n\n"
            "반드시 JSON 형식으로 반환해라. 키(Key)는 그대로 두고 값(Value)만 번역해라."
        )

    def spent_usd(self) -> float | None:
        """Cost of this run so far: what the provider reported, else tokens at the model's list price."""
        usage = dict(LLMProviderClient.usage)
        if usage.get("cost_reported"):
            return float(usage.get("cost") or 0)
        price = self.price
        if price:
            return (
                float(usage.get("prompt_tokens") or 0) * float(price.get("input") or 0)
                + float(usage.get("completion_tokens") or 0) * float(price.get("output") or 0)
            )
        return None

    def _check_budget(self) -> None:
        if self.max_cost_usd <= 0:
            return
        spent = self.spent_usd()
        if spent is not None and spent >= self.max_cost_usd:
            stop = BudgetStopped(spent, self.max_cost_usd)
            with self._lock:
                if self._abort is None:
                    self._abort = stop
                else:
                    stop = self._abort if isinstance(self._abort, BudgetStopped) else stop
            raise stop

    def pending(self, texts: list[str]) -> list[str]:
        """Texts that still need a provider call: not cached and not manually overridden."""
        for text in texts:
            if text not in self.cache and text in self.overrides:
                self.cache[text] = self.overrides[text]
        return [text for text in texts if text not in self.cache or text in self.failed]

    def lookup(self, texts: list[str]) -> dict[str, str]:
        """Cache-only view. It never calls the provider."""
        return {text: self.cache.get(text, text) for text in texts}

    def translate_texts(self, texts: list[str]) -> dict[str, str]:
        self.ensure_not_cancelled()
        missing = self.pending(texts)
        if not missing:
            return self.lookup(texts)

        batch_size = max(1, int(self.config["batch_size"]))
        total = len(missing)
        groups = [missing[start : start + batch_size] for start in range(0, total, batch_size)]
        done = 0

        def finished(number: int, batch: list[str], translated: dict[str, str]) -> None:
            nonlocal done
            with self._lock:
                self.cache.update(translated)
                done += len(batch)
                failed = len(self.failed)
            self.emit(
                "translation_progress",
                completed=done,
                total=total,
                failed=failed,
                batch=number,
                batches=len(groups),
                requests=LLMProviderClient.request_count,
            )
            # A few finished pairs per batch let the screen show what the AI is producing.
            shown = 0
            for text in batch:
                answer = translated.get(text)
                if isinstance(answer, str) and answer and answer != text and shown < 3:
                    shown += 1
                    self.emit("translation_sample", source=_clip(text), translated=_clip(answer))
            self._check_budget()

        workers = min(self.concurrency, len(groups))
        if workers <= 1:
            for number, batch in enumerate(groups, start=1):
                self.ensure_not_cancelled()
                finished(number, batch, self._translate_batch(batch, batch_size))
            return self.lookup(texts)

        stopped: BaseException | None = None
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="pomi-translate") as pool:
            futures = {pool.submit(self._translate_batch, batch, batch_size): (number, batch) for number, batch in enumerate(groups, start=1)}
            try:
                for future in as_completed(futures):
                    number, batch = futures[future]
                    finished(number, batch, future.result())
            except BaseException as exc:
                self._abort = exc
                for pending in futures:
                    pending.cancel()
                stopped = exc
        if stopped is not None:
            # Batches already in flight when this stopped were paid for; keep their answers.
            with self._lock:
                for future in futures:
                    if future.done() and not future.cancelled() and future.exception() is None:
                        self.cache.update(future.result())
            raise stopped
        return self.lookup(texts)

    def _note_failure(self, exc: Exception, *, attempt: int, max_retries: int, batch_size: int) -> float:
        """Record one failed request and return how long to wait before the next try."""
        status = getattr(exc, "status", None)
        code = getattr(exc, "code", "REQUEST_FAILED")
        # Only outages count toward the circuit breaker. A rejected or malformed answer for one
        # batch says nothing about the next one.
        with self._lock:
            provider_outage = isinstance(exc, ProviderError) and (status is None or status == 429 or status >= 500)
            if provider_outage:
                self.consecutive_failures += 1
            streak = self.consecutive_failures
            abort: ProviderUnavailable | None = None
            if getattr(exc, "fatal", False):
                abort = ProviderUnavailable(str(exc), code=code, fatal=True)
            elif streak >= MAX_CONSECUTIVE_REQUEST_FAILURES:
                abort = ProviderUnavailable(
                    f"{streak} requests in a row failed. Last error: {exc}",
                    code=code,
                )
            # Publish the breaker while the failure counter is still locked. Otherwise a worker
            # can take another queued batch before the coordinator observes this exception.
            if abort is not None:
                if self._abort is None:
                    self._abort = abort
                elif isinstance(self._abort, ProviderUnavailable):
                    abort = self._abort
        self.emit(
            "translation_batch_error",
            batch_size=batch_size,
            attempt=attempt,
            max_attempts=max_retries,
            code=code,
            status=status,
            message=str(exc),
        )
        if abort is not None:
            raise abort from exc
        retry_after = getattr(exc, "retry_after", None)
        if retry_after:
            return float(retry_after)
        if status == 429:
            return min(2.0 * (2 ** (attempt - 1)), 30.0)
        return min(1.5 * attempt, 4.0)

    def _translate_batch(self, texts: list[str], batch_size: int) -> dict[str, str]:
        payload = {str(i): text for i, text in enumerate(texts)}
        max_retries = max(1, int(self.config["runtime"]["max_batch_retries"]))
        last_error = ""
        last_exc: BaseException | None = None
        for attempt in range(1, max_retries + 1):
            self.ensure_not_cancelled()
            try:
                self.throttle(len(texts))
                # The breaker may have tripped while this worker waited for the shared throttle.
                self.ensure_not_cancelled()
                self._check_budget()
                self.emit("translation_batch_start", batch_size=len(texts), attempt=attempt, max_attempts=max_retries)
                parsed = self.client.translate_mapping(
                    payload,
                    system_prompt=self.system_prompt(),
                    temperature=float(self.config["temperature"]),
                )
                self.emit("translation_batch_done", batch_size=len(texts), attempt=attempt)
                with self._lock:
                    self.consecutive_failures = 0
                    for text in texts:
                        self.failed.pop(text, None)
                        self.failed_codes.pop(text, None)
                return {
                    text: parsed.get(str(i), text)
                    for i, text in enumerate(texts)
                }
            except (TranslationCancelled, ProviderUnavailable):
                raise
            except Exception as exc:
                last_error = str(exc)
                last_exc = exc
                try:
                    delay = self._note_failure(exc, attempt=attempt, max_retries=max_retries, batch_size=len(texts))
                except ProviderUnavailable:
                    # A fatal/breaker stop still needs row-level reasons for this attempted batch.
                    with self._lock:
                        for text in texts:
                            self.failed[text] = last_error
                            self.failed_codes[text] = classify_failure(exc)
                    raise
                self._check_budget()
                if attempt < max_retries:
                    self.wait(delay)

        if len(texts) > 1:
            next_size = max(1, len(texts) // 5)
            merged: dict[str, str] = {}
            for i in range(0, len(texts), next_size):
                self.ensure_not_cancelled()
                merged.update(self._translate_batch(texts[i : i + next_size], next_size))
            return merged
        # A single string that never translated is recorded, not passed off as translated.
        with self._lock:
            self.failed[texts[0]] = last_error or "The provider did not return a translation."
            self.failed_codes[texts[0]] = classify_failure(last_exc) if last_exc is not None else "unknown"
        return {}


class WorldTranslator(TextExtractionMixin):
    def __init__(
        self,
        config: dict[str, Any],
        progress_callback: Any = None,
        cancel_check: Any = None,
    ) -> None:
        self.config = config
        self.scan_config = config["scan"]
        self.runtime_config = config["runtime"]
        self.external_pack_inputs: dict[str, str] = {}
        self.external_pack_parents: dict[str, str] = {}
        self.component_prefixes = tuple(self.scan_config["component_translate_key_prefixes"])
        self.skip_patterns = tuple(self.scan_config["skip_patterns"])
        self.progress_callback = progress_callback
        self.cancel_check = cancel_check
        self.checkpoint_path = Path(self.runtime_config["checkpoint_path"]) if self.runtime_config["checkpoint_path"] else None
        self.resume_from_checkpoint = bool(self.runtime_config["resume_from_checkpoint"])
        self.checkpoint_loaded = False
        self.completed_region_files: set[str] = set()
        self.completed_resource_pack_paths: set[str] = set()
        self.translation_cache: dict[str, str] = {}
        self.candidate_texts: set[str] = set()
        self.file_errors: list[dict[str, Any]] = []
        self._candidate_order: dict[str, None] = {}
        self.occurrences: dict[str, dict[str, Any]] = {}
        self.final_translations: dict[str, str] = {}
        self.file_scan: dict[str, dict[str, Any]] = {}
        # Desktop review flow: the user's edits to translations, the usage of earlier runs of this
        # job, and the write that already happened (so a later correction can restore it first).
        self.edits: dict[str, str] = {}
        self.prior_usage: dict[str, Any] = {}
        self.applied: dict[str, Any] | None = None
        self.stop_code: str = ""
        self._adopted_failures: dict[str, Any] = {}
        self._run_backup = None
        self._write_lock = None
        self._session_locks = None
        self.report: dict[str, Any] = {
            "world_dir": config["world_dir"],
            "dry_run": config["dry_run"],
            "provider": config["api"]["provider"],
            "model": config["api"]["model"],
            "status": "running",
            "changed_files": [],
            "resource_packs": [],
            "errors": [],
            "warnings": [],
        }
        self.load_checkpoint()
        adopted = self.runtime_config.get("adopt_checkpoint")
        if not self.checkpoint_loaded and isinstance(adopted, dict):
            self.adopt_checkpoint(adopted, keep_report=bool(self.runtime_config.get("adopt_report")))
        for source, text in (self.runtime_config.get("edits") or {}).items():
            # An edit equal to the saved translation, or null, takes the string back to the AI's answer.
            if text is None or text == self.translation_cache.get(source):
                self.edits.pop(source, None)
            else:
                self.edits[source] = text
        self.translator = None if config["dry_run"] else BatchTranslator(
            config,
            progress_callback=lambda event: self.emit(
                event["event"], **{key: value for key, value in event.items() if key != "event"}
            ),
            cancel_check=self.is_cancelled,
            initial_cache=self.translation_cache,
        )
        if self.translator is not None:
            for text, info in self._adopted_failures.items():
                if isinstance(info, dict):
                    self.translator.failed[text] = str(info.get("detail") or "")
                    self.translator.failed_codes[text] = str(info.get("reason") or "unknown")

    def emit(self, event: str, **payload: Any) -> None:
        if self.progress_callback is not None:
            self.progress_callback({"event": event, **payload})

    def is_cancelled(self) -> bool:
        return bool(self.cancel_check is not None and self.cancel_check())

    def ensure_not_cancelled(self) -> None:
        if self.is_cancelled():
            self.report["status"] = "cancelled"
            self.save_checkpoint()
            raise TranslationCancelled("Translation was cancelled by the user.")

    def release_write_lock(self) -> None:
        if self._session_locks is not None:
            self._session_locks.release()
            self._session_locks = None
        if self._write_lock is not None:
            self._write_lock.release()
            self._write_lock = None

    def checkpoint_config_fingerprint(self) -> str:
        """Identify settings that would make a resumed translation inconsistent."""
        relevant_config = {
            "world_dir": self.config["world_dir"],
            "dry_run": self.config["dry_run"],
            "batch_size": self.config["batch_size"],
            "temperature": self.config["temperature"],
            "api": {
                "provider": self.config["api"]["provider"],
                "base_url": self.config["api"]["base_url"],
                "model": self.config["api"]["model"],
            },
            "prompt": self.config["prompt"],
            "scan": self.config["scan"],
            "resource_pack": self.config["resource_pack"],
            "runtime": {
                "excluded_candidate_ids": sorted(self.runtime_config.get("excluded_candidate_ids") or []),
                "scan_plan_id": str(self.runtime_config.get("scan_plan_id") or ""),
                "adapter_version": 1,
                "translation_strategy_version": 2,
            },
        }
        encoded = json.dumps(relevant_config, ensure_ascii=False, sort_keys=True).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def checkpoint_payload(self) -> dict[str, Any]:
        from mwt.safety import world_fingerprint

        self.refresh_report_counts()
        return {
            "version": 2,
            "world_dir": self.config["world_dir"],
            "provider": self.config["api"]["provider"],
            "model": self.config["api"]["model"],
            "dry_run": self.config["dry_run"],
            "config_fingerprint": self.checkpoint_config_fingerprint(),
            "world_fingerprint": world_fingerprint(Path(self.config["world_dir"])),
            "resume": {
                "scan_plan_id": str(self.runtime_config.get("scan_plan_id") or ""),
                "translation_settings_fingerprint": str(self.runtime_config.get("translation_settings_fingerprint") or ""),
                "expected_world_fingerprint": str(self.runtime_config.get("expected_world_fingerprint") or ""),
                "excluded_candidate_ids": list(self.runtime_config.get("excluded_candidate_ids") or []),
                "manual_overrides": dict(self.scan_config.get("overrides") or {}),
            },
            "completed_region_files": sorted(self.completed_region_files),
            "completed_resource_pack_paths": sorted(self.completed_resource_pack_paths),
            "translation_cache": self.translator.cache if self.translator is not None else self.translation_cache,
            "candidate_texts": sorted(self.candidate_texts),
            "report": self.report,
            # Additive fields (older checkpoints lack them and still resume): why strings failed,
            # the user's edits, what every run of this job cost, and the write that was applied.
            "failures": self.failure_info(),
            "edits": dict(self.edits),
            "usage_total": self.usage_total(),
            "stop_code": self.stop_code,
            "applied": self.applied,
            "saved_at": time.time(),
        }

    def adopt_checkpoint(self, checkpoint: dict[str, Any], *, keep_report: bool = False) -> None:
        """Take over a saved job's translations without the resume checks.

        Applying or retrying a reviewed job must not depend on the settings fingerprint (the user's
        edits change it) or on the world still matching the checkpoint (an applied job's world has
        changed on purpose). The caller has already checked what matters for its own request.
        """
        self.translation_cache = dict(checkpoint.get("translation_cache") or {})
        self.candidate_texts = set(checkpoint.get("candidate_texts") or [])
        self.prior_usage = dict(checkpoint.get("usage_total") or {})
        self.edits = {k: v for k, v in dict(checkpoint.get("edits") or {}).items() if isinstance(v, str)}
        self.applied = checkpoint.get("applied") or None
        self.stop_code = str(checkpoint.get("stop_code") or "")
        self._adopted_failures = dict(checkpoint.get("failures") or {})
        if keep_report and isinstance(checkpoint.get("report"), dict):
            self.report.update(checkpoint["report"])
            self.completed_region_files = set(checkpoint.get("completed_region_files") or [])
            self.completed_resource_pack_paths = set(checkpoint.get("completed_resource_pack_paths") or [])

    def failure_info(self) -> dict[str, dict[str, str]]:
        if self.translator is None:
            return {}
        return {
            text: {"reason": self.translator.failed_codes.get(text, "unknown"), "detail": str(detail)[:300]}
            for text, detail in self.translator.failed.items()
        }

    def usage_total(self) -> dict[str, Any]:
        """Usage of every run of this job: earlier runs from the checkpoint plus the current one."""
        current = dict(LLMProviderClient.usage)
        prior = self.prior_usage
        return {
            "prompt_tokens": int(prior.get("prompt_tokens") or 0) + int(current.get("prompt_tokens") or 0),
            "completion_tokens": int(prior.get("completion_tokens") or 0) + int(current.get("completion_tokens") or 0),
            "cost": float(prior.get("cost") or 0) + float(current.get("cost") or 0),
            "cost_reported": bool(prior.get("cost_reported") or current.get("cost_reported")),
            # Requests of the whole job too, so a result never pairs one call's count with the job's cost.
            "requests": int(prior.get("requests") or 0) + int(LLMProviderClient.request_count),
        }

    def load_checkpoint(self) -> None:
        if not self.resume_from_checkpoint or self.checkpoint_path is None:
            return
        checkpoint = load_json_file(self.checkpoint_path)
        if not checkpoint:
            return
        if checkpoint.get("world_dir") != self.config["world_dir"]:
            self.emit("checkpoint_ignored", reason="world_dir")
            return
        if checkpoint.get("config_fingerprint") != self.checkpoint_config_fingerprint():
            self.emit("checkpoint_ignored", reason="settings")
            return
        from mwt.safety import world_fingerprint

        current_fingerprint = world_fingerprint(Path(self.config["world_dir"]))
        if checkpoint.get("world_fingerprint") != current_fingerprint:
            self.emit("checkpoint_ignored", reason="world_fingerprint")
            return
        self.completed_region_files = set(checkpoint.get("completed_region_files", []))
        self.completed_resource_pack_paths = set(checkpoint.get("completed_resource_pack_paths", []))
        self.translation_cache = dict(checkpoint.get("translation_cache", {}))
        self.candidate_texts = set(checkpoint.get("candidate_texts", []))
        self.prior_usage = dict(checkpoint.get("usage_total") or {})
        self.edits = dict(checkpoint.get("edits") or {})
        self.applied = checkpoint.get("applied") or None
        self.stop_code = str(checkpoint.get("stop_code") or "")
        self._adopted_failures = dict(checkpoint.get("failures") or {})
        saved_report = checkpoint.get("report")
        if isinstance(saved_report, dict):
            self.report.update(saved_report)
            self.report["status"] = "running"
        backup_set_id = str(self.report.get("backup_set_id") or "")
        if backup_set_id:
            from mwt.safety import BackupSet

            self._run_backup = BackupSet.open_existing(
                Path(self.config["world_dir"]), backup_set_id, self._backup_store(),
                external_files=self._external_backup_files(),
            )
        self.checkpoint_loaded = True
        self.emit(
            "checkpoint_loaded",
            completed_region_files=len(self.completed_region_files),
            completed_resource_packs=len(self.completed_resource_pack_paths),
        )

    def clear_checkpoint(self) -> None:
        if self.checkpoint_path is not None and self.checkpoint_path.exists():
            try:
                self.checkpoint_path.unlink()
            except FileNotFoundError:
                pass

    def save_checkpoint(self) -> None:
        if not self.runtime_config["checkpoint_enabled"] or self.checkpoint_path is None:
            return
        write_text_atomic(
            self.checkpoint_path,
            json.dumps(self.checkpoint_payload(), ensure_ascii=False, indent=2),
        )

    def refresh_report_counts(self) -> None:
        self.report["changed_file_count"] = len(
            {
                path
                for item in self.report["changed_files"]
                if item.get("changed_chunks", 0) > 0
                for path in item.get("written_files", [item["file"]])
            } | {
            item["zip_path"] for item in self.report["resource_packs"]
            if item.get("translated_files", 0) > 0
            }
        )  # Count physical region/.mcc/ZIP paths; old checkpoints fall back to region.
        self.report["candidate_file_count"] = len(
            [item for item in self.report["changed_files"] if item.get("candidates", 0) > 0]
        ) + len({
            item["zip_path"] for item in self.report["resource_packs"]
            if item.get("candidates", 0) > 0
        })
        self.report["candidate_text_count"] = len(self.candidate_texts)

    def run(self) -> dict[str, Any]:
        LLMProviderClient.reset_counters()
        if not self.checkpoint_loaded:
            self._run_backup = None
        self._write_lock = None
        self._session_locks = None
        world_dir = Path(self.config["world_dir"]).resolve()
        if not world_dir.exists() or not world_dir.is_dir():
            msg = f"World directory not found or invalid: {world_dir}"
            self.emit("file_error", file=str(world_dir), message=msg)
            self.report["status"] = "failed"
            self.report["error"] = msg
            return self.report

        try:
            from mwt.layout import detect_write_blockers
            from mwt.locking import MinecraftSessionLocks, MinecraftWorldInUse, WorldWriteLock, WorldWriteLocked
            from mwt.safety import world_fingerprint

            blockers = detect_write_blockers(world_dir)
            self.report["write_blockers"] = blockers
            if blockers:
                self.report["status"] = "unsupported"
                self.report["errors"].append({"scope": "layout", "message": ",".join(blockers)})
                self.refresh_report_counts()
                self.write_report()
                self.release_write_lock()
                return self.report

            if not self.config["dry_run"]:
                self._write_lock = WorldWriteLock(world_dir)
                try:
                    self._write_lock.acquire()
                except WorldWriteLocked as exc:
                    self.report["status"] = "locked"
                    self.report["errors"].append({"scope": "world_lock", "message": str(exc)})
                    self.refresh_report_counts()
                    self.write_report()
                    self.release_write_lock()
                    return self.report
                self._session_locks = MinecraftSessionLocks(world_dir)
                try:
                    self._session_locks.acquire()
                except MinecraftWorldInUse as exc:
                    self.report["status"] = "locked"
                    self.report["errors"].append({"scope": "minecraft_session", "message": str(exc)})
                    self.refresh_report_counts()
                    self.write_report()
                    self.release_write_lock()
                    return self.report

            fingerprint = world_fingerprint(world_dir)
            self.report["world_fingerprint"] = fingerprint
            expected = str(self.runtime_config.get("expected_world_fingerprint") or "")
            if expected and expected != fingerprint and not self.checkpoint_loaded:
                self.report["status"] = "invalidated"
                self.report["errors"].append({"scope": "plan", "message": "World changed after scan"})
                self.refresh_report_counts()
                self.write_report()
                self.release_write_lock()
                return self.report
            if (
                not self.config["dry_run"]
                and self.config["backup"]
                and self.config["resource_pack"]["enabled"]
            ):
                self._preflight_resource_pack_backup_paths(world_dir)
            if (
                not self.config["dry_run"]
                and self.translator is not None
                and not self.runtime_config.get("skip_provider_validation", False)
            ):
                try:
                    self.translator.client.try_refresh_text_models()
                except ModelCatalogError as exc:
                    self.report["status"] = "failed"
                    self.report["error"] = str(exc)
                    self.report["errors"].append({"scope": "models", "message": str(exc)})
                    self.refresh_report_counts()
                    self.write_report()
                    self.release_write_lock()
                    return self.report
                if self.translator.client.model_info:
                    info = self.translator.client.model_info
                    self.report["model_info"] = {
                        "id": info.get("id", ""),
                        "display_name": info.get("display_name", ""),
                        "description": info.get("description", ""),
                        "context_length": info.get("context_length"),
                    }
            dry_run = bool(self.config["dry_run"])
            if self.config["resource_pack"]["enabled"]:
                self.ensure_not_cancelled()
                self.emit("resource_pack_start")
                self.collect_resource_packs()
                self.emit(
                    "resource_pack_done",
                    count=len(self.report["resource_packs"]),
                    candidate_text_count=len(self.candidate_texts),
                )

            region_files = self.iter_region_files()
            pending_files = [path for path in region_files if str(path) not in self.completed_region_files]
            total_files = len(pending_files)
            self.emit(
                "scan_start",
                phase="collect",
                total_files=total_files,
                skipped_completed=len(region_files) - total_files,
            )
            for index, file_path in enumerate(pending_files, start=1):
                self.ensure_not_cancelled()
                self.emit("file_start", phase="collect", index=index, total=total_files, file=str(file_path))
                result = self._run_file_step(self.collect_region_file, file_path)
                self.file_scan[str(file_path)] = result
                if dry_run and (result["changed_chunks"] > 0 or result.get("candidates", 0) > 0 or result.get("skipped")):
                    self.report["changed_files"].append(result)
                self.emit(
                    "file_done",
                    phase="collect",
                    index=index,
                    total=total_files,
                    file=str(file_path),
                    changed_chunks=0,
                    candidates=result.get("candidates", 0),
                    candidate_text_count=len(self._candidate_order),
                    skipped=result.get("skipped", ""),
                )

            if dry_run:
                return self._finish("partial" if self._left_untranslated() else "completed")

            ordered = list(self._candidate_order)
            batch_size = max(1, int(self.config["batch_size"]))
            if self.runtime_config.get("apply_only"):
                # Writing what the checkpoint already holds: no phase of this run may call the provider.
                resolved = self._resolve_for_apply(ordered)
                self.final_translations = self._guard_translations(ordered, resolved)
                self.report["translation"] = self._translation_stats(ordered, resolved)
                self.save_checkpoint()
            else:
                self.emit(
                    "phase_start",
                    phase="translate",
                    total=len(ordered),
                    batch_size=batch_size,
                    requests_estimate=math.ceil(len(self.translator.pending(ordered)) / batch_size),
                )
                review = bool(self.runtime_config.get("review_before_apply"))
                try:
                    self.translator.translate_texts(ordered)
                except BudgetStopped as exc:
                    return self._stop_before_write(ordered, None, budget=exc)
                except ProviderUnavailable as exc:
                    return self._stop_before_write(ordered, exc)
                self.final_translations = self._guard_translations(ordered, self.translator.cache)
                self.report["translation"] = self._translation_stats(ordered)
                if review:
                    return self._await_review()
                if self.translator.failed and str(self.runtime_config.get("on_translation_failure") or "stop") != "skip":
                    return self._stop_before_write(ordered, None)
                self.save_checkpoint()

            self._verify_external_pack_inputs()
            self.emit("phase_start", phase="write", total=len(pending_files))
            # Recheck after collection/translation and its callbacks, before the first backup/write.
            if world_fingerprint(world_dir) != fingerprint:
                raise PlanInvalidated("World changed during translation. Rescan before writing.")
            if self.config["resource_pack"]["enabled"]:
                self.write_resource_packs()
            for index, file_path in enumerate(pending_files, start=1):
                self.ensure_not_cancelled()
                self.emit("file_start", phase="write", index=index, total=total_files, file=str(file_path))
                scanned = self.file_scan.get(str(file_path), {})
                if scanned.get("skipped") or not scanned.get("candidates", 0):
                    result = scanned
                else:
                    result = self._run_file_step(self.apply_region_file, file_path)
                if result.get("skipped") not in {"file_error", "parse_error"}:
                    self.completed_region_files.add(str(file_path))
                if result["changed_chunks"] > 0 or result.get("candidates", 0) > 0 or result.get("skipped"):
                    self.report["changed_files"].append(result)
                self.save_checkpoint()
                self.emit(
                    "file_done",
                    phase="write",
                    index=index,
                    total=total_files,
                    file=str(file_path),
                    changed_chunks=result["changed_chunks"],
                    candidates=result.get("candidates", 0),
                    candidate_text_count=len(self.candidate_texts),
                    skipped=result.get("skipped", ""),
                )

            return self._finish("partial" if self._left_untranslated() else "completed")
        except PlanInvalidated as exc:
            self.report["errors"].append({"scope": "plan", "message": str(exc)})
            return self._finish("invalidated")
        except TranslationCancelled:
            self.report["status"] = "cancelled"
            self.report["provider_requests"] = LLMProviderClient.request_count
            self.report["usage"] = dict(LLMProviderClient.usage)
            self.refresh_report_counts()
            self.write_report()
            self.save_checkpoint()
            self.emit(
                "cancelled",
                changed_file_count=self.report.get("changed_file_count", 0),
                candidate_file_count=self.report.get("candidate_file_count", 0),
                candidate_text_count=self.report.get("candidate_text_count", 0),
            )
            self.release_write_lock()
            return self.report
        except Exception as exc:
            error_entry = {
                "scope": "run",
                "message": str(exc) or exc.__class__.__name__,
            }
            self.report["status"] = "failed"
            self.report["errors"].append(error_entry)
            self.report["provider_requests"] = LLMProviderClient.request_count
            self.report["usage"] = dict(LLMProviderClient.usage)
            self.refresh_report_counts()
            self.write_report()
            self.save_checkpoint()
            self.emit("fatal_error", message=error_entry["message"])
            self.release_write_lock()
            raise

    def iter_region_files(self) -> list[Path]:
        world_dir = Path(self.config["world_dir"]).resolve()
        files: list[Path] = []
        seen: set[Path] = set()
        configured_dirs = [str(item) for item in self.scan_config.get("region_dirs", [])]
        if self.scan_config.get("discover_layout", True):
            from mwt.layout import discover_region_dirs

            for relative in discover_region_dirs(world_dir):
                if relative not in configured_dirs:
                    configured_dirs.append(relative)
        for configured_dir in configured_dirs:
            directory = Path(str(configured_dir)).expanduser()
            directory = directory.resolve() if directory.is_absolute() else (world_dir / directory).resolve()
            if directory != world_dir and world_dir not in directory.parents:
                raise ValueError(f"Configured region directory is outside the world folder: {configured_dir}")
            if not directory.is_dir():
                continue
            for path in sorted(directory.glob("*.mca")):
                relative_path = path.relative_to(world_dir).as_posix()
                if any(
                    fnmatch.fnmatch(path.name, pattern) or fnmatch.fnmatch(relative_path, pattern)
                    for pattern in self.skip_patterns
                ):
                    continue
                resolved_path = path.resolve()
                if not resolved_path.is_relative_to(world_dir):
                    raise ValueError("Region file source is outside the selected world")
                if resolved_path not in seen:
                    seen.add(resolved_path)
                    files.append(resolved_path)
        return files

    @staticmethod
    def parse_nbt_bytes(raw_nbt: bytes) -> nbt.TAG_Compound:
        return nbt.parse(raw_nbt)

    @staticmethod
    def dump_nbt_bytes(root: nbt.TAG_Compound) -> bytes:
        return root.dump()

    @staticmethod
    def load_chunk_payload(data: bytes, sector_offset: int) -> tuple[int, bytes, int]:
        byte_offset = sector_offset * 4096
        if byte_offset + 5 > len(data):
            raise ValueError("Chunk offset out of bounds")
        length = int.from_bytes(data[byte_offset : byte_offset + 4], "big")
        if length <= 1 or byte_offset + 4 + length > len(data):
            raise ValueError("Invalid chunk length")
        compression = data[byte_offset + 4]
        payload = data[byte_offset + 5 : byte_offset + 4 + length]
        return compression, payload, length

    @staticmethod
    def decompress_payload(compression: int, payload: bytes) -> bytes:
        if compression == 1:
            import gzip

            return gzip.decompress(payload)
        if compression == 2:
            return zlib.decompress(payload)
        if compression == 3:
            return payload
        raise ValueError(f"Unsupported compression type: {compression}")

    @staticmethod
    def compress_payload(compression: int, raw_nbt: bytes) -> bytes:
        if compression == 1:
            import gzip

            return gzip.compress(raw_nbt)
        if compression == 2:
            return zlib.compress(raw_nbt)
        if compression == 3:
            return raw_nbt
        raise ValueError(f"Unsupported compression type: {compression}")

    def backup_once(self, path: Path) -> None:
        if not self.config["backup"]:
            return
        from mwt.safety import BackupSet

        world_dir = Path(self.config["world_dir"]).resolve()
        resolved = path.resolve()
        external_files = self._external_backup_files()
        if not resolved.is_relative_to(world_dir) and resolved not in {path.resolve() for path in external_files}:
            raise ValueError("Backup source is outside the selected world")
        if self._run_backup is None:
            self._run_backup = BackupSet.new(world_dir, store=self._backup_store(), external_files=external_files)
        self._run_backup.add(resolved)
        self._run_backup.verify()
        self._run_backup.publish_latest()
        self.report["backup_set_id"] = self._run_backup.backup_id

    def _preflight_resource_pack_backup_paths(self, world_dir: Path) -> None:
        """Only explicitly selected external ZIP targets may extend the world write scope."""
        world_root = world_dir.resolve()
        external_files = self._external_backup_files()
        authorized = {path.resolve() for path in external_files}
        expected = self.runtime_config.get("expected_external_pack_fingerprints", {})
        if not isinstance(expected, dict):
            raise ValueError("External resource-pack fingerprints must be an object")
        # Validate target availability and parent identity before any provider request.
        from mwt.safety import BackupSet
        BackupSet(world_root, "preflight", self._backup_store(), external_files=external_files)
        for configured_path in self.config["resource_pack"]["zip_paths"]:
            try:
                resolved = Path(configured_path).expanduser().resolve(strict=False)
            except (OSError, RuntimeError) as exc:
                raise ValueError(
                    f"Could not safely resolve resource-pack backup source: {configured_path}"
                ) from exc
            if not resolved.is_relative_to(world_root) and resolved not in authorized:
                raise ValueError(
                    f"Resource-pack backup source is outside the selected world: {configured_path}"
                )
            if Path(configured_path).expanduser().is_symlink():
                raise ValueError("Resource-pack symbolic links cannot be safely backed up and restored")
            if resolved in authorized and (not os.access(resolved, os.W_OK) or not os.access(resolved.parent, os.W_OK)):
                raise ValueError("External resource pack is not writable")
            if resolved in authorized:
                digest = file_sha256(resolved)
                parent = resolved.parent.stat()
                identity = f"{parent.st_dev}:{parent.st_ino}"
                planned = expected.get(str(resolved))
                expected_hash = planned.get("sha256") if isinstance(planned, dict) else planned
                expected_parent = planned.get("parentIdentity") if isinstance(planned, dict) else None
                if (expected_hash is not None and expected_hash != digest) or (expected_parent is not None and expected_parent != identity):
                    raise PlanInvalidated("An external resource pack changed after scan")
                self.external_pack_inputs[str(resolved)] = digest
                self.external_pack_parents[str(resolved)] = identity

    def _verify_external_pack_inputs(self) -> None:
        for path, digest in self.external_pack_inputs.items():
            target = Path(path)
            parent = target.parent.stat() if target.parent.is_dir() else None
            identity = f"{parent.st_dev}:{parent.st_ino}" if parent else None
            if target.is_symlink() or not target.is_file() or identity != self.external_pack_parents[path] or file_sha256(target) != digest:
                raise PlanInvalidated("An external resource pack changed during translation. Rescan before writing.")

    def _external_backup_files(self) -> list[Path]:
        if not self.config["resource_pack"]["enabled"]:
            return []
        selected = self.runtime_config.get("authorized_external_pack_paths", [])
        if not isinstance(selected, list) or len(selected) > 16 or any(not isinstance(path, str) for path in selected):
            raise ValueError("External resource-pack authorization must be a list of at most 16 ZIP paths")
        configured = {Path(path).expanduser().resolve() for path in self.config["resource_pack"]["zip_paths"]}
        paths = [Path(path).expanduser() for path in selected]
        if any(not path.is_absolute() or path.resolve() not in configured for path in paths):
            raise ValueError("External resource-pack authorization does not match the selected inputs")
        return paths

    def _guard_translations(self, texts: list[str], translations: dict[str, str]) -> dict[str, str]:
        from mwt.tokens import _without_trailing_reset, preserve_tokens, tokens_preserved

        guarded = {}
        for text in texts:
            answer = translations.get(text, text)
            translated = preserve_tokens(text, answer)
            problem = ""
            if not isinstance(answer, str) or not answer.strip():
                problem = "The provider returned an empty or invalid translation."
            elif not tokens_preserved(text, _without_trailing_reset(text, answer)):
                problem = "The translation's format tokens differ from the original."
            # NBT stores a string with a 16-bit length. Keep the original rather than fail the file.
            if len(translated.encode("utf-8")) > 30000:
                translated = text
                problem = "The translation exceeds the safe NBT string length."
            if problem and self.translator is not None and self.runtime_config.get("keep_checkpoint"):
                # Desktop review/retry can correct unusable answers. Legacy CLI still counts
                # these as kept originals, preserving its single-pass behavior.
                self.translator.failed[text] = problem
                self.translator.failed_codes[text] = "invalid_response"
            guarded[text] = translated
        return guarded

    def _write_world_bytes(self, path: Path, content: bytes) -> None:
        last_error: Exception | None = None
        for attempt in range(1, max(1, int(self.runtime_config["max_file_write_retries"])) + 1):
            try:
                write_bytes_atomic(path, content)
                last_error = None
                break
            except Exception as exc:
                last_error = exc
                self.emit("file_write_retry", file=str(path), attempt=attempt, message=str(exc))
                time.sleep(min(0.5 * attempt, 2.0))
        if last_error is not None:
            raise last_error

    def _backup_store(self) -> Path | None:
        """The configured backup folder, or ``None`` for the legacy folder inside the world."""
        configured = str(self.runtime_config.get("backup_store") or "")
        return Path(configured) if configured else None

    def _relative(self, path: Path) -> str:
        try:
            return path.resolve().relative_to(Path(self.config["world_dir"]).resolve()).as_posix()
        except ValueError:
            return str(path)

    def _warn(self, code: str, **details: Any) -> None:
        self.report["warnings"].append({"code": code, **details})

    def _add_candidates(self, texts: Any) -> None:
        for text in texts:
            self.candidate_texts.add(text)
            self._candidate_order.setdefault(text, None)

    def _run_file_step(self, step: Any, file_path: Path) -> dict[str, Any]:
        try:
            return step(file_path)
        except (TranslationCancelled, ProviderUnavailable):
            raise
        except Exception as exc:
            result = {
                "file": str(file_path),
                "changed_chunks": 0,
                "unique_texts": 0,
                "candidates": 0,
                "skipped": "file_error",
                "error": str(exc),
            }
            self.file_errors.append(result)
            self.report["errors"].append(result)
            self.emit("file_error", file=str(file_path), message=str(exc))
            if not self.runtime_config["continue_on_file_error"]:
                raise
            return result

    def _open_region(self, path: Path) -> tuple[Any, dict[str, Any] | None]:
        from mwt.region import RegionFile

        self.ensure_not_cancelled()
        if path.stat().st_size < 8192:
            return None, {"file": str(path), "changed_chunks": 0, "unique_texts": 0, "candidates": 0, "skipped": "small"}
        try:
            return RegionFile.read(path), None
        except Exception as exc:
            self._warn("file_unreadable", file=self._relative(path), message=str(exc)[:200])
            return None, {
                "file": str(path),
                "changed_chunks": 0,
                "unique_texts": 0,
                "candidates": 0,
                "skipped": "parse_error",
                "error": str(exc),
            }

    def _chunk_refs(self, region: Any, path: Path, stats: dict[str, Any]):
        """Yield (chunk, root, refs, occurrences) for every chunk that can be read. Count the rest."""
        for chunk in region.chunks:
            self.ensure_not_cancelled()
            if chunk.empty or chunk.unsupported:
                continue
            if chunk.malformed or chunk.raw_nbt is None:
                stats["unreadable_chunks"] += 1
                stats.setdefault("unreadable_sample", "The chunk record could not be decompressed.")
                continue
            try:
                root = self.parse_nbt_bytes(chunk.raw_nbt)
            except Exception as exc:
                chunk.malformed = True
                chunk.raw_nbt = None
                stats["unreadable_chunks"] += 1
                stats.setdefault("unreadable_sample", f"{type(exc).__name__}: {exc}"[:200])
                continue
            refs: list[TextRef] = []
            self.collect_tag_refs(root, refs, f"{path.name}#{chunk.index}")
            yield chunk, root, refs, self.extract_occurrences(refs)

    def _note_occurrence(self, text: str, ref: TextRef, path: Path, chunk_index: int) -> None:
        from mwt.region import chunk_coords, region_coordinates

        entry = self.occurrences.setdefault(text, {"count": 0, "kinds": {}, "locations": []})
        entry["count"] += 1
        entry["kinds"][ref.category] = entry["kinds"].get(ref.category, 0) + 1
        if len(entry["locations"]) < 5:
            region_x, region_z = region_coordinates(path)
            chunk_x, chunk_z = chunk_coords(chunk_index, region_x, region_z)
            entry["locations"].append(
                {
                    "kind": ref.category,
                    "holder": ref.scope.holder,
                    "pos": list(ref.scope.pos) if ref.scope.pos else None,
                    "detail": ref.detail,
                    "chunk": [chunk_x, chunk_z],
                    "file": self._relative(path),
                }
            )

    def collect_region_file(self, path: Path) -> dict[str, Any]:
        """Find translatable text in one region file. Never calls the provider or writes."""
        region, early = self._open_region(path)
        if early is not None:
            return early
        locked = bool(region.unsupported_ids)
        stats: dict[str, Any] = {"unreadable_chunks": 0}
        unique_texts: dict[str, None] = {}
        candidate_count = 0
        unparsed_before = getattr(self, "unparsed_commands", 0)
        for chunk, _root, _refs, occurrences in self._chunk_refs(region, path, stats):
            for text, ref in occurrences:
                unique_texts[text] = None
                candidate_count += 1
                if not locked:
                    self._note_occurrence(text, ref, path, chunk.index)
        result: dict[str, Any] = {
            "file": str(path),
            "changed_chunks": 0,
            "unique_texts": len(unique_texts),
            "candidates": candidate_count,
        }
        if stats["unreadable_chunks"]:
            result["unreadable_chunks"] = stats["unreadable_chunks"]
            self._warn(
                "chunk_unreadable",
                file=self._relative(path),
                count=stats["unreadable_chunks"],
                message=stats.get("unreadable_sample", ""),
            )
        unparsed = getattr(self, "unparsed_commands", 0) - unparsed_before
        if unparsed:
            # Command text in a form this reader cannot parse stays as written, and the scan says so.
            self._warn("command_unparsed", file=self._relative(path), count=unparsed)
        if locked:
            # The file cannot be written, so its text is not a translation candidate.
            result.update(
                skipped="unsupported_compression",
                unsupported_compression=region.unsupported_ids,
                wrote=False,
            )
            self._warn("file_unwritable", file=self._relative(path), compression=region.unsupported_ids)
        else:
            self._add_candidates(unique_texts)
        return result

    def apply_region_file(self, path: Path) -> dict[str, Any]:
        """Write cached translations into one region file, backing it up first."""
        from mwt.region import external_chunk_path
        from mwt.safety import BackupSet

        region, early = self._open_region(path)
        if early is not None:
            return early
        if region.unsupported_ids:
            return {"file": str(path), "changed_chunks": 0, "unique_texts": 0, "candidates": 0, "skipped": "unsupported_compression"}
        changed_chunks = 0
        unique_texts: dict[str, None] = {}
        candidate_count = 0
        written_files: list[str] = []
        for chunk, root, refs, occurrences in self._chunk_refs(region, path, {"unreadable_chunks": 0}):
            texts = list(dict.fromkeys(text for text, _ in occurrences))
            unique_texts.update(dict.fromkeys(texts))
            candidate_count += len(occurrences)
            if not texts:
                continue
            translations = {text: self.final_translations.get(text, text) for text in texts}
            if self.apply_translations(refs, translations) > 0:
                changed_chunks += 1
                region.replace_nbt(chunk.index, self.dump_nbt_bytes(root))

        if changed_chunks > 0:
            data, mcc_files = region.build()
            world_dir = Path(self.config["world_dir"]).resolve()
            if self._run_backup is None:
                self._run_backup = BackupSet.new(world_dir, store=self._backup_store(), external_files=self._external_backup_files())
            backup = self._run_backup
            backup.add(path)
            for chunk in region.chunks:
                if not chunk.external:
                    continue
                mcc_path = external_chunk_path(path, chunk.index)
                if mcc_path.is_file():
                    backup.add(mcc_path)
                elif chunk.index in mcc_files:
                    backup.record_new_external_chunk(mcc_path)
            backup.verify()
            backup.publish_latest()
            self.report["backup_set_id"] = backup.backup_id
            # Publish payloads before the region points at a newly created .mcc.
            for index, payload in mcc_files.items():
                mcc_path = external_chunk_path(path, index)
                self._write_world_bytes(mcc_path, payload)
                backup.mark_written([mcc_path])
                written_files.append(str(mcc_path))
            self._write_world_bytes(path, data)
            backup.mark_written([path])
            written_files.append(str(path))

        return {
            "file": str(path),
            "changed_chunks": changed_chunks,
            "unique_texts": len(unique_texts),
            "candidates": candidate_count,
            "written_files": written_files,
        }

    def retry_failed(self, ordered: list[str], sources: list[str]) -> dict[str, Any]:
        """Send only ``sources`` to the provider again. Reads and writes no world file."""
        LLMProviderClient.reset_counters()
        translator = self.translator
        for text in sources:
            translator.cache.pop(text, None)
            translator.failed.pop(text, None)
            translator.failed_codes.pop(text, None)
        batch_size = max(1, int(self.config["batch_size"]))
        self.emit(
            "phase_start",
            phase="translate",
            total=len(sources),
            batch_size=batch_size,
            requests_estimate=math.ceil(len(translator.pending(sources)) / batch_size),
        )
        status = "awaiting_review"
        self.stop_code = ""
        self.report["errors"] = [item for item in self.report.get("errors", [])
                                 if item.get("scope") not in {"provider", "translation", "budget"}]
        try:
            translator.translate_texts(sources)
        except BudgetStopped as exc:
            status = "budget_stopped"
            self.report.setdefault("errors", []).append({"scope": "budget", "code": "BUDGET_EXCEEDED", "message": str(exc)[:400]})
        except ProviderUnavailable as exc:
            status = "failed" if exc.fatal else "needs_retry"
            self.stop_code = exc.code
            self.report.setdefault("errors", []).append({"scope": "provider", "code": exc.code, "message": str(exc)[:400]})
        except TranslationCancelled:
            status = "cancelled"
        resolved = self._resolve_for_apply(ordered, record_pending=False)
        self.final_translations = self._guard_translations(ordered, resolved)
        self.report["translation"] = self._translation_stats(ordered, resolved)
        self.report["status"] = status
        self.report["provider_requests"] = LLMProviderClient.request_count
        self.report["usage"] = dict(LLMProviderClient.usage)
        self.write_report()
        self.save_checkpoint()
        self.emit("awaiting_review" if status == "awaiting_review" else "translation_stopped", status=status)
        return self.report

    def _resolve_for_apply(self, ordered: list[str], record_pending: bool = True) -> dict[str, str]:
        """What to write for every candidate, without the provider: edit, then manual override, then
        the saved translation. A string with none of these is recorded as failed and stays as it is."""
        translator = self.translator
        resolved: dict[str, str] = {}
        for text in ordered:
            if text in self.edits:
                resolved[text] = self.edits[text]
            elif text in translator.overrides:
                resolved[text] = translator.overrides[text]
            elif text in translator.cache and text not in translator.failed:
                resolved[text] = translator.cache[text]
            elif record_pending:
                translator.failed.setdefault(text, "Not translated yet.")
                translator.failed_codes.setdefault(text, failure_code_for_stop(self.stop_code) if self.stop_code else "unknown")
        for text in list(translator.failed):
            if text in self.edits or text in translator.overrides:
                translator.failed.pop(text, None)
                translator.failed_codes.pop(text, None)
        return resolved

    def _await_review(self) -> dict[str, Any]:
        """Translation is done and saved; nothing was written. The user reviews before anything is."""
        self.refresh_report_counts()
        self.report["status"] = "awaiting_review"
        self.report["provider_requests"] = LLMProviderClient.request_count
        self.report["usage"] = dict(LLMProviderClient.usage)
        self.write_report()
        self.save_checkpoint()
        self.emit(
            "awaiting_review",
            candidate_text_count=self.report.get("candidate_text_count", 0),
            failed=len(self.translator.failed),
        )
        self.release_write_lock()
        return self.report

    def _translation_stats(self, ordered: list[str], resolved: dict[str, str] | None = None) -> dict[str, Any]:
        failed = set(self.translator.failed)
        cache = resolved if resolved is not None else self.translator.cache
        translated = kept = unchanged = 0
        kept_samples: list[str] = []
        for text in ordered:
            if text in failed:
                continue
            final = self.final_translations.get(text, text)
            if final != text:
                translated += 1
            elif cache.get(text, text) != text:
                kept += 1
                if len(kept_samples) < 20:
                    kept_samples.append(text)
            else:
                unchanged += 1
        self.report["kept_original_samples"] = kept_samples
        self.report["translation_samples"] = [
            {"source": text, "translated": self.final_translations[text]}
            for text in ordered
            if text not in failed and self.final_translations.get(text, text) != text
        ][:12]
        self.report["translation_failures"] = [
            {
                "source": text,
                "reason": self.translator.failed_codes.get(text, "unknown"),
                "detail": reason[:300],
            }
            for text, reason in list(self.translator.failed.items())[:20]
        ]
        # Strings no request has answered yet (a stop before the end): neither translated nor failed.
        pending = sum(1 for text in ordered if text not in failed and text not in cache)
        return {
            "unique": len(ordered),
            "translated": translated,
            "failed": len(failed),
            "pending": pending,
            "kept_original": kept,
            "unchanged": unchanged,
        }

    def _left_untranslated(self) -> bool:
        if self.translator is not None and self.translator.failed:
            return True
        if self.file_errors:
            return True
        return any(
            item.get("skipped") == "unsupported_compression" and item.get("candidates", 0) > 0
            for item in self.file_scan.values()
        )

    def _finish(self, status: str) -> dict[str, Any]:
        self.refresh_report_counts()
        self.report["status"] = status
        self.report["provider_requests"] = LLMProviderClient.request_count
        self.report["usage"] = dict(LLMProviderClient.usage)
        self.write_report()
        if self.runtime_config.get("keep_checkpoint") and not self.config["dry_run"]:
            # The desktop keeps the finished job so its translations can be reviewed and corrected
            # later; a new scan replaces it. A rejected or invalidated run leaves it as it was.
            if status in {"completed", "partial"}:
                from mwt.safety import world_fingerprint

                self.applied = {
                    "backup_set_id": str(self.report.get("backup_set_id") or ""),
                    "world_fingerprint": world_fingerprint(Path(self.config["world_dir"])),
                    "at": time.time(),
                    "external_pack_fingerprints": {
                        str(path.resolve()): file_sha256(path) for path in self._external_backup_files()
                    },
                }
                self.save_checkpoint()
            elif not self.runtime_config.get("apply_only"):
                self.clear_checkpoint()
        else:
            self.clear_checkpoint()
        self.emit(
            "done",
            status=status,
            changed_file_count=self.report["changed_file_count"],
            candidate_file_count=self.report["candidate_file_count"],
            candidate_text_count=self.report["candidate_text_count"],
            error_count=len(self.report["errors"]),
        )
        self.release_write_lock()
        return self.report

    def _stop_before_write(
        self,
        ordered: list[str],
        exc: ProviderUnavailable | None,
        budget: BudgetStopped | None = None,
    ) -> dict[str, Any]:
        """Stop with the world untouched. Cached translations stay in the checkpoint for a retry."""
        failed = self.translator.failed
        if budget is not None:
            status = "budget_stopped"
            entry = {"scope": "budget", "code": "BUDGET_EXCEEDED", "message": str(budget)[:400]}
        elif exc is not None:
            status = "failed" if exc.fatal else "needs_retry"
            entry = {"scope": "provider", "code": exc.code, "message": str(exc)[:400]}
            self.stop_code = exc.code
        else:
            status = "needs_retry"
            entry = {
                "scope": "translation",
                "code": "TRANSLATION_INCOMPLETE",
                "message": f"{len(failed)} strings could not be translated. Nothing was written to the world.",
            }
        self.report["errors"].append(entry)
        if exc is not None or budget is not None:
            self.final_translations = self._guard_translations(ordered, self.translator.cache)
            self.report["translation"] = self._translation_stats(ordered)
        self.refresh_report_counts()
        self.report["status"] = status
        self.report["provider_requests"] = LLMProviderClient.request_count
        self.report["usage"] = dict(LLMProviderClient.usage)
        self.write_report()
        self.save_checkpoint()
        self.emit("translation_stopped", status=status, code=entry["code"], message=entry["message"])
        self.release_write_lock()
        return self.report

    def collect_resource_packs(self) -> None:
        dry_run = bool(self.config["dry_run"])
        for zip_path_str in self.config["resource_pack"]["zip_paths"]:
            self.ensure_not_cancelled()
            if zip_path_str in self.completed_resource_pack_paths:
                self.emit("resource_pack_skipped", zip_path=zip_path_str, reason="checkpoint")
                continue
            zip_path = Path(zip_path_str)
            try:
                result = self.scan_resource_pack_zip(zip_path)
            except TranslationCancelled:
                raise
            except Exception as exc:
                result = {
                    "zip_path": str(zip_path),
                    "translated_files": 0,
                    "candidates": 0,
                    "skipped": "resource_pack_error",
                    "error": str(exc),
                }
                self.report["errors"].append(result)
                self.file_errors.append(result)
                self.emit("file_error", file=str(zip_path), message=str(exc))
                if not self.runtime_config["continue_on_file_error"]:
                    raise
            if dry_run:
                self.report["resource_packs"].append(result)
                if result.get("skipped") not in {"missing", "resource_pack_error"}:
                    self.completed_resource_pack_paths.add(zip_path_str)
                self.save_checkpoint()

    translate_resource_packs = collect_resource_packs  # name used before the phases were split

    def write_resource_packs(self) -> None:
        for zip_path_str in self.config["resource_pack"]["zip_paths"]:
            self.ensure_not_cancelled()
            if zip_path_str in self.completed_resource_pack_paths:
                continue
            zip_path = Path(zip_path_str)
            try:
                result = self.translate_resource_pack_zip(zip_path)
            except (TranslationCancelled, PlanInvalidated):
                raise
            except Exception as exc:
                result = {
                    "zip_path": str(zip_path),
                    "translated_files": 0,
                    "candidates": 0,
                    "skipped": "resource_pack_error",
                    "error": str(exc),
                }
                self.file_errors.append(result)
                self.report["errors"].append(result)
                self.emit("file_error", file=str(zip_path), message=str(exc))
                if not self.runtime_config["continue_on_file_error"]:
                    raise
            self.report["resource_packs"].append(result)
            if result.get("skipped") not in {"missing", "resource_pack_error"}:
                self.completed_resource_pack_paths.add(zip_path_str)
            self.save_checkpoint()

    def resource_pack_language_files(self, names: list[str]) -> list[tuple[str, str]]:
        """Return language files once, in configured source-language priority order."""
        found: list[tuple[str, str]] = []
        seen: set[str] = set()
        for source_name in self.config["resource_pack"]["source_lang_files"]:
            for name in names:
                if name in seen or name.rsplit("/", 1)[-1] != source_name or "/lang/" not in name:
                    continue
                seen.add(name)
                found.append((name, source_name))
        return found

    def scan_resource_pack_zip(self, zip_path: Path) -> dict[str, Any]:
        import zipfile

        self.ensure_not_cancelled()
        if not zip_path.exists():
            return {
                "zip_path": str(zip_path),
                "translated_files": 0,
                "candidates": 0,
                "dry_run": True,
                "skipped": "missing",
            }

        candidate_texts: dict[str, None] = {}
        source_files = 0
        with zipfile.ZipFile(zip_path, "r") as zf:
            names = zf.namelist()
            target_name = self.config["resource_pack"]["target_lang_file"]
            for source_path, source_name in self.resource_pack_language_files(names):
                self.ensure_not_cancelled()
                target_path = source_path[: -len(source_name)] + target_name
                if self.config["resource_pack"]["skip_if_target_exists"] and target_path in names:
                    continue
                try:
                    payload = json.loads(zf.read(source_path).decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if not isinstance(payload, dict):
                    continue
                source_files += 1
                candidate_texts.update(
                    dict.fromkeys(
                        value for value in payload.values() if isinstance(value, str) and self.should_translate_text(value)
                    )
                )

        self._add_candidates(candidate_texts)
        return {
            "zip_path": str(zip_path),
            "translated_files": 0,
            "source_files": source_files,
            "candidates": len(candidate_texts),
            "dry_run": True,
        }

    def translate_resource_pack_zip(self, zip_path: Path) -> dict[str, Any]:
        import zipfile

        self.ensure_not_cancelled()
        self._verify_external_pack_inputs()
        if not zip_path.exists():
            return {"zip_path": str(zip_path), "translated_files": 0, "candidates": 0, "skipped": "missing"}

        target_name = self.config["resource_pack"]["target_lang_file"]
        replacements: dict[str, bytes] = {}
        translated_files = 0
        candidate_texts: set[str] = set()

        with zipfile.ZipFile(zip_path, "r") as zf:
            names = zf.namelist()
            for source_path, source_name in self.resource_pack_language_files(names):
                self.ensure_not_cancelled()
                target_path = source_path[: -len(source_name)] + target_name
                if target_path in replacements:
                    continue
                if self.config["resource_pack"]["skip_if_target_exists"] and target_path in names:
                    continue
                try:
                    payload = json.loads(zf.read(source_path).decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if not isinstance(payload, dict):
                    continue
                texts = list(
                    dict.fromkeys(
                        value for value in payload.values() if isinstance(value, str) and self.should_translate_text(value)
                    )
                )
                candidate_texts.update(texts)
                if not texts:
                    continue
                translations = {text: self.final_translations.get(text, text) for text in texts}
                translated_payload = {
                    key: translations.get(value, value) if isinstance(value, str) else value
                    for key, value in payload.items()
                }
                replacements[target_path] = json.dumps(
                    translated_payload, ensure_ascii=False, indent=2
                ).encode("utf-8")
                translated_files += 1

        self.candidate_texts.update(candidate_texts)

        if replacements:
            self.backup_once(zip_path)
            tmp_path: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(delete=False, suffix=".zip", dir=str(zip_path.parent)) as tmp:
                    tmp_path = Path(tmp.name)
                with zipfile.ZipFile(zip_path, "r") as src, zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as dst:
                    dst.comment = src.comment
                    written_targets = set()
                    for info in src.infolist():
                        self.ensure_not_cancelled()
                        if info.filename in replacements:
                            dst.writestr(info, replacements[info.filename])
                            written_targets.add(info.filename)
                        else:
                            dst.writestr(info, src.read(info.filename))
                    for target_path, payload in replacements.items():
                        self.ensure_not_cancelled()
                        if target_path not in written_targets:
                            dst.writestr(target_path, payload)
                shutil.copymode(zip_path, tmp_path)
                with tmp_path.open("rb") as tmp_file:
                    os.fsync(tmp_file.fileno())
                new_digest = file_sha256(tmp_path)
                self._verify_external_pack_inputs()
                os.replace(tmp_path, zip_path)
                if str(zip_path.resolve()) in self.external_pack_inputs:
                    self.external_pack_inputs[str(zip_path.resolve())] = new_digest
                if self._run_backup is not None:
                    self._run_backup.mark_written([zip_path])
            except Exception:
                if tmp_path is not None:
                    tmp_path.unlink(missing_ok=True)
                raise

        return {
            "zip_path": str(zip_path),
            "translated_files": translated_files,
            "candidates": len(candidate_texts),
        }

    def write_report(self) -> None:
        report_path = Path(self.config["report_path"])
        self.report["job_usage"] = self.usage_total()
        write_text_atomic(
            report_path,
            json.dumps(self.report, ensure_ascii=False, indent=2),
        )


def list_models_for_config(config: dict[str, Any]) -> list[dict[str, Any]]:
    client = LLMProviderClient(config)
    return client.list_models()


def enhance_style_prompt_for_config(config: dict[str, Any], brief: str) -> str:
    return enhance_style_prompt(config, brief)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Translate Minecraft world NBT texts and optional resource-pack language files."
    )
    parser.add_argument("--config", type=str, help="TOML config path")
    parser.add_argument("--world-dir", type=str, help="Minecraft world directory")
    parser.add_argument("--report-path", type=str, help="JSON report output path")
    parser.add_argument(
        "--provider",
        type=str,
        choices=provider_choices(),
        help="LLM provider override",
    )
    parser.add_argument("--api-key", type=str, help="API key override")
    parser.add_argument("--base-url", type=str, help="Base URL override")
    parser.add_argument("--model", type=str, help="Model override")
    parser.add_argument(
        "--wire-format",
        choices=("openai", "anthropic"),
        default="",
        help="Wire format used by the custom provider",
    )
    parser.add_argument(
        "--data-dir",
        default="",
        help="Directory for remembered settings. Defaults to the OS application support folder.",
    )
    parser.add_argument("--target-language", type=str, help="Target language, e.g. 한국어")
    parser.add_argument(
        "--style-preset",
        type=str,
        choices=sorted(STYLE_PRESETS),
        help="Style preset override",
    )
    parser.add_argument("--style-prompt", type=str, help="Additional style instructions")
    parser.add_argument("--custom-system-prompt", type=str, help="Full custom system prompt")
    parser.add_argument("--batch-size", type=int, help="Translation batch size")
    parser.add_argument("--temperature", type=float, help="Sampling temperature")
    parser.add_argument("--dry-run", action="store_true", help="Scan only, do not call API or write files")
    parser.add_argument(
        "--expect-fingerprint",
        default="",
        help="Refuse to write if the world data fingerprint differs from this scan fingerprint",
    )
    parser.add_argument("--restore-backup", action="store_true", help="Restore the verified latest backup")
    parser.add_argument("--print-notices", action="store_true", help="Print the first-launch safety notice")
    parser.add_argument("--resume", action="store_true", help="Resume from the last saved checkpoint if it exists")
    parser.add_argument("--no-backup", action="store_true", help="Do not create backup files")
    parser.add_argument(
        "--resource-pack-zip",
        action="append",
        help="Resource pack zip path to translate; repeatable",
    )
    parser.add_argument(
        "--enable-resource-pack-translation",
        action="store_true",
        help="Enable resource-pack zip translation from config",
    )
    parser.add_argument(
        "--disable-resource-pack-translation",
        action="store_true",
        help="Disable resource-pack zip translation even if config enables it",
    )
    parser.add_argument(
        "--list-models",
        action="store_true",
        help="List available models for the selected provider and exit",
    )
    parser.add_argument(
        "--enhance-style-brief",
        type=str,
        help="Expand a short style brief into a more detailed prompt using the configured provider/model",
    )
    return parser


def main(argv: list[str] | None = None) -> None:
    from mwt.userdata import user_data_dir

    parser = build_parser()
    args = parser.parse_args(argv)

    if args.print_notices:
        from mwt.notices import FIRST_LAUNCH

        print(FIRST_LAUNCH)
        return

    data_dir = Path(args.data_dir).expanduser() if args.data_dir else user_data_dir()
    config_path = Path(args.config).expanduser().resolve() if args.config else None
    loaded = load_toml_config(config_path)
    config = merge_nested(DEFAULT_CONFIG, loaded)
    config = apply_remembered_defaults(config, data_dir)
    config = apply_cli_overrides(config, args)
    config["runtime"]["data_dir"] = str(data_dir)
    if config["world_dir"] and not config["runtime"].get("backup_store"):
        from mwt.safety import backup_store

        config["runtime"]["backup_store"] = str(backup_store(Path(config["world_dir"]), data_dir))
    try:
        config = normalize_config(config, config_path)
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc

    if args.list_models:
        try:
            models = list_models_for_config(config)
        except Exception as exc:
            raise SystemExit(str(exc)) from exc
        remember_run_settings(config, data_dir, args.api_key or None)
        print(json.dumps({"provider": config["api"]["provider"], "models": models}, ensure_ascii=False, indent=2))
        return

    if args.enhance_style_brief:
        if not config["api"]["api_key"]:
            raise SystemExit("API key is missing. Set it in config, environment, or translate.py defaults.")
        if not config["api"]["model"]:
            raise SystemExit("Model is missing. Set it in config or translate.py defaults.")
        try:
            enhanced = enhance_style_prompt_for_config(config, args.enhance_style_brief)
        except Exception as exc:
            raise SystemExit(str(exc)) from exc
        print(enhanced)
        return

    if not config["world_dir"]:
        raise SystemExit("`world_dir` is required. Set it in config or pass --world-dir.")
    if args.restore_backup:
        from mwt.safety import BackupSet, backup_store

        world = Path(config["world_dir"])
        store = backup_store(world, data_dir)
        external_files = [Path(path) for path in config["runtime"].get("authorized_external_pack_paths", [])]
        source = BackupSet(world, "latest", store, external_files=external_files) if (store / "latest.json").is_file() else BackupSet(world, "latest", external_files=external_files)
        source.restore(recovery_store=store)
        print(json.dumps({"status": "restored", "world_dir": config["world_dir"]}, ensure_ascii=False))
        return
    if args.expect_fingerprint:
        config["runtime"]["expected_world_fingerprint"] = args.expect_fingerprint
    if not config["dry_run"]:
        if not config["api"]["api_key"]:
            raise SystemExit("API key is missing. Set it in config, environment, or translate.py defaults.")
        if not config["api"]["model"]:
            raise SystemExit("Model is missing. Set it in config or translate.py defaults.")

    translator = WorldTranslator(config)
    report = translator.run()
    remember_run_settings(config, data_dir, args.api_key or None)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
