//! A durable, non-secret record of which provider entries this app created in the OS credential
//! store (M1). It lives next to the vault directories, not inside them, so "reset credential
//! storage" (which sets those directories aside) cannot lose the knowledge of what the keychain
//! holds on the app's behalf. App reset with "delete keys" deletes exactly these entries; the
//! keychain is never enumerated, and an entry that is not listed here is never touched.
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{now_millis, private_fs, set_aside, PROVIDERS};
use crate::error::{code, IpcError};

pub const FILE_NAME: &str = "keychain-ledger.json";

#[derive(Serialize, Deserialize)]
struct Document {
    v: u32,
    providers: Vec<String>,
}

pub struct Ledger {
    path: PathBuf,
}

fn damaged() -> IpcError {
    IpcError::new(
        code::VAULT_CORRUPT,
        "The record of OS credential entries is damaged",
    )
}

fn unwritable() -> IpcError {
    IpcError::new(
        code::VAULT_IO,
        "Cannot save the record of OS credential entries",
    )
}

impl Ledger {
    pub fn new(root: &Path) -> Self {
        Self {
            path: root.join(FILE_NAME),
        }
    }

    pub fn exists(&self) -> bool {
        fs::symlink_metadata(&self.path).is_ok()
    }

    /// The providers listed, restricted to the providers this app knows (anything else in the file
    /// is ignored, so the file can never make the app touch a foreign entry).
    pub fn providers(&self) -> Result<Vec<&'static str>, IpcError> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
            Err(_) => return Err(unwritable()),
        };
        let document: Document = serde_json::from_slice(&bytes).map_err(|_| damaged())?;
        if document.v != 1 {
            return Err(damaged());
        }
        Ok(PROVIDERS
            .iter()
            .copied()
            .filter(|known| document.providers.iter().any(|listed| listed == known))
            .collect())
    }

    pub fn contains(&self, provider: &str) -> bool {
        self.providers().is_ok_and(|list| list.contains(&provider))
    }

    fn write(&self, providers: &BTreeSet<&str>) -> Result<(), IpcError> {
        let document = Document {
            v: 1,
            providers: providers.iter().map(|name| (*name).to_owned()).collect(),
        };
        let bytes = serde_json::to_vec(&document).map_err(|_| unwritable())?;
        let temporary = self.path.with_file_name(format!("{FILE_NAME}.new"));
        {
            let mut file = fs::File::create(&temporary).map_err(|_| unwritable())?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|_| unwritable())?;
        }
        private_fs::rename(&temporary, &self.path).map_err(|_| unwritable())
    }

    /// The current list; a damaged file is set aside (never deleted) and replaced by an empty one,
    /// so one bad write cannot block the Keychain mode for good.
    fn load_for_update(&self) -> Result<BTreeSet<&'static str>, IpcError> {
        match self.providers() {
            Ok(list) => Ok(list.into_iter().collect()),
            Err(error) if error.code == code::VAULT_CORRUPT => {
                set_aside(&self.path, now_millis())?;
                Ok(BTreeSet::new())
            }
            Err(error) => Err(error),
        }
    }

    /// Record `provider` before its OS entry is written, so a crash in between cannot lose it.
    pub fn add(&self, provider: &'static str) -> Result<(), IpcError> {
        let mut list = self.load_for_update()?;
        if list.insert(provider) || !self.exists() {
            self.write(&list.iter().copied().collect())?;
        }
        Ok(())
    }

    /// Forget `provider` once its OS entry is confirmed gone.
    pub fn remove(&self, provider: &str) -> Result<(), IpcError> {
        if !self.exists() {
            return Ok(());
        }
        let mut list = self.load_for_update()?;
        if list.contains(&provider) {
            list.retain(|listed| *listed != provider);
            self.write(&list.iter().copied().collect())?;
        }
        Ok(())
    }

    /// Start tracking with `providers` when no record exists yet (installs from before the record).
    pub fn ensure(
        &self,
        providers: impl IntoIterator<Item = &'static str>,
    ) -> Result<(), IpcError> {
        if self.exists() {
            return Ok(());
        }
        self.write(&providers.into_iter().collect())
    }

    /// The record and every set-aside or half-written copy of it.
    pub fn remove_files(&self) -> Result<(), IpcError> {
        let Some(parent) = self.path.parent() else {
            return Ok(());
        };
        let mut failed = false;
        match fs::read_dir(parent) {
            Ok(entries) => {
                for entry in entries {
                    let Ok(entry) = entry else {
                        failed = true;
                        continue;
                    };
                    let name = entry.file_name();
                    if name.to_string_lossy().starts_with(FILE_NAME)
                        && fs::remove_file(entry.path()).is_err()
                    {
                        failed = true;
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => failed = true,
        }
        if failed {
            Err(unwritable())
        } else {
            Ok(())
        }
    }
}
