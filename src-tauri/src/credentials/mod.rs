mod keychain;
mod keychain_transaction;
mod ledger;
mod private_fs;

use ring::{
    aead::{self, Aad, LessSafeKey, Nonce, UnboundKey},
    digest,
    rand::{SecureRandom, SystemRandom},
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, TryLockError},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;

use crate::error::{code, IpcError};
pub use keychain::{KeychainStore, OsKeychain};
use ledger::{Authority, Ledger, Ownership, Previous, Read as LedgerRead, Record};
use private_fs::{FsError, FsErrorKind};

pub const PROVIDERS: &[&str] = &[
    "openai",
    "gemini",
    "anthropic",
    "openrouter",
    "comet",
    "custom",
];
const SCHEMA: i64 = 1;
/// The only provider whose endpoint is chosen by the person, so its key is bound to that endpoint.
const BOUND_PROVIDER: &str = "custom";

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
    fn parse(value: &str) -> Result<Self, IpcError> {
        match value {
            "local" => Ok(Self::Local),
            "session" => Ok(Self::Session),
            "keychain" => Ok(Self::Keychain),
            _ => Err(IpcError::new(
                code::VAULT_CORRUPT,
                "Unknown credential storage mode",
            )),
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub mode: Mode,
    pub stored: bool,
}

/// What the page is told about credential storage. A vault that cannot be opened is reported as
/// data, not as a failed command: the configured mode is kept (`null` only when it was never read in
/// this run), `stored` is unknown (`null`), and `error` names the reason.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub mode: Option<Mode>,
    pub stored: Option<bool>,
    pub error: Option<&'static str>,
}

#[derive(Debug)]
pub struct SaveError {
    pub error: IpcError,
    pub uncertain: bool,
}
impl From<IpcError> for SaveError {
    fn from(error: IpcError) -> Self {
        Self {
            error,
            uncertain: false,
        }
    }
}
impl From<FsError> for SaveError {
    fn from(error: FsError) -> Self {
        IpcError::from(error).into()
    }
}

impl From<FsError> for IpcError {
    fn from(error: FsError) -> Self {
        let code = match error.kind {
            FsErrorKind::Permissions => code::VAULT_PERMISSIONS,
            FsErrorKind::Io => code::VAULT_IO,
            FsErrorKind::Busy => code::VAULT_LOCKED,
        };
        IpcError::new(code, error.message)
    }
}

fn io_error(message: &str) -> IpcError {
    IpcError::new(code::VAULT_IO, message)
}

/// Classify a SQLite failure: corruption and I/O trouble are different problems for the person.
fn sql(error: rusqlite::Error, fallback: &'static str, message: &str) -> IpcError {
    use rusqlite::ErrorCode as E;
    let code = match &error {
        rusqlite::Error::SqliteFailure(failure, _) => match failure.code {
            E::NotADatabase | E::DatabaseCorrupt => code::VAULT_CORRUPT,
            E::DatabaseBusy
            | E::DatabaseLocked
            | E::SystemIoFailure
            | E::DiskFull
            | E::CannotOpen
            | E::ReadOnly
            | E::PermissionDenied => code::VAULT_IO,
            _ => fallback,
        },
        _ => fallback,
    };
    IpcError::new(code, format!("{message}: {error}"))
}

pub fn validate_provider(provider: &str) -> Result<(), IpcError> {
    if PROVIDERS.contains(&provider) {
        Ok(())
    } else {
        Err(IpcError::new(
            code::CREDENTIAL_PROVIDER_INVALID,
            "Unsupported credential provider",
        ))
    }
}

/// SHA-256 of a canonical endpoint URL, hex encoded.
pub fn endpoint_hash(canonical: &str) -> String {
    let hash = digest::digest(&digest::SHA256, canonical.as_bytes());
    hash.as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis())
}

/// Wait a bounded time for an in-process lock, and recover one that a panic poisoned (RB-1).
fn lock_wait<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, IpcError> {
    let deadline = Instant::now() + private_fs::LOCK_WAIT;
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Ok(guard),
            Err(TryLockError::Poisoned(poisoned)) => return Ok(poisoned.into_inner()),
            Err(TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Err(IpcError::new(
                        code::VAULT_LOCKED,
                        "Credential storage is busy with another operation",
                    ));
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

pub struct Credentials {
    sessions: Mutex<HashMap<String, Zeroizing<String>>>,
    /// The last mode read from a healthy vault, so an unreadable vault does not look like a fresh one.
    known_modes: Mutex<HashMap<String, Mode>>,
    keychain: Box<dyn KeychainStore>,
}

impl Default for Credentials {
    fn default() -> Self {
        Self::with_keychain(Box::new(OsKeychain))
    }
}

/// What a vault operation holds while it works: the cross-process lock and the vault directory,
/// pinned so it cannot be swapped for a link underneath the operation (H1).
struct Held {
    _lock: private_fs::Lock,
    _pin: private_fs::DirPin,
}

struct Vault {
    /// The application data folder everything below hangs from.
    app_root: PathBuf,
    root: PathBuf,
    key_dir: PathBuf,
    db: PathBuf,
}
impl Vault {
    fn new(root: &Path) -> Self {
        Self {
            app_root: root.to_path_buf(),
            root: root.join("credentials"),
            key_dir: root.join("credential-key"),
            db: root.join("credentials/credentials.sqlite"),
        }
    }

    fn exists(path: &Path) -> Result<bool, IpcError> {
        path.try_exists()
            .map_err(|_| io_error("Cannot inspect credential storage"))
    }

    /// Something is at `path`, a link included (never followed).
    fn present(path: &Path) -> Result<bool, IpcError> {
        match fs::symlink_metadata(path) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err(io_error("Cannot inspect credential storage")),
        }
    }

    fn connection(&self, create: bool) -> Result<Option<(Connection, Held)>, IpcError> {
        if !Self::present(&self.root)? && !create {
            return Ok(None);
        }
        // The folder above is checked first, then the directory is validated (not a link, owned by
        // the user, user-only) and held before the lock file or anything else below it is touched.
        if create {
            // A first run may come before anything else made the folder; a link there is caught below.
            fs::create_dir_all(&self.app_root)
                .map_err(|_| io_error("Cannot create the application data folder"))?;
        }
        private_fs::check_root(&self.app_root)?;
        private_fs::directory(&self.root)?;
        let pin = private_fs::pin_directory(&self.root)?;
        let lock = private_fs::Lock::acquire(&self.root.join("vault.lock"), private_fs::LOCK_WAIT)?;
        self.discard_unfinished_database()?;
        let exists = Self::exists(&self.db)?;
        if !exists && !create {
            return Ok(None);
        }
        if exists {
            private_fs::check(&self.db, false)?;
        } else {
            self.create_database()?;
        }
        for suffix in ["-journal", "-wal", "-shm"] {
            let path = PathBuf::from(format!("{}{suffix}", self.db.display()));
            if Self::exists(&path)? {
                private_fs::check(&path, false)?;
            }
        }
        let conn = Connection::open(&self.db)
            .map_err(|error| sql(error, code::VAULT_IO, "Cannot open credential database"))?;
        conn.pragma_update(None, "journal_mode", "DELETE")
            .map_err(|error| {
                sql(
                    error,
                    code::VAULT_IO,
                    "Cannot configure credential database",
                )
            })?;
        conn.pragma_update(None, "secure_delete", "ON")
            .map_err(|error| {
                sql(
                    error,
                    code::VAULT_IO,
                    "Cannot configure credential database",
                )
            })?;
        let schema: i64 = conn
            .query_row("SELECT schema_version FROM vault_meta", [], |row| {
                row.get(0)
            })
            .map_err(|error| {
                sql(
                    error,
                    code::VAULT_SCHEMA,
                    "Credential database schema is invalid",
                )
            })?;
        if schema != SCHEMA {
            return Err(IpcError::new(
                code::VAULT_SCHEMA,
                "Unsupported credential database version",
            ));
        }
        Self::ensure_endpoint_column(&conn)?;
        Ok(Some((
            conn,
            Held {
                _lock: lock,
                _pin: pin,
            },
        )))
    }

    /// A zero-byte database is a creation that never finished (an older build made the file before
    /// its schema). It holds nothing, so it is removed and made again instead of failing forever.
    fn discard_unfinished_database(&self) -> Result<(), IpcError> {
        let Ok(metadata) = fs::symlink_metadata(&self.db) else {
            return Ok(());
        };
        let journal = PathBuf::from(format!("{}-journal", self.db.display()));
        if metadata.is_file() && metadata.len() == 0 && !Self::exists(&journal)? {
            private_fs::check(&self.db, false)?;
            fs::remove_file(&self.db)
                .map_err(|_| io_error("Cannot discard an unfinished credential database"))?;
        }
        Ok(())
    }

    /// Build the schema in a side file and move it into place, so no reader ever sees a database
    /// without its tables. A leftover side file from an interrupted attempt holds nothing and is replaced.
    fn create_database(&self) -> Result<(), IpcError> {
        let temporary = self.root.join("credentials.sqlite.new");
        for path in [
            temporary.clone(),
            PathBuf::from(format!("{}-journal", temporary.display())),
        ] {
            if Self::exists(&path)? {
                private_fs::check(&path, false)?;
                fs::remove_file(&path)
                    .map_err(|_| io_error("Cannot remove an unfinished credential database"))?;
            }
        }
        drop(private_fs::open(&temporary, true)?);
        {
            let conn = Connection::open(&temporary)
                .map_err(|error| sql(error, code::VAULT_IO, "Cannot open credential database"))?;
            conn.pragma_update(None, "journal_mode", "DELETE")
                .map_err(|error| {
                    sql(
                        error,
                        code::VAULT_IO,
                        "Cannot configure credential database",
                    )
                })?;
            conn.pragma_update(None, "secure_delete", "ON")
                .map_err(|error| {
                    sql(
                        error,
                        code::VAULT_IO,
                        "Cannot configure credential database",
                    )
                })?;
            conn.execute_batch("BEGIN IMMEDIATE; CREATE TABLE vault_meta (schema_version INTEGER NOT NULL); INSERT INTO vault_meta VALUES (1); CREATE TABLE accounts (provider TEXT PRIMARY KEY, mode TEXT NOT NULL, known_keychain INTEGER NOT NULL DEFAULT 0, endpoint_hash TEXT); CREATE TABLE credentials (provider TEXT PRIMARY KEY, cipher_version INTEGER NOT NULL, key_id BLOB NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())); COMMIT;")
                .map_err(|error| sql(error, code::VAULT_IO, "Cannot initialize credential database"))?;
            conn.close().map_err(|(_, error)| {
                sql(error, code::VAULT_IO, "Cannot finish credential database")
            })?;
        }
        private_fs::open(&temporary, false)?
            .sync_all()
            .map_err(|_| io_error("Cannot flush the credential database"))?;
        private_fs::check_root(&self.app_root)?;
        private_fs::rename(&temporary, &self.db)
            .map_err(|_| io_error("Cannot commit the credential database"))?;
        private_fs::sync_directory(&self.root)
            .map_err(|_| io_error("Cannot flush the credential directory"))?;
        Ok(())
    }

    /// Databases made before the endpoint binding existed gain the column; old builds ignore it.
    fn ensure_endpoint_column(conn: &Connection) -> Result<(), IpcError> {
        let present = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('accounts') WHERE name='endpoint_hash'",
                [],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| {
                sql(
                    error,
                    code::VAULT_SCHEMA,
                    "Credential database schema is invalid",
                )
            })?
            .is_some();
        if !present {
            conn.execute("ALTER TABLE accounts ADD COLUMN endpoint_hash TEXT", [])
                .map_err(|error| {
                    sql(
                        error,
                        code::VAULT_SCHEMA,
                        "Credential database schema is invalid",
                    )
                })?;
        }
        Ok(())
    }

    /// The 48-byte master key (32 AES key bytes, 16 key-id bytes). `create` allows making one when
    /// the vault holds no credentials yet.
    fn master(&self, conn: &Connection, create: bool) -> Result<Zeroizing<Vec<u8>>, IpcError> {
        let path = self.key_dir.join("master.key");
        // The key directory is validated and pinned before anything below it is read, promoted or
        // set aside: a link in its place (or a swap during the work) is refused first (H1).
        let existing = if Self::present(&self.key_dir)? {
            Some(private_fs::pin_directory(&self.key_dir)?)
        } else {
            None
        };
        let pin = match existing {
            Some(pin) if Self::present(&path)? => pin,
            existing => self.recover_or_create_key(conn, &path, create, existing)?,
        };
        pin.confirm(&self.key_dir)?;
        let file = private_fs::open(&path, false)?;
        let mut key = Zeroizing::new(Vec::new());
        file.take(49)
            .read_to_end(&mut key)
            .map_err(|_| io_error("Cannot read credential master key"))?;
        if key.len() != 48 {
            return Err(IpcError::new(
                code::VAULT_CORRUPT,
                "Credential master key is invalid",
            ));
        }
        Ok(key)
    }

    /// Right before a rename in the key directory: the folder above is still the user's own and the
    /// key directory is still the one that was validated (R4).
    fn confirm_before_rename(&self, pin: &private_fs::DirPin) -> Result<(), IpcError> {
        private_fs::check_root(&self.app_root)?;
        pin.confirm(&self.key_dir)?;
        Ok(())
    }

    /// `master.key` is missing. A `master.new` left by an interrupted creation is promoted only when
    /// it is exactly 48 bytes and no stored credential was encrypted under a different key;
    /// otherwise it is set aside (never overwritten or deleted) and, when allowed, a fresh key is made.
    /// `existing` is the already validated key directory, if there is one. Returns the pinned
    /// directory the key now lives in.
    fn recover_or_create_key(
        &self,
        conn: &Connection,
        path: &Path,
        create: bool,
        existing: Option<private_fs::DirPin>,
    ) -> Result<private_fs::DirPin, IpcError> {
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM credentials", [], |row| row.get(0))
            .map_err(|error| {
                sql(
                    error,
                    code::VAULT_CORRUPT,
                    "Cannot inspect stored credentials",
                )
            })?;
        let leftover = self.key_dir.join("master.new");
        let missing = || {
            IpcError::new(
                code::VAULT_KEY_MISSING,
                "Credential master key is missing; re-enter the API key after recovering or clearing the damaged vault",
            )
        };
        let pin = match existing {
            Some(pin) => {
                if fs::symlink_metadata(&leftover).is_ok() {
                    if self.leftover_is_promotable(conn, &leftover) {
                        self.confirm_before_rename(&pin)?;
                        private_fs::rename(&leftover, path)
                            .map_err(|_| io_error("Cannot commit credential master key"))?;
                        private_fs::sync_directory(&self.key_dir)
                            .map_err(|_| io_error("Cannot flush the credential key directory"))?;
                        return Ok(pin);
                    }
                    self.confirm_before_rename(&pin)?;
                    self.set_aside(&leftover)?;
                }
                if !create || rows > 0 {
                    return Err(missing());
                }
                pin
            }
            None => {
                if !create || rows > 0 {
                    return Err(missing());
                }
                private_fs::directory(&self.key_dir)?;
                private_fs::pin_directory(&self.key_dir)?
            }
        };
        let mut key = Zeroizing::new(vec![0u8; 48]);
        SystemRandom::new()
            .fill(&mut key)
            .map_err(|_| io_error("Secure randomness is unavailable"))?;
        // The handle must be closed before the rename: a Windows file that is still open without
        // delete sharing cannot be renamed (CR-1).
        {
            let mut file = private_fs::open(&leftover, true)?;
            file.write_all(&key)
                .and_then(|_| file.sync_all())
                .map_err(|_| io_error("Cannot save credential master key"))?;
        }
        self.confirm_before_rename(&pin)?;
        private_fs::rename(&leftover, path)
            .map_err(|_| io_error("Cannot commit credential master key"))?;
        private_fs::sync_directory(&self.key_dir)
            .map_err(|_| io_error("Cannot flush the credential key directory"))?;
        Ok(pin)
    }

    fn leftover_is_promotable(&self, conn: &Connection, leftover: &Path) -> bool {
        let Ok(file) = private_fs::open(leftover, false) else {
            return false;
        };
        let mut key = Zeroizing::new(Vec::new());
        if file.take(49).read_to_end(&mut key).is_err() || key.len() != 48 {
            return false;
        }
        conn.query_row(
            "SELECT count(*) FROM credentials WHERE key_id != ?1",
            [&key[32..]],
            |row| row.get::<_, i64>(0),
        )
        .is_ok_and(|other| other == 0)
    }

    /// Rename `path` to `<name>.broken-<ms>` next to it. The path itself is renamed, so a symlink or
    /// reparse point is moved as a link and never followed.
    fn set_aside(&self, path: &Path) -> Result<PathBuf, IpcError> {
        set_aside(path, now_millis())
    }
}

fn set_aside(path: &Path, stamp: u128) -> Result<PathBuf, IpcError> {
    // Re-validated right before the rename: the folder must still be the user's own (R4).
    if let Some(parent) = path.parent() {
        private_fs::check_root(parent)?;
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io_error("Invalid credential path"))?;
    let mut target = path.with_file_name(format!("{name}.broken-{stamp}"));
    let mut counter = 1;
    while fs::symlink_metadata(&target).is_ok() {
        target = path.with_file_name(format!("{name}.broken-{stamp}-{counter}"));
        counter += 1;
    }
    private_fs::rename(path, &target)
        .map_err(|_| io_error("Cannot set the damaged credential data aside"))?;
    Ok(target)
}

/// Remove a path without following links: a link is removed as a link.
fn remove_path(path: &Path) -> Result<(), IpcError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(io_error("Cannot inspect credential storage")),
    };
    let result = if metadata.file_type().is_symlink() {
        fs::remove_file(path).or_else(|_| fs::remove_dir(path))
    } else if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    };
    result.map_err(|_| io_error("Cannot remove credential storage"))
}

fn mode_of(conn: &Connection, provider: &str) -> Result<Mode, IpcError> {
    let value: Option<String> = conn
        .query_row(
            "SELECT mode FROM accounts WHERE provider=?1",
            [provider],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| sql(error, code::VAULT_CORRUPT, "Cannot inspect credential mode"))?;
    value.as_deref().map(Mode::parse).unwrap_or(Ok(Mode::Local))
}

fn account_flags(conn: &Connection, provider: &str) -> Result<(bool, Option<String>), IpcError> {
    Ok(conn
        .query_row(
            "SELECT known_keychain, endpoint_hash FROM accounts WHERE provider=?1",
            [provider],
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| {
            sql(
                error,
                code::VAULT_CORRUPT,
                "Cannot inspect credential metadata",
            )
        })?
        .unwrap_or((false, None)))
}

fn aad(provider: &str, id: &[u8]) -> Vec<u8> {
    serde_json::to_vec(&("PomiTranslate", SCHEMA, 1, provider, id))
        .expect("fixed credential metadata")
}
fn cipher(key: &[u8]) -> Result<LessSafeKey, IpcError> {
    UnboundKey::new(&aead::AES_256_GCM, &key[..32])
        .map(LessSafeKey::new)
        .map_err(|_| {
            IpcError::new(
                code::VAULT_CORRUPT,
                "Cannot initialize credential encryption",
            )
        })
}
fn decrypt(
    conn: &Connection,
    vault: &Vault,
    provider: &str,
) -> Result<Option<Zeroizing<String>>, IpcError> {
    #[allow(clippy::type_complexity)]
    let row: Option<(i64, Vec<u8>, Vec<u8>, Vec<u8>)> = conn
        .query_row(
            "SELECT cipher_version,key_id,nonce,ciphertext FROM credentials WHERE provider=?1",
            [provider],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|error| {
            sql(
                error,
                code::VAULT_CORRUPT,
                "Cannot read encrypted credential",
            )
        })?;
    let Some((version, id, nonce, ciphertext)) = row else {
        return Ok(None);
    };
    let key = vault.master(conn, false)?;
    let corrupt = |message: &str| IpcError::new(code::VAULT_CORRUPT, message.to_owned());
    if version != 1 || id != key[32..] || nonce.len() != 12 {
        return Err(corrupt("Credential metadata or master key does not match"));
    }
    let mut bytes = Zeroizing::new(ciphertext);
    let plain = cipher(&key)?
        .open_in_place(
            Nonce::try_assume_unique_for_key(&nonce)
                .map_err(|_| corrupt("Invalid credential nonce"))?,
            Aad::from(aad(provider, &id)),
            &mut bytes,
        )
        .map_err(|_| {
            corrupt("Credential authentication failed; stored data was altered or the master key is wrong")
        })?;
    let value =
        std::str::from_utf8(plain).map_err(|_| corrupt("Decrypted credential is invalid"))?;
    Ok(Some(Zeroizing::new(value.to_owned())))
}

impl Credentials {
    pub fn with_keychain(keychain: Box<dyn KeychainStore>) -> Self {
        Self {
            sessions: Mutex::default(),
            known_modes: Mutex::default(),
            keychain,
        }
    }

    fn remember(&self, provider: &str, mode: Mode) {
        if let Ok(mut known) = lock_wait(&self.known_modes) {
            known.insert(provider.to_owned(), mode);
        }
    }

    fn remembered(&self, provider: &str) -> Option<Mode> {
        lock_wait(&self.known_modes)
            .ok()
            .and_then(|known| known.get(provider).copied())
    }

    /// Storage state for the page. Never fails: an unreadable vault comes back as `error`.
    pub fn state(&self, root: &Path, provider: &str) -> State {
        match self.status(root, provider) {
            Ok(status) => State {
                mode: Some(status.mode),
                stored: Some(status.stored),
                error: None,
            },
            Err(error) => State {
                mode: self.remembered(provider),
                stored: None,
                error: Some(error.code),
            },
        }
    }

    pub fn status(&self, root: &Path, provider: &str) -> Result<Status, IpcError> {
        validate_provider(provider)?;
        let sessions = lock_wait(&self.sessions)?;
        let vault = Vault::new(root);
        let Some((conn, _held)) = vault.connection(false)? else {
            return Ok(Status {
                mode: Mode::Local,
                stored: false,
            });
        };
        let mode = mode_of(&conn, provider)?;
        self.remember(provider, mode);
        let stored = match mode {
            Mode::Local => conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM credentials WHERE provider=?1)",
                    [provider],
                    |row| row.get(0),
                )
                .map_err(|error| {
                    sql(
                        error,
                        code::VAULT_CORRUPT,
                        "Cannot inspect credential metadata",
                    )
                })?,
            Mode::Session => sessions.contains_key(provider),
            Mode::Keychain => account_flags(&conn, provider)?.0,
        };
        Ok(Status { mode, stored })
    }

    /// The stored key for `provider`, or `None`. `endpoint` is the canonical base URL the request is
    /// about to be sent to; the Custom key is returned only for the endpoint it was saved for.
    pub fn read(
        &self,
        root: &Path,
        provider: &str,
        endpoint: Option<&str>,
    ) -> Result<Option<Zeroizing<String>>, IpcError> {
        validate_provider(provider)?;
        let sessions = lock_wait(&self.sessions)?;
        let vault = Vault::new(root);
        let Some((conn, _held)) = vault.connection(false)? else {
            return Ok(None);
        };
        let mode = mode_of(&conn, provider)?;
        self.remember(provider, mode);
        let secret = match mode {
            Mode::Local => decrypt(&conn, &vault, provider)?,
            Mode::Session => sessions
                .get(provider)
                .map(|s| Zeroizing::new(s.to_string())),
            Mode::Keychain => self.keychain.get(provider)?,
        };
        if secret.is_some() && provider == BOUND_PROVIDER {
            Self::check_endpoint(&conn, provider, endpoint)?;
        }
        Ok(secret)
    }

    /// The Custom key goes only to the endpoint it was saved for. A key saved before endpoints were
    /// recorded has none, and a request cannot establish where it was meant to go: it stays unusable
    /// until the person types it again (R2): the request or a renderer message cannot say where a key
    /// belongs, only the key being entered together with the endpoint can.
    fn check_endpoint(
        conn: &Connection,
        provider: &str,
        endpoint: Option<&str>,
    ) -> Result<(), IpcError> {
        let wanted = endpoint.map(endpoint_hash);
        let (_, stored) = account_flags(conn, provider)?;
        match (stored, wanted) {
            (Some(stored), Some(wanted)) if stored == wanted => Ok(()),
            (None, _) => Err(IpcError::new(
                code::CREDENTIAL_ENDPOINT_UNBOUND,
                "The stored API key has no recorded endpoint; enter the key again",
            )),
            _ => Err(IpcError::new(
                code::CREDENTIAL_ENDPOINT_MISMATCH,
                "The stored API key was saved for a different endpoint",
            )),
        }
    }

    pub fn save(
        &self,
        root: &Path,
        provider: &str,
        mode: Mode,
        supplied: &str,
        endpoint: Option<&str>,
    ) -> Result<Status, SaveError> {
        validate_provider(provider)?;
        let mut sessions = lock_wait(&self.sessions)?;
        let vault = Vault::new(root);
        let (mut conn, _held) = vault
            .connection(true)?
            .ok_or_else(|| io_error("Cannot initialize credential storage"))?;
        let ledger = Ledger::new(root);
        let mut record = load_record(&ledger, VaultView::Readable(&conn))?;
        let previous = mode_of(&conn, provider)?;
        let (was_known_keychain, existing_hash) = account_flags(&conn, provider)?;
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
                Mode::Keychain => self.keychain.get(provider)?,
            }
        };
        let tx = conn
            .transaction()
            .map_err(|error| sql(error, code::VAULT_IO, "Cannot begin credential transaction"))?;
        // A storage-mode change moves this application's copy. Do not leave a dormant
        // local key behind that can be reactivated after a session expires or is deleted.
        // Existing rows from earlier versions also must not substitute for a missing key.
        if mode != Mode::Local || (previous != mode && secret.is_none()) {
            tx.execute("DELETE FROM credentials WHERE provider=?1", [provider])
                .map_err(|error| {
                    sql(
                        error,
                        code::VAULT_IO,
                        "Cannot remove previous encrypted credential",
                    )
                })?;
        }
        if let Some(ref secret) = secret {
            if mode == Mode::Local {
                let key = vault.master(&tx, true)?;
                let mut nonce = [0u8; 12];
                SystemRandom::new()
                    .fill(&mut nonce)
                    .map_err(|_| io_error("Secure randomness is unavailable"))?;
                let mut bytes = Zeroizing::new(secret.as_bytes().to_vec());
                cipher(&key)?
                    .seal_in_place_append_tag(
                        Nonce::assume_unique_for_key(nonce),
                        Aad::from(aad(provider, &key[32..])),
                        &mut *bytes,
                    )
                    .map_err(|_| io_error("Could not encrypt credential"))?;
                tx.execute("INSERT INTO credentials(provider,cipher_version,key_id,nonce,ciphertext) VALUES (?1,1,?2,?3,?4) ON CONFLICT(provider) DO UPDATE SET cipher_version=1,key_id=excluded.key_id,nonce=excluded.nonce,ciphertext=excluded.ciphertext,updated_at=unixepoch()", params![provider,&key[32..],&nonce[..],&*bytes]).map_err(|error| sql(error, code::VAULT_IO, "Could not store encrypted credential"))?;
                if decrypt(&tx, &vault, provider)?
                    .as_deref()
                    .map(|s| s.as_str())
                    != Some(secret.as_str())
                {
                    return Err(IpcError::new(
                        code::VAULT_CORRUPT,
                        "Credential verification failed",
                    )
                    .into());
                }
            }
        }
        // The app's own keychain entry is removed when the key moves to another store (CR-5).
        let leaving_keychain = previous == Mode::Keychain && mode != Mode::Keychain;
        let known = if mode == Mode::Keychain && secret.is_some() {
            true
        } else if leaving_keychain {
            false
        } else {
            was_known_keychain
        };
        let bound_hash = if provider != BOUND_PROVIDER {
            None
        } else if supplied.is_empty() {
            existing_hash
        } else {
            endpoint.map(endpoint_hash)
        };
        tx.execute("INSERT INTO accounts(provider,mode,known_keychain,endpoint_hash) VALUES (?1,?2,?3,?4) ON CONFLICT(provider) DO UPDATE SET mode=excluded.mode,known_keychain=excluded.known_keychain,endpoint_hash=excluded.endpoint_hash", params![provider,mode.label(),known,bound_hash]).map_err(|error| sql(error, code::VAULT_IO, "Cannot save credential mode"))?;
        // Derive the acknowledgement inside this transaction. A second status read after
        // commit could fail and falsely report that an already committed key was not saved.
        let stored = match mode {
            Mode::Local => {
                tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM credentials WHERE provider=?1)",
                    [provider],
                    |row| row.get(0),
                )
                .map_err(|error| sql(error, code::VAULT_IO, "Cannot inspect credential metadata"))?
            }
            Mode::Session => secret.is_some() || sessions.contains_key(provider),
            Mode::Keychain => known,
        };
        let keychain_action: Option<Option<&str>> = if mode == Mode::Keychain && secret.is_some() {
            Some(secret.as_ref().map(|s| s.as_str()))
        } else if leaving_keychain && was_known_keychain {
            Some(None)
        } else {
            None
        };
        if let Some(action) = keychain_action {
            let previous_key = self.keychain.get(provider)?;
            let name = provider_name(provider);
            let before = Previous::of(record.get(name));
            if action.is_some() {
                // Recorded as pending, with what the entry was before, and made durable before the
                // OS entry is touched: a crash in between cannot lose it, and a write that fails
                // and is undone puts the old state back exactly (R3).
                record.set(name, Ownership::Pending(before));
                ledger.save(&record)?;
            }
            let result = keychain_transaction::commit(
                || match action {
                    Some(value) => self.keychain.set(provider, value),
                    None => self.keychain.delete(provider),
                },
                || {
                    tx.commit().map_err(|error| {
                        sql(error, code::VAULT_IO, "Credential metadata commit failed")
                    })
                },
                || match previous_key.as_ref() {
                    Some(previous) => self.keychain.set(provider, previous),
                    None => self.keychain.delete(provider),
                },
            );
            match &result {
                Ok(()) => {
                    if action.is_some() {
                        record.set(name, Ownership::Owned);
                    } else {
                        record.remove(name);
                    }
                }
                // The previous value is back: so is the previous ownership.
                Err(error) if !error.uncertain => {
                    if action.is_some() {
                        record.restore(name, before);
                    }
                }
                // Neither state can be vouched for.
                Err(_) => record.set(name, Ownership::Uncertain),
            }
            // A record that cannot be saved here stays as the (conservative) pending one on disk.
            save_best_effort(&ledger, &record);
            result?;
        } else {
            tx.commit().map_err(|error| {
                sql(
                    error,
                    code::VAULT_IO,
                    "Cannot commit credential transaction",
                )
            })?;
        }
        if mode == Mode::Session {
            if let Some(secret) = secret {
                sessions.insert(provider.to_owned(), secret);
            }
        } else {
            sessions.remove(provider);
        }
        self.remember(provider, mode);
        Ok(Status { mode, stored })
    }

    pub fn import_keychain(
        &self,
        root: &Path,
        provider: &str,
        endpoint: Option<&str>,
    ) -> Result<Status, IpcError> {
        validate_provider(provider)?;
        let secret = self.keychain.get(provider)?.ok_or_else(|| {
            IpcError::new(
                code::KEYCHAIN_EMPTY,
                "No existing API key was found in the OS credential store",
            )
        })?;
        self.save(root, provider, Mode::Local, &secret, endpoint)
            .map_err(|error| error.error)
    }

    /// Delete one provider's key from every store this app writes to. When the vault cannot even be
    /// opened (bad permissions, damaged data) it cannot be edited row by row, so it is set aside
    /// whole, exactly as "reset credential storage" does.
    ///
    /// The OS entry is deleted only when the ownership record confirms the app wrote it (the same
    /// decision a purge makes, `Record::authority`). Otherwise nothing is sent to the OS store and
    /// the answer is `KEYCHAIN_UNCONFIRMED`, whether or not the vault could be read; the app's own
    /// copies (encrypted row, session) are still removed.
    pub fn delete(&self, root: &Path, provider: &str) -> Result<(), IpcError> {
        validate_provider(provider)?;
        let mut sessions = lock_wait(&self.sessions)?;
        let vault = Vault::new(root);
        let ledger = Ledger::new(root);
        let (mut conn, _held) = match vault.connection(false) {
            Ok(Some(open)) => open,
            Ok(None) => {
                let recorded = self.delete_recorded(&ledger, provider, VaultView::Absent);
                sessions.remove(provider);
                return recorded;
            }
            Err(error)
                if matches!(
                    error.code,
                    code::VAULT_PERMISSIONS | code::VAULT_SCHEMA | code::VAULT_CORRUPT
                ) =>
            {
                // The vault cannot say what it wrote; the record outside it can. The vault is set
                // aside either way; an entry the record cannot vouch for is reported afterwards.
                let recorded = self.delete_recorded(&ledger, provider, VaultView::Unreadable);
                self.reset_locked(&mut sessions, root)?;
                return recorded;
            }
            Err(error) => return Err(error),
        };
        // The vault's committed `known_keychain` is merged into the record here (as `Owned`), a
        // keychain mode without it as `Uncertain`: the mode alone is never ownership.
        let mut record = load_record(&ledger, VaultView::Readable(&conn))?;
        let name = provider_name(provider);
        let authority = record.authority(name);
        let tx = conn
            .transaction()
            .map_err(|error| sql(error, code::VAULT_IO, "Cannot begin credential transaction"))?;
        if authority == Authority::Owned {
            self.keychain.delete(provider)?;
        }
        if authority != Authority::Unconfirmed {
            tx.execute(
                "UPDATE accounts SET known_keychain=0, endpoint_hash=NULL WHERE provider=?1",
                [provider],
            )
            .map_err(|error| sql(error, code::VAULT_IO, "Cannot update credential metadata"))?;
        }
        // Purge any local copy, including rows left by an older storage-mode switch.
        tx.execute("DELETE FROM credentials WHERE provider=?1", [provider])
            .map_err(|error| sql(error, code::VAULT_IO, "Cannot delete encrypted credential"))?;
        tx.commit()
            .map_err(|error| sql(error, code::VAULT_IO, "Cannot commit credential deletion"))?;
        if authority == Authority::Owned {
            record.remove(name);
            save_best_effort(&ledger, &record);
        }
        sessions.remove(provider);
        match authority {
            Authority::Unconfirmed => Err(unconfirmed()),
            Authority::Owned | Authority::NotOurs => Ok(()),
        }
    }

    /// The delete of one provider's OS entry when the vault cannot help: the same decision as every
    /// other delete. An entry the record cannot vouch for is reported, never touched.
    fn delete_recorded(
        &self,
        ledger: &Ledger,
        provider: &str,
        vault: VaultView<'_>,
    ) -> Result<(), IpcError> {
        let mut record = load_record(ledger, vault)?;
        let name = provider_name(provider);
        match record.authority(name) {
            Authority::Owned => {
                self.keychain.delete(provider)?;
                record.remove(name);
                save_best_effort(ledger, &record);
                Ok(())
            }
            Authority::Unconfirmed => Err(unconfirmed()),
            Authority::NotOurs => Ok(()),
        }
    }

    /// Set the vault and its key directory aside (`*.broken-<ms>`, links are never followed) and make
    /// fresh empty ones. Nothing is read or decrypted, so it works whatever is wrong with them. The
    /// OS keychain is not touched, but what the vault says it wrote there is first copied into the
    /// ownership record that lives outside the directories being set aside (M1).
    pub fn reset_storage(&self, root: &Path) -> Result<(), IpcError> {
        let mut sessions = lock_wait(&self.sessions)?;
        self.reset_locked(&mut sessions, root)
    }

    fn reset_locked(
        &self,
        sessions: &mut HashMap<String, Zeroizing<String>>,
        root: &Path,
    ) -> Result<(), IpcError> {
        let vault = Vault::new(root);
        let ledger = Ledger::new(root);
        // What the keychain may hold for this app is written into the record, which lives outside
        // the directories about to be set aside, before they are touched. When that cannot be
        // done the reset stops: setting the vault aside would lose the only evidence (R5).
        match vault.connection(false) {
            Ok(Some((conn, held))) => {
                let loaded = load_record(&ledger, VaultView::Readable(&conn));
                // Close the database before its directory is moved.
                drop(conn);
                drop(held);
                // Everything the vault says is now in the record. Its archive (made below) is what
                // reconciles a record lost later; a record that is already unknown stays unknown.
                loaded?;
            }
            Ok(None) => {
                load_record(&ledger, VaultView::Absent)?;
            }
            Err(_) => {
                load_record(&ledger, VaultView::Unreadable)?;
            }
        }
        let stamp = now_millis();
        for dir in [&vault.root, &vault.key_dir] {
            match fs::symlink_metadata(dir) {
                Ok(_) => {
                    set_aside(dir, stamp)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(io_error("Cannot inspect credential storage")),
            }
        }
        private_fs::directory(&vault.root)?;
        private_fs::directory(&vault.key_dir)?;
        sessions.clear();
        if let Ok(mut known) = lock_wait(&self.known_modes) {
            known.clear();
        }
        Ok(())
    }

    /// The person says they removed any PomiTranslate entries from the system keychain themselves.
    /// This clears the unknown-history marker that was already saved and records the time. It never
    /// touches the OS store, the vault or any other entry of the record, and it reads nothing new
    /// into the record: with no saved marker there is nothing to clear and the answer is `false`.
    pub fn acknowledge_unknown(&self, root: &Path) -> Result<bool, IpcError> {
        let _sessions = lock_wait(&self.sessions)?;
        let ledger = Ledger::new(root);
        match ledger.read()? {
            LedgerRead::Present(mut record) if record.unreconciled => {
                record.unreconciled = false;
                record.acknowledged_at = Some(u64::try_from(now_millis()).unwrap_or(u64::MAX));
                ledger.save(&record)?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    /// App reset with "delete keys": delete the OS entries the ownership record says this app
    /// created (and nothing else), then the vault, the key directory and every set-aside copy. A
    /// step that fails does not stop the others: the answer says what is gone and what could not be
    /// confirmed. An entry whose deletion failed stays in the record, and every entry is written
    /// there before any vault metadata is removed, so a retry finds it. An entry the app cannot
    /// vouch for (pending, or found only in damaged data) is reported uncertain and never deleted.
    pub fn purge(&self, root: &Path) -> Result<Purged, IpcError> {
        let mut sessions = lock_wait(&self.sessions)?;
        let vault = Vault::new(root);
        let ledger = Ledger::new(root);
        let mut outcome = Purged::default();

        let loaded = match vault.connection(false) {
            Ok(Some((conn, held))) => {
                let loaded = load_record(&ledger, VaultView::Readable(&conn));
                // Close the database before its directory is removed.
                drop(conn);
                drop(held);
                loaded
            }
            Ok(None) => load_record(&ledger, VaultView::Absent),
            Err(_) => load_record(&ledger, VaultView::Unreadable),
        };
        // Without a record nothing is known, and the vault metadata that could say is kept.
        let mut record = match loaded {
            Ok(loaded) => loaded,
            Err(error) => {
                outcome.errors.push(error.code);
                outcome.keychain_unverified = true;
                Record::default()
            }
        };
        let record_known = !outcome.keychain_unverified;
        for provider in record.owned() {
            match self.keychain.delete(provider) {
                Ok(()) => {
                    outcome.keychain_deleted.push(provider);
                    record.remove(provider);
                }
                Err(error) => outcome.keychain_failed.push((provider, error.code)),
            }
        }
        outcome.keychain_uncertain = record.unestablished();
        // An unknown history stays unknown: no vault, however readable (a new or replacement one
        // included), says what the keychain held before it. Only a reconciliation that covered the
        // history when the loss was found, or the person's acknowledgement, clears the marker.
        if record.unreconciled {
            outcome.keychain_unverified = true;
        }
        // Every obligation that is left is durable before any vault metadata goes.
        let mut obligations_saved = record_known;
        if record_known && !record.is_clear() {
            if let Err(error) = ledger.save(&record) {
                obligations_saved = false;
                outcome.errors.push(error.code);
            }
        }

        let mut targets = vec![vault.root.clone(), vault.key_dir.clone()];
        let mut listed = true;
        if let Some(parent) = vault.root.parent() {
            match fs::read_dir(parent) {
                Ok(entries) => {
                    for entry in entries {
                        let Ok(entry) = entry else {
                            listed = false;
                            continue;
                        };
                        let name = entry.file_name();
                        let name = name.to_string_lossy();
                        if name.starts_with("credentials.broken-")
                            || name.starts_with("credential-key.broken-")
                        {
                            targets.push(entry.path());
                        }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => listed = false,
            }
        }
        outcome.files_removed = listed && obligations_saved;
        if !listed {
            outcome.errors.push(code::VAULT_IO);
        }
        if obligations_saved {
            for target in targets {
                if let Err(error) = remove_path(&target) {
                    outcome.files_removed = false;
                    outcome.errors.push(error.code);
                }
            }
        }
        // The record goes with the keys only when nothing is owed and nothing is unknown.
        if record_known && obligations_saved && record.is_clear() {
            if let Err(error) = ledger.remove_files() {
                outcome.errors.push(error.code);
            }
        }
        sessions.clear();
        if let Ok(mut known) = lock_wait(&self.known_modes) {
            known.clear();
        }
        outcome.errors.dedup();
        Ok(outcome)
    }
}

/// What a purge removed and what it could not confirm.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Purged {
    /// OS credential entries confirmed deleted.
    pub keychain_deleted: Vec<&'static str>,
    /// Entries whose deletion failed, with the reason; they stay in the ownership record.
    pub keychain_failed: Vec<(&'static str, &'static str)>,
    /// Entries that may exist but that the app cannot vouch for as its own (a write that never
    /// finished, or a name found only in damaged data). They are never deleted, and stay recorded.
    pub keychain_uncertain: Vec<&'static str>,
    /// Neither the ownership record nor the vault could say which OS entries exist, so none could
    /// be checked.
    pub keychain_unverified: bool,
    /// The vault, the key directory and every set-aside copy are gone.
    pub files_removed: bool,
    /// Codes of failures other than a failed entry deletion.
    pub errors: Vec<&'static str>,
}

impl Purged {
    /// Every store was emptied and confirmed.
    pub fn complete(&self) -> bool {
        self.keychain_failed.is_empty()
            && self.keychain_uncertain.is_empty()
            && !self.keychain_unverified
            && self.files_removed
            && self.errors.is_empty()
    }
}

/// The OS entries the vault says this app wrote. `known_keychain` is committed only after the OS
/// write was confirmed, so it is ownership; a keychain mode without it is only a hint. A vault that
/// cannot be read is an error, never an empty answer.
fn vault_entries(conn: &Connection) -> Result<Vec<(&'static str, Ownership)>, IpcError> {
    let mut entries = Vec::new();
    for provider in PROVIDERS.iter().copied() {
        let (known, _) = account_flags(conn, provider)?;
        if known {
            entries.push((provider, Ownership::Owned));
        } else if mode_of(conn, provider)? == Mode::Keychain {
            entries.push((provider, Ownership::Uncertain));
        }
    }
    Ok(entries)
}

/// What the vault can say when the ownership record is read.
enum VaultView<'a> {
    /// There is no vault.
    Absent,
    Readable(&'a Connection),
    /// There is one, but it cannot be read.
    Unreadable,
}

/// What the archived vaults (`credentials.broken-*`, set aside by a storage reset) say about the
/// keychain: the metadata of every earlier vault generation, which a fresh vault cannot know.
struct Archives {
    entries: Vec<(&'static str, Ownership)>,
    /// Every archive could be read (one that holds no database holds nothing and counts as read).
    complete: bool,
}

fn read_archives(root: &Path) -> Archives {
    let mut archives = Archives {
        entries: Vec::new(),
        complete: true,
    };
    let listing = match fs::read_dir(root) {
        Ok(listing) => listing,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return archives,
        Err(_) => {
            archives.complete = false;
            return archives;
        }
    };
    for entry in listing {
        let Ok(entry) = entry else {
            archives.complete = false;
            continue;
        };
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with("credentials.broken-")
        {
            continue;
        }
        match archived_accounts(&entry.path()) {
            Some(found) => archives.entries.extend(found),
            None => archives.complete = false,
        }
    }
    archives
}

/// The keychain-related rows of one archived vault directory, read-only; `None` when it cannot be
/// read. Nothing in it is decrypted.
fn archived_accounts(directory: &Path) -> Option<Vec<(&'static str, Ownership)>> {
    let metadata = fs::symlink_metadata(directory).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    let db = directory.join("credentials.sqlite");
    match fs::symlink_metadata(&db) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(Vec::new()),
        Err(_) => return None,
        Ok(metadata) if !metadata.is_file() => return None,
        Ok(metadata) if metadata.len() == 0 => return Some(Vec::new()),
        Ok(_) => {}
    }
    let conn = Connection::open_with_flags(
        &db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let mut found = Vec::new();
    {
        let mut statement = conn
            .prepare("SELECT provider, mode, known_keychain FROM accounts")
            .ok()?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                ))
            })
            .ok()?;
        for row in rows {
            let (provider, mode, known) = row.ok()?;
            let Some(provider) = PROVIDERS.iter().copied().find(|name| *name == provider) else {
                continue;
            };
            if known {
                found.push((provider, Ownership::Owned));
            } else if mode == Mode::Keychain.label() {
                found.push((provider, Ownership::Uncertain));
            }
        }
    }
    Some(found)
}

/// Put what a witness says into the record: a new name as it says, an uncertain one confirmed by an
/// owned witness. A pending or already owned entry is never overridden.
fn merge_witness(record: &mut Record, provider: &'static str, state: Ownership) {
    match record.get(provider) {
        None => record.set(provider, state),
        Some(Ownership::Uncertain) if state == Ownership::Owned => {
            record.set(provider, Ownership::Owned);
        }
        Some(_) => {}
    }
}

/// The ownership record, with a lost, damaged or untrusted one rebuilt as far as it can be (R5, F3,
/// F4). A missing record next to a vault, or one that is damaged or fails the integrity checks, is
/// unknown, not empty: a bad file is kept aside, and what can still be read from it, from earlier
/// copies, from the vault and from the archived vaults goes in (a name found only in damaged data is
/// uncertain). The `unreconciled` marker is set unless that evidence covers the history:
///
/// * every archived vault was readable, and the live vault could be read;
/// * and, when there is evidence that a record existed (a damaged file or earlier copies), something
///   witnessed an earlier keychain entry: a row in an archive or in the live vault. A live vault
///   with no keychain row at all is a fresh one, and a fresh vault is never a witness.
///
/// That decision is made once, when the loss is found. A saved marker is never re-evaluated here, so
/// a vault created afterwards cannot clear it; only `acknowledge_unknown` does. The record is saved
/// when it changed.
fn load_record(ledger: &Ledger, vault: VaultView<'_>) -> Result<Record, IpcError> {
    let (mut record, baseline, rebuilt, damaged) = match ledger.read()? {
        LedgerRead::Present(found) => (found.clone(), found, false, false),
        LedgerRead::Missing => (Record::default(), Record::default(), true, false),
        LedgerRead::Damaged { recovered } => {
            ledger.quarantine()?;
            let mut record = Record::default();
            for provider in recovered {
                record.set(provider, Ownership::Uncertain);
            }
            (record, Record::default(), true, true)
        }
    };
    let live = match &vault {
        VaultView::Absent => Some(Vec::new()),
        VaultView::Readable(conn) => vault_entries(conn).ok(),
        VaultView::Unreadable => None,
    };
    if rebuilt {
        let traces = ledger.traces()?;
        for provider in &traces.providers {
            if record.get(provider).is_none() {
                record.set(provider, Ownership::Uncertain);
            }
        }
        let archives = read_archives(ledger.root());
        for (provider, state) in &archives.entries {
            merge_witness(&mut record, provider, *state);
        }
        let record_existed = damaged || traces.any;
        let witnessed = !archives.entries.is_empty()
            || live.as_ref().is_some_and(|entries| !entries.is_empty());
        let covered = archives.complete && live.is_some() && (!record_existed || witnessed);
        if !covered {
            record.unreconciled = true;
        }
    }
    for (provider, state) in live.into_iter().flatten() {
        merge_witness(&mut record, provider, state);
    }
    // A damaged file has just been moved away: the rebuilt record must be written.
    if damaged || record != baseline {
        ledger.save(&record)?;
    }
    Ok(record)
}

fn unconfirmed() -> IpcError {
    IpcError::new(
        code::KEYCHAIN_UNCONFIRMED,
        "An OS credential entry may exist that this app cannot confirm it created",
    )
}

/// Save the record where a failure must not undo what already happened; the failure is logged. The
/// copy on disk then stays the more conservative earlier one.
fn save_best_effort(ledger: &Ledger, record: &Record) {
    if let Err(error) = ledger.save(record) {
        crate::diagnostics::global().log_error("credentials:ledger", &error);
    }
}

/// The static name of a provider that passed `validate_provider`.
fn provider_name(provider: &str) -> &'static str {
    PROVIDERS
        .iter()
        .copied()
        .find(|known| *known == provider)
        .unwrap_or("")
}

/// Test-only: credentials on an in-memory keychain that the test can look into and make fail.
#[cfg(test)]
pub(crate) fn with_fake_keychain() -> (Credentials, std::sync::Arc<keychain::fake::FakeKeychain>) {
    struct Shared(std::sync::Arc<keychain::fake::FakeKeychain>);
    impl KeychainStore for Shared {
        fn get(&self, provider: &str) -> Result<Option<Zeroizing<String>>, IpcError> {
            self.0.get(provider)
        }
        fn set(&self, provider: &str, secret: &str) -> Result<(), IpcError> {
            self.0.set(provider, secret)
        }
        fn delete(&self, provider: &str) -> Result<(), IpcError> {
            self.0.delete(provider)
        }
    }
    let fake = std::sync::Arc::new(keychain::fake::FakeKeychain::default());
    (
        Credentials::with_keychain(Box::new(Shared(fake.clone()))),
        fake,
    )
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod vault_tests;
