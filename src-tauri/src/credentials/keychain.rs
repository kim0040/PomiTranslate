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
    /// Deleting an entry that does not exist succeeds.
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
            Err(_) => Err(failed("Could not read the API key from the OS credential store")),
        }
    }

    fn set(&self, provider: &str, secret: &str) -> Result<(), IpcError> {
        Self::entry(provider)?
            .set_password(secret)
            .map_err(|_| failed("OS credential write failed"))
    }

    fn delete(&self, provider: &str) -> Result<(), IpcError> {
        match Self::entry(provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(failed("Could not delete the OS credential")),
        }
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

    /// An in-memory store that counts how often the vault reached it.
    #[derive(Default)]
    pub struct FakeKeychain {
        pub entries: Mutex<HashMap<String, String>>,
        pub calls: AtomicUsize,
        pub fail_delete: AtomicBool,
    }

    impl KeychainStore for FakeKeychain {
        fn get(&self, provider: &str) -> Result<Option<Zeroizing<String>>, IpcError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.entries.lock().unwrap().get(provider).cloned().map(Zeroizing::new))
        }
        fn set(&self, provider: &str, secret: &str) -> Result<(), IpcError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.entries.lock().unwrap().insert(provider.into(), secret.into());
            Ok(())
        }
        fn delete(&self, provider: &str) -> Result<(), IpcError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_delete.load(Ordering::SeqCst) {
                return Err(failed("fixture delete failure"));
            }
            self.entries.lock().unwrap().remove(provider);
            Ok(())
        }
    }
}
