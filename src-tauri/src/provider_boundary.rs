use serde_json::{Map, Value};

/// Plain `http://` would expose the key on the network. It is accepted only for this computer.
pub const CODE_CUSTOM_ENDPOINT_INSECURE: &str = "CUSTOM_ENDPOINT_INSECURE";

fn is_loopback(url: &tauri::Url) -> bool {
    // The URL parser has already normalized IP forms (for example `0x7f.1` to `127.0.0.1`).
    let Some(host) = url.host_str() else {
        return false;
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    match bare.parse::<std::net::IpAddr>() {
        Ok(address) => address.is_loopback(),
        Err(_) => host.eq_ignore_ascii_case("localhost"),
    }
}

/// The origin (scheme, host and port) a stored Custom key is bound to. Public providers return
/// `None`: their endpoints are pinned above and their keys never go anywhere else.
pub fn custom_origin(payload: &Map<String, Value>) -> Option<String> {
    if payload.get("provider").and_then(Value::as_str) != Some("custom") {
        return None;
    }
    let base = payload.get("baseUrl").and_then(Value::as_str)?;
    let url = tauri::Url::parse(base).ok()?;
    let origin = url.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

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

/// Called before reading credentials. Never route a public-provider key to a custom origin.
pub fn validate(payload: &mut Map<String, Value>) -> Result<(), String> {
    let provider = payload
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    crate::credentials::validate_provider(&provider)?;
    if let Some((url, wire)) = canonical(&provider) {
        let supplied = payload.get("baseUrl").and_then(Value::as_str).unwrap_or("");
        if !supplied.is_empty() && supplied.trim_end_matches('/') != url {
            return Err("Public provider endpoint does not match the selected provider; use Custom for a custom URL".into());
        }
        payload.insert("baseUrl".into(), Value::String(url.into()));
        payload.insert("wireFormat".into(), Value::String(wire.into()));
    } else {
        let base = payload
            .get("baseUrl")
            .and_then(Value::as_str)
            .ok_or("Custom provider requires an explicit endpoint")?;
        let url = tauri::Url::parse(base).map_err(|_| "Custom endpoint is invalid")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "Custom endpoint must be an HTTP(S) URL without credentials, query or fragment"
                    .into(),
            );
        }
        if url.scheme() == "http" && !is_loopback(&url) {
            return Err(crate::coded(
                CODE_CUSTOM_ENDPOINT_INSECURE,
                "Custom endpoint uses plain HTTP outside this computer",
            ));
        }
        let wire = payload
            .get("wireFormat")
            .and_then(Value::as_str)
            .unwrap_or("openai");
        if !matches!(wire, "openai" | "anthropic") {
            return Err("Unsupported Custom wire format".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn public_endpoints_are_pinned_and_mismatches_rejected() {
        for provider in ["openai", "openrouter", "gemini", "anthropic", "comet"] {
            let mut payload = serde_json::json!({"provider":provider})
                .as_object()
                .unwrap()
                .clone();
            validate(&mut payload).unwrap();
            assert_eq!(payload["baseUrl"], canonical(provider).unwrap().0);
            payload.insert(
                "baseUrl".into(),
                Value::String("http://127.0.0.1:52831".into()),
            );
            assert!(validate(&mut payload).is_err());
        }
    }
    #[test]
    fn custom_requires_explicit_valid_endpoint() {
        for url in [
            "",
            "file:///tmp/a",
            "https://user:secret@example.com",
            "https://example.com?token=secret",
        ] {
            let mut payload = serde_json::json!({"provider":"custom","baseUrl":url})
                .as_object()
                .unwrap()
                .clone();
            assert!(validate(&mut payload).is_err());
        }
        let mut payload = serde_json::json!({"provider":"custom","baseUrl":"http://127.0.0.1:8080/v1","wireFormat":"openai"}).as_object().unwrap().clone();
        validate(&mut payload).unwrap();
    }

    fn custom(url: &str) -> Map<String, Value> {
        serde_json::json!({"provider":"custom","baseUrl":url}).as_object().unwrap().clone()
    }

    #[test]
    fn plain_http_is_only_accepted_for_this_computer() {
        for url in [
            "http://127.0.0.1:8080/v1",
            "http://127.8.0.1/v1",
            "http://localhost:11434/v1",
            "http://LOCALHOST/v1",
            "http://[::1]:1234/v1",
            "https://example.com/v1",
            "https://192.168.0.10/v1",
        ] {
            assert!(validate(&mut custom(url)).is_ok(), "{url} must be accepted");
        }
        for url in [
            "http://example.com/v1",
            "http://192.168.0.10:8080/v1",
            "http://10.0.0.2/v1",
            "http://localhost.example.com/v1",
            "http://127.0.0.1.example.com/v1",
            "http://[::ffff:8.8.8.8]/v1",
        ] {
            assert_eq!(
                validate(&mut custom(url)),
                Err(CODE_CUSTOM_ENDPOINT_INSECURE.to_string()),
                "{url} must be refused"
            );
        }
    }

    #[test]
    fn the_custom_origin_ignores_the_path_and_normalizes_the_port() {
        assert_eq!(
            custom_origin(&custom("https://Example.com:443/v1/chat")).as_deref(),
            Some("https://example.com")
        );
        assert_eq!(
            custom_origin(&custom("https://example.com/other")),
            custom_origin(&custom("https://example.com/v1"))
        );
        assert_ne!(
            custom_origin(&custom("https://example.com:8443/v1")),
            custom_origin(&custom("https://example.com/v1"))
        );
        assert_ne!(
            custom_origin(&custom("http://127.0.0.1:8080/v1")),
            custom_origin(&custom("http://127.0.0.1:8081/v1"))
        );
        let public = serde_json::json!({"provider":"openai","baseUrl":"https://api.openai.com/v1"});
        assert_eq!(custom_origin(public.as_object().unwrap()), None);
    }
}
