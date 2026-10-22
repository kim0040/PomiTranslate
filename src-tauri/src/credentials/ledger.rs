//! A durable, non-secret record of which provider entries this app created in the OS credential
//! store (M1, R3, R5). It lives next to the vault directories, not inside them, so "reset credential
//! storage" (which sets those directories aside) cannot lose the knowledge of what the keychain
//! holds on the app's behalf. App reset with "delete keys" deletes exactly the entries recorded as
//! *owned*; the keychain is never enumerated, and an entry that is not owned is never deleted.
//!
//! Each provider has one of three recorded states (no record at all means "not ours"):
//!
//! * `Owned` - the app wrote the entry and the write was confirmed;
//! * `Pending { previous }` - an OS write is under way (or its outcome is unknown). The state the
//!   entry had before is kept with it, so a failed write whose compensation restored the old value
//!   puts that state back exactly, and a pre-existing entry that was never ours never becomes ours;
//! * `Uncertain` - an entry may exist but the app cannot say it wrote it: found in vault metadata or
//!   in a damaged copy of this record, or left by a write that could not be undone.
//!
//! A record that is missing next to a vault, or damaged, or that fails the integrity checks below, is
//! *unknown*, not empty: the file is kept (never deleted), what can be recovered from it, from
//! earlier copies, from the vault and from the archived vaults is merged in as `Uncertain`, and the
//! `unreconciled` marker is set unless that evidence covers the history. The marker is durable: it is
//! cleared only by a reconciliation that covers the history (made when the loss is found, from the
//! archived vault metadata) or by the person's explicit acknowledgement. A fresh or replacement vault
//! is never a witness. Nothing here ever lets a lost record turn into "nothing to delete".
//!
//! The record decides which OS entries may be deleted, so it is protected like the vault: created
//! owner-only (0600; a current-user-only ACL on Windows), opened without following links, and read
//! only when it is a regular single-link file owned by the user that nobody else can write. A record
//! that fails those checks is not trusted (`Read::Damaged`).
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Read as _, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::{now_millis, private_fs, set_aside, PROVIDERS};
use crate::error::{code, IpcError};

pub const FILE_NAME: &str = "keychain-ledger.json";
const VERSION: u32 = 2;
/// The record is a few hundred bytes; a bigger file is not one.
const MAX_BYTES: u64 = 64 * 1024;

/// What an entry was before an OS write started.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Previous {
    /// Not recorded: not the app's (it may not exist at all, or someone else made it).
    Absent,
    Owned,
    Uncertain,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ownership {
    Owned,
    Pending(Previous),
    Uncertain,
}

impl Previous {
    /// What an entry in state `current` was, as the state to return to if its write fails.
    pub fn of(current: Option<Ownership>) -> Self {
        match current {
            None => Self::Absent,
            Some(Ownership::Owned) => Self::Owned,
            Some(Ownership::Pending(_) | Ownership::Uncertain) => Self::Uncertain,
        }
    }

    fn state(self) -> Option<Ownership> {
        match self {
            Self::Absent => None,
            Self::Owned => Some(Ownership::Owned),
            Self::Uncertain => Some(Ownership::Uncertain),
        }
    }
}

/// The record in memory.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Record {
    entries: BTreeMap<&'static str, Ownership>,
    /// The record was lost, damaged or untrusted and nothing has covered the history since: any
    /// provider may have an OS entry whose origin is unknown. Durable until the person
    /// acknowledges it or a reconciliation covers the history.
    pub unreconciled: bool,
    /// When (ms since the epoch) the person last acknowledged an unknown history.
    pub acknowledged_at: Option<u64>,
}

/// What the app may do about the OS entry of one provider. The single decision both deleting one key
/// and purging go by: only a confirmed `Owned` record authorizes an OS delete.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Authority {
    /// Confirmed written by the app: it may delete the entry.
    Owned,
    /// An entry may exist and the app cannot say it made it (pending, uncertain, or no record while
    /// the history is unknown): no OS call, report `KEYCHAIN_UNCONFIRMED`.
    Unconfirmed,
    /// The history is known and holds no entry of the app for this provider: nothing to delete.
    NotOurs,
}

impl Record {
    pub fn get(&self, provider: &str) -> Option<Ownership> {
        self.entries.get(provider).copied()
    }

    pub fn set(&mut self, provider: &'static str, state: Ownership) {
        self.entries.insert(provider, state);
    }

    /// Put an entry back into the state it had before a write began.
    pub fn restore(&mut self, provider: &'static str, previous: Previous) {
        match previous.state() {
            Some(state) => self.set(provider, state),
            None => {
                self.entries.remove(provider);
            }
        }
    }

    pub fn remove(&mut self, provider: &str) {
        self.entries.remove(provider);
    }

    /// The one ownership decision. A keychain mode in the vault is never ownership by itself: it
    /// reaches here only as `Uncertain`.
    pub fn authority(&self, provider: &str) -> Authority {
        match self.get(provider) {
            Some(Ownership::Owned) => Authority::Owned,
            Some(Ownership::Pending(_) | Ownership::Uncertain) => Authority::Unconfirmed,
            None if self.unreconciled => Authority::Unconfirmed,
            None => Authority::NotOurs,
        }
    }

    /// The entries the app wrote and may delete.
    pub fn owned(&self) -> Vec<&'static str> {
        PROVIDERS
            .iter()
            .copied()
            .filter(|provider| self.authority(provider) == Authority::Owned)
            .collect()
    }

    /// Entries that may exist but are not established as the app's: reported, never deleted.
    pub fn unestablished(&self) -> Vec<&'static str> {
        self.with_state(|state| state != Ownership::Owned)
    }

    fn with_state(&self, keep: impl Fn(Ownership) -> bool) -> Vec<&'static str> {
        self.entries
            .iter()
            .filter(|(_, state)| keep(**state))
            .map(|(name, _)| *name)
            .collect()
    }

    /// Nothing is owed and nothing is unknown.
    pub fn is_clear(&self) -> bool {
        self.entries.is_empty() && !self.unreconciled
    }
}

/// What reading the file found.
pub enum Read {
    /// No file.
    Missing,
    Present(Record),
    /// The file exists but is not a record this app understands. The providers whose names can still
    /// be found in it are listed.
    Damaged {
        recovered: Vec<&'static str>,
    },
}

/// Traces of earlier damaged or half-written records next to the live one.
pub struct Traces {
    pub any: bool,
    pub providers: BTreeSet<&'static str>,
}

#[derive(Serialize, Deserialize)]
struct Document {
    v: u32,
    #[serde(default)]
    unreconciled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    acknowledged_at: Option<u64>,
    /// Version 2.
    #[serde(default)]
    entries: BTreeMap<String, Entry>,
    /// Version 1 listed provider names only.
    #[serde(default)]
    providers: Vec<String>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous: Option<String>,
}

pub struct Ledger {
    path: PathBuf,
}

fn unwritable() -> IpcError {
    IpcError::new(
        code::VAULT_IO,
        "Cannot save the record of OS credential entries",
    )
}

fn known(name: &str) -> Option<&'static str> {
    PROVIDERS.iter().copied().find(|provider| *provider == name)
}

fn entry_of(entry: &Entry) -> Option<Ownership> {
    Some(match (entry.state.as_str(), entry.previous.as_deref()) {
        ("owned", None) => Ownership::Owned,
        ("uncertain", None) => Ownership::Uncertain,
        ("pending", Some("absent")) => Ownership::Pending(Previous::Absent),
        ("pending", Some("owned")) => Ownership::Pending(Previous::Owned),
        ("pending", Some("uncertain")) => Ownership::Pending(Previous::Uncertain),
        _ => return None,
    })
}

fn parse(bytes: &[u8]) -> Option<Record> {
    let document: Document = serde_json::from_slice(bytes).ok()?;
    let mut record = Record {
        unreconciled: document.unreconciled,
        acknowledged_at: document.acknowledged_at,
        ..Record::default()
    };
    match document.v {
        // The first format listed names only, written before the OS write and never rolled back:
        // none of them can be taken as confirmed.
        1 => {
            for name in &document.providers {
                if let Some(provider) = known(name) {
                    record.set(provider, Ownership::Uncertain);
                }
            }
        }
        VERSION => {
            for (name, entry) in &document.entries {
                // A name this app does not know is never acted on, but a state it cannot read is
                // damage.
                let state = entry_of(entry)?;
                if let Some(provider) = known(name) {
                    record.set(provider, state);
                }
            }
        }
        _ => return None,
    }
    Some(record)
}

/// The providers whose names appear (quoted) anywhere in `bytes`: what a damaged record can still say.
fn recover(bytes: &[u8]) -> Vec<&'static str> {
    let text = String::from_utf8_lossy(bytes);
    PROVIDERS
        .iter()
        .copied()
        .filter(|provider| text.contains(&format!("\"{provider}\"")))
        .collect()
}

fn state_name(state: Ownership) -> (&'static str, Option<&'static str>) {
    match state {
        Ownership::Owned => ("owned", None),
        Ownership::Uncertain => ("uncertain", None),
        Ownership::Pending(Previous::Absent) => ("pending", Some("absent")),
        Ownership::Pending(Previous::Owned) => ("pending", Some("owned")),
        Ownership::Pending(Previous::Uncertain) => ("pending", Some("uncertain")),
    }
}

impl Ledger {
    pub fn new(root: &Path) -> Self {
        Self {
            path: root.join(FILE_NAME),
        }
    }

    #[cfg(test)]
    pub fn exists(&self) -> bool {
        fs::symlink_metadata(&self.path).is_ok()
    }

    /// The folder the record lives in (the application data folder).
    pub fn root(&self) -> &Path {
        self.path.parent().unwrap_or_else(|| Path::new("."))
    }

    /// Read the record. It is trusted only when it is a regular, single-link file owned by the user
    /// that nobody else can write (checked on the handle that is read, opened without following a
    /// link). Anything else that is there is `Damaged`: the caller sets it aside and enters the
    /// unknown state. Content is read from an untrusted file only to find provider names, and only
    /// if it is a small regular file.
    pub fn read(&self) -> Result<Read, IpcError> {
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Read::Missing),
            // A file that cannot even be looked at is not known to be damaged or fine.
            Err(_) => return Err(unwritable()),
        };
        let trusted = match private_fs::open(&self.path, false) {
            Ok(file) => {
                let mut bytes = Vec::new();
                match file.take(MAX_BYTES + 1).read_to_end(&mut bytes) {
                    Ok(_) if bytes.len() as u64 <= MAX_BYTES => Some(bytes),
                    _ => None,
                }
            }
            Err(_) => None,
        };
        if let Some(bytes) = trusted {
            return Ok(match parse(&bytes) {
                Some(record) => Read::Present(record),
                None => Read::Damaged {
                    recovered: recover(&bytes),
                },
            });
        }
        // Not trusted. Names are looked for only in a plain small file.
        let recovered = if metadata.is_file() && metadata.len() <= MAX_BYTES {
            fs::read(&self.path).map_or_else(|_| Vec::new(), |bytes| recover(&bytes))
        } else {
            Vec::new()
        };
        Ok(Read::Damaged { recovered })
    }

    /// Replace the record, durably (written and flushed aside, then renamed over).
    pub fn save(&self, record: &Record) -> Result<(), IpcError> {
        let document = Document {
            v: VERSION,
            unreconciled: record.unreconciled,
            acknowledged_at: record.acknowledged_at,
            entries: record
                .entries
                .iter()
                .map(|(name, state)| {
                    let (state, previous) = state_name(*state);
                    (
                        (*name).to_owned(),
                        Entry {
                            state: state.to_owned(),
                            previous: previous.map(str::to_owned),
                        },
                    )
                })
                .collect(),
            providers: Vec::new(),
        };
        let bytes = serde_json::to_vec(&document).map_err(|_| unwritable())?;
        let temporary = self.path.with_file_name(format!("{FILE_NAME}.new"));
        // A leftover side file from an interrupted save holds nothing that matters (the record is
        // only ever renamed over after this write) and is replaced, never reopened or trusted.
        match fs::symlink_metadata(&temporary) {
            Ok(_) => fs::remove_file(&temporary).map_err(|_| unwritable())?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(unwritable()),
        }
        {
            // Owner-only from the moment it exists (0600; current-user-only ACL on Windows), never
            // following a link, and checked on the handle: this file is the deletion authority.
            let mut file = private_fs::open(&temporary, true).map_err(|_| unwritable())?;
            file.write_all(&bytes)
                .and_then(|()| file.sync_all())
                .map_err(|_| unwritable())?;
        }
        // The folder must still be the user's own right before the record is moved into place.
        if let Some(parent) = self.path.parent() {
            private_fs::check_root(parent).map_err(|_| unwritable())?;
        }
        private_fs::rename(&temporary, &self.path).map_err(|_| unwritable())?;
        if let Some(parent) = self.path.parent() {
            private_fs::sync_directory(parent).map_err(|_| unwritable())?;
        }
        Ok(())
    }

    /// Keep a damaged record as `keychain-ledger.json.broken-<ms>` (never deleted here).
    pub fn quarantine(&self) -> Result<(), IpcError> {
        set_aside(&self.path, now_millis()).map(|_| ())
    }

    /// What earlier damaged or half-written copies of the record can still say.
    pub fn traces(&self) -> Result<Traces, IpcError> {
        let mut traces = Traces {
            any: false,
            providers: BTreeSet::new(),
        };
        let Some(parent) = self.path.parent() else {
            return Ok(traces);
        };
        let entries = match fs::read_dir(parent) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(traces),
            Err(_) => return Err(unwritable()),
        };
        for entry in entries {
            let entry = entry.map_err(|_| unwritable())?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name == FILE_NAME || !name.starts_with(FILE_NAME) {
                continue;
            }
            traces.any = true;
            if let Ok(bytes) = fs::read(entry.path()) {
                traces.providers.extend(recover(&bytes));
            }
        }
        Ok(traces)
    }

    /// The record and every set-aside or half-written copy of it. Only for a record with nothing
    /// owed and nothing unknown.
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
