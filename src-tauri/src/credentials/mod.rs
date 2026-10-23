mod keychain;
mod keychain_transaction;
mod private_fs;

use ring::{
    aead::{self, Aad, LessSafeKey, Nonce, UnboundKey},
    digest,
    rand::{SecureRandom, SystemRandom},
};
use rusqlite::{params, Connection, OptionalExtension};
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

/// Whether the OS store has to be asked about a provider's key before it is deleted. The vault's
/// row is the only evidence: the person is in Keychain mode now, or the row records (the plain
/// `known_keychain` metadata) that a key was ever stored there. Anything else is someone who never
/// chose the keychain, and the app must not reach it for them (no automatic keychain access).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EntryPlan {
    /// The vault says the keychain was never used for this provider: no OS call.
    Skip,
    /// The vault says the keychain holds, or held, this key: a delete the store does not confirm is
    /// `KEYCHAIN_UNCONFIRMED`, a platform without any store included.
    Required,
    /// The vault cannot say (missing, unreadable) and the person asked for the keys to go: try, and a
    /// platform with no credential store at all counts as nothing to delete.
    BestEffort,
}

fn entry_plan(conn: &Connection, provider: &str) -> EntryPlan {
    match (mode_of(conn, provider), account_flags(conn, provider)) {
        (Ok(mode), Ok((known, _))) if mode == Mode::Keychain || known => EntryPlan::Required,
        (Ok(_), Ok(_)) => EntryPlan::Skip,
        _ => EntryPlan::BestEffort,
    }
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
        self.save_locked(root, provider, mode, supplied, endpoint, false)
    }

    /// `import` copies a key that is already in the OS store into Local mode: the OS entry stays, and
    /// the row records (`known_keychain`) that it exists, so a later delete or reset still reaches it.
    fn save_locked(
        &self,
        root: &Path,
        provider: &str,
        mode: Mode,
        supplied: &str,
        endpoint: Option<&str>,
        import: bool,
    ) -> Result<Status, SaveError> {
        validate_provider(provider)?;
        let mut sessions = lock_wait(&self.sessions)?;
        let vault = Vault::new(root);
        let (mut conn, _held) = vault
            .connection(true)?
            .ok_or_else(|| io_error("Cannot initialize credential storage"))?;
        let previous = mode_of(&conn, provider)?;
        if import && previous == Mode::Keychain {
            return Err(already_in_keychain().into());
        }
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
        // Before the OS store is written, the vault durably records (`known_keychain`, in a
        // transaction of its own) that this provider used the keychain. A crash between the OS write
        // and the mode commit then still leaves the note that makes a later delete or reset reach the
        // entry. If the note cannot be made durable the OS store is not touched. The note is cleared
        // only together with a confirmed OS delete.
        if mode == Mode::Keychain && secret.is_some() && !was_known_keychain {
            conn.execute(
                "INSERT INTO accounts(provider,mode,known_keychain,endpoint_hash) VALUES (?1,?2,1,NULL) ON CONFLICT(provider) DO UPDATE SET known_keychain=1",
                params![provider, previous.label()],
            )
            .map_err(|error| sql(error, code::VAULT_IO, "Cannot save credential mode"))?;
        }
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
        // The app's own keychain entry (`PomiTranslate/<provider>`) is removed when the key moves to
        // another store (CR-5); one that is already missing counts as removed. The OS store is only
        // reached when the vault's row says Keychain mode now or that a key was ever stored there
        // (`known_keychain`): someone who never used the keychain makes no OS call.
        let leaving_keychain =
            !import && mode != Mode::Keychain && (previous == Mode::Keychain || was_known_keychain);
        let known = if (mode == Mode::Keychain && secret.is_some()) || import {
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
        } else if leaving_keychain {
            Some(None)
        } else {
            None
        };
        if let Some(action) = keychain_action {
            let previous_key = self.keychain.get(provider)?;
            keychain_transaction::commit(
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
            )?;
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

    /// Copy the key that is in the OS store into Local mode. It is a copy: the OS entry is not
    /// deleted, and the row records that the keychain holds a key, so a later delete or reset still
    /// removes it. A provider that is already in Keychain mode has nothing to import.
    pub fn import_keychain(
        &self,
        root: &Path,
        provider: &str,
        endpoint: Option<&str>,
    ) -> Result<Status, IpcError> {
        validate_provider(provider)?;
        if self.status(root, provider)?.mode == Mode::Keychain {
            return Err(already_in_keychain());
        }
        let secret = self.keychain.get(provider)?.ok_or_else(|| {
            IpcError::new(
                code::KEYCHAIN_EMPTY,
                "No existing API key was found in the OS credential store",
            )
        })?;
        self.save_locked(root, provider, Mode::Local, &secret, endpoint, true)
            .map_err(|error| error.error)
    }

    /// Delete one provider's key from every store this app writes to. When the vault cannot even be
    /// opened (bad permissions, damaged data) it cannot be edited row by row, so it is set aside
    /// whole, exactly as "reset credential storage" does.
    ///
    /// The OS entry is `PomiTranslate/<provider>`: the app's own namespace, and one that is already
    /// missing counts as deleted. It is only asked about when the vault's row says Keychain mode now
    /// or that a key was ever stored there (`known_keychain`); with no such record (or no vault) the
    /// OS store is not contacted. A vault that cannot be read cannot say, so the delete is tried and
    /// a platform without any credential store counts as nothing to delete. When the OS store
    /// refuses the delete the answer is `KEYCHAIN_UNCONFIRMED` and nothing else is uncertain: the
    /// entry (and the vault's note that it exists) is left as it was, the app's own copies (encrypted
    /// row, session) are removed anyway, and deleting again tries the OS entry again.
    pub fn delete(&self, root: &Path, provider: &str) -> Result<(), IpcError> {
        validate_provider(provider)?;
        let mut sessions = lock_wait(&self.sessions)?;
        let vault = Vault::new(root);
        let (mut conn, _held) = match vault.connection(false) {
            Ok(Some(open)) => open,
            Ok(None) => {
                // No vault: nothing ever recorded a keychain key.
                sessions.remove(provider);
                return Ok(());
            }
            Err(error)
                if matches!(
                    error.code,
                    code::VAULT_PERMISSIONS | code::VAULT_SCHEMA | code::VAULT_CORRUPT
                ) =>
            {
                // The vault cannot say, so the entry is tried. A refused delete is owed a retry: the
                // damaged vault is replaced only by one that records the keychain for this provider
                // (otherwise it stays, and the retry meets the same unreadable vault).
                let entry = self.delete_entry(provider, EntryPlan::BestEffort);
                if entry.is_ok() {
                    self.reset_locked(&mut sessions, root)?;
                } else if self
                    .reset_recording_keychain(&mut sessions, root, provider)
                    .is_err()
                {
                    sessions.remove(provider);
                }
                return entry;
            }
            Err(error) => return Err(error),
        };
        let entry = self.delete_entry(provider, entry_plan(&conn, provider));
        let tx = conn
            .transaction()
            .map_err(|error| sql(error, code::VAULT_IO, "Cannot begin credential transaction"))?;
        if entry.is_ok() {
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
        sessions.remove(provider);
        entry
    }

    /// Delete this app's OS entry for `provider` (`PomiTranslate/<provider>`; a missing entry is a
    /// success) as far as `plan` allows. A refusal is the one thing reported, as
    /// `KEYCHAIN_UNCONFIRMED`; the OS reason goes to the log.
    fn delete_entry(&self, provider: &str, plan: EntryPlan) -> Result<(), IpcError> {
        if plan == EntryPlan::Skip {
            return Ok(());
        }
        match self.keychain.delete(provider) {
            Ok(()) => Ok(()),
            Err(error)
                if plan == EntryPlan::BestEffort && error.code == code::KEYCHAIN_UNAVAILABLE =>
            {
                Ok(())
            }
            Err(error) => {
                crate::diagnostics::global().log_error("credentials:keychain", &error);
                Err(unconfirmed())
            }
        }
    }

    /// Set the vault and its key directory aside (`*.broken-<ms>`, links are never followed) and make
    /// fresh empty ones. Nothing is read or decrypted, so it works whatever is wrong with them. The
    /// OS keychain is not touched.
    pub fn reset_storage(&self, root: &Path) -> Result<(), IpcError> {
        let mut sessions = lock_wait(&self.sessions)?;
        self.reset_locked(&mut sessions, root)
    }

    /// Like `reset_locked`, for a delete the OS store refused while the vault was unreadable: the new
    /// vault holds `known_keychain=1` for `provider`, so deleting again reaches the entry. All or
    /// nothing: if that vault cannot be made, whatever was set aside is moved back.
    fn reset_recording_keychain(
        &self,
        sessions: &mut HashMap<String, Zeroizing<String>>,
        root: &Path,
        provider: &str,
    ) -> Result<(), IpcError> {
        let vault = Vault::new(root);
        let stamp = now_millis();
        // `moved`: set-aside copies to put back. `ours`: places that no longer hold the original.
        let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
        let mut ours: Vec<PathBuf> = Vec::new();
        let replace = |moved: &mut Vec<(PathBuf, PathBuf)>,
                       ours: &mut Vec<PathBuf>|
         -> Result<(), IpcError> {
            for dir in [&vault.root, &vault.key_dir] {
                match fs::symlink_metadata(dir) {
                    Ok(_) => {
                        moved.push((dir.clone(), set_aside(dir, stamp)?));
                        ours.push(dir.clone());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        ours.push(dir.clone());
                    }
                    Err(_) => return Err(io_error("Cannot inspect credential storage")),
                }
            }
            #[cfg(test)]
            if tests_hook::FAIL_NEW_VAULT.with(|flag| flag.get()) {
                return Err(io_error("Fixture: the replacement vault cannot be made"));
            }
            private_fs::directory(&vault.key_dir)?;
            let (conn, _held) = vault
                .connection(true)?
                .ok_or_else(|| io_error("Cannot initialize credential storage"))?;
            conn.execute(
                "INSERT INTO accounts(provider,mode,known_keychain,endpoint_hash) VALUES (?1,'local',1,NULL) ON CONFLICT(provider) DO UPDATE SET known_keychain=1",
                [provider],
            )
            .map_err(|error| sql(error, code::VAULT_IO, "Cannot save credential mode"))?;
            Ok(())
        };
        if let Err(error) = replace(&mut moved, &mut ours) {
            // Whatever stands in the old places was made by this attempt: remove it, then put the
            // original back. A step that fails here leaves the set-aside copy where it is.
            let cleared = ours.iter().all(|path| remove_path(path).is_ok());
            let restored = cleared
                && moved
                    .iter()
                    .rev()
                    .all(|(original, aside)| private_fs::rename(aside, original).is_ok());
            if !restored {
                crate::diagnostics::global().log_error(
                    "credentials",
                    &io_error("Cannot restore the previous credential storage"),
                );
            }
            return Err(error);
        }
        sessions.clear();
        if let Ok(mut known) = lock_wait(&self.known_modes) {
            known.clear();
        }
        Ok(())
    }

    fn reset_locked(
        &self,
        sessions: &mut HashMap<String, Zeroizing<String>>,
        root: &Path,
    ) -> Result<(), IpcError> {
        let vault = Vault::new(root);
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

    /// App reset with "delete keys": delete `PomiTranslate/<provider>` for the providers the vault's
    /// rows say used the keychain (Keychain mode now, or `known_keychain`; a missing entry counts as
    /// deleted; the OS store is never listed), then the vault, the key directory and every set-aside
    /// copy. When the vault is missing or cannot be read it cannot say, so every known provider is
    /// tried and a platform without any credential store counts as nothing to delete. A step that
    /// fails does not stop the others: the answer says what is gone and which entries could not be
    /// deleted. Nothing is remembered about a failed delete; deleting again tries again.
    pub fn purge(&self, root: &Path) -> Result<Purged, IpcError> {
        let mut sessions = lock_wait(&self.sessions)?;
        let vault = Vault::new(root);
        let mut outcome = Purged::default();

        // The connection is dropped before the files go: an open database cannot be removed everywhere.
        let plans: Vec<EntryPlan> = match vault.connection(false) {
            Ok(Some((conn, _held))) => PROVIDERS
                .iter()
                .map(|provider| entry_plan(&conn, provider))
                .collect(),
            _ => vec![EntryPlan::BestEffort; PROVIDERS.len()],
        };
        for (provider, plan) in PROVIDERS.iter().copied().zip(plans) {
            match self.delete_entry(provider, plan) {
                Ok(()) => outcome.keychain_deleted.push(provider),
                Err(_) => outcome.keychain_failed.push(provider),
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
        outcome.files_removed = listed;
        if !listed {
            outcome.errors.push(code::VAULT_IO);
        }
        for target in targets {
            if let Err(error) = remove_path(&target) {
                outcome.files_removed = false;
                outcome.errors.push(error.code);
            }
        }
        remove_legacy_ledger(root);
        sessions.clear();
        if let Ok(mut known) = lock_wait(&self.known_modes) {
            known.clear();
        }
        outcome.errors.dedup();
        Ok(outcome)
    }
}

/// What a purge removed and what it could not delete.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Purged {
    /// Providers whose OS entry is confirmed gone (deleted, not there, or never used: the vault's
    /// rows had no record of the keychain, so the OS store was not asked).
    pub keychain_deleted: Vec<&'static str>,
    /// Providers whose OS entry could not be deleted (`KEYCHAIN_UNCONFIRMED`); deleting again retries.
    pub keychain_failed: Vec<&'static str>,
    /// The vault, the key directory and every set-aside copy are gone.
    pub files_removed: bool,
    /// Codes of failures other than a failed entry deletion.
    pub errors: Vec<&'static str>,
}

impl Purged {
    /// Every store was emptied and confirmed.
    pub fn complete(&self) -> bool {
        self.keychain_failed.is_empty() && self.files_removed && self.errors.is_empty()
    }
}

/// The ownership record of earlier builds, which inferred ownership instead of reading the app's own
/// namespace. Nothing consults it any more; it holds no secret, and leaving it behind would only
/// look like a state that matters. Only the names the retired code produced are deleted:
/// `keychain-ledger.json`, its `.new` side file and its `.broken-<ms>[-<n>]` set-aside copies, and
/// only regular files (a link or folder is left alone). The application data folder is validated first
/// like the vault does (a real folder, not a link, the user's own) and checked again right before each
/// delete; a folder that cannot be trusted is skipped. A failure is logged, not reported: the file has
/// no effect.
pub fn remove_legacy_ledger(root: &Path) {
    match root.try_exists() {
        Ok(false) => return,
        Ok(true) => {}
        Err(_) => {
            crate::diagnostics::global().log_error(
                "credentials",
                &io_error("Cannot list the application data folder"),
            );
            return;
        }
    }
    if private_fs::check_root(root).is_err() {
        crate::diagnostics::global().log_error(
            "credentials",
            &IpcError::new(
                code::VAULT_PERMISSIONS,
                "The application data folder cannot be trusted; the unused ownership record was not cleaned",
            ),
        );
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        crate::diagnostics::global().log_error(
            "credentials",
            &io_error("Cannot list the application data folder"),
        );
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !is_legacy_ledger_name(&name.to_string_lossy()) {
            continue;
        }
        let path = entry.path();
        if !fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
            continue;
        }
        if private_fs::check_root(root).is_err() || fs::remove_file(&path).is_err() {
            crate::diagnostics::global().log_error(
                "credentials",
                &io_error("Cannot remove an unused ownership record"),
            );
        }
    }
}

/// The file names the retired ownership record used: the record, its side file, and its set-aside
/// copies (`.broken-<ms>`, with `-<n>` when the name was taken).
fn is_legacy_ledger_name(name: &str) -> bool {
    const FILE: &str = "keychain-ledger.json";
    let Some(suffix) = name.strip_prefix(FILE) else {
        return false;
    };
    match suffix {
        "" | ".new" => true,
        _ => suffix.strip_prefix(".broken-").is_some_and(|stamp| {
            let digits = |text: &str| !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit());
            match stamp.split_once('-') {
                Some((first, second)) => digits(first) && digits(second),
                None => digits(stamp),
            }
        }),
    }
}

fn already_in_keychain() -> IpcError {
    IpcError::new(
        code::INVALID_REQUEST,
        "This provider already uses the OS credential store; there is nothing to import",
    )
}

fn unconfirmed() -> IpcError {
    IpcError::new(
        code::KEYCHAIN_UNCONFIRMED,
        "The OS credential entry could not be deleted",
    )
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

/// Test-only switch: the replacement vault of `reset_recording_keychain` cannot be made.
#[cfg(test)]
mod tests_hook {
    use std::cell::Cell;
    thread_local! {
        pub static FAIL_NEW_VAULT: Cell<bool> = const { Cell::new(false) };
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod vault_tests;
