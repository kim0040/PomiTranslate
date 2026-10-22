use serde_json::{Map, Value};
use std::net::IpAddr;

use crate::error::{code, IpcError};

pub fn canonical(provider: &str) -> Option<(&'static str, &'static str)> {
    match provider {
        "openai" => Some(("https://api.openai.com/v1", "openai")),
        "openrouter" => Some(("https://openrouter.ai/api/v1", "openai")),
        "comet" => Some(("https://api.cometapi.com/v1", "openai")),
        "gemini" => Some(("https://generativelanguage.googleapis.com/v1beta", "gemini")),
        "anthropic" => Some(("https://api.anthropic.com/v1", "anthropic")),
        _ => None,
    }
}

/// Plain http is for a server on this computer only; anything else would send the key in clear text.
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(address) = host.parse::<IpAddr>() {
        return address.is_loopback();
    }
    let host = host.to_ascii_lowercase();
    host == "localhost" || host.ends_with(".localhost")
}

/// The one spelling of a Custom endpoint that a stored key is bound to: lower-case scheme and host,
/// no default port, no trailing slash.
pub fn canonical_endpoint(base: &str) -> Option<String> {
    let url = tauri::Url::parse(base).ok()?;
    url.host_str()?;
    Some(url.as_str().trim_end_matches('/').to_owned())
}

/// The endpoint the stored key may be sent to for this payload (already validated).
pub fn bound_endpoint(payload: &Map<String, Value>) -> Option<String> {
    let provider = payload.get("provider").and_then(Value::as_str)?;
    match canonical(provider) {
        Some((url, _)) => Some(url.to_owned()),
        None => canonical_endpoint(payload.get("baseUrl").and_then(Value::as_str)?),
    }
}

/// Called before reading credentials. Never route a public-provider key to a custom origin.
pub fn validate(payload: &mut Map<String, Value>) -> Result<(), IpcError> {
    let provider = payload
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    crate::credentials::validate_provider(&provider)?;
    if let Some((url, wire)) = canonical(&provider) {
        let supplied = payload.get("baseUrl").and_then(Value::as_str).unwrap_or("");
        if !supplied.is_empty() && supplied.trim_end_matches('/') != url {
            return Err(IpcError::new(
                code::PROVIDER_ENDPOINT_MISMATCH,
                "Public provider endpoint does not match the selected provider; use Custom for a custom URL",
            ));
        }
        payload.insert("baseUrl".into(), Value::String(url.into()));
        payload.insert("wireFormat".into(), Value::String(wire.into()));
    } else {
        let base = payload
            .get("baseUrl")
            .and_then(Value::as_str)
            .filter(|base| !base.is_empty())
            .ok_or_else(|| {
                IpcError::new(
                    code::CUSTOM_ENDPOINT_REQUIRED,
                    "Custom provider requires an explicit endpoint",
                )
            })?;
        let invalid = || {
            IpcError::new(
                code::CUSTOM_ENDPOINT_INVALID,
                "Custom endpoint must be an HTTP(S) URL without credentials, query or fragment",
            )
        };
        let url = tauri::Url::parse(base).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
        if url.scheme() == "http" && !url.host_str().is_some_and(is_loopback_host) {
            return Err(IpcError::new(
                code::CUSTOM_ENDPOINT_INSECURE,
                "Plain http is only allowed for a server on this computer; use https",
            ));
        }
        let wire = payload
            .get("wireFormat")
            .and_then(Value::as_str)
            .unwrap_or("openai");
        if !matches!(wire, "openai" | "anthropic") {
            return Err(IpcError::new(
                code::UNSUPPORTED_WIRE_FORMAT,
                "Unsupported Custom wire format",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn public_endpoints_are_pinned_and_mismatches_rejected() {
        for provider in ["openai", "openrouter", "gemini", "anthropic", "comet"] {
            let mut payload = payload(serde_json::json!({"provider":provider}));
            validate(&mut payload).unwrap();
            assert_eq!(payload["baseUrl"], canonical(provider).unwrap().0);
            payload.insert(
                "baseUrl".into(),
                Value::String("http://127.0.0.1:52831".into()),
            );
            assert_eq!(
                validate(&mut payload).unwrap_err().code,
                code::PROVIDER_ENDPOINT_MISMATCH
            );
        }
    }

    #[test]
    fn custom_requires_explicit_valid_endpoint() {
        for (url, expected) in [
            ("", code::CUSTOM_ENDPOINT_REQUIRED),
            ("file:///tmp/a", code::CUSTOM_ENDPOINT_INVALID),
            ("https://user:secret@example.com", code::CUSTOM_ENDPOINT_INVALID),
            ("https://example.com?token=secret", code::CUSTOM_ENDPOINT_INVALID),
            ("not a url", code::CUSTOM_ENDPOINT_INVALID),
        ] {
            let mut p = payload(serde_json::json!({"provider":"custom","baseUrl":url}));
            assert_eq!(validate(&mut p).unwrap_err().code, expected, "{url}");
        }
        let mut p = payload(serde_json::json!({"provider":"custom","baseUrl":"http://127.0.0.1:8080/v1","wireFormat":"openai"}));
        validate(&mut p).unwrap();
        let mut p = payload(serde_json::json!({"provider":"custom","baseUrl":"https://example.com/v1","wireFormat":"gemini"}));
        assert_eq!(validate(&mut p).unwrap_err().code, code::UNSUPPORTED_WIRE_FORMAT);
    }

    #[test]
    fn plain_http_is_allowed_for_loopback_only() {
        for url in [
            "http://localhost:1234/v1",
            "http://127.0.0.1:8080/v1",
            "http://127.1.2.3/v1",
            "http://[::1]:8080/v1",
            "http://llm.localhost/v1",
            "https://models.example.com/v1",
        ] {
            let mut p = payload(serde_json::json!({"provider":"custom","baseUrl":url}));
            validate(&mut p).unwrap_or_else(|error| panic!("{url}: {error}"));
        }
        for url in [
            "http://models.example.com/v1",
            "http://192.168.0.5:1234/v1",
            "http://10.0.0.2/v1",
            "http://localhost.evil.example/v1",
            "http://0.0.0.0:8080/v1",
        ] {
            let mut p = payload(serde_json::json!({"provider":"custom","baseUrl":url}));
            assert_eq!(
                validate(&mut p).unwrap_err().code,
                code::CUSTOM_ENDPOINT_INSECURE,
                "{url}"
            );
        }
    }

    #[test]
    fn the_bound_endpoint_ignores_spelling_differences() {
        let a = payload(serde_json::json!({"provider":"custom","baseUrl":"HTTPS://Models.Example.com:443/v1/"}));
        let b = payload(serde_json::json!({"provider":"custom","baseUrl":"https://models.example.com/v1"}));
        assert_eq!(bound_endpoint(&a), bound_endpoint(&b));
        assert_eq!(bound_endpoint(&a).unwrap(), "https://models.example.com/v1");
        let c = payload(serde_json::json!({"provider":"custom","baseUrl":"https://models.example.com/v2"}));
        assert_ne!(bound_endpoint(&a), bound_endpoint(&c));
        let public = payload(serde_json::json!({"provider":"openai"}));
        assert_eq!(bound_endpoint(&public).unwrap(), "https://api.openai.com/v1");
    }
}
