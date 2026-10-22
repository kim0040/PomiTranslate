//! The one error shape every Rust command returns (RB-3).
//!
//! The page receives `{ code, message, detail? }`. `code` is stable and is what the UI maps to its
//! localized text; `message` is an English diagnostic for logs and support and is never shown to
//! the person as-is. `detail` carries a second stable code when one cause has several reasons
//! (for example `CREDENTIAL_UNAVAILABLE` with the `VAULT_*` reason).
use serde::Serialize;
use std::fmt;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct IpcError {
    pub code: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<&'static str>,
}

impl IpcError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: &'static str) -> Self {
        self.detail = Some(detail);
        self
    }
}

impl fmt::Display for IpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for IpcError {}

/// Codes the shell can return. The frontend catalogs (`error.<CODE>`) must carry every one of them;
/// `tests/frontend/api.test.ts` checks the list below against the catalogs.
pub mod code {
    pub const INTERNAL: &str = "INTERNAL";
    pub const BUSY: &str = "BUSY";
    pub const INVALID_REQUEST: &str = "INVALID_REQUEST";
    pub const UNSUPPORTED_REQUEST: &str = "UNSUPPORTED_REQUEST";

    pub const CORE_SPAWN_FAILED: &str = "CORE_SPAWN_FAILED";
    pub const CORE_STOPPED: &str = "CORE_STOPPED";
    pub const CORE_CRASHED: &str = "CORE_CRASHED";
    pub const CORE_PROTOCOL: &str = "CORE_PROTOCOL";

    pub const CREDENTIAL_UNAVAILABLE: &str = "CREDENTIAL_UNAVAILABLE";
    pub const CREDENTIAL_ENDPOINT_MISMATCH: &str = "CREDENTIAL_ENDPOINT_MISMATCH";
    pub const CREDENTIAL_PROVIDER_INVALID: &str = "CREDENTIAL_PROVIDER_INVALID";
    pub const CREDENTIAL_SAVE_FAILED: &str = "CREDENTIAL_SAVE_FAILED";
    pub const CREDENTIAL_SAVE_UNCERTAIN: &str = "CREDENTIAL_SAVE_UNCERTAIN";
    pub const CREDENTIAL_RESET_FAILED: &str = "CREDENTIAL_RESET_FAILED";
    pub const SETTINGS_RECONCILIATION_REQUIRED: &str = "SETTINGS_RECONCILIATION_REQUIRED";

    pub const VAULT_PERMISSIONS: &str = "VAULT_PERMISSIONS";
    pub const VAULT_SCHEMA: &str = "VAULT_SCHEMA";
    pub const VAULT_CORRUPT: &str = "VAULT_CORRUPT";
    pub const VAULT_IO: &str = "VAULT_IO";
    pub const VAULT_KEY_MISSING: &str = "VAULT_KEY_MISSING";
    pub const VAULT_LOCKED: &str = "VAULT_LOCKED";

    pub const KEYCHAIN_UNAVAILABLE: &str = "KEYCHAIN_UNAVAILABLE";
    pub const KEYCHAIN_FAILED: &str = "KEYCHAIN_FAILED";
    pub const KEYCHAIN_EMPTY: &str = "KEYCHAIN_EMPTY";

    pub const PROVIDER_ENDPOINT_MISMATCH: &str = "PROVIDER_ENDPOINT_MISMATCH";
    pub const CUSTOM_ENDPOINT_REQUIRED: &str = "CUSTOM_ENDPOINT_REQUIRED";
    pub const CUSTOM_ENDPOINT_INVALID: &str = "CUSTOM_ENDPOINT_INVALID";
    pub const CUSTOM_ENDPOINT_INSECURE: &str = "CUSTOM_ENDPOINT_INSECURE";
    pub const UNSUPPORTED_WIRE_FORMAT: &str = "UNSUPPORTED_WIRE_FORMAT";

    pub const EXPORT_REPORT_MISSING: &str = "EXPORT_REPORT_MISSING";
    pub const EXPORT_FAILED: &str = "EXPORT_FAILED";
    pub const EXPORT_BAD_EXTENSION: &str = "EXPORT_BAD_EXTENSION";

    pub const LINK_NOT_ALLOWED: &str = "LINK_NOT_ALLOWED";
    pub const LINK_OPEN_FAILED: &str = "LINK_OPEN_FAILED";
    pub const FOLDER_OPEN_FAILED: &str = "FOLDER_OPEN_FAILED";
    pub const MENU_UPDATE_FAILED: &str = "MENU_UPDATE_FAILED";
    pub const RESET_FAILED: &str = "RESET_FAILED";

    /// Update codes keep the `UPDATE_*` names the page already maps under `update.error.*`.
    pub const UPDATE_BUSY: &str = "UPDATE_BUSY";
    pub const UPDATE_NONE: &str = "UPDATE_NONE";
    pub const UPDATE_NOT_PUBLISHED: &str = "UPDATE_NOT_PUBLISHED";
    pub const UPDATE_UNREACHABLE: &str = "UPDATE_UNREACHABLE";
    pub const UPDATE_TIMEOUT: &str = "UPDATE_TIMEOUT";
    pub const UPDATE_STALLED: &str = "UPDATE_STALLED";
    pub const UPDATE_CANCELLED: &str = "UPDATE_CANCELLED";
    pub const UPDATE_UNSIGNED_BUILD: &str = "UPDATE_UNSIGNED_BUILD";
    pub const UPDATE_SIGNATURE_INVALID: &str = "UPDATE_SIGNATURE_INVALID";
    pub const UPDATE_INSTALL_FAILED: &str = "UPDATE_INSTALL_FAILED";
}

/// Every code above that reaches the page under `error.<CODE>`. `UPDATE_*` codes live under
/// `update.error.*` and are listed separately.
#[cfg(test)]
pub const ERROR_CODES: &[&str] = &[
    code::INTERNAL,
    code::BUSY,
    code::INVALID_REQUEST,
    code::UNSUPPORTED_REQUEST,
    code::CORE_SPAWN_FAILED,
    code::CORE_STOPPED,
    code::CORE_CRASHED,
    code::CORE_PROTOCOL,
    code::CREDENTIAL_UNAVAILABLE,
    code::CREDENTIAL_ENDPOINT_MISMATCH,
    code::CREDENTIAL_PROVIDER_INVALID,
    code::CREDENTIAL_SAVE_FAILED,
    code::CREDENTIAL_SAVE_UNCERTAIN,
    code::CREDENTIAL_RESET_FAILED,
    code::SETTINGS_RECONCILIATION_REQUIRED,
    code::VAULT_PERMISSIONS,
    code::VAULT_SCHEMA,
    code::VAULT_CORRUPT,
    code::VAULT_IO,
    code::VAULT_KEY_MISSING,
    code::VAULT_LOCKED,
    code::KEYCHAIN_UNAVAILABLE,
    code::KEYCHAIN_FAILED,
    code::KEYCHAIN_EMPTY,
    code::PROVIDER_ENDPOINT_MISMATCH,
    code::CUSTOM_ENDPOINT_REQUIRED,
    code::CUSTOM_ENDPOINT_INVALID,
    code::CUSTOM_ENDPOINT_INSECURE,
    code::UNSUPPORTED_WIRE_FORMAT,
    code::EXPORT_REPORT_MISSING,
    code::EXPORT_FAILED,
    code::EXPORT_BAD_EXTENSION,
    code::LINK_NOT_ALLOWED,
    code::LINK_OPEN_FAILED,
    code::FOLDER_OPEN_FAILED,
    code::MENU_UPDATE_FAILED,
    code::RESET_FAILED,
];

#[cfg(test)]
pub const UPDATE_CODES: &[&str] = &[
    code::UPDATE_BUSY,
    code::UPDATE_NONE,
    code::UPDATE_NOT_PUBLISHED,
    code::UPDATE_UNREACHABLE,
    code::UPDATE_TIMEOUT,
    code::UPDATE_STALLED,
    code::UPDATE_CANCELLED,
    code::UPDATE_UNSIGNED_BUILD,
    code::UPDATE_SIGNATURE_INVALID,
    code::UPDATE_INSTALL_FAILED,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_serialize_as_a_code_message_object() {
        let value = serde_json::to_value(IpcError::new(code::BUSY, "busy")).unwrap();
        assert_eq!(value, serde_json::json!({"code": "BUSY", "message": "busy"}));
        let value = serde_json::to_value(
            IpcError::new(code::CREDENTIAL_UNAVAILABLE, "x").with_detail(code::VAULT_CORRUPT),
        )
        .unwrap();
        assert_eq!(value["detail"], "VAULT_CORRUPT");
    }

    #[test]
    fn code_lists_have_no_duplicates() {
        let mut all: Vec<_> = ERROR_CODES.iter().chain(UPDATE_CODES).collect();
        all.sort();
        let before = all.len();
        all.dedup();
        assert_eq!(before, all.len());
    }
}
