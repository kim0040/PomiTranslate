//! The opt-in OS credential store behind a small trait, so the vault logic can be tested with a fake
//! and never opens the person's real keychain from a unit test.
//!
//! keyring 4.2.0 (the default `v1` feature) installs the platform store itself the first time an
//! `Entry` is created, so nothing is installed at start-up and nothing touches the keychain until the
//! person chooses Keychain mode and saves, imports or deletes a key (CR-4).
use zeroize::Zeroizing;

use crate::error::{code, IpcError};

const SERVICE: &str = "PomiTranslate";

pub trait KeychainStore: Send + Sync {
    fn get(&self, provider: &str) -> Result<Option<Zeroizing<String>>, IpcError>;
    fn set(&self, provider: &str, secret: &str) -> Result<(), IpcError>;
    /// Deleting an entry that does not exist succeeds. `KEYCHAIN_UNAVAILABLE` means the platform has
    /// no credential store at all (nothing can be kept there, so nothing is left to delete); any
    /// other error is a delete the store refused or could not finish.
    fn delete(&self, provider: &str) -> Result<(), IpcError>;
}

pub struct OsKeychain;

impl OsKeychain {
    fn entry(provider: &str) -> Result<keyring::Entry, IpcError> {
        keyring::Entry::new(SERVICE, provider).map_err(|_| {
            IpcError::new(
                code::KEYCHAIN_UNAVAILABLE,
                "The OS credential store is unavailable",
            )
        })
    }
}

fn failed(message: &str) -> IpcError {
    IpcError::new(code::KEYCHAIN_FAILED, message)
}

impl KeychainStore for OsKeychain {
    fn get(&self, provider: &str) -> Result<Option<Zeroizing<String>>, IpcError> {
        match Self::entry(provider)?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(failed(
                "Could not read the API key from the OS credential store",
            )),
        }
    }

    fn set(&self, provider: &str, secret: &str) -> Result<(), IpcError> {
        Self::entry(provider)?
            .set_password(secret)
            .map_err(|_| failed("OS credential write failed"))
    }

    fn delete(&self, provider: &str) -> Result<(), IpcError> {
        let entry = keyring::Entry::new(SERVICE, provider).map_err(|error| delete_error(&error))?;
        delete_result(entry.delete_credential())
    }
}

/// How a failed delete is told apart from "there is no store".
///
/// - `NoEntry`: nothing to delete, which is success (`delete_result`).
/// - `NoDefaultStore`: keyring could not install the platform store when the first `Entry` was made
///   (on Linux: no Secret Service / D-Bus session; on an unsupported platform: no store). Nothing
///   can have been written there, so this is `KEYCHAIN_UNAVAILABLE`.
/// - everything else (`NoStorageAccess`: locked or denied; `PlatformFailure`; `Ambiguous`, ...) is a
///   store that exists and did not finish the delete: `KEYCHAIN_FAILED`. With the Secret Service
///   store a missing service always fails at store creation, never at the delete, so these are
///   never "no service"; a locked keyring in particular may still hold the entry.
fn delete_error(error: &keyring::Error) -> IpcError {
    match error {
        keyring::Error::NoDefaultStore => IpcError::new(
            code::KEYCHAIN_UNAVAILABLE,
            "The OS credential store is unavailable",
        ),
        _ => failed("Could not delete the OS credential"),
    }
}

/// `Ok(())` when the delete is done or there was nothing to delete (`NoEntry`), else the classified
/// error.
fn delete_result(result: Result<(), keyring::Error>) -> Result<(), IpcError> {
    match result {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(delete_error(&error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn platform() -> keyring::Error {
        keyring::Error::PlatformFailure(Box::new(std::io::Error::other("fixture")))
    }

    #[test]
    fn a_missing_entry_is_a_deleted_entry() {
        assert!(delete_result(Ok(())).is_ok());
        assert!(delete_result(Err(keyring::Error::NoEntry)).is_ok());
    }

    #[test]
    fn only_a_platform_without_a_store_is_unavailable() {
        let error = delete_result(Err(keyring::Error::NoDefaultStore)).unwrap_err();
        assert_eq!(error.code, code::KEYCHAIN_UNAVAILABLE);
    }

    #[test]
    fn a_locked_denied_or_failing_store_is_a_refused_delete() {
        for refused in [
            platform(),
            keyring::Error::NoStorageAccess(Box::new(std::io::Error::other("locked"))),
            keyring::Error::Invalid("service".into(), "fixture".into()),
        ] {
            let error = delete_result(Err(refused)).unwrap_err();
            assert_eq!(error.code, code::KEYCHAIN_FAILED);
        }
    }

    /// The real OS store, under the app's own service and a provider name no real provider uses.
    /// It writes a dummy value (never a key) and removes it again. Run it on purpose on each OS:
    /// `cargo test --lib os_keychain_round_trip -- --ignored --nocapture`.
    #[test]
    #[ignore = "touches the real OS credential store"]
    fn os_keychain_round_trip() {
        let provider = format!("native-check-{}", std::process::id());
        let store = OsKeychain;
        assert!(store.get(&provider).unwrap().is_none(), "the probe name is free");
        store.set(&provider, "dummy value — 더미 ✓").unwrap();
        assert_eq!(
            store.get(&provider).unwrap().as_deref().map(String::as_str),
            Some("dummy value — 더미 ✓")
        );
        store.set(&provider, "replaced").unwrap();
        assert_eq!(
            store.get(&provider).unwrap().as_deref().map(String::as_str),
            Some("replaced")
        );
        store.delete(&provider).unwrap();
        assert!(store.get(&provider).unwrap().is_none(), "deleted");
        store.delete(&provider).unwrap();
        println!("OS keychain round trip under {SERVICE}/{provider}: ok");
    }
}

#[cfg(test)]
pub mod fake {
    use super::*;
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Mutex,
        },
    };

    /// An in-memory store that counts how often the vault reached it and logs every call (`get:<name>`,
    /// `set:<name>`, `delete:<name>`). The trait has no way to list the store, so the log is the whole
    /// of what the app ever asked it.
    #[derive(Default)]
    pub struct FakeKeychain {
        pub entries: Mutex<HashMap<String, String>>,
        pub calls: AtomicUsize,
        pub log: Mutex<Vec<String>>,
        pub fail_delete: AtomicBool,
        /// Deletes fail the way a platform without any credential store fails.
        pub unavailable: AtomicBool,
        /// How many of the next writes fail *after* they changed the entry: the worst case, one that
        /// has to be undone.
        pub fail_next_sets: AtomicUsize,
    }

    impl KeychainStore for FakeKeychain {
        fn get(&self, provider: &str) -> Result<Option<Zeroizing<String>>, IpcError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.log.lock().unwrap().push(format!("get:{provider}"));
            Ok(self
                .entries
                .lock()
                .unwrap()
                .get(provider)
                .cloned()
                .map(Zeroizing::new))
        }
        fn set(&self, provider: &str, secret: &str) -> Result<(), IpcError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.log.lock().unwrap().push(format!("set:{provider}"));
            self.entries
                .lock()
                .unwrap()
                .insert(provider.into(), secret.into());
            let failing =
                self.fail_next_sets
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                        left.checked_sub(1)
                    });
            if failing.is_ok() {
                return Err(failed("fixture write failure"));
            }
            Ok(())
        }
        fn delete(&self, provider: &str) -> Result<(), IpcError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.log.lock().unwrap().push(format!("delete:{provider}"));
            if self.unavailable.load(Ordering::SeqCst) {
                return Err(IpcError::new(
                    code::KEYCHAIN_UNAVAILABLE,
                    "The OS credential store is unavailable",
                ));
            }
            if self.fail_delete.load(Ordering::SeqCst) {
                return Err(failed("fixture delete failure"));
            }
            self.entries.lock().unwrap().remove(provider);
            Ok(())
        }
    }
}
