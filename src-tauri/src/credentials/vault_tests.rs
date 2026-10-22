//! Recovery, degraded-state, keychain and endpoint-binding behaviour of the vault.
use super::*;

const EP: &str = "https://models.example.test/v1";
const OTHER: &str = "https://attacker.example/v1";
const SECRET: &str = "fixture-secret-never-persist-in-plaintext-1942";

fn key_dir(root: &Path) -> PathBuf {
    root.join("credential-key")
}
fn broken_entries(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with(prefix))
                })
                .collect()
        })
        .unwrap_or_default()
}
/// A `master.new` as an interrupted creation leaves it, with the vault's private permissions.
fn plant_leftover(root: &Path, bytes: &[u8]) {
    private_fs::directory(&key_dir(root)).unwrap();
    let mut file = private_fs::open(&key_dir(root).join("master.new"), true).unwrap();
    file.write_all(bytes).unwrap();
}

// --- CR-1 / CR-2: key creation and interrupted initialization ---------------------------------

#[test]
fn the_first_local_save_commits_the_master_key_and_leaves_no_temporary_file() {
    let dir = tempfile::tempdir().unwrap();
    Credentials::default()
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    assert_eq!(fs::read(key_dir(dir.path()).join("master.key")).unwrap().len(), 48);
    assert!(!key_dir(dir.path()).join("master.new").exists());
}

#[test]
fn a_complete_leftover_key_is_promoted_when_nothing_else_was_encrypted() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault.save(dir.path(), "openai", Mode::Session, SECRET, None).unwrap();
    let planted = [7u8; 48];
    plant_leftover(dir.path(), &planted);
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    assert_eq!(fs::read(key_dir(dir.path()).join("master.key")).unwrap(), planted);
    assert!(!key_dir(dir.path()).join("master.new").exists());
    assert_eq!(
        vault.read(dir.path(), "openrouter", None).unwrap().unwrap().as_str(),
        SECRET
    );
}

#[test]
fn a_truncated_leftover_key_is_set_aside_and_a_new_key_is_made() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault.save(dir.path(), "openai", Mode::Session, SECRET, None).unwrap();
    plant_leftover(dir.path(), &[1u8; 10]);
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    let aside = broken_entries(&key_dir(dir.path()), "master.new.broken-");
    assert_eq!(aside.len(), 1);
    assert_eq!(fs::read(&aside[0]).unwrap(), [1u8; 10], "set aside, never deleted");
    assert_eq!(fs::read(key_dir(dir.path()).join("master.key")).unwrap().len(), 48);
    assert!(!key_dir(dir.path()).join("master.new").exists());
}

#[test]
fn a_leftover_key_is_not_promoted_over_credentials_encrypted_under_another_key() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    fs::remove_file(key_dir(dir.path()).join("master.key")).unwrap();
    plant_leftover(dir.path(), &[9u8; 48]);
    let error = vault.read(dir.path(), "openrouter", None).unwrap_err();
    assert_eq!(error.code, code::VAULT_KEY_MISSING);
    assert!(!key_dir(dir.path()).join("master.key").exists());
    assert_eq!(broken_entries(&key_dir(dir.path()), "master.new.broken-").len(), 1);
}

#[test]
fn a_leftover_key_that_matches_the_stored_rows_is_promoted_after_a_lost_rename() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    let master = key_dir(dir.path()).join("master.key");
    let bytes = fs::read(&master).unwrap();
    fs::remove_file(&master).unwrap();
    plant_leftover(dir.path(), &bytes);
    assert_eq!(
        vault.read(dir.path(), "openrouter", None).unwrap().unwrap().as_str(),
        SECRET
    );
    assert!(master.exists());
}

#[test]
fn a_zero_byte_database_from_an_interrupted_creation_is_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("credentials");
    private_fs::directory(&root).unwrap();
    drop(private_fs::open(&root.join("credentials.sqlite"), true).unwrap());
    let vault = Credentials::default();
    assert!(!vault.status(dir.path(), "openai").unwrap().stored);
    vault.save(dir.path(), "openai", Mode::Local, SECRET, None).unwrap();
    assert_eq!(
        vault.read(dir.path(), "openai", None).unwrap().unwrap().as_str(),
        SECRET
    );
}

#[test]
fn a_stale_side_file_from_an_interrupted_database_creation_does_not_block_a_new_one() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("credentials");
    private_fs::directory(&root).unwrap();
    let mut stale = private_fs::open(&root.join("credentials.sqlite.new"), true).unwrap();
    stale.write_all(b"half written").unwrap();
    drop(stale);
    let vault = Credentials::default();
    vault.save(dir.path(), "openai", Mode::Local, SECRET, None).unwrap();
    assert!(!root.join("credentials.sqlite.new").exists());
    assert!(vault.status(dir.path(), "openai").unwrap().stored);
}

// --- CR-3: an unusable vault is data, never a failed command ----------------------------------

#[test]
fn a_damaged_vault_is_reported_as_state_and_keeps_the_known_mode() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "openrouter", Mode::Session, SECRET, None)
        .unwrap();
    fs::write(dir.path().join("credentials/credentials.sqlite"), b"this is not sqlite").unwrap();
    let state = vault.state(dir.path(), "openrouter");
    assert_eq!(state.error, Some(code::VAULT_CORRUPT));
    assert_eq!(state.stored, None, "unavailable is not empty");
    assert_eq!(state.mode, Some(Mode::Session), "the configured mode is kept");
    assert_eq!(
        vault.read(dir.path(), "openrouter", None).unwrap_err().code,
        code::VAULT_CORRUPT
    );
}

#[test]
fn an_unknown_schema_is_a_schema_error_and_a_missing_key_a_key_error() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    fs::remove_file(key_dir(dir.path()).join("master.key")).unwrap();
    assert_eq!(
        vault.read(dir.path(), "openrouter", None).unwrap_err().code,
        code::VAULT_KEY_MISSING
    );
    Connection::open(dir.path().join("credentials/credentials.sqlite"))
        .unwrap()
        .execute("UPDATE vault_meta SET schema_version=100", [])
        .unwrap();
    assert_eq!(vault.state(dir.path(), "openrouter").error, Some(code::VAULT_SCHEMA));
}

#[test]
fn reset_sets_the_vault_aside_recreates_it_and_does_not_need_it_to_be_readable() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    fs::write(dir.path().join("credentials/credentials.sqlite"), b"garbage").unwrap();
    assert!(vault.state(dir.path(), "openrouter").error.is_some());
    vault.reset_storage(dir.path()).unwrap();
    assert_eq!(broken_entries(dir.path(), "credentials.broken-").len(), 1);
    assert_eq!(broken_entries(dir.path(), "credential-key.broken-").len(), 1);
    assert!(dir.path().join("credentials").is_dir());
    let state = vault.state(dir.path(), "openrouter");
    assert_eq!(
        state,
        State {
            mode: Some(Mode::Local),
            stored: Some(false),
            error: None
        }
    );
    vault
        .save(dir.path(), "openrouter", Mode::Local, "after-reset", None)
        .unwrap();
    assert_eq!(
        vault.read(dir.path(), "openrouter", None).unwrap().unwrap().as_str(),
        "after-reset"
    );
}

#[test]
fn delete_on_a_vault_that_cannot_be_opened_sets_it_aside_instead_of_failing() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    fs::write(dir.path().join("credentials/credentials.sqlite"), b"garbage").unwrap();
    vault.delete(dir.path(), "openrouter").unwrap();
    assert_eq!(vault.state(dir.path(), "openrouter").stored, Some(false));
    assert_eq!(broken_entries(dir.path(), "credentials.broken-").len(), 1);
}

#[cfg(unix)]
#[test]
fn delete_and_reset_work_when_the_permission_check_fails() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    let db = dir.path().join("credentials/credentials.sqlite");
    fs::set_permissions(&db, fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(
        vault.state(dir.path(), "openrouter").error,
        Some(code::VAULT_PERMISSIONS)
    );
    vault.delete(dir.path(), "openrouter").unwrap();
    assert!(vault.state(dir.path(), "openrouter").error.is_none());
}

#[test]
fn purge_removes_the_vault_the_key_and_every_set_aside_copy() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    vault.reset_storage(dir.path()).unwrap();
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    vault.purge(dir.path()).unwrap();
    for name in ["credentials", "credential-key"] {
        assert!(!dir.path().join(name).exists(), "{name} must be gone");
    }
    assert!(broken_entries(dir.path(), "credentials.broken-").is_empty());
    assert!(broken_entries(dir.path(), "credential-key.broken-").is_empty());
}

#[test]
fn a_poisoned_in_process_lock_does_not_wedge_credentials() {
    let vault = std::sync::Arc::new(Credentials::default());
    let held = vault.clone();
    let _ = std::thread::spawn(move || {
        let _guard = held.sessions.lock().unwrap();
        panic!("fixture panic while holding the session lock");
    })
    .join();
    let dir = tempfile::tempdir().unwrap();
    assert!(vault.status(dir.path(), "openai").is_ok());
}

// --- CR-4 / CR-5: the opt-in OS store ---------------------------------------------------------

type Fake = std::sync::Arc<keychain::fake::FakeKeychain>;

fn with_fake() -> (Credentials, Fake) {
    struct Shared(Fake);
    impl KeychainStore for Shared {
        fn get(&self, p: &str) -> Result<Option<Zeroizing<String>>, IpcError> {
            self.0.get(p)
        }
        fn set(&self, p: &str, s: &str) -> Result<(), IpcError> {
            self.0.set(p, s)
        }
        fn delete(&self, p: &str) -> Result<(), IpcError> {
            self.0.delete(p)
        }
    }
    let fake = Fake::default();
    (Credentials::with_keychain(Box::new(Shared(fake.clone()))), fake)
}

#[test]
fn keychain_mode_reaches_the_store_and_only_then() {
    use std::sync::atomic::Ordering;
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault.save(dir.path(), "openai", Mode::Local, SECRET, None).unwrap();
    assert_eq!(fake.calls.load(Ordering::SeqCst), 0, "Local never touches the keychain");
    vault
        .save(dir.path(), "openrouter", Mode::Keychain, SECRET, None)
        .unwrap();
    assert_eq!(fake.entries.lock().unwrap().get("openrouter").unwrap(), SECRET);
    assert_eq!(
        vault.read(dir.path(), "openrouter", None).unwrap().unwrap().as_str(),
        SECRET
    );
    assert!(vault.status(dir.path(), "openrouter").unwrap().stored);
}

#[test]
fn leaving_keychain_mode_deletes_the_apps_own_entry() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openrouter", Mode::Keychain, SECRET, None)
        .unwrap();
    vault.save(dir.path(), "openrouter", Mode::Local, "", None).unwrap();
    assert!(fake.entries.lock().unwrap().is_empty(), "the keychain copy is gone");
    assert_eq!(
        vault.read(dir.path(), "openrouter", None).unwrap().unwrap().as_str(),
        SECRET,
        "the key moved to the local vault"
    );
}

#[test]
fn delete_and_purge_remove_the_apps_keychain_entry() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openrouter", Mode::Keychain, SECRET, None)
        .unwrap();
    vault.delete(dir.path(), "openrouter").unwrap();
    assert!(fake.entries.lock().unwrap().is_empty());
    vault.save(dir.path(), "openai", Mode::Keychain, SECRET, None).unwrap();
    vault.purge(dir.path()).unwrap();
    assert!(fake.entries.lock().unwrap().is_empty());
}

#[test]
fn a_failed_keychain_delete_keeps_the_vault_files_so_a_retry_sees_the_same_state() {
    use std::sync::atomic::Ordering;
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault.save(dir.path(), "openai", Mode::Keychain, SECRET, None).unwrap();
    fake.fail_delete.store(true, Ordering::SeqCst);
    assert!(vault.purge(dir.path()).is_err());
    assert!(dir.path().join("credentials").is_dir());
    assert!(vault.status(dir.path(), "openai").unwrap().stored);
}

#[test]
fn a_keychain_import_copies_into_local_and_leaves_the_original() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    fake.entries.lock().unwrap().insert("openai".into(), SECRET.into());
    let status = vault.import_keychain(dir.path(), "openai", None).unwrap();
    assert_eq!(status.mode, Mode::Local);
    assert!(fake.entries.lock().unwrap().contains_key("openai"));
    let empty = vault.import_keychain(dir.path(), "gemini", None).unwrap_err();
    assert_eq!(empty.code, code::KEYCHAIN_EMPTY);
}

/// keyring 4.2.0 installs the platform store on the first `Entry::new`; making an entry does not
/// read or write any secret. Linux needs a running Secret Service, so only Windows and macOS assert it.
#[cfg(any(windows, target_os = "macos"))]
#[test]
fn the_platform_store_is_installed_by_the_first_entry() {
    assert!(keyring::Entry::new("PomiTranslate-unit-test", "probe").is_ok());
    assert!(keyring::Entry::store_status().is_ok());
}

// --- CR-7: the Custom key belongs to one endpoint ---------------------------------------------

#[test]
fn the_custom_key_is_only_returned_for_the_endpoint_it_was_saved_for() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault.save(dir.path(), "custom", Mode::Local, SECRET, Some(EP)).unwrap();
    assert!(vault.read(dir.path(), "custom", Some(EP)).unwrap().is_some());
    for other in [Some(OTHER), None] {
        assert_eq!(
            vault.read(dir.path(), "custom", other).unwrap_err().code,
            code::CREDENTIAL_ENDPOINT_MISMATCH
        );
    }
    // Saving again without a key (a settings change) keeps the old binding.
    vault.save(dir.path(), "custom", Mode::Local, "", Some(OTHER)).unwrap();
    assert_eq!(
        vault.read(dir.path(), "custom", Some(OTHER)).unwrap_err().code,
        code::CREDENTIAL_ENDPOINT_MISMATCH
    );
    // A re-entered key binds to the new endpoint.
    vault.save(dir.path(), "custom", Mode::Local, SECRET, Some(OTHER)).unwrap();
    assert!(vault.read(dir.path(), "custom", Some(OTHER)).unwrap().is_some());
}

#[test]
fn a_custom_key_saved_before_the_binding_existed_is_bound_on_first_use() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault.save(dir.path(), "custom", Mode::Local, SECRET, None).unwrap();
    assert!(vault.read(dir.path(), "custom", Some(EP)).unwrap().is_some());
    assert_eq!(
        vault.read(dir.path(), "custom", Some(OTHER)).unwrap_err().code,
        code::CREDENTIAL_ENDPOINT_MISMATCH
    );
}

#[test]
fn an_old_database_without_the_endpoint_column_is_upgraded_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault.save(dir.path(), "custom", Mode::Local, SECRET, Some(EP)).unwrap();
    let conn = Connection::open(dir.path().join("credentials/credentials.sqlite")).unwrap();
    conn.execute("ALTER TABLE accounts DROP COLUMN endpoint_hash", []).unwrap();
    drop(conn);
    assert!(vault.read(dir.path(), "custom", Some(EP)).unwrap().is_some());
}

#[test]
fn only_custom_keys_are_bound_to_an_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault.save(dir.path(), "openai", Mode::Local, SECRET, Some(EP)).unwrap();
    assert!(vault.read(dir.path(), "openai", None).unwrap().is_some());
}

#[test]
fn endpoint_hashes_are_sha256_hex() {
    assert_eq!(
        endpoint_hash("a"),
        "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"
    );
}
