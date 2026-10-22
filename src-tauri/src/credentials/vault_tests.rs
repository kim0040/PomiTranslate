//! Recovery, degraded-state, keychain and endpoint-binding behaviour of the vault.
use super::*;

const EP: &str = "https://models.example.test/v1";
const OTHER: &str = "https://attacker.example/v1";
const SECRET: &str = "fixture-secret-never-persist-in-plaintext-1942";

/// The providers the ownership record says the app may delete.
fn owned_in_record(root: &Path) -> Vec<&'static str> {
    match Ledger::new(root).read().unwrap() {
        ledger::Read::Present(record) => record.owned(),
        ledger::Read::Missing => Vec::new(),
        ledger::Read::Damaged { .. } => panic!("the record is damaged"),
    }
}

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
    assert_eq!(
        fs::read(key_dir(dir.path()).join("master.key"))
            .unwrap()
            .len(),
        48
    );
    assert!(!key_dir(dir.path()).join("master.new").exists());
}

#[test]
fn a_complete_leftover_key_is_promoted_when_nothing_else_was_encrypted() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "openai", Mode::Session, SECRET, None)
        .unwrap();
    let planted = [7u8; 48];
    plant_leftover(dir.path(), &planted);
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    assert_eq!(
        fs::read(key_dir(dir.path()).join("master.key")).unwrap(),
        planted
    );
    assert!(!key_dir(dir.path()).join("master.new").exists());
    assert_eq!(
        vault
            .read(dir.path(), "openrouter", None)
            .unwrap()
            .unwrap()
            .as_str(),
        SECRET
    );
}

#[test]
fn a_truncated_leftover_key_is_set_aside_and_a_new_key_is_made() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "openai", Mode::Session, SECRET, None)
        .unwrap();
    plant_leftover(dir.path(), &[1u8; 10]);
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    let aside = broken_entries(&key_dir(dir.path()), "master.new.broken-");
    assert_eq!(aside.len(), 1);
    assert_eq!(
        fs::read(&aside[0]).unwrap(),
        [1u8; 10],
        "set aside, never deleted"
    );
    assert_eq!(
        fs::read(key_dir(dir.path()).join("master.key"))
            .unwrap()
            .len(),
        48
    );
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
    assert_eq!(
        broken_entries(&key_dir(dir.path()), "master.new.broken-").len(),
        1
    );
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
        vault
            .read(dir.path(), "openrouter", None)
            .unwrap()
            .unwrap()
            .as_str(),
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
    vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    assert_eq!(
        vault
            .read(dir.path(), "openai", None)
            .unwrap()
            .unwrap()
            .as_str(),
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
    vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
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
    fs::write(
        dir.path().join("credentials/credentials.sqlite"),
        b"this is not sqlite",
    )
    .unwrap();
    let state = vault.state(dir.path(), "openrouter");
    assert_eq!(state.error, Some(code::VAULT_CORRUPT));
    assert_eq!(state.stored, None, "unavailable is not empty");
    assert_eq!(
        state.mode,
        Some(Mode::Session),
        "the configured mode is kept"
    );
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
    assert_eq!(
        vault.state(dir.path(), "openrouter").error,
        Some(code::VAULT_SCHEMA)
    );
}

#[test]
fn reset_sets_the_vault_aside_recreates_it_and_does_not_need_it_to_be_readable() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    fs::write(
        dir.path().join("credentials/credentials.sqlite"),
        b"garbage",
    )
    .unwrap();
    assert!(vault.state(dir.path(), "openrouter").error.is_some());
    vault.reset_storage(dir.path()).unwrap();
    assert_eq!(broken_entries(dir.path(), "credentials.broken-").len(), 1);
    assert_eq!(
        broken_entries(dir.path(), "credential-key.broken-").len(),
        1
    );
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
        vault
            .read(dir.path(), "openrouter", None)
            .unwrap()
            .unwrap()
            .as_str(),
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
    fs::write(
        dir.path().join("credentials/credentials.sqlite"),
        b"garbage",
    )
    .unwrap();
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
    (
        Credentials::with_keychain(Box::new(Shared(fake.clone()))),
        fake,
    )
}

#[test]
fn keychain_mode_reaches_the_store_and_only_then() {
    use std::sync::atomic::Ordering;
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    assert_eq!(
        fake.calls.load(Ordering::SeqCst),
        0,
        "Local never touches the keychain"
    );
    vault
        .save(dir.path(), "openrouter", Mode::Keychain, SECRET, None)
        .unwrap();
    assert_eq!(
        fake.entries.lock().unwrap().get("openrouter").unwrap(),
        SECRET
    );
    assert_eq!(
        vault
            .read(dir.path(), "openrouter", None)
            .unwrap()
            .unwrap()
            .as_str(),
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
    vault
        .save(dir.path(), "openrouter", Mode::Local, "", None)
        .unwrap();
    assert!(
        fake.entries.lock().unwrap().is_empty(),
        "the keychain copy is gone"
    );
    assert_eq!(
        vault
            .read(dir.path(), "openrouter", None)
            .unwrap()
            .unwrap()
            .as_str(),
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
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    vault.purge(dir.path()).unwrap();
    assert!(fake.entries.lock().unwrap().is_empty());
}

#[test]
fn a_failed_keychain_delete_is_a_partial_outcome_and_the_retry_finishes_the_job() {
    use std::sync::atomic::Ordering;
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    fake.fail_delete.store(true, Ordering::SeqCst);
    let first = vault.purge(dir.path()).unwrap();
    assert!(!first.complete());
    assert_eq!(first.keychain_failed, [("openai", code::KEYCHAIN_FAILED)]);
    assert!(first.keychain_deleted.is_empty());
    // The files are gone anyway; what is left is the entry and the record that names it.
    assert!(first.files_removed);
    assert!(!dir.path().join("credentials").exists());
    assert!(fake.entries.lock().unwrap().contains_key("openai"));
    assert_eq!(
        owned_in_record(dir.path()),
        ["openai"],
        "the record survives so a retry finds the entry"
    );
    fake.fail_delete.store(false, Ordering::SeqCst);
    let retry = vault.purge(dir.path()).unwrap();
    assert!(retry.complete(), "{retry:?}");
    assert_eq!(retry.keychain_deleted, ["openai"]);
    assert!(fake.entries.lock().unwrap().is_empty());
    assert!(
        !Ledger::new(dir.path()).exists(),
        "the record goes with the last entry"
    );
}

#[test]
fn a_keychain_import_copies_into_local_and_leaves_the_original() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    fake.entries
        .lock()
        .unwrap()
        .insert("openai".into(), SECRET.into());
    let status = vault.import_keychain(dir.path(), "openai", None).unwrap();
    assert_eq!(status.mode, Mode::Local);
    assert!(fake.entries.lock().unwrap().contains_key("openai"));
    let empty = vault
        .import_keychain(dir.path(), "gemini", None)
        .unwrap_err();
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
    vault
        .save(dir.path(), "custom", Mode::Local, SECRET, Some(EP))
        .unwrap();
    assert!(vault
        .read(dir.path(), "custom", Some(EP))
        .unwrap()
        .is_some());
    for other in [Some(OTHER), None] {
        assert_eq!(
            vault.read(dir.path(), "custom", other).unwrap_err().code,
            code::CREDENTIAL_ENDPOINT_MISMATCH
        );
    }
    // Saving again without a key (a settings change) keeps the old binding.
    vault
        .save(dir.path(), "custom", Mode::Local, "", Some(OTHER))
        .unwrap();
    assert_eq!(
        vault
            .read(dir.path(), "custom", Some(OTHER))
            .unwrap_err()
            .code,
        code::CREDENTIAL_ENDPOINT_MISMATCH
    );
    // A re-entered key binds to the new endpoint.
    vault
        .save(dir.path(), "custom", Mode::Local, SECRET, Some(OTHER))
        .unwrap();
    assert!(vault
        .read(dir.path(), "custom", Some(OTHER))
        .unwrap()
        .is_some());
}

#[test]
fn a_custom_key_saved_before_the_binding_existed_is_never_released_and_only_re_entering_binds_it() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "custom", Mode::Local, SECRET, None)
        .unwrap();
    // No endpoint, whichever one asks: not the configured one, not an attacker's, and repeatedly.
    for _ in 0..2 {
        for endpoint in [EP, OTHER] {
            assert_eq!(
                vault
                    .read(dir.path(), "custom", Some(endpoint))
                    .unwrap_err()
                    .code,
                code::CREDENTIAL_ENDPOINT_UNBOUND,
                "{endpoint}"
            );
        }
    }
    // A settings save that supplies no key does not bind it either (R2: nothing but the key the
    // person types again can say where the key belongs).
    vault
        .save(dir.path(), "custom", Mode::Local, "", Some(OTHER))
        .unwrap();
    assert_eq!(
        vault
            .read(dir.path(), "custom", Some(OTHER))
            .unwrap_err()
            .code,
        code::CREDENTIAL_ENDPOINT_UNBOUND
    );
    // Typing the key again binds it, to that endpoint alone.
    vault
        .save(dir.path(), "custom", Mode::Local, SECRET, Some(EP))
        .unwrap();
    assert_eq!(
        vault
            .read(dir.path(), "custom", Some(EP))
            .unwrap()
            .unwrap()
            .as_str(),
        SECRET
    );
    assert_eq!(
        vault
            .read(dir.path(), "custom", Some(OTHER))
            .unwrap_err()
            .code,
        code::CREDENTIAL_ENDPOINT_MISMATCH
    );
}

#[test]
fn an_old_database_without_the_endpoint_column_is_upgraded_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "custom", Mode::Local, SECRET, Some(EP))
        .unwrap();
    let conn = Connection::open(dir.path().join("credentials/credentials.sqlite")).unwrap();
    conn.execute("ALTER TABLE accounts DROP COLUMN endpoint_hash", [])
        .unwrap();
    drop(conn);
    // The upgrade adds the column empty: the key it describes is unbound, not silently trusted.
    assert_eq!(
        vault.read(dir.path(), "custom", Some(EP)).unwrap_err().code,
        code::CREDENTIAL_ENDPOINT_UNBOUND
    );
    vault
        .save(dir.path(), "custom", Mode::Local, SECRET, Some(EP))
        .unwrap();
    assert!(vault
        .read(dir.path(), "custom", Some(EP))
        .unwrap()
        .is_some());
}

#[test]
fn only_custom_keys_are_bound_to_an_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "openai", Mode::Local, SECRET, Some(EP))
        .unwrap();
    assert!(vault.read(dir.path(), "openai", None).unwrap().is_some());
}

#[test]
fn endpoint_hashes_are_sha256_hex() {
    assert_eq!(
        endpoint_hash("a"),
        "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb"
    );
}

// --- M1: the ownership record of the OS entries -----------------------------------------------

#[test]
fn the_ownership_record_survives_a_storage_reset_and_a_purge_then_deletes_the_entries() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    assert_eq!(owned_in_record(dir.path()), ["openai"]);
    // "Reset credential storage" sets the vault aside; the OS entry is still the app's.
    vault.reset_storage(dir.path()).unwrap();
    assert!(fake.entries.lock().unwrap().contains_key("openai"));
    assert_eq!(owned_in_record(dir.path()), ["openai"]);
    let purged = vault.purge(dir.path()).unwrap();
    assert!(purged.complete(), "{purged:?}");
    assert_eq!(purged.keychain_deleted, ["openai"]);
    assert!(fake.entries.lock().unwrap().is_empty());
    assert!(!Ledger::new(dir.path()).exists());
}

#[test]
fn purge_never_touches_a_keychain_entry_the_app_did_not_write() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    fake.entries
        .lock()
        .unwrap()
        .insert("gemini".into(), "someone-elses-secret".into());
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    vault.reset_storage(dir.path()).unwrap();
    let before = fake.calls.load(std::sync::atomic::Ordering::SeqCst);
    vault.purge(dir.path()).unwrap();
    let entries = fake.entries.lock().unwrap();
    assert!(!entries.contains_key("openai"));
    assert_eq!(entries.get("gemini").unwrap(), "someone-elses-secret");
    // One delete for the one entry the record names; nothing was listed or read.
    assert_eq!(
        fake.calls.load(std::sync::atomic::Ordering::SeqCst) - before,
        1
    );
}

#[test]
fn a_purge_without_a_record_still_finds_what_a_readable_vault_says_it_wrote() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    // An install from before the record existed.
    Ledger::new(dir.path()).remove_files().unwrap();
    assert!(!Ledger::new(dir.path()).exists());
    let purged = vault.purge(dir.path()).unwrap();
    assert!(purged.complete(), "{purged:?}");
    assert!(fake.entries.lock().unwrap().is_empty());
}

#[test]
fn a_purge_that_can_learn_nothing_about_the_keychain_says_so_instead_of_claiming_success() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, _fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    // An install from before the record existed, and a vault that cannot be read.
    Ledger::new(dir.path()).remove_files().unwrap();
    fs::write(
        dir.path().join("credentials/credentials.sqlite"),
        b"this is not a database at all, just bytes that are long enough to be rejected",
    )
    .unwrap();
    let purged = vault.purge(dir.path()).unwrap();
    assert!(purged.keychain_unverified, "{purged:?}");
    assert!(!purged.complete());
    assert!(purged.files_removed, "the files are removed regardless");
}

#[test]
fn deleting_one_key_after_a_storage_reset_still_removes_its_keychain_entry() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    vault.reset_storage(dir.path()).unwrap();
    // The fresh vault knows nothing, the record does.
    vault.delete(dir.path(), "openai").unwrap();
    assert!(fake.entries.lock().unwrap().is_empty());
    assert!(owned_in_record(dir.path()).is_empty());
}

// --- R3 / R5: ownership is pending, then owned; a lost record is unknown, not empty ------------

fn corrupt_record(root: &Path, bytes: &[u8]) {
    fs::write(root.join(ledger::FILE_NAME), bytes).unwrap();
}

fn break_the_database(root: &Path) {
    fs::write(
        root.join("credentials/credentials.sqlite"),
        b"this is not a database at all, just bytes that are long enough to be rejected",
    )
    .unwrap();
}

#[test]
fn a_failed_write_over_an_entry_the_app_never_made_leaves_it_alone_and_unowned() {
    use std::sync::atomic::Ordering;
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    fake.entries
        .lock()
        .unwrap()
        .insert("openai".into(), "someone-elses-secret".into());
    fake.fail_next_sets.store(1, Ordering::SeqCst);
    let error = vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap_err();
    assert!(!error.uncertain, "the compensation put the old value back");
    assert_eq!(
        fake.entries.lock().unwrap().get("openai").unwrap(),
        "someone-elses-secret"
    );
    // The entry was never the app's, and a failed attempt does not make it so.
    assert!(owned_in_record(dir.path()).is_empty());
    let purged = vault.purge(dir.path()).unwrap();
    assert!(purged.keychain_deleted.is_empty(), "{purged:?}");
    assert!(purged.keychain_uncertain.is_empty(), "{purged:?}");
    assert_eq!(
        fake.entries.lock().unwrap().get("openai").unwrap(),
        "someone-elses-secret",
        "a purge never deletes what the app did not write"
    );
}

#[test]
fn a_failed_write_whose_undo_worked_restores_the_ownership_the_entry_had() {
    use std::sync::atomic::Ordering;
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    assert_eq!(owned_in_record(dir.path()), ["openai"]);
    fake.fail_next_sets.store(1, Ordering::SeqCst);
    let error = vault
        .save(
            dir.path(),
            "openai",
            Mode::Keychain,
            "second-fixture-secret",
            None,
        )
        .unwrap_err();
    assert!(!error.uncertain);
    assert_eq!(
        owned_in_record(dir.path()),
        ["openai"],
        "still the app's: the old value is back"
    );
    assert_eq!(fake.entries.lock().unwrap().get("openai").unwrap(), SECRET);
}

#[test]
fn a_write_that_cannot_be_undone_is_uncertain_and_a_purge_reports_it_without_deleting() {
    use std::sync::atomic::Ordering;
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    // An entry that is there already: the undo has to write it back, and that fails too.
    fake.entries
        .lock()
        .unwrap()
        .insert("openai".into(), "someone-elses-secret".into());
    fake.fail_next_sets.store(2, Ordering::SeqCst);
    let error = vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap_err();
    assert!(error.uncertain);
    assert!(owned_in_record(dir.path()).is_empty());
    let purged = vault.purge(dir.path()).unwrap();
    assert_eq!(purged.keychain_uncertain, ["openai"]);
    assert!(!purged.complete());
    assert!(
        fake.entries.lock().unwrap().contains_key("openai"),
        "an entry the app cannot vouch for is never deleted"
    );
    // It stays recorded, so the next purge still reports it.
    let again = vault.purge(dir.path()).unwrap();
    assert_eq!(again.keychain_uncertain, ["openai"]);
}

#[test]
fn a_write_that_was_under_way_when_the_app_died_is_pending_and_never_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "gemini", Mode::Local, SECRET, None)
        .unwrap();
    // What a crash between "recorded as pending" and "confirmed" leaves behind.
    let mut record = Record::default();
    record.set("openai", Ownership::Pending(Previous::Absent));
    Ledger::new(dir.path()).save(&record).unwrap();
    fake.entries
        .lock()
        .unwrap()
        .insert("openai".into(), "half-written".into());
    let purged = vault.purge(dir.path()).unwrap();
    assert_eq!(purged.keychain_uncertain, ["openai"]);
    assert!(!purged.complete());
    assert!(fake.entries.lock().unwrap().contains_key("openai"));
}

#[test]
fn a_missing_record_and_a_failed_keychain_delete_do_not_lose_the_obligation_over_two_purges() {
    use std::sync::atomic::Ordering;
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    // The record is lost (or the install is from before it existed); the vault still knows.
    Ledger::new(dir.path()).remove_files().unwrap();
    fake.fail_delete.store(true, Ordering::SeqCst);
    let first = vault.purge(dir.path()).unwrap();
    assert!(!first.complete());
    assert_eq!(first.keychain_failed.len(), 1);
    assert!(
        !dir.path().join("credentials").exists(),
        "vault metadata is gone"
    );
    assert_eq!(
        owned_in_record(dir.path()),
        ["openai"],
        "the obligation was written down before the vault went"
    );
    fake.fail_delete.store(false, Ordering::SeqCst);
    let second = vault.purge(dir.path()).unwrap();
    assert!(second.complete(), "{second:?}");
    assert!(fake.entries.lock().unwrap().is_empty());
}

#[test]
fn a_damaged_record_is_kept_merged_and_never_turned_into_an_empty_one() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    // The record is truncated mid-entry; a new key is saved before anything else happens.
    corrupt_record(dir.path(), br#"{"v":2,"entries":{"openai":{"state":"ow"#);
    vault
        .save(dir.path(), "gemini", Mode::Keychain, SECRET, None)
        .unwrap();
    assert_eq!(
        broken_entries(dir.path(), "keychain-ledger.json.broken-").len(),
        1,
        "the damaged copy is kept"
    );
    let mut owned = owned_in_record(dir.path());
    owned.sort_unstable();
    assert_eq!(
        owned,
        ["gemini", "openai"],
        "nothing the damaged copy named is lost"
    );
    let purged = vault.purge(dir.path()).unwrap();
    assert!(purged.complete(), "{purged:?}");
    assert!(fake.entries.lock().unwrap().is_empty());
}

#[test]
fn a_damaged_record_survives_a_storage_reset_with_what_can_still_be_read() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    corrupt_record(dir.path(), br#"{"v":2,"entries":{"openai":{"sta"#);
    vault.reset_storage(dir.path()).unwrap();
    assert_eq!(owned_in_record(dir.path()), ["openai"]);
    assert!(fake.entries.lock().unwrap().contains_key("openai"));
    let purged = vault.purge(dir.path()).unwrap();
    assert!(purged.complete(), "{purged:?}");
    assert!(fake.entries.lock().unwrap().is_empty());
}

#[test]
fn a_damaged_record_and_an_unreadable_vault_is_unknown_and_never_reported_as_complete() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    // Nothing left in the record can be read, and the vault cannot say either.
    corrupt_record(dir.path(), b"\0\0 not a record at all");
    break_the_database(dir.path());
    for _ in 0..2 {
        let purged = vault.purge(dir.path()).unwrap();
        assert!(purged.keychain_unverified, "{purged:?}");
        assert!(!purged.complete());
    }
    assert!(
        fake.entries.lock().unwrap().contains_key("openai"),
        "nothing was deleted on a guess"
    );
    assert!(
        dir.path().join(ledger::FILE_NAME).exists(),
        "the uncertainty marker stays"
    );
    assert!(!broken_entries(dir.path(), "keychain-ledger.json.broken-").is_empty());
}

#[test]
fn a_reset_that_cannot_write_the_record_stops_before_the_vault_is_moved() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, _fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    // A directory where the record belongs: it can neither be read nor replaced.
    fs::remove_file(dir.path().join(ledger::FILE_NAME)).unwrap();
    fs::create_dir(dir.path().join(ledger::FILE_NAME)).unwrap();
    assert!(vault.reset_storage(dir.path()).is_err());
    assert!(
        dir.path().join("credentials/credentials.sqlite").exists(),
        "the vault, the only other witness, was not set aside"
    );
}

#[test]
fn deleting_one_key_never_deletes_an_entry_the_record_cannot_vouch_for() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "gemini", Mode::Local, SECRET, None)
        .unwrap();
    let mut record = Record::default();
    record.set("openai", Ownership::Uncertain);
    Ledger::new(dir.path()).save(&record).unwrap();
    fake.entries
        .lock()
        .unwrap()
        .insert("openai".into(), "not-known-to-be-ours".into());
    vault.delete(dir.path(), "openai").unwrap();
    assert!(fake.entries.lock().unwrap().contains_key("openai"));
}

// --- R4: the folder above the vault directories ------------------------------------------------

#[test]
fn an_application_folder_that_is_a_link_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    fs::create_dir(&real).unwrap();
    let link = dir.path().join("app-data");
    link_directory(&link, &real);
    let error = Credentials::default()
        .save(&link, "openai", Mode::Local, SECRET, None)
        .unwrap_err();
    assert_eq!(error.error.code, code::VAULT_PERMISSIONS);
    assert!(
        !real.join("credentials").exists(),
        "nothing was created through the link"
    );
}

#[cfg(unix)]
#[test]
fn an_application_folder_others_can_write_to_is_made_safe_before_it_is_used() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o777)).unwrap();
    Credentials::default()
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    let mode = fs::metadata(dir.path()).unwrap().permissions().mode();
    assert_eq!(
        mode & 0o022,
        0,
        "group and others can no longer write: {mode:o}"
    );
}

// --- H1: links in place of the vault directories ----------------------------------------------

/// A directory link: a real junction on Windows (no privilege needed), a symlink elsewhere.
fn link_directory(link: &Path, target: &Path) {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("cmd")
            .arg("/C")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "mklink /J failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
}

/// Names and bytes of everything below `dir`.
fn tree(dir: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, dir: &Path, out: &mut std::collections::BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            let name = path
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            if path.is_dir() {
                out.insert(format!("{name}/"), Vec::new());
                walk(base, &path, out);
            } else {
                out.insert(name, fs::read(&path).unwrap());
            }
        }
    }
    let mut out = std::collections::BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

/// A vault that has a database but no key (a Session save creates the one without the other),
/// then its key directory replaced by a link to `outside`.
fn vault_with_linked_key_dir(root: &Path, outside: &Path) -> Credentials {
    let vault = Credentials::default();
    vault
        .save(root, "openai", Mode::Session, SECRET, None)
        .unwrap();
    let key_dir = key_dir(root);
    if key_dir.exists() {
        fs::remove_dir_all(&key_dir).unwrap();
    }
    link_directory(&key_dir, outside);
    vault
}

fn assert_vault_refused(error: IpcError) {
    assert!(
        matches!(error.code, code::VAULT_PERMISSIONS | code::VAULT_IO),
        "{error:?}"
    );
}

#[test]
fn a_linked_key_directory_is_refused_and_nothing_outside_it_is_promoted_or_quarantined() {
    // A complete leftover (would be promoted) and a truncated one (would be set aside).
    for leftover in [&[7u8; 48][..], &[1u8; 10][..]] {
        let (root, outside) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        fs::write(outside.path().join("master.new"), leftover).unwrap();
        fs::write(outside.path().join("unrelated.txt"), b"keep me").unwrap();
        let before = tree(outside.path());
        let vault = vault_with_linked_key_dir(root.path(), outside.path());

        assert_vault_refused(
            vault
                .save(root.path(), "openrouter", Mode::Local, SECRET, None)
                .unwrap_err()
                .error,
        );
        assert_eq!(
            tree(outside.path()),
            before,
            "nothing outside the vault changed (leftover of {} bytes)",
            leftover.len()
        );
        assert!(!outside.path().join("master.key").exists());
    }
}

#[test]
fn a_key_read_through_a_linked_key_directory_is_refused_even_when_the_key_there_is_valid() {
    let (root, outside) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let vault = Credentials::default();
    vault
        .save(root.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    // The genuine key directory, moved out of the vault and linked back in its place.
    let moved = outside.path().join("credential-key");
    fs::rename(key_dir(root.path()), &moved).unwrap();
    link_directory(&key_dir(root.path()), &moved);
    fs::write(moved.join("unrelated.txt"), b"keep me").unwrap();
    let before = tree(outside.path());
    // A fresh process: nothing cached.
    let vault = Credentials::default();
    assert_vault_refused(vault.read(root.path(), "openai", None).unwrap_err());
    assert_vault_refused(
        vault
            .save(root.path(), "openai", Mode::Local, "other", None)
            .unwrap_err()
            .error,
    );
    assert_eq!(tree(outside.path()), before);
}

#[test]
fn a_linked_vault_directory_is_refused_and_a_purge_removes_only_the_link() {
    let (root, outside) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    // A vault that really exists, then moved out and linked back.
    let vault = Credentials::default();
    vault
        .save(root.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    let real = outside.path().join("credentials");
    fs::rename(root.path().join("credentials"), &real).unwrap();
    fs::write(real.join("unrelated.txt"), b"keep me").unwrap();
    link_directory(&root.path().join("credentials"), &real);
    let before = tree(outside.path());

    assert_vault_refused(vault.read(root.path(), "openai", None).unwrap_err());
    assert_vault_refused(vault.status(root.path(), "openai").unwrap_err());
    assert_vault_refused(
        vault
            .save(root.path(), "openrouter", Mode::Local, SECRET, None)
            .unwrap_err()
            .error,
    );
    assert_eq!(tree(outside.path()), before);

    // Purge and reset act on the link itself, never on what it points to.
    let purged = vault.purge(root.path()).unwrap();
    assert!(purged.files_removed, "{purged:?}");
    assert!(!root.path().join("credentials").exists());
    assert_eq!(tree(outside.path()), before, "the target kept every file");
}

#[test]
fn a_directory_swapped_for_a_link_after_the_check_cannot_be_renamed_from_under_the_pin() {
    // The pin holds the directory without letting it be renamed or replaced, so the sequence
    // validate -> pin -> rename acts on the directory that was validated (H1).
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().join("pinned");
    private_fs::directory(&dir).unwrap();
    let pin = private_fs::pin_directory(&dir).unwrap();
    pin.confirm(&dir).unwrap();
    let outside = tempfile::tempdir().unwrap();
    let swapped = fs::rename(&dir, root.path().join("moved"));
    if swapped.is_ok() {
        // Platforms without a deny-rename pin (Unix) must notice the swap instead.
        link_directory(&dir, outside.path());
        assert!(pin.confirm(&dir).is_err(), "the swap was not detected");
    } else {
        assert!(dir.is_dir(), "the pinned directory stayed where it was");
        pin.confirm(&dir).unwrap();
    }
}
