mod keychain_transaction;
mod private_fs;

use ring::{
    aead::{self, Aad, LessSafeKey, Nonce, UnboundKey},
    rand::{SecureRandom, SystemRandom},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use zeroize::Zeroizing;

pub const PROVIDERS: &[&str] = &[
    "openai",
    "gemini",
    "anthropic",
    "openrouter",
    "comet",
    "custom",
];
const SCHEMA: i64 = 1;
const KEYRING_SERVICE: &str = "PomiTranslate";

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Local,
    Session,
    Keychain,
}
impl Mode {
    fn label(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Session => "session",
            Self::Keychain => "keychain",
        }
    }
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "local" => Ok(Self::Local),
            "session" => Ok(Self::Session),
            "keychain" => Ok(Self::Keychain),
            _ => Err("Unknown credential storage mode".into()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub mode: Mode,
    pub stored: bool,
}

#[derive(Debug)]
pub struct SaveError {
    pub message: String,
    pub uncertain: bool,
}
impl From<String> for SaveError {
    fn from(message: String) -> Self {
        Self {
            message,
            uncertain: false,
        }
    }
}
impl From<&str> for SaveError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}

pub fn validate_provider(provider: &str) -> Result<(), String> {
    if PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err("Unsupported credential provider".into())
    }
}

struct Vault {
    root: PathBuf,
    key_dir: PathBuf,
    db: PathBuf,
}
impl Vault {
    fn new(root: &Path) -> Self {
        Self {
            root: root.join("credentials"),
            key_dir: root.join("credential-key"),
            db: root.join("credentials/credentials.sqlite"),
        }
    }
    fn connection(&self, create: bool) -> Result<Option<(Connection, private_fs::Lock)>, String> {
        if !self
            .root
            .try_exists()
            .map_err(|_| "Cannot inspect credential storage")?
            && !create
        {
            return Ok(None);
        }
        private_fs::directory(&self.root)?;
        let lock = private_fs::Lock::acquire(&self.root.join("vault.lock"))?;
        let exists = self
            .db
            .try_exists()
            .map_err(|_| "Cannot inspect credential database")?;
        if !exists && !create {
            return Ok(None);
        }
        if exists {
            private_fs::check(&self.db, false)?;
        } else {
            private_fs::open(&self.db, true)?;
        }
        for suffix in ["-journal", "-wal", "-shm"] {
            let path = PathBuf::from(format!("{}{suffix}", self.db.display()));
            if path
                .try_exists()
                .map_err(|_| "Cannot inspect credential journal")?
            {
                private_fs::check(&path, false)?;
            }
        }
        let conn = Connection::open(&self.db).map_err(|_| "Cannot open credential database")?;
        conn.pragma_update(None, "journal_mode", "DELETE")
            .map_err(|_| "Cannot configure credential database")?;
        conn.pragma_update(None, "secure_delete", "ON")
            .map_err(|_| "Cannot configure credential database")?;
        if !exists {
            conn.execute_batch("BEGIN IMMEDIATE; CREATE TABLE vault_meta (schema_version INTEGER NOT NULL); INSERT INTO vault_meta VALUES (1); CREATE TABLE accounts (provider TEXT PRIMARY KEY, mode TEXT NOT NULL, known_keychain INTEGER NOT NULL DEFAULT 0); CREATE TABLE credentials (provider TEXT PRIMARY KEY, cipher_version INTEGER NOT NULL, key_id BLOB NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())); COMMIT;").map_err(|_| "Cannot initialize credential database")?;
        }
        let schema: i64 = conn
            .query_row("SELECT schema_version FROM vault_meta", [], |row| {
                row.get(0)
            })
            .map_err(|_| "Credential database schema is invalid")?;
        if schema != SCHEMA {
            return Err("Unsupported credential database version".into());
        }
        // Added without a schema bump: earlier versions ignore the table, and a key saved by them
        // simply has no recorded origin.
        conn.execute_batch("CREATE TABLE IF NOT EXISTS credential_origins (provider TEXT PRIMARY KEY, origin TEXT NOT NULL)")
            .map_err(|_| "Cannot initialize credential database")?;
        Ok(Some((conn, lock)))
    }
    fn master(&self, conn: &Connection, create: bool) -> Result<Zeroizing<Vec<u8>>, String> {
        let path = self.key_dir.join("master.key");
        if !self.key_dir.exists() || !path.exists() {
            let count: i64 = conn
                .query_row("SELECT count(*) FROM credentials", [], |row| row.get(0))
                .map_err(|_| "Cannot inspect stored credentials")?;
            if !create || count > 0 {
                return Err("Credential master key is missing; re-enter the API key after recovering or clearing the damaged vault".into());
            }
            private_fs::directory(&self.key_dir)?;
            exclude_from_backup(&self.key_dir);
            let mut key = Zeroizing::new(vec![0u8; 48]);
            SystemRandom::new()
                .fill(&mut key)
                .map_err(|_| "Secure randomness is unavailable")?;
            let temporary = self.key_dir.join("master.new");
            // A creation interrupted before its rename leaves `master.new`. With no `master.key`
            // and no ciphertext (checked above, under the vault lock), nothing can depend on it, so
            // it is replaced. Anything else at that name is not ours to remove.
            if let Ok(metadata) = fs::symlink_metadata(&temporary) {
                if !metadata.is_file() {
                    return Err("Credential key folder contains an unexpected master.new".into());
                }
                fs::remove_file(&temporary)
                    .map_err(|_| "Cannot remove an interrupted credential key")?;
            }
            {
                let mut file = private_fs::open(&temporary, true)?;
                file.write_all(&key)
                    .and_then(|_| file.sync_all())
                    .map_err(|_| "Cannot save credential master key")?;
                // The handle closes here: Windows refuses to rename a file that is still open
                // without delete sharing.
            }
            fs::rename(&temporary, &path).map_err(|_| "Cannot commit credential master key")?;
            #[cfg(unix)]
            if let Ok(folder) = fs::File::open(&self.key_dir) {
                let _ = folder.sync_all();
            }
        }
        private_fs::check(&self.key_dir, true)?;
        exclude_from_backup(&self.key_dir);
        let file = private_fs::open(&path, false)?;
        let mut key = Zeroizing::new(Vec::new());
        file.take(49)
            .read_to_end(&mut key)
            .map_err(|_| "Cannot read credential master key")?;
        if key.len() != 48 {
            return Err("Credential master key is invalid".into());
        }
        Ok(key)
    }
}

/// Keep the key file out of Time Machine, the way `tmutil addexclusion` does: a sticky exclusion
/// stored as an extended attribute on the folder. A backup that carries the encrypted database
/// then never carries the key that opens it. Best effort: failure leaves the folder as it was.
#[cfg(target_os = "macos")]
const BACKUP_EXCLUDE_ATTRIBUTE: &[u8] = b"com.apple.metadata:com_apple_backup_excludeItem\0";
/// The binary property list for the string `com.apple.backupd`, byte for byte what tmutil writes.
#[cfg(target_os = "macos")]
const BACKUP_EXCLUDE_VALUE: &[u8] = &[
    0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0x30, 0x30, 0x5f, 0x10, 0x11, 0x63, 0x6f, 0x6d, 0x2e, 0x61,
    0x70, 0x70, 0x6c, 0x65, 0x2e, 0x62, 0x61, 0x63, 0x6b, 0x75, 0x70, 0x64, 0x08, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1c,
];

#[cfg(target_os = "macos")]
fn exclude_from_backup(folder: &Path) {
    use std::os::unix::ffi::OsStrExt;
    let Ok(path) = std::ffi::CString::new(folder.as_os_str().as_bytes()) else {
        return;
    };
    unsafe {
        libc::setxattr(
            path.as_ptr(),
            BACKUP_EXCLUDE_ATTRIBUTE.as_ptr().cast(),
            BACKUP_EXCLUDE_VALUE.as_ptr().cast(),
            BACKUP_EXCLUDE_VALUE.len(),
            0,
            libc::XATTR_NOFOLLOW,
        );
    }
}

#[cfg(not(target_os = "macos"))]
fn exclude_from_backup(_folder: &Path) {}

fn mode_of(conn: &Connection, provider: &str) -> Result<Mode, String> {
    let value: Option<String> = conn
        .query_row(
            "SELECT mode FROM accounts WHERE provider=?1",
            [provider],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "Cannot inspect credential mode")?;
    value.as_deref().map(Mode::parse).unwrap_or(Ok(Mode::Local))
}
fn aad(provider: &str, id: &[u8]) -> Vec<u8> {
    serde_json::to_vec(&("PomiTranslate", SCHEMA, 1, provider, id))
        .expect("fixed credential metadata")
}
fn cipher(key: &[u8]) -> Result<LessSafeKey, String> {
    UnboundKey::new(&aead::AES_256_GCM, &key[..32])
        .map(LessSafeKey::new)
        .map_err(|_| "Cannot initialize credential encryption".into())
}
fn decrypt(
    conn: &Connection,
    vault: &Vault,
    provider: &str,
) -> Result<Option<Zeroizing<String>>, String> {
    let row: Option<(i64, Vec<u8>, Vec<u8>, Vec<u8>)> = conn
        .query_row(
            "SELECT cipher_version,key_id,nonce,ciphertext FROM credentials WHERE provider=?1",
            [provider],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|_| "Cannot read encrypted credential")?;
    let Some((version, id, nonce, ciphertext)) = row else {
        return Ok(None);
    };
    let key = vault.master(conn, false)?;
    if version != 1 || id != key[32..] || nonce.len() != 12 {
        return Err("Credential metadata or master key does not match".into());
    }
    let mut bytes = Zeroizing::new(ciphertext);
    let plain = cipher(&key)?
        .open_in_place(
            Nonce::try_assume_unique_for_key(&nonce).map_err(|_| "Invalid credential nonce")?,
            Aad::from(aad(provider, &id)),
            &mut bytes,
        )
        .map_err(|_| {
            "Credential authentication failed; stored data was altered or the master key is wrong"
        })?;
    let value = std::str::from_utf8(plain).map_err(|_| "Decrypted credential is invalid")?;
    Ok(Some(Zeroizing::new(value.to_owned())))
}
/// The OS credential store, behind a seam so that unit tests use an in-memory fake and never open
/// the user's keychain.
pub trait Keychain: Send + Sync {
    fn get(&self, provider: &str) -> Result<Option<Zeroizing<String>>, String>;
    fn set(&self, provider: &str, secret: &str) -> Result<(), String>;
    /// Removing an entry that does not exist succeeds.
    fn remove(&self, provider: &str) -> Result<(), String>;
}

struct OsKeychain;

fn keychain(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, provider)
        .map_err(|_| "OS credential store is unavailable".into())
}

impl Keychain for OsKeychain {
    fn get(&self, provider: &str) -> Result<Option<Zeroizing<String>>, String> {
        match keychain(provider)?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("Could not read the API key from the OS credential store".into()),
        }
    }
    fn set(&self, provider: &str, secret: &str) -> Result<(), String> {
        keychain(provider)?
            .set_password(secret)
            .map_err(|_| "OS credential write failed".into())
    }
    fn remove(&self, provider: &str) -> Result<(), String> {
        match keychain(provider)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not delete keychain credential".into()),
        }
    }
}

fn known_keychain(conn: &Connection, provider: &str) -> Result<bool, String> {
    Ok(conn
        .query_row(
            "SELECT known_keychain FROM accounts WHERE provider=?1",
            [provider],
            |row| row.get::<_, bool>(0),
        )
        .optional()
        .map_err(|_| "Cannot inspect credential metadata")?
        .unwrap_or(false))
}

fn origin_of(conn: &Connection, provider: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT origin FROM credential_origins WHERE provider=?1",
        [provider],
        |row| row.get(0),
    )
    .optional()
    .map_err(|_| "Cannot inspect credential metadata".into())
}

/// A stored Custom key is sent only to the origin it was saved for. A key saved before origins
/// were recorded, or imported from the OS keychain, has no origin and must be entered again.
pub const CODE_KEY_ORIGIN_MISMATCH: &str = "CUSTOM_KEY_ORIGIN_MISMATCH";
const ORIGIN_BOUND_PROVIDER: &str = "custom";

pub struct Credentials {
    sessions: Mutex<HashMap<String, Zeroizing<String>>>,
    keychain: Box<dyn Keychain>,
}

impl Default for Credentials {
    fn default() -> Self {
        Self::with_keychain(Box::new(OsKeychain))
    }
}

impl Credentials {
    pub fn with_keychain(keychain: Box<dyn Keychain>) -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            keychain,
        }
    }
    pub fn status(&self, root: &Path, provider: &str) -> Result<Status, String> {
        validate_provider(provider)?;
        let vault = Vault::new(root);
        let (mode, stored) = {
            let Some((conn, _lock)) = vault.connection(false)? else {
                return Ok(Status {
                    mode: Mode::Local,
                    stored: false,
                });
            };
            let mode = mode_of(&conn, provider)?;
            let stored = match mode {
                Mode::Local => conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM credentials WHERE provider=?1)",
                        [provider],
                        |row| row.get(0),
                    )
                    .map_err(|_| "Cannot inspect credential metadata")?,
                Mode::Session => false,
                Mode::Keychain => known_keychain(&conn, provider)?,
            };
            (mode, stored)
        };
        let stored = if mode == Mode::Session {
            self.sessions
                .lock()
                .map_err(|_| "Credential session is unavailable")?
                .contains_key(provider)
        } else {
            stored
        };
        Ok(Status { mode, stored })
    }
    /// Read the key for a provider request. `origin` is the request's endpoint origin for the
    /// Custom provider. The OS keychain is read after the vault lock is released.
    pub fn read(
        &self,
        root: &Path,
        provider: &str,
        origin: Option<&str>,
    ) -> Result<Option<Zeroizing<String>>, String> {
        validate_provider(provider)?;
        let vault = Vault::new(root);
        let (mode, known, bound, local) = {
            let Some((conn, _lock)) = vault.connection(false)? else {
                return Ok(None);
            };
            let mode = mode_of(&conn, provider)?;
            let local = if mode == Mode::Local {
                decrypt(&conn, &vault, provider)?
            } else {
                None
            };
            (
                mode,
                known_keychain(&conn, provider)?,
                origin_of(&conn, provider)?,
                local,
            )
        };
        let session = if mode == Mode::Session {
            self.sessions
                .lock()
                .map_err(|_| "Credential session is unavailable")?
                .get(provider)
                .map(|secret| Zeroizing::new(secret.to_string()))
        } else {
            None
        };
        let stored = match mode {
            Mode::Local => local.is_some(),
            Mode::Session => session.is_some(),
            // Only an entry this app wrote counts. A pre-existing entry is used only after the
            // user imports it, so deleting the key here can never leave a usable one behind.
            Mode::Keychain => known,
        };
        if stored
            && provider == ORIGIN_BOUND_PROVIDER
            && (origin.is_none() || bound.as_deref() != origin)
        {
            eprintln!("[pomitranslate] {CODE_KEY_ORIGIN_MISMATCH}: the stored Custom key belongs to another endpoint");
            return Err(CODE_KEY_ORIGIN_MISMATCH.into());
        }
        match mode {
            Mode::Local => Ok(local),
            Mode::Session => Ok(session),
            Mode::Keychain if known => self.keychain.get(provider),
            Mode::Keychain => Ok(None),
        }
    }
    /// Save a key or move it to another storage mode. `origin` binds a newly supplied Custom key
    /// to its endpoint; moving an existing key never rebinds it.
    pub fn save(
        &self,
        root: &Path,
        provider: &str,
        mode: Mode,
        supplied: &str,
        origin: Option<&str>,
    ) -> Result<Status, SaveError> {
        validate_provider(provider)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Credential session is unavailable")?;
        let vault = Vault::new(root);
        let (mut conn, _lock) = vault
            .connection(true)?
            .ok_or("Cannot initialize credential storage")?;
        let previous = mode_of(&conn, provider)?;
        let known_before = known_keychain(&conn, provider)?;
        let secret = if !supplied.is_empty() {
            Some(Zeroizing::new(supplied.to_owned()))
        } else if previous == mode {
            None
        } else {
            match previous {
                Mode::Local => decrypt(&conn, &vault, provider)?,
                Mode::Session => sessions
                    .get(provider)
                    .map(|s| Zeroizing::new(s.to_string())),
                Mode::Keychain if known_before => self.keychain.get(provider)?,
                Mode::Keychain => None,
            }
        };
        // The keychain entry this app wrote is removed when the key leaves Keychain mode (and any
        // such entry left by an earlier version is removed on the next non-keychain save). An
        // entry the app did not write, such as one the user imported from, is never touched.
        let remove_keychain = mode != Mode::Keychain && known_before;
        let keychain_restore = if remove_keychain {
            if previous == Mode::Keychain && supplied.is_empty() {
                secret.as_ref().map(|s| Zeroizing::new(s.to_string()))
            } else {
                self.keychain.get(provider)?
            }
        } else {
            None
        };
        let tx = conn
            .transaction()
            .map_err(|_| "Cannot begin credential transaction")?;
        // A storage-mode change moves this application's copy. Do not leave a dormant
        // local key behind that can be reactivated after a session expires or is deleted.
        // Existing rows from earlier versions also must not substitute for a missing key.
        if mode != Mode::Local || (previous != mode && secret.is_none()) {
            tx.execute("DELETE FROM credentials WHERE provider=?1", [provider])
                .map_err(|_| "Cannot remove previous encrypted credential")?;
        }
        if let Some(ref secret) = secret {
            if mode == Mode::Local {
                let key = vault.master(&tx, true)?;
                let mut nonce = [0u8; 12];
                SystemRandom::new()
                    .fill(&mut nonce)
                    .map_err(|_| "Secure randomness is unavailable")?;
                let mut bytes = Zeroizing::new(secret.as_bytes().to_vec());
                cipher(&key)?
                    .seal_in_place_append_tag(
                        Nonce::assume_unique_for_key(nonce),
                        Aad::from(aad(provider, &key[32..])),
                        &mut *bytes,
                    )
                    .map_err(|_| "Could not encrypt credential")?;
                tx.execute("INSERT INTO credentials(provider,cipher_version,key_id,nonce,ciphertext) VALUES (?1,1,?2,?3,?4) ON CONFLICT(provider) DO UPDATE SET cipher_version=1,key_id=excluded.key_id,nonce=excluded.nonce,ciphertext=excluded.ciphertext,updated_at=unixepoch()", params![provider,&key[32..],&nonce[..],&*bytes]).map_err(|_| "Could not store encrypted credential")?;
                if decrypt(&tx, &vault, provider)?
                    .as_deref()
                    .map(|s| s.as_str())
                    != Some(secret.as_str())
                {
                    return Err("Credential verification failed".into());
                }
            }
        }
        if !supplied.is_empty() {
            // A new key is bound to the endpoint it was entered for, or to none.
            match origin {
                Some(origin) => tx.execute(
                    "INSERT INTO credential_origins(provider,origin) VALUES (?1,?2) ON CONFLICT(provider) DO UPDATE SET origin=excluded.origin",
                    params![provider, origin],
                ),
                None => tx.execute("DELETE FROM credential_origins WHERE provider=?1", [provider]),
            }
            .map_err(|_| "Cannot save credential endpoint")?;
        }
        let known = if mode == Mode::Keychain && secret.is_some() {
            true
        } else {
            known_before && !remove_keychain
        };
        tx.execute("INSERT INTO accounts(provider,mode,known_keychain) VALUES (?1,?2,?3) ON CONFLICT(provider) DO UPDATE SET mode=excluded.mode,known_keychain=excluded.known_keychain", params![provider,mode.label(),known]).map_err(|_| "Cannot save credential mode")?;
        // Derive the acknowledgement inside this transaction. A second status read after
        // commit could fail and falsely report that an already committed key was not saved.
        let stored = match mode {
            Mode::Local => tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM credentials WHERE provider=?1)",
                    [provider],
                    |row| row.get(0),
                )
                .map_err(|_| "Cannot inspect credential metadata")?,
            Mode::Session => secret.is_some() || sessions.contains_key(provider),
            Mode::Keychain => known,
        };
        if mode == Mode::Keychain && secret.is_some() {
            let previous_key = self.keychain.get(provider)?;
            keychain_transaction::commit(
                || self.keychain.set(provider, secret.as_ref().unwrap()),
                || {
                    tx.commit()
                        .map_err(|_| "Credential metadata commit failed".into())
                },
                || match previous_key.as_ref() {
                    Some(previous) => self
                        .keychain
                        .set(provider, previous)
                        .map_err(|_| "OS credential recovery failed".into()),
                    None => self
                        .keychain
                        .remove(provider)
                        .map_err(|_| "OS credential recovery failed".into()),
                },
            )?;
        } else if remove_keychain {
            keychain_transaction::commit(
                || self.keychain.remove(provider),
                || {
                    tx.commit()
                        .map_err(|_| "Credential metadata commit failed".into())
                },
                || match keychain_restore.as_ref() {
                    Some(previous) => self
                        .keychain
                        .set(provider, previous)
                        .map_err(|_| "OS credential recovery failed".into()),
                    None => Ok(()),
                },
            )?;
        } else {
            tx.commit()
                .map_err(|_| "Cannot commit credential transaction")?;
        }
        if mode == Mode::Session {
            if let Some(secret) = secret {
                sessions.insert(provider.to_owned(), secret);
            }
        } else {
            sessions.remove(provider);
        }
        Ok(Status { mode, stored })
    }
    pub fn import_keychain(&self, root: &Path, provider: &str) -> Result<Status, String> {
        validate_provider(provider)?;
        let secret = self
            .keychain
            .get(provider)?
            .ok_or("No existing API key was found in the OS credential store")?;
        // The original entry stays where it is: it belongs to the user, not to this app.
        self.save(root, provider, Mode::Local, &secret, None)
            .map_err(|error| error.message)
    }
    pub fn delete(&self, root: &Path, provider: &str) -> Result<(), String> {
        validate_provider(provider)?;
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "Credential session is unavailable")?;
        let vault = Vault::new(root);
        let Some((mut conn, _lock)) = vault.connection(false)? else {
            sessions.remove(provider);
            return Ok(());
        };
        let tx = conn
            .transaction()
            .map_err(|_| "Cannot begin credential transaction")?;
        // Remove the keychain entry only when this app wrote it, in any mode. An entry the user
        // imported from (never written by this app) stays in the OS keychain.
        if known_keychain(&tx, provider)? {
            self.keychain.remove(provider)?;
            tx.execute(
                "UPDATE accounts SET known_keychain=0 WHERE provider=?1",
                [provider],
            )
            .map_err(|_| "Cannot update credential metadata")?;
        }
        // Purge any local copy, including rows left by an older storage-mode switch.
        tx.execute("DELETE FROM credentials WHERE provider=?1", [provider])
            .map_err(|_| "Cannot delete encrypted credential")?;
        tx.execute("DELETE FROM credential_origins WHERE provider=?1", [provider])
            .map_err(|_| "Cannot delete credential endpoint")?;
        tx.commit()
            .map_err(|_| "Cannot commit credential deletion")?;
        sessions.remove(provider);
        Ok(())
    }
}

#[cfg(test)]
mod tests;
