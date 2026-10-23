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
    let (vault, _fake) = with_fake();
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    fs::write(
        dir.path().join("credentials/credentials.sqlite"),
        b"garbage",
    )
    .unwrap();
    // The vault is set aside; the OS entry is deleted by name and there is none, which is a success.
    vault.delete(dir.path(), "openrouter").unwrap();
    assert_eq!(vault.state(dir.path(), "openrouter").stored, Some(false));
    assert_eq!(broken_entries(dir.path(), "credentials.broken-").len(), 1);
}

#[cfg(unix)]
#[test]
fn delete_and_reset_work_when_the_permission_check_fails() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let (vault, _fake) = with_fake();
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
    let (vault, _fake) = with_fake();
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

/// A `Credentials` on `fake`; several of them stand for the app being started again.
fn credentials_on(fake: &Fake) -> Credentials {
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
    Credentials::with_keychain(Box::new(Shared(fake.clone())))
}

fn with_fake() -> (Credentials, Fake) {
    let fake = Fake::default();
    (credentials_on(&fake), fake)
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
    // The import recorded that the keychain holds a key, so deleting it still removes the original.
    assert!(!calls(&fake).iter().any(|call| call.starts_with("delete:")));
    fake.log.lock().unwrap().clear();
    vault.delete(dir.path(), "openai").unwrap();
    assert_eq!(calls(&fake), ["delete:openai"]);
    assert!(!has_entry(&fake, "openai"));
}

#[test]
fn importing_from_the_keychain_is_refused_in_keychain_mode_and_keeps_the_original() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    fake.log.lock().unwrap().clear();
    let error = vault
        .import_keychain(dir.path(), "openai", None)
        .unwrap_err();
    assert_eq!(error.code, code::INVALID_REQUEST);
    assert!(calls(&fake).is_empty(), "nothing was read or deleted");
    assert!(has_entry(&fake, "openai"));
    assert_eq!(
        vault.status(dir.path(), "openai").unwrap().mode,
        Mode::Keychain
    );
}

#[test]
fn importing_over_a_local_row_that_records_the_keychain_copies_and_keeps_the_original() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(
            dir.path(),
            "openai",
            Mode::Local,
            "older-local-fixture",
            None,
        )
        .unwrap();
    mark_known_keychain(dir.path(), "openai");
    put_entry(&fake, "openai", "keychain-fixture");
    fake.log.lock().unwrap().clear();
    let status = vault.import_keychain(dir.path(), "openai", None).unwrap();
    assert_eq!(status.mode, Mode::Local);
    assert!(status.stored);
    assert!(has_entry(&fake, "openai"), "the original is still there");
    assert!(!calls(&fake).iter().any(|call| call.starts_with("delete:")));
    assert_eq!(
        vault
            .read(dir.path(), "openai", None)
            .unwrap()
            .as_deref()
            .map(|s| s.as_str()),
        Some("keychain-fixture")
    );
    // The note is kept: a later delete removes the original as well.
    fake.log.lock().unwrap().clear();
    vault.delete(dir.path(), "openai").unwrap();
    assert_eq!(calls(&fake), ["delete:openai"]);
    assert!(!has_entry(&fake, "openai"));
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

// --- The app's own keychain namespace: PomiTranslate/<provider> ---------------------------------

use std::sync::atomic::Ordering;

fn put_entry(fake: &Fake, provider: &str, value: &str) {
    fake.entries
        .lock()
        .unwrap()
        .insert(provider.into(), value.into());
}

fn has_entry(fake: &Fake, provider: &str) -> bool {
    fake.entries.lock().unwrap().contains_key(provider)
}

fn break_the_database(root: &Path) {
    fs::write(
        root.join("credentials/credentials.sqlite"),
        b"this is not a database at all, just bytes that are long enough to be rejected",
    )
    .unwrap();
}

/// Everything the vault asked the fake store, in order (`get:`, `set:`, `delete:` + provider).
fn calls(fake: &Fake) -> Vec<String> {
    fake.log.lock().unwrap().clone()
}

#[test]
fn deleting_a_key_deletes_that_providers_entry_and_nothing_else() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    put_entry(&fake, "gemini", "other-provider-fixture");
    put_entry(&fake, "someone-else", "foreign-fixture");
    fake.log.lock().unwrap().clear();
    vault.delete(dir.path(), "openai").unwrap();
    assert!(!has_entry(&fake, "openai"));
    assert!(
        has_entry(&fake, "gemini"),
        "another provider is not affected"
    );
    assert!(has_entry(&fake, "someone-else"), "not the app's name");
    assert_eq!(
        calls(&fake),
        ["delete:openai"],
        "one delete, no read, no listing"
    );
    assert!(!vault.status(dir.path(), "openai").unwrap().stored);
}

/// Record in the vault's row that a key was once stored in the keychain, as an older build left it.
fn mark_known_keychain(root: &Path, provider: &str) {
    let (conn, _held) = Vault::new(root).connection(false).unwrap().unwrap();
    conn.execute(
        "UPDATE accounts SET known_keychain=1 WHERE provider=?1",
        [provider],
    )
    .unwrap();
}

#[test]
fn someone_who_never_used_the_keychain_makes_no_os_call_on_delete() {
    // The entries planted here are not theirs: no row says the keychain was ever used.
    for mode in [Mode::Local, Mode::Session] {
        let dir = tempfile::tempdir().unwrap();
        let (vault, fake) = with_fake();
        vault
            .save(dir.path(), "openai", mode, SECRET, None)
            .unwrap();
        put_entry(&fake, "openai", "not-ours-fixture");
        vault.delete(dir.path(), "openai").unwrap();
        assert!(calls(&fake).is_empty(), "{mode:?}: {:?}", calls(&fake));
        assert!(has_entry(&fake, "openai"), "{mode:?}");
        assert!(vault.read(dir.path(), "openai", None).unwrap().is_none());
    }
    // A provider without a row at all, in a vault that exists.
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    vault.delete(dir.path(), "gemini").unwrap();
    // And with no vault at all.
    let dir = tempfile::tempdir().unwrap();
    let (other, other_fake) = with_fake();
    other.delete(dir.path(), "openai").unwrap();
    assert!(calls(&fake).is_empty());
    assert!(calls(&other_fake).is_empty());
}

#[test]
fn a_row_that_records_the_keychain_makes_delete_reach_the_entry() {
    // Keychain mode now.
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, "", None)
        .unwrap();
    put_entry(&fake, "openai", "found-in-the-apps-namespace");
    vault.delete(dir.path(), "openai").unwrap();
    assert!(!has_entry(&fake, "openai"));
    assert_eq!(calls(&fake), ["delete:openai"]);
    // The key was stored there once (the plain `known_keychain` note), whatever the mode is now.
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    mark_known_keychain(dir.path(), "openai");
    put_entry(&fake, "openai", "left-by-an-older-build");
    vault.delete(dir.path(), "openai").unwrap();
    assert!(!has_entry(&fake, "openai"));
    assert_eq!(calls(&fake), ["delete:openai"]);
    assert!(vault.read(dir.path(), "openai", None).unwrap().is_none());
}

#[test]
fn after_a_storage_reset_the_vault_no_longer_says_so_and_delete_leaves_the_os_store_alone() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    vault.reset_storage(dir.path()).unwrap();
    assert!(
        has_entry(&fake, "openai"),
        "a reset of the vault leaves the OS store alone"
    );
    fake.log.lock().unwrap().clear();
    vault.delete(dir.path(), "openai").unwrap();
    assert!(calls(&fake).is_empty(), "no row, no OS call");
}

#[test]
fn a_vault_that_cannot_be_read_cannot_say_so_delete_tries_the_entry() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "gemini", Mode::Keychain, SECRET, None)
        .unwrap();
    break_the_database(dir.path());
    fake.log.lock().unwrap().clear();
    vault.delete(dir.path(), "gemini").unwrap();
    assert!(!has_entry(&fake, "gemini"));
    assert_eq!(calls(&fake), ["delete:gemini"]);
    assert_eq!(broken_entries(dir.path(), "credentials.broken-").len(), 1);
    // A platform with no credential store at all has nothing to delete.
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "gemini", Mode::Local, SECRET, None)
        .unwrap();
    break_the_database(dir.path());
    fake.unavailable.store(true, Ordering::SeqCst);
    vault.delete(dir.path(), "gemini").unwrap();
    // A store that refuses is still reported.
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "gemini", Mode::Local, SECRET, None)
        .unwrap();
    break_the_database(dir.path());
    fake.fail_delete.store(true, Ordering::SeqCst);
    let error = vault.delete(dir.path(), "gemini").unwrap_err();
    assert_eq!(error.code, code::KEYCHAIN_UNCONFIRMED);
}

#[test]
fn where_the_vault_says_keychain_a_missing_store_is_not_a_confirmed_delete() {
    // The person did use the keychain; a platform that now has no store cannot confirm the entry
    // is gone, and says so.
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    fake.unavailable.store(true, Ordering::SeqCst);
    let error = vault.delete(dir.path(), "openai").unwrap_err();
    assert_eq!(error.code, code::KEYCHAIN_UNCONFIRMED);
    assert!(vault.status(dir.path(), "openai").unwrap().stored);
}

#[test]
fn a_missing_entry_counts_as_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault.delete(dir.path(), "openai").unwrap();
    vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    vault.delete(dir.path(), "openai").unwrap();
    assert!(vault.read(dir.path(), "openai", None).unwrap().is_none());
    let purged = vault.purge(dir.path()).unwrap();
    assert!(purged.complete(), "{purged:?}");
    assert!(fake.entries.lock().unwrap().is_empty());
}

#[test]
fn a_failed_os_delete_is_the_one_thing_reported_and_a_retry_deletes_again() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    fake.fail_delete.store(true, Ordering::SeqCst);
    let error = vault.delete(dir.path(), "openai").unwrap_err();
    assert_eq!(error.code, code::KEYCHAIN_UNCONFIRMED);
    assert!(has_entry(&fake, "openai"), "the entry is still there");
    assert!(
        vault.status(dir.path(), "openai").unwrap().stored,
        "the vault still says the key is stored, because it is"
    );
    fake.fail_delete.store(false, Ordering::SeqCst);
    vault.delete(dir.path(), "openai").unwrap();
    assert!(!has_entry(&fake, "openai"));
    assert!(!vault.status(dir.path(), "openai").unwrap().stored);
}

#[test]
fn a_failed_os_delete_still_removes_the_apps_own_copies() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    mark_known_keychain(dir.path(), "openai");
    fake.fail_delete.store(true, Ordering::SeqCst);
    let error = vault.delete(dir.path(), "openai").unwrap_err();
    assert_eq!(error.code, code::KEYCHAIN_UNCONFIRMED);
    assert!(
        vault.read(dir.path(), "openai", None).unwrap().is_none(),
        "the encrypted row is gone"
    );
}

#[test]
fn switching_away_from_keychain_mode_deletes_the_entry_for_every_destination() {
    for destination in [Mode::Local, Mode::Session] {
        let dir = tempfile::tempdir().unwrap();
        let (vault, fake) = with_fake();
        vault
            .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
            .unwrap();
        vault
            .save(dir.path(), "openai", destination, "", None)
            .unwrap();
        assert!(!has_entry(&fake, "openai"), "{destination:?}");
        assert_eq!(
            vault.status(dir.path(), "openai").unwrap().mode,
            destination
        );
    }
    // Keychain mode chosen without ever writing a key: the namespace entry is still the app's.
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, "", None)
        .unwrap();
    put_entry(&fake, "openai", "found-in-the-apps-namespace");
    vault
        .save(dir.path(), "openai", Mode::Local, "", None)
        .unwrap();
    assert!(!has_entry(&fake, "openai"));
}

#[test]
fn a_mode_switch_of_someone_who_never_used_the_keychain_makes_no_os_call() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    vault
        .save(dir.path(), "openai", Mode::Session, "", None)
        .unwrap();
    vault
        .save(
            dir.path(),
            "openai",
            Mode::Local,
            "second-fixture-secret",
            None,
        )
        .unwrap();
    assert!(calls(&fake).is_empty(), "{:?}", calls(&fake));
}

#[test]
fn a_switch_away_from_a_mode_with_the_keychain_note_deletes_the_entry_and_clears_the_note() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    mark_known_keychain(dir.path(), "openai");
    put_entry(&fake, "openai", "left-by-an-older-build");
    vault
        .save(dir.path(), "openai", Mode::Session, "", None)
        .unwrap();
    assert!(!has_entry(&fake, "openai"));
    let after = calls(&fake);
    assert!(after.contains(&"delete:openai".to_string()), "{after:?}");
    fake.log.lock().unwrap().clear();
    vault
        .save(dir.path(), "openai", Mode::Local, "", None)
        .unwrap();
    assert!(
        calls(&fake).is_empty(),
        "the note is cleared: {:?}",
        calls(&fake)
    );
}

#[test]
fn a_failed_os_delete_during_a_mode_switch_keeps_the_old_mode_and_the_retry_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    fake.fail_delete.store(true, Ordering::SeqCst);
    let error = vault
        .save(dir.path(), "openai", Mode::Local, "", None)
        .unwrap_err();
    assert!(!error.uncertain, "{error:?}");
    assert_eq!(
        vault.status(dir.path(), "openai").unwrap().mode,
        Mode::Keychain
    );
    assert_eq!(fake.entries.lock().unwrap().get("openai").unwrap(), SECRET);
    fake.fail_delete.store(false, Ordering::SeqCst);
    vault
        .save(dir.path(), "openai", Mode::Local, "", None)
        .unwrap();
    assert!(!has_entry(&fake, "openai"));
    assert_eq!(
        vault
            .read(dir.path(), "openai", None)
            .unwrap()
            .unwrap()
            .as_str(),
        SECRET,
        "the key moved into the local vault"
    );
}

#[test]
fn purge_deletes_the_entry_of_every_known_provider_and_nothing_else() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    // An entry the vault knows nothing about is still in the app's namespace.
    put_entry(&fake, "gemini", "left-by-an-older-build");
    put_entry(&fake, "someone-else", "foreign-fixture");
    vault.reset_storage(dir.path()).unwrap();
    fake.log.lock().unwrap().clear();
    let purged = vault.purge(dir.path()).unwrap();
    assert!(purged.complete(), "{purged:?}");
    assert_eq!(purged.keychain_deleted, PROVIDERS);
    let entries = fake.entries.lock().unwrap();
    assert_eq!(entries.len(), 1);
    assert!(entries.contains_key("someone-else"));
    // One delete per known provider; nothing was read and nothing was listed.
    let mut expected: Vec<String> = PROVIDERS
        .iter()
        .map(|name| format!("delete:{name}"))
        .collect();
    let mut seen = calls(&fake);
    expected.sort();
    seen.sort();
    assert_eq!(seen, expected);
}

#[test]
fn purge_does_not_need_the_vault_to_be_readable_or_present() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    break_the_database(dir.path());
    let purged = vault.purge(dir.path()).unwrap();
    assert!(purged.complete(), "{purged:?}");
    assert!(fake.entries.lock().unwrap().is_empty());
    // And again with nothing there at all: nothing to delete is not a failure.
    let again = vault.purge(dir.path()).unwrap();
    assert!(again.complete(), "{again:?}");
}

#[test]
fn a_reset_of_someone_who_never_used_the_keychain_makes_zero_os_calls() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    vault
        .save(dir.path(), "gemini", Mode::Session, SECRET, None)
        .unwrap();
    put_entry(&fake, "openrouter", "not-ours-fixture");
    let purged = vault.purge(dir.path()).unwrap();
    assert!(purged.complete(), "{purged:?}");
    assert_eq!(purged.keychain_deleted, PROVIDERS);
    assert!(calls(&fake).is_empty(), "{:?}", calls(&fake));
    assert!(has_entry(&fake, "openrouter"));
    assert!(!dir.path().join("credentials").exists());
}

#[test]
fn a_reset_deletes_only_the_entries_the_vault_says_were_used() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    vault
        .save(dir.path(), "gemini", Mode::Local, SECRET, None)
        .unwrap();
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    mark_known_keychain(dir.path(), "openrouter");
    put_entry(&fake, "openrouter", "left-by-an-older-build");
    put_entry(&fake, "gemini", "not-ours-fixture");
    fake.log.lock().unwrap().clear();
    let purged = vault.purge(dir.path()).unwrap();
    assert!(purged.complete(), "{purged:?}");
    let mut seen = calls(&fake);
    seen.sort();
    assert_eq!(seen, ["delete:openai", "delete:openrouter"]);
    assert!(!has_entry(&fake, "openai") && !has_entry(&fake, "openrouter"));
    assert!(has_entry(&fake, "gemini"), "no row says it was ours");
}

#[test]
fn an_unreadable_vault_makes_a_reset_try_every_provider_and_no_store_counts_as_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    break_the_database(dir.path());
    fake.unavailable.store(true, Ordering::SeqCst);
    let purged = vault.purge(dir.path()).unwrap();
    assert!(purged.complete(), "{purged:?}");
    assert_eq!(purged.keychain_deleted, PROVIDERS);
    assert_eq!(
        calls(&fake).len(),
        PROVIDERS.len(),
        "every provider was tried"
    );
    assert!(!dir.path().join("credentials").exists());
    // A missing vault is the same as an unreadable one.
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    fake.unavailable.store(true, Ordering::SeqCst);
    let purged = vault.purge(dir.path()).unwrap();
    assert!(purged.complete(), "{purged:?}");
    assert_eq!(calls(&fake).len(), PROVIDERS.len());
}

#[test]
fn an_unreadable_vault_and_a_refused_delete_is_unconfirmed_for_each_provider() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    break_the_database(dir.path());
    put_entry(&fake, "openai", "entry-fixture");
    fake.fail_delete.store(true, Ordering::SeqCst);
    let first = vault.purge(dir.path()).unwrap();
    assert!(!first.complete());
    assert_eq!(first.keychain_failed, PROVIDERS);
    assert!(first.keychain_deleted.is_empty());
    assert!(has_entry(&fake, "openai"));
    fake.fail_delete.store(false, Ordering::SeqCst);
    // The vault is gone now, so the retry also tries every provider.
    let retry = vault.purge(dir.path()).unwrap();
    assert!(retry.complete(), "{retry:?}");
    assert!(!has_entry(&fake, "openai"));
}

#[test]
fn where_the_vault_says_keychain_a_reset_on_a_platform_without_a_store_is_unconfirmed() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    fake.unavailable.store(true, Ordering::SeqCst);
    let purged = vault.purge(dir.path()).unwrap();
    assert_eq!(purged.keychain_failed, ["openai"]);
    assert!(!purged.complete());
}

#[test]
fn a_failed_keychain_delete_is_a_partial_outcome_and_the_retry_deletes_again() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    fake.fail_delete.store(true, Ordering::SeqCst);
    let first = vault.purge(dir.path()).unwrap();
    assert!(!first.complete());
    assert_eq!(first.keychain_failed, ["openai"], "the refused delete");
    assert_eq!(first.keychain_deleted.len(), PROVIDERS.len() - 1);
    // The files are gone anyway; what is left is the entry. The vault that said so is gone too, so
    // the retry cannot tell which provider it was and tries every one.
    assert!(first.files_removed);
    assert!(!dir.path().join("credentials").exists());
    assert!(has_entry(&fake, "openai"));
    fake.fail_delete.store(false, Ordering::SeqCst);
    let retry = vault.purge(dir.path()).unwrap();
    assert!(retry.complete(), "{retry:?}");
    assert_eq!(retry.keychain_deleted, PROVIDERS);
    assert!(fake.entries.lock().unwrap().is_empty());
}

// --- Failed-write compensation ---------------------------------------------------------------

#[test]
fn a_failed_write_over_an_existing_entry_puts_the_old_value_back() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    put_entry(&fake, "openai", "previous-fixture");
    fake.fail_next_sets.store(1, Ordering::SeqCst);
    let error = vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap_err();
    assert!(!error.uncertain, "the compensation put the old value back");
    assert_eq!(
        fake.entries.lock().unwrap().get("openai").unwrap(),
        "previous-fixture"
    );
    assert!(!vault.status(dir.path(), "openai").unwrap().stored);
}

#[test]
fn a_failed_write_with_no_previous_entry_leaves_none() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    fake.fail_next_sets.store(1, Ordering::SeqCst);
    let error = vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap_err();
    assert!(!error.uncertain);
    assert!(fake.entries.lock().unwrap().is_empty());
}

#[test]
fn a_failed_write_whose_undo_worked_keeps_the_stored_key() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
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
    assert_eq!(fake.entries.lock().unwrap().get("openai").unwrap(), SECRET);
    assert!(vault.status(dir.path(), "openai").unwrap().stored);
}

#[test]
fn a_write_that_cannot_be_undone_is_reported_uncertain() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    // An entry that is there already: the undo has to write it back, and that fails too.
    put_entry(&fake, "openai", "previous-fixture");
    fake.fail_next_sets.store(2, Ordering::SeqCst);
    let error = vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap_err();
    assert!(error.uncertain);
    assert_eq!(error.error.code, code::CREDENTIAL_SAVE_UNCERTAIN);
    // The way out the error names is to delete the key. The save recorded that the keychain was
    // used before it wrote there, so the delete reaches the entry.
    fake.log.lock().unwrap().clear();
    vault.delete(dir.path(), "openai").unwrap();
    assert_eq!(calls(&fake), ["delete:openai"]);
    assert!(!has_entry(&fake, "openai"));
}

// --- Earlier builds' ownership record ----------------------------------------------------------

fn plant_legacy_files(root: &Path) -> Vec<PathBuf> {
    let names = [
        "keychain-ledger.json",
        "keychain-ledger.json.new",
        "keychain-ledger.json.broken-1700000000000",
        "keychain-ledger.json.broken-1700000000000-1",
    ];
    names
        .iter()
        .map(|name| {
            let path = root.join(name);
            fs::write(
                &path,
                br#"{"v":2,"unreconciled":true,"entries":{"openai":{"state":"owned"}}}"#,
            )
            .unwrap();
            path
        })
        .collect()
}

#[test]
fn a_leftover_ownership_record_is_deleted_and_nothing_else_is() {
    let dir = tempfile::tempdir().unwrap();
    let planted = plant_legacy_files(dir.path());
    let other = dir.path().join("settings.json");
    fs::write(&other, b"{}").unwrap();
    // A directory that merely has the name is not a file of that record and is left alone.
    let odd = dir.path().join("keychain-ledger.json.d");
    fs::create_dir(&odd).unwrap();
    remove_legacy_ledger(dir.path());
    for path in planted {
        assert!(!path.exists(), "{}", path.display());
    }
    assert!(other.exists());
    assert!(odd.is_dir());
    // A missing folder and a second run are fine.
    remove_legacy_ledger(dir.path());
    remove_legacy_ledger(&dir.path().join("missing"));
}

#[test]
fn a_leftover_ownership_record_and_archived_vaults_are_never_consulted() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    let planted = plant_legacy_files(dir.path());
    // An archived vault whose rows claim ownership of a name is not read either.
    let archive = dir.path().join("credentials.broken-1");
    fs::create_dir(&archive).unwrap();
    fs::write(archive.join("credentials.sqlite"), b"not a database").unwrap();
    // The record's "unknown history" marker does not make a delete or a reset fail, and neither
    // does the entry it called owned.
    put_entry(&fake, "openai", "entry-in-the-apps-namespace");
    fake.log.lock().unwrap().clear();
    vault.delete(dir.path(), "openai").unwrap();
    assert!(!has_entry(&fake, "openai"));
    assert_eq!(calls(&fake), ["delete:openai"]);
    let purged = vault.purge(dir.path()).unwrap();
    assert!(purged.complete(), "{purged:?}");
    assert!(!archive.exists());
    for path in planted {
        assert!(!path.exists(), "a reset takes the leftover record with it");
    }
}

// --- Review C3: first-write crash, unreadable-vault retry, link-following cleanup --------------

/// Runs in a child process: a store whose write ends the process the moment it happens, before the
/// vault can commit the mode.
const CRASH_ROOT: &str = "PT_CRASH_AT_THE_OS_WRITE_ROOT";

fn crash_test_name(name: &str) -> String {
    let module = module_path!();
    format!(
        "{}::{name}",
        module.split_once("::").map_or(module, |(_, rest)| rest)
    )
}

fn run_the_crashing_child(test: &str, root: &Path) {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &crash_test_name(test), "--test-threads=1"])
        .env(CRASH_ROOT, root)
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(86),
        "the child must end at the OS write: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn a_process_that_ends_between_the_os_write_and_the_mode_commit_leaves_the_delete_obligation() {
    const NAME: &str =
        "a_process_that_ends_between_the_os_write_and_the_mode_commit_leaves_the_delete_obligation";
    if let Some(root) = std::env::var_os(CRASH_ROOT) {
        struct Dies;
        impl KeychainStore for Dies {
            fn get(&self, _: &str) -> Result<Option<Zeroizing<String>>, IpcError> {
                Ok(None)
            }
            fn set(&self, _: &str, _: &str) -> Result<(), IpcError> {
                std::process::exit(86)
            }
            fn delete(&self, _: &str) -> Result<(), IpcError> {
                Ok(())
            }
        }
        let _ = Credentials::with_keychain(Box::new(Dies)).save(
            Path::new(&root),
            "openai",
            Mode::Keychain,
            SECRET,
            None,
        );
        std::process::exit(3);
    }
    for reset in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        run_the_crashing_child(NAME, dir.path());
        // The OS slot survived the crash; the vault has rolled the mode back.
        let (vault, fake) = with_fake();
        put_entry(&fake, "openai", "written-before-the-crash-fixture");
        assert_eq!(
            vault.status(dir.path(), "openai").unwrap().mode,
            Mode::Local
        );
        if reset {
            let purged = vault.purge(dir.path()).unwrap();
            assert!(purged.complete(), "{purged:?}");
        } else {
            vault.delete(dir.path(), "openai").unwrap();
        }
        assert_eq!(calls(&fake), ["delete:openai"], "reset: {reset}");
        assert!(!has_entry(&fake, "openai"), "reset: {reset}");
    }
}

#[test]
fn a_note_that_cannot_be_saved_means_no_os_write_at_all() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Local, "local-fixture", None)
        .unwrap();
    {
        let (conn, _held) = Vault::new(dir.path()).connection(false).unwrap().unwrap();
        conn.execute_batch(
            "CREATE TRIGGER no_note_insert BEFORE INSERT ON accounts WHEN NEW.known_keychain=1 BEGIN SELECT RAISE(ABORT,'fixture'); END; CREATE TRIGGER no_note_update BEFORE UPDATE ON accounts WHEN NEW.known_keychain=1 BEGIN SELECT RAISE(ABORT,'fixture'); END;",
        )
        .unwrap();
    }
    fake.log.lock().unwrap().clear();
    let error = vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap_err();
    assert_eq!(error.error.code, code::VAULT_IO);
    assert!(!error.uncertain);
    assert!(calls(&fake).is_empty(), "the OS store was not touched");
    assert!(!has_entry(&fake, "openai"));
    assert_eq!(
        vault.status(dir.path(), "openai").unwrap().mode,
        Mode::Local
    );
}

#[test]
fn a_failed_save_whose_undo_worked_keeps_the_note_so_a_delete_still_reaches_the_entry() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    fake.fail_next_sets.store(1, Ordering::SeqCst);
    let error = vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap_err();
    assert_eq!(error.error.code, code::CREDENTIAL_SAVE_FAILED);
    fake.log.lock().unwrap().clear();
    vault.delete(dir.path(), "openai").unwrap();
    assert_eq!(
        calls(&fake),
        ["delete:openai"],
        "a spare delete for someone who opted in"
    );
}

fn refused_delete_on_an_unreadable_vault() -> (tempfile::TempDir, Credentials, Fake) {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    break_the_database(dir.path());
    fake.fail_delete.store(true, Ordering::SeqCst);
    let error = vault.delete(dir.path(), "openai").unwrap_err();
    assert_eq!(error.code, code::KEYCHAIN_UNCONFIRMED);
    assert!(has_entry(&fake, "openai"));
    (dir, vault, fake)
}

#[test]
fn a_refused_delete_on_an_unreadable_vault_is_retried_after_the_vault_is_replaced() {
    let (dir, _first_run, fake) = refused_delete_on_an_unreadable_vault();
    assert_eq!(broken_entries(dir.path(), "credentials.broken-").len(), 1);
    // The app is started again; the OS store now allows the delete.
    fake.fail_delete.store(false, Ordering::SeqCst);
    fake.log.lock().unwrap().clear();
    let restarted = credentials_on(&fake);
    restarted.delete(dir.path(), "openai").unwrap();
    assert_eq!(
        calls(&fake),
        ["delete:openai"],
        "the retry reaches the OS store"
    );
    assert!(!has_entry(&fake, "openai"));
    // Confirmed: the note is gone and a further delete makes no OS call.
    fake.log.lock().unwrap().clear();
    restarted.delete(dir.path(), "openai").unwrap();
    assert!(calls(&fake).is_empty());
}

#[test]
fn a_refused_delete_keeps_the_unreadable_vault_when_no_replacement_can_be_made() {
    let dir = tempfile::tempdir().unwrap();
    let (vault, fake) = with_fake();
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    break_the_database(dir.path());
    let before = tree(dir.path());
    fake.fail_delete.store(true, Ordering::SeqCst);
    tests_hook::FAIL_NEW_VAULT.with(|flag| flag.set(true));
    let error = vault.delete(dir.path(), "openai").unwrap_err();
    tests_hook::FAIL_NEW_VAULT.with(|flag| flag.set(false));
    assert_eq!(error.code, code::KEYCHAIN_UNCONFIRMED);
    assert!(broken_entries(dir.path(), "credentials.broken-").is_empty());
    assert_eq!(
        tree(dir.path()),
        before,
        "the old vault is exactly as it was"
    );
    // Retry once the store allows it: the delete reaches the entry, then the vault is set aside.
    fake.fail_delete.store(false, Ordering::SeqCst);
    fake.log.lock().unwrap().clear();
    credentials_on(&fake).delete(dir.path(), "openai").unwrap();
    assert_eq!(calls(&fake), ["delete:openai"]);
    assert!(!has_entry(&fake, "openai"));
    assert_eq!(broken_entries(dir.path(), "credentials.broken-").len(), 1);
}

#[test]
fn legacy_cleanup_does_not_follow_a_link_as_the_application_folder() {
    let dir = tempfile::tempdir().unwrap();
    let outside = dir.path().join("outside");
    fs::create_dir(&outside).unwrap();
    let survivors = plant_legacy_files(&outside);
    let link = dir.path().join("app-data");
    link_directory(&link, &outside);
    remove_legacy_ledger(&link);
    for path in survivors {
        assert!(
            path.exists(),
            "{} was reached through the link",
            path.display()
        );
    }
}

#[test]
fn legacy_cleanup_deletes_only_the_names_the_retired_record_used() {
    let dir = tempfile::tempdir().unwrap();
    let planted = plant_legacy_files(dir.path());
    let unrelated = [
        "keychain-ledger.json.notes.txt",
        "keychain-ledger.json.bak",
        "keychain-ledger.json.broken-",
        "keychain-ledger.json.broken-abc",
        "keychain-ledger.json.broken-1-2-3",
        "my-keychain-ledger.json",
    ];
    for name in unrelated {
        fs::write(dir.path().join(name), b"keep").unwrap();
    }
    remove_legacy_ledger(dir.path());
    for path in planted {
        assert!(!path.exists(), "{}", path.display());
    }
    for name in unrelated {
        assert!(dir.path().join(name).exists(), "{name} was deleted");
    }
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
    let (vault, _fake) = with_fake();
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
