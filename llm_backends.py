from __future__ import annotations

import json
import os
import re
import threading
from typing import Any

from mwt.reasoning import (
    GEMINI_LEVELS,
    gemini_reasoning,
    gemini_thinking_config,
    model_reasoning,
    normalize_reasoning,
    reasoning_payload,
)
from urllib import error, parse, request


PROVIDER_SPECS: dict[str, dict[str, str]] = {
    "openai": {
        "label": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "env_var": "OPENAI_API_KEY",
        "base_url_env_var": "OPENAI_BASE_URL",
        "model_env_var": "OPENAI_MODEL",
        "family": "openai_compatible",
    },
    "gemini": {
        "label": "Gemini",
        "base_url": "https://generativelanguage.googleapis.com/v1beta",
        "env_var": "GEMINI_API_KEY",
        "base_url_env_var": "GEMINI_BASE_URL",
        "model_env_var": "GEMINI_MODEL",
        "family": "gemini",
    },
    "anthropic": {
        "label": "Anthropic",
        "base_url": "https://api.anthropic.com/v1",
        "env_var": "ANTHROPIC_API_KEY",
        "base_url_env_var": "ANTHROPIC_BASE_URL",
        "model_env_var": "ANTHROPIC_MODEL",
        "family": "anthropic",
    },
    "openrouter": {
        "label": "OpenRouter",
        "base_url": "https://openrouter.ai/api/v1",
        "env_var": "OPENROUTER_API_KEY",
        "base_url_env_var": "OPENROUTER_BASE_URL",
        "model_env_var": "OPENROUTER_MODEL",
        "family": "openai_compatible",
    },
    "custom": {
        "label": "Custom",
        "base_url": "",
        "env_var": "CUSTOM_API_KEY",
        "base_url_env_var": "CUSTOM_BASE_URL",
        "model_env_var": "CUSTOM_MODEL",
        "family": "openai_compatible",
    },
    "comet": {
        "label": "Comet API",
        "base_url": "https://api.cometapi.com/v1",
        "env_var": "COMET_API_KEY",
        "base_url_env_var": "COMET_BASE_URL",
        "model_env_var": "COMET_MODEL",
        "family": "openai_compatible",
    },
    "custom_openai": {
        "label": "기타 / Custom (OpenAI 호환)",
        "base_url": "",
        "env_var": "CUSTOM_OPENAI_API_KEY",
        "base_url_env_var": "CUSTOM_OPENAI_BASE_URL",
        "model_env_var": "CUSTOM_OPENAI_MODEL",
        "family": "openai_compatible",
    },
    "custom_anthropic": {
        "label": "기타 / Custom (Anthropic 호환)",
        "base_url": "",
        "env_var": "CUSTOM_ANTHROPIC_API_KEY",
        "base_url_env_var": "CUSTOM_ANTHROPIC_BASE_URL",
        "model_env_var": "CUSTOM_ANTHROPIC_MODEL",
        "family": "anthropic",
    },
}


PROMPT_ENHANCER_SYSTEM_PROMPT = """
당신은 마인크래프트(Minecraft) 월드 및 맵 번역을 위한 시스템 프롬프트 엔지니어입니다.
사용자가 입력한 간략한 스타일 메모나 요구사항을 실제 번역 시스템 프롬프트에 덧붙여 사용할 수 있는 구체적이고 전문적인 추가 지침문으로 확장하세요.

[작성 지침]
1. 인게임 번역 품질을 실질적으로 높일 수 있는 명료하고 실전적인 지침을 작성합니다.
2. 사용자의 핵심 의도를 훼손하지 않으면서, 어휘 선택, 말투, 세계관 분위기(중세 판타지, SF, 호러 등), 고유명사 처리 원칙 등을 구체화합니다.
3. 퍼즐 힌트 및 퀘스트 안내의 명확성, 가독성, 서식 기호(§, \\n, %s 등) 및 JSON 구조의 절대적 보존 원칙을 강조합니다.
4. 불필요한 서두나 인사말, 해설 없이 오직 프롬프트에 즉시 추가할 지침문 본문만 반환합니다.
""".strip()


PUBLIC_PROVIDERS = ("openai", "gemini", "anthropic", "openrouter", "comet", "custom")


def provider_choices() -> list[str]:
    return sorted(PROVIDER_SPECS)


def public_provider_choices() -> list[str]:
    return [provider for provider in PUBLIC_PROVIDERS if provider in PROVIDER_SPECS]


def provider_spec(provider: str) -> dict[str, str]:
    if provider not in PROVIDER_SPECS:
        raise ValueError(f"Unsupported provider: {provider}")
    return PROVIDER_SPECS[provider]


def infer_provider(provider: str | None, base_url: str) -> str:
    explicit = (provider or "").strip().lower()
    if explicit and explicit != "auto":
        return explicit

    lowered = base_url.strip().lower()
    if "openrouter.ai" in lowered:
        return "openrouter"
    if "generativelanguage.googleapis.com" in lowered or "googleapis.com" in lowered:
        return "gemini"
    if "anthropic.com" in lowered:
        return "anthropic"
    if "openai.com" in lowered:
        return "openai"
    if "cometapi.com" in lowered:
        return "comet"
    return "comet"


# Implicit keys (environment variables and the OS keyring) are a CLI convenience. The desktop
# JSONL entry turns them off: there the shell supplies the key, or there is none.
_IMPLICIT_KEYS_ENABLED = True
# normalize_config() resolves the endpoint and then the key without passing the endpoint along;
# remember the endpoint resolved last on this thread so the key resolver can check it.
_LAST_ENDPOINT = threading.local()


def disable_implicit_api_keys() -> None:
    global _IMPLICIT_KEYS_ENABLED
    _IMPLICIT_KEYS_ENABLED = False


def _same_endpoint(left: str, right: str) -> bool:
    return bool(left) and bool(right) and left.strip().rstrip("/").lower() == right.strip().rstrip("/").lower()


def resolve_api_key(provider: str, current: str, base_url: str | None = None) -> str:
    """Return the explicit key, or a key implied for this provider and endpoint.

    An implied key never crosses providers and never leaves the endpoint it belongs to:
    - the provider's own environment variable is used for its default endpoint, or for the endpoint
      set in the same provider's base-URL environment variable (both come from the user's shell);
    - a stored OS-keyring key is used only for the provider's default (public) endpoint.
    A Custom or other non-default endpoint therefore gets no implied key from env or keyring.
    """
    if current:
        return current
    if not _IMPLICIT_KEYS_ENABLED:
        return ""
    spec = provider_spec(provider)
    if base_url is None:
        remembered = getattr(_LAST_ENDPOINT, "value", None)
        # Without a known endpoint, assume the worst: nothing implied is sent.
        if not remembered or remembered[0] != provider:
            return ""
        base_url = remembered[1]
    default_endpoint = spec["base_url"]
    env_endpoint = os.getenv(spec["base_url_env_var"], "")
    on_default = _same_endpoint(base_url, default_endpoint)
    on_env_endpoint = _same_endpoint(base_url, env_endpoint)

    if on_default or on_env_endpoint:
        env_key = os.getenv(spec["env_var"], "")
        if env_key:
            return env_key
    if on_default:
        try:
            from mwt.secrets import load_api_key

            stored = load_api_key(provider)
            if stored:
                return stored
        except Exception:
            pass
    return ""


def default_base_url(provider: str) -> str:
    return provider_spec(provider)["base_url"]


def resolve_base_url(provider: str, current: str) -> str:
    if current:
        resolved = current
    else:
        spec = provider_spec(provider)
        resolved = os.getenv(spec["base_url_env_var"], spec["base_url"])
    _LAST_ENDPOINT.value = (provider, resolved)
    return resolved


def resolve_model(provider: str, current: str) -> str:
    if current:
        return current
    spec = provider_spec(provider)
    return os.getenv(spec["model_env_var"], "")


def normalize_model_name(provider: str, model: str) -> str:
    cleaned = model.strip()
    if not cleaned:
        return cleaned

    _ALIASES: dict[str, dict[str, str]] = {
        "openai": {
            "gpt4": "gpt-4",
            "gpt4-turbo": "gpt-4-turbo",
            "gpt4o": "gpt-4o",
            "gpt4o-mini": "gpt-4o-mini",
            "gpt35": "gpt-3.5-turbo",
            "gpt35-turbo": "gpt-3.5-turbo",
        },
        "gemini": {
            # Google's moving aliases; the old gemini-pro/gemini-flash ids are no longer published.
            "pro": "gemini-pro-latest",
            "flash": "gemini-flash-latest",
            "flash-lite": "gemini-flash-lite-latest",
        },
        "anthropic": {
            "claude3-opus": "claude-3-opus-20240229",
            "claude3-sonnet": "claude-3-sonnet-20240229",
            "claude3-haiku": "claude-3-haiku-20240307",
            "claude35-sonnet": "claude-3-5-sonnet-20241022",
            "claude35-haiku": "claude-3-5-haiku-20241022",
        },
        "openrouter": {},
        "comet": {},
    }

    provider_aliases = _ALIASES.get(provider, {})
    lower = cleaned.lower().replace(" ", "")
    if lower in provider_aliases:
        return provider_aliases[lower]

    return cleaned


def extract_json_object(text: str) -> dict[str, Any]:
    if not text:
        return {}
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return {}
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


_NON_TEXT_TOKENS = (
    "embed",
    "whisper",
    "tts",
    "dall-e",
    "dalle",
    "moderation",
    "transcribe",
    "-image",
    "realtime",
    "audio-only",
)


# Ids that name a model made for something other than translating text. A model that can also
# answer in text (a speech or image model) is still a poor, expensive pick for this app.
_UNSUITABLE_ID_TOKENS = frozenset(
    {
        "embed", "embedding", "embeddings", "whisper", "tts", "dall", "dalle", "moderation", "moderations",
        "transcribe", "transcription", "image", "images", "imagen", "realtime", "audio", "speech",
        "robotics", "veo", "lyria", "sora", "live",
    }
)
_COMPUTER_USE = re.compile(r"computer[-_ ]?use")


def is_translation_suitable(model_id: str, item: dict[str, Any] | None = None) -> bool:
    """False for models whose id or modalities say they are not for translating text."""
    lowered = str(model_id).lower()
    if _COMPUTER_USE.search(lowered):
        return False
    if any(token in _UNSUITABLE_ID_TOKENS for token in re.split(r"[^a-z0-9]+", lowered)):
        return False
    outputs = _output_modalities(item) if item else []
    return not outputs or "text" in outputs


def annotate_suitability(models: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Give every catalog record a ``suitable`` flag, including ones cached by an older build."""
    annotated: list[dict[str, Any]] = []
    for record in models:
        if "suitable" in record:
            annotated.append(record)
            continue
        outputs = record.get("output_modalities")
        probe = {"architecture": {"output_modalities": outputs}} if isinstance(outputs, list) and outputs else None
        annotated.append({**record, "suitable": record.get("text") is not False and is_translation_suitable(str(record.get("id", "")), probe)})
    return annotated


class ModelCatalogError(RuntimeError):
    pass


class ProviderError(RuntimeError):
    """A provider call failed. ``fatal`` errors cannot be fixed by retrying."""

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        retry_after: float | None = None,
        kind: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after
        self.kind = kind

    @property
    def fatal(self) -> bool:
        # 401/403: bad or unauthorized key. 402: no credit. 404: unknown model or endpoint.
        return self.status in {401, 402, 403, 404}

    @property
    def code(self) -> str:
        if self.kind:
            return self.kind
        if self.status in {401, 403}:
            return "AUTH_FAILED"
        if self.status == 402:
            return "NO_CREDIT"
        if self.status == 404:
            return "MODEL_NOT_FOUND"
        if self.status == 429:
            return "RATE_LIMITED"
        if self.status is not None and self.status >= 500:
            return "PROVIDER_ERROR"
        if self.status is None:
            return "NETWORK_ERROR"
        return "REQUEST_REJECTED"


def _retry_after_seconds(headers: Any) -> float | None:
    value = headers.get("Retry-After") if headers is not None else None
    if not value:
        return None
    try:
        return max(0.0, min(float(value), 120.0))
    except ValueError:
        return None


def _output_modalities(item: dict[str, Any]) -> list[str]:
    architecture = item.get("architecture") if isinstance(item.get("architecture"), dict) else {}
    outputs = architecture.get("output_modalities")
    if isinstance(outputs, list) and outputs:
        return [str(part) for part in outputs]
    modality = str(architecture.get("modality") or "")
    if "->" in modality:
        target = modality.split("->", 1)[1]
        return [part.strip() for part in target.replace("+", ",").split(",") if part.strip()]
    return []


def _is_text_generation_model(model_id: str, item: dict[str, Any]) -> bool:
    outputs = _output_modalities(item)
    if outputs:
        return "text" in outputs
    lowered = model_id.lower()
    return not any(token in lowered for token in _NON_TEXT_TOKENS)


def _model_record(model_id: str, item: dict[str, Any], *, display_name: str, description: str) -> dict[str, Any]:
    architecture = item.get("architecture") if isinstance(item.get("architecture"), dict) else {}
    pricing = item.get("pricing") if isinstance(item.get("pricing"), dict) else {}
    inputs = architecture.get("input_modalities") if isinstance(architecture.get("input_modalities"), list) else []
    parameters = item.get("supported_parameters") if isinstance(item.get("supported_parameters"), list) else []
    text = _is_text_generation_model(model_id, item)
    outputs = _output_modalities(item) or (["text"] if text else [])
    return {
        "id": model_id,
        "display_name": display_name or model_id,
        "description": description,
        "context_length": item.get("context_length") or item.get("context_window") or item.get("max_context_length"),
        "input_modalities": inputs,
        "output_modalities": outputs,
        "pricing_prompt": str(pricing.get("prompt", "")),
        "pricing_completion": str(pricing.get("completion", "")),
        "supported_parameters": [str(parameter) for parameter in parameters],
        "text": text,
        "suitable": text and is_translation_suitable(model_id, item),
        "reasoning": model_reasoning(item.get("reasoning")),
    }


def _catalog_allows_json(info: dict[str, Any] | None, provider: str) -> bool:
    if provider == "openrouter" and not info:
        return False
    if not info:
        return True
    parameters = info.get("supported_parameters") or []
    if not parameters:
        return provider != "openrouter"
    return "response_format" in parameters or "structured_outputs" in parameters


def flatten_text_payload(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if isinstance(item.get("text"), str):
                    parts.append(item["text"])
                elif item.get("type") == "output_text" and isinstance(item.get("text"), str):
                    parts.append(item["text"])
        return "\n".join(parts).strip()
    if isinstance(content, dict):
        if isinstance(content.get("text"), str):
            return content["text"]
    return ""


GEMINI_MIN_OUTPUT_TOKENS = 32768
# The lowest thinking level each Gemini model accepted in this process, learned from 400 replies.
_GEMINI_LEVEL_FLOOR: dict[str, str] = {}


class LLMProviderClient:
    request_count = 0

    def __init__(self, config: dict[str, Any]) -> None:
        api_config = config["api"]
        self.provider = api_config["provider"]
        self.openrouter_reasoning = normalize_reasoning(api_config.get("openrouter_reasoning", "default"))
        self.base_url = api_config["base_url"].rstrip("/")
        self.api_key = api_config["api_key"]
        self.model = api_config["model"]
        self.timeout = int(api_config.get("request_timeout", 120))
        self.wire_format = str(api_config.get("wire_format") or "").strip().lower()
        self.family = self._family_for()
        runtime = config.get("runtime") or {}
        self.data_dir = str(runtime.get("data_dir") or "")
        self.model_info: dict[str, Any] | None = None
        self.supports_json_response = self.provider != "openrouter"
        self._catalog_checked = False
        self._catalog_error: ModelCatalogError | None = None
        self._catalog: list[dict[str, Any]] = []
        self.catalog_cached = False

    def _family_for(self) -> str:
        if self.provider in {"custom", "custom_openai", "custom_anthropic"}:
            wire = self.wire_format or ("anthropic" if self.provider == "custom_anthropic" else "openai")
            return "anthropic" if wire == "anthropic" else "openai_compatible"
        return provider_spec(self.provider)["family"]

    def ensure_ready(self, require_model: bool = True) -> None:
        if not self.api_key:
            raise RuntimeError(f"{provider_spec(self.provider)['label']} API key is missing.")
        if require_model and not self.model:
            raise RuntimeError(f"{provider_spec(self.provider)['label']} model is missing.")

    def list_models(self) -> list[dict[str, Any]]:
        self.ensure_ready(require_model=False)
        if self.family == "openai_compatible":
            return self._list_models_openai_compatible()
        if self.family == "gemini":
            return self._list_models_gemini()
        if self.family == "anthropic":
            return self._list_models_anthropic()
        raise RuntimeError(f"Unsupported provider family: {self.family}")

    def check_connection(self) -> list[dict[str, Any]]:
        """List the full catalog with the key, failing loudly: no cache and no silent empty list.

        OpenRouter publishes its catalog without authentication, so listing alone would call a wrong
        key fine. Its ``/key`` endpoint is what actually checks the key.
        """
        self.ensure_ready(require_model=False)
        if self.provider == "openrouter":
            self._request_json("GET", f"{self.base_url}/key", headers=self._openai_headers())
        return self.list_models()

    def list_public_models(self) -> list[dict[str, Any]]:
        """Read OpenRouter's pinned catalog without authenticating or generating text."""
        if self.provider != "openrouter" or self.base_url != default_base_url("openrouter"):
            raise ValueError("Public catalog is only available at the OpenRouter endpoint")
        return self._list_models_openai_compatible(public=True)

    def try_refresh_model_catalog(self) -> list[dict[str, Any]]:
        """Catalog view retains non-text records; only the run path filters them out."""
        from pathlib import Path
        from mwt.userdata import load_model_catalog, remember_model_catalog

        self.catalog_cached = False
        try:
            models = self.list_models()
        except Exception:
            models = load_model_catalog(self.provider, root=Path(self.data_dir)) if self.data_dir else []
            self.catalog_cached = bool(models)
        else:
            if self.data_dir and models:
                remember_model_catalog(self.provider, models, root=Path(self.data_dir))
        return models

    def try_refresh_text_models(self) -> list[dict[str, Any]]:
        """Fetch text models once and pin the configured id to a published model."""
        if self._catalog_error is not None:
            raise self._catalog_error
        if self._catalog_checked:
            return self._catalog
        catalog = self.try_refresh_model_catalog()
        self._catalog = [item for item in catalog if item.get("text", True)]
        self._catalog_checked = True
        if self.model and catalog:
            match = next((item for item in self._catalog if item.get("id") == self.model), None)
            if match is None:
                self._catalog_error = ModelCatalogError(
                    f"{self.model} is not in the text models published by {self.provider}"
                )
                raise self._catalog_error
            self.model = str(match["id"])
            self.model_info = match
            self.supports_json_response = _catalog_allows_json(match, self.provider)
        if self.provider in ("openrouter", "gemini"):
            try:
                reasoning_payload(self.openrouter_reasoning, self.model_info)
            except ValueError as exc:
                self._catalog_error = ModelCatalogError(str(exc))
                raise self._catalog_error from exc
        return self._catalog

    def complete_text(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float,
        expect_json: bool = False,
        max_output_tokens: int = 4096,
    ) -> str:
        self.ensure_ready(require_model=True)
        self.try_refresh_text_models()
        if self.family == "openai_compatible":
            return self._complete_openai_compatible(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                temperature=temperature,
                expect_json=expect_json,
            )
        if self.family == "gemini":
            return self._complete_gemini(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                temperature=temperature,
                expect_json=expect_json,
                max_output_tokens=max_output_tokens,
            )
        if self.family == "anthropic":
            return self._complete_anthropic(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                temperature=temperature,
                max_output_tokens=max_output_tokens,
            )
        raise RuntimeError(f"Unsupported provider family: {self.family}")

    def translate_mapping(self, payload: dict[str, str], *, system_prompt: str, temperature: float) -> dict[str, str]:
        raw = self.complete_text(
            system_prompt=system_prompt,
            user_prompt=json.dumps(payload, ensure_ascii=False, indent=2),
            temperature=temperature,
            expect_json=True,
        )
        parsed = extract_json_object(raw)
        missing_keys = [key for key in payload if not isinstance(parsed.get(key), str)]
        if missing_keys:
            raise RuntimeError(
                "The model returned an incomplete translation JSON mapping "
                f"({len(payload) - len(missing_keys)}/{len(payload)} values)."
            )
        return {key: parsed[key] for key in payload}

    def _request_json(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        payload: dict[str, Any] | None = None,
    ) -> Any:
        body = None
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if method == "POST":  # count translation calls; a model-list lookup is not one
            with LLMProviderClient._counter_lock:
                LLMProviderClient.request_count += 1
        req = request.Request(url=url, data=body, headers=headers, method=method)
        try:
            with request.urlopen(req, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            message = f"{provider_spec(self.provider)['label']} request failed with HTTP {exc.code}: {detail[:600]}"
            raise ProviderError(
                self._redact(message),
                status=exc.code,
                retry_after=_retry_after_seconds(exc.headers),
            ) from exc
        except error.URLError as exc:
            message = f"{provider_spec(self.provider)['label']} request failed: {exc.reason}"
            raise ProviderError(
                self._redact(message), kind="TIMEOUT" if isinstance(exc.reason, TimeoutError) else None
            ) from exc
        except (TimeoutError, OSError) as exc:
            message = f"{provider_spec(self.provider)['label']} request failed: {exc}"
            raise ProviderError(self._redact(message), kind="TIMEOUT" if isinstance(exc, TimeoutError) else None) from exc

        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ProviderError(f"{provider_spec(self.provider)['label']} returned invalid JSON.") from exc
        if method == "POST":
            LLMProviderClient.record_usage(parsed)
        return parsed

    _counter_lock = threading.Lock()
    usage: dict[str, Any] = {"prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0, "cost_reported": False}

    @classmethod
    def reset_counters(cls) -> None:
        with cls._counter_lock:
            cls.request_count = 0
            cls.usage = {"prompt_tokens": 0, "completion_tokens": 0, "cost": 0.0, "cost_reported": False}

    @classmethod
    def record_usage(cls, response: Any) -> None:
        """Add the token counts a provider reports; providers that omit them add nothing."""
        if not isinstance(response, dict):
            return
        usage = response.get("usage")
        cost = None
        if isinstance(usage, dict):
            prompt = usage.get("prompt_tokens", usage.get("input_tokens"))
            completion = usage.get("completion_tokens", usage.get("output_tokens"))
            if isinstance(usage.get("cost"), (int, float)):
                cost = float(usage["cost"])
        else:
            meta = response.get("usageMetadata")
            prompt = meta.get("promptTokenCount") if isinstance(meta, dict) else None
            completion = meta.get("candidatesTokenCount") if isinstance(meta, dict) else None
            # Gemini bills thought tokens as output but reports them apart from the answer.
            thoughts = meta.get("thoughtsTokenCount") if isinstance(meta, dict) else None
            if isinstance(thoughts, int):
                completion = (completion if isinstance(completion, int) else 0) + thoughts
        with cls._counter_lock:
            if cost is not None:
                cls.usage["cost"] += cost
                cls.usage["cost_reported"] = True
            if isinstance(prompt, int):
                cls.usage["prompt_tokens"] += prompt
            if isinstance(completion, int):
                cls.usage["completion_tokens"] += completion

    def _redact(self, message: str) -> str:
        from mwt.secrets import redact_log

        return redact_log(message, self.api_key)

    def _openai_headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        if self.provider == "openrouter":
            headers["HTTP-Referer"] = "https://github.com/kim0040/Minecraft-World-Translator"
            headers["X-Title"] = "PomiTranslate"
            headers["X-OpenRouter-Title"] = "PomiTranslate"
        return headers

    def _complete_openai_compatible(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float,
        expect_json: bool,
    ) -> str:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": temperature,
        }
        if expect_json and self.supports_json_response:
            payload["response_format"] = {"type": "json_object"}
        if self.provider == "openrouter":
            payload["usage"] = {"include": True}
            reasoning = reasoning_payload(self.openrouter_reasoning, self.model_info)
            if reasoning is not None:
                payload["reasoning"] = reasoning

        response = self._request_json(
            "POST",
            f"{self.base_url}/chat/completions",
            headers=self._openai_headers(),
            payload=payload,
        )
        choices = response.get("choices") or []
        if not choices:
            raise RuntimeError(f"{provider_spec(self.provider)['label']} returned no choices.")
        message = choices[0].get("message", {})
        return flatten_text_payload(message.get("content"))

    def _list_models_openai_compatible(self, *, public: bool = False) -> list[dict[str, Any]]:
        url = f"{self.base_url}/models"
        response = self._request_json("GET", url, headers={"Accept": "application/json"} if public else self._openai_headers())
        data = response.get("data") or []
        models: list[dict[str, Any]] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            model_id = str(item.get("id", "")).strip()
            if not model_id:
                continue
            description = str(item.get("description") or item.get("owned_by") or "")
            record = _model_record(
                model_id,
                item,
                display_name=str(item.get("name") or model_id),
                description=description,
            )
            models.append(record)
        return models

    def _complete_gemini(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float,
        expect_json: bool,
        max_output_tokens: int,
    ) -> str:
        model_name = self.model if self.model.startswith("models/") else f"models/{self.model}"
        # Thought tokens count against maxOutputTokens; a translation-sized cap would truncate a
        # thinking model's answer, so leave room and pay only for what is generated.
        payload: dict[str, Any] = {
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max(max_output_tokens, GEMINI_MIN_OUTPUT_TOKENS),
            },
        }
        if expect_json:
            payload["generationConfig"]["responseMimeType"] = "application/json"
        thinking = gemini_thinking_config(self.openrouter_reasoning, self.model, self.model_info)
        level = (thinking or {}).get("thinkingLevel")
        floor = _GEMINI_LEVEL_FLOOR.get(self.model)
        if level and floor and GEMINI_LEVELS.index(floor) > GEMINI_LEVELS.index(level):
            thinking, level = {"thinkingLevel": floor}, floor
        while True:
            if thinking is not None:
                payload["generationConfig"]["thinkingConfig"] = thinking
            try:
                response = self._request_json(
                    "POST",
                    f"{self.base_url}/{model_name}:generateContent",
                    headers=self._gemini_headers(),
                    payload=payload,
                )
                break
            except ProviderError as exc:
                # Models disagree on their lowest level (3.8 flash rejects "minimal"). Use the next
                # level up rather than failing every batch; "high" is the ceiling.
                text = str(exc).lower()
                if not (exc.status == 400 and level and "thinking level" in text and "not supported" in text):
                    raise
                if level == GEMINI_LEVELS[-1]:
                    raise
                level = GEMINI_LEVELS[GEMINI_LEVELS.index(level) + 1]
                thinking = {"thinkingLevel": level}
                _GEMINI_LEVEL_FLOOR[self.model] = level
        candidates = response.get("candidates") or []
        if not candidates:
            reason = (response.get("promptFeedback") or {}).get("blockReason")
            raise RuntimeError(f"Gemini returned no candidates{f' ({reason})' if reason else ''}.")
        content = candidates[0].get("content", {})
        parts = content.get("parts") or []
        text = "\n".join(
            part.get("text", "")
            for part in parts
            if isinstance(part, dict) and isinstance(part.get("text"), str) and not part.get("thought")
        ).strip()
        finish = candidates[0].get("finishReason")
        if finish == "MAX_TOKENS":
            raise RuntimeError("Gemini stopped at the output token limit before finishing the answer.")
        if not text and finish not in (None, "STOP"):
            raise RuntimeError(f"Gemini returned no text (finish reason {finish}).")
        return text

    def _gemini_headers(self) -> dict[str, str]:
        # A header keeps the key out of URLs, which proxies and request logs record.
        return {"Content-Type": "application/json", "x-goog-api-key": self.api_key}

    def _list_models_gemini(self) -> list[dict[str, Any]]:
        response = self._request_json(
            "GET",
            f"{self.base_url}/models?{parse.urlencode({'pageSize': 1000})}",
            headers=self._gemini_headers(),
        )
        data = response.get("models") or []
        models: list[dict[str, Any]] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            methods = item.get("supportedGenerationMethods") or []
            model_id = str(item.get("baseModelId") or item.get("name", "")).strip()
            if model_id.startswith("models/"):
                model_id = model_id.split("/", 1)[1]
            if not model_id:
                continue
            description_parts = [item.get("displayName", "")]
            if item.get("description"):
                description_parts.append(str(item["description"]))
            record = _model_record(
                model_id,
                item,
                display_name=str(item.get("displayName") or model_id),
                description=" | ".join(part for part in description_parts if part),
            )
            if "generateContent" not in methods:
                record.update(text=False, suitable=False, output_modalities=[])
            thinking = gemini_reasoning(model_id, item.get("thinking"))
            if thinking is not None:
                record["reasoning"] = thinking
                record["supported_parameters"] = [*record["supported_parameters"], "reasoning"]
            models.append(record)
        return models

    def _anthropic_headers(self) -> dict[str, str]:
        return {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

    def _complete_anthropic(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        temperature: float,
        max_output_tokens: int,
    ) -> str:
        payload = {
            "model": self.model,
            "system": system_prompt,
            "max_tokens": max_output_tokens,
            "temperature": temperature,
            "messages": [{"role": "user", "content": user_prompt}],
        }
        response = self._request_json(
            "POST",
            f"{self.base_url}/messages",
            headers=self._anthropic_headers(),
            payload=payload,
        )
        parts = response.get("content") or []
        return "\n".join(
            part.get("text", "")
            for part in parts
            if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str)
        ).strip()

    def _list_models_anthropic(self) -> list[dict[str, Any]]:
        response = self._request_json("GET", f"{self.base_url}/models?limit=1000", headers=self._anthropic_headers())
        data = response.get("data") or []
        models: list[dict[str, Any]] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            model_id = str(item.get("id", "")).strip()
            if not model_id:
                continue
            record = _model_record(
                model_id,
                item,
                display_name=str(item.get("display_name") or model_id),
                description=str(item.get("description") or item.get("created_at") or ""),
            )
            models.append(record)
        return models


def enhance_style_prompt(config: dict[str, Any], brief: str) -> str:
    cleaned = brief.strip()
    if not cleaned:
        raise ValueError("Style brief is empty.")

    prompt_config = config["prompt"]
    user_prompt = (
        f"대상 언어: {prompt_config['target_language']}\n"
        f"기본 스타일 프리셋: {prompt_config['style_preset']}\n"
        f"현재 추가 스타일 지시: {prompt_config['style_prompt'] or '(없음)'}\n"
        f"사용자 메모: {cleaned}\n\n"
        "위 메모를 바탕으로 실제 게임 번역 품질에 도움이 되는 추가 스타일 지시문을 4~8줄 정도로 정리해라."
    )
    client = LLMProviderClient(config)
    return client.complete_text(
        system_prompt=PROMPT_ENHANCER_SYSTEM_PROMPT,
        user_prompt=user_prompt,
        temperature=0.2,
        max_output_tokens=700,
    ).strip()
