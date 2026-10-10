use super::*;
use std::sync::Arc;

const SECRET: &str = "fixture-secret-never-persist-in-plaintext-1942";
const ORIGIN: &str = "https://llm.example.test";

/// An in-memory OS keychain. No unit test opens the user's keychain.
#[derive(Clone, Default)]
struct FakeKeychain(Arc<Mutex<HashMap<String, String>>>);
impl Keychain for FakeKeychain {
    fn get(&self, provider: &str) -> Result<Option<Zeroizing<String>>, String> {
        Ok(self.0.lock().unwrap().get(provider).map(|s| Zeroizing::new(s.clone())))
    }
    fn set(&self, provider: &str, secret: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(provider.into(), secret.into());
        Ok(())
    }
    fn remove(&self, provider: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(provider);
        Ok(())
    }
}
impl FakeKeychain {
    fn entry(&self, provider: &str) -> Option<String> {
        self.0.lock().unwrap().get(provider).cloned()
    }
}

fn vault_with_fake() -> Credentials {
    Credentials::with_keychain(Box::new(FakeKeychain::default()))
}

fn vault_with(store: &FakeKeychain) -> Credentials {
    Credentials::with_keychain(Box::new(store.clone()))
}
#[test]
fn failed_metadata_write_preserves_previous_ciphertext_mode_and_session() {
    let dir = tempfile::tempdir().unwrap();
    let vault = vault_with_fake();
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    let conn = Connection::open(dir.path().join("credentials/credentials.sqlite")).unwrap();
    let before: Vec<u8> = conn
        .query_row(
            "SELECT ciphertext FROM credentials WHERE provider='openrouter'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    conn.execute_batch("CREATE TRIGGER fail_accounts BEFORE INSERT ON accounts BEGIN SELECT RAISE(ABORT,'fixture metadata failure'); END;").unwrap();
    for mode in [Mode::Local, Mode::Session] {
        assert!(vault
            .save(dir.path(), "openrouter", mode, "replacement-fixture", None)
            .is_err());
        assert_eq!(
            vault.status(dir.path(), "openrouter").unwrap().mode,
            Mode::Local
        );
        assert_eq!(
            vault
                .read(dir.path(), "openrouter", None)
                .unwrap()
                .unwrap()
                .as_str(),
            SECRET
        );
        let after: Vec<u8> = conn
            .query_row(
                "SELECT ciphertext FROM credentials WHERE provider='openrouter'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(before, after);
    }
}
#[test]
fn encrypted_roundtrip_restart_update_delete_and_provider_isolation() {
    let dir = tempfile::tempdir().unwrap();
    let vault = vault_with_fake();
    assert!(!vault.status(dir.path(), "openrouter").unwrap().stored);
    assert!(!dir.path().join("credentials").exists());
    assert!(
        vault
            .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
            .unwrap()
            .stored
    );
    assert_eq!(
        vault
            .read(dir.path(), "openrouter", None)
            .unwrap()
            .unwrap()
            .as_str(),
        SECRET
    );
    assert!(vault.read(dir.path(), "openai", None).unwrap().is_none());
    let restarted = vault_with_fake();
    assert_eq!(
        restarted
            .read(dir.path(), "openrouter", None)
            .unwrap()
            .unwrap()
            .as_str(),
        SECRET
    );
    let bytes = fs::read(dir.path().join("credentials/credentials.sqlite")).unwrap();
    assert!(!bytes.windows(SECRET.len()).any(|s| s == SECRET.as_bytes()));
    restarted
        .save(dir.path(), "openrouter", Mode::Local, "replacement-fixture", None)
        .unwrap();
    assert_eq!(
        restarted
            .read(dir.path(), "openrouter", None)
            .unwrap()
            .unwrap()
            .as_str(),
        "replacement-fixture"
    );
    restarted.delete(dir.path(), "openrouter").unwrap();
    assert!(!restarted.status(dir.path(), "openrouter").unwrap().stored);
}
#[test]
fn session_mode_never_persists_secret_and_expires_on_restart() {
    let dir = tempfile::tempdir().unwrap();
    let vault = vault_with_fake();
    vault
        .save(dir.path(), "custom", Mode::Session, SECRET, Some(ORIGIN))
        .unwrap();
    assert_eq!(
        vault.read(dir.path(), "custom", Some(ORIGIN)).unwrap().unwrap().as_str(),
        SECRET
    );
    assert!(!dir.path().join("credential-key").exists());
    let conn = Connection::open(dir.path().join("credentials/credentials.sqlite")).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM credentials", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(
        !vault_with_fake()
            .status(dir.path(), "custom")
            .unwrap()
            .stored
    );
}

#[test]
fn local_to_session_removes_the_persisted_key_and_cannot_reactivate_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let vault = vault_with_fake();
    vault
        .save(dir.path(), "custom", Mode::Local, SECRET, Some(ORIGIN))
        .unwrap();
    vault.save(dir.path(), "custom", Mode::Session, "", None).unwrap();
    assert_eq!(
        vault.read(dir.path(), "custom", Some(ORIGIN)).unwrap().unwrap().as_str(),
        SECRET
    );
    let conn = Connection::open(dir.path().join("credentials/credentials.sqlite")).unwrap();
    assert_eq!(
        conn.query_row(
            "SELECT count(*) FROM credentials WHERE provider='custom'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    let restarted = vault_with_fake();
    assert!(!restarted.status(dir.path(), "custom").unwrap().stored);
    assert!(
        !restarted
            .save(dir.path(), "custom", Mode::Local, "", None)
            .unwrap()
            .stored
    );
    assert!(restarted.read(dir.path(), "custom", None).unwrap().is_none());
}

#[test]
fn an_expired_session_does_not_reactivate_a_legacy_local_copy() {
    let dir = tempfile::tempdir().unwrap();
    let vault = vault_with_fake();
    vault
        .save(dir.path(), "custom", Mode::Local, SECRET, None)
        .unwrap();
    let conn = Connection::open(dir.path().join("credentials/credentials.sqlite")).unwrap();
    // Reproduce metadata/ciphertext left by an earlier application version.
    conn.execute(
        "UPDATE accounts SET mode='session' WHERE provider='custom'",
        [],
    )
    .unwrap();
    let restarted = vault_with_fake();
    assert!(
        !restarted
            .save(dir.path(), "custom", Mode::Local, "", None)
            .unwrap()
            .stored
    );
    assert!(restarted.read(dir.path(), "custom", None).unwrap().is_none());
}
#[test]
fn tamper_missing_key_bad_schema_and_aad_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let vault = vault_with_fake();
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    let db = dir.path().join("credentials/credentials.sqlite");
    let conn = Connection::open(&db).unwrap();
    conn.execute("UPDATE credentials SET provider='openai'", [])
        .unwrap();
    assert!(vault.read(dir.path(), "openai", None).is_err());
    conn.execute("UPDATE credentials SET provider='openrouter'", [])
        .unwrap();
    conn.execute("UPDATE credentials SET nonce=zeroblob(12)", [])
        .unwrap();
    assert!(vault.read(dir.path(), "openrouter", None).is_err());
    fs::remove_file(dir.path().join("credential-key/master.key")).unwrap();
    assert!(
        vault.status(dir.path(), "openrouter").unwrap().stored,
        "status inspects metadata without decrypting"
    );
    assert!(vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .is_err());
    assert!(!dir.path().join("credential-key/master.key").exists());
    conn.execute("UPDATE vault_meta SET schema_version=100", [])
        .unwrap();
    assert!(vault.status(dir.path(), "openrouter").is_err());
}
#[cfg(unix)]
#[test]
fn permissions_and_symlinks_are_rejected() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let vault = vault_with_fake();
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .unwrap();
    let db = dir.path().join("credentials/credentials.sqlite");
    assert_eq!(
        fs::metadata(&db).unwrap().permissions().mode() & 0o777,
        0o600
    );
    fs::set_permissions(&db, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(vault.status(dir.path(), "openrouter").is_err());
    fs::set_permissions(&db, fs::Permissions::from_mode(0o600)).unwrap();
    fs::remove_file(dir.path().join("credential-key/master.key")).unwrap();
    let outside = dir.path().join("outside");
    fs::write(&outside, [0u8; 48]).unwrap();
    symlink(outside, dir.path().join("credential-key/master.key")).unwrap();
    assert!(vault.read(dir.path(), "openrouter", None).is_err());
}
#[test]
fn concurrent_creators_share_one_key_and_generate_distinct_nonces() {
    let dir = tempfile::tempdir().unwrap();
    std::thread::scope(|scope| {
        for provider in ["openai", "openrouter"] {
            let root = dir.path();
            scope.spawn(move || {
                vault_with_fake()
                    .save(root, provider, Mode::Local, SECRET, None)
                    .unwrap()
            });
        }
    });
    let conn = Connection::open(dir.path().join("credentials/credentials.sqlite")).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(DISTINCT nonce) FROM credentials", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        2
    );
    for provider in ["openai", "openrouter"] {
        assert_eq!(
            vault_with_fake()
                .read(dir.path(), provider, None)
                .unwrap()
                .unwrap()
                .as_str(),
            SECRET
        );
    }
}

#[test]
fn an_interrupted_key_creation_is_replaced_only_while_nothing_depends_on_it() {
    let dir = tempfile::tempdir().unwrap();
    let vault = vault_with_fake();
    // Initialize the database without a key, then leave a stale master.new behind.
    vault.save(dir.path(), "openai", Mode::Session, SECRET, None).unwrap();
    let key_dir = dir.path().join("credential-key");
    private_fs::directory(&key_dir).unwrap();
    drop(private_fs::open(&key_dir.join("master.new"), true).unwrap());
    vault
        .save(dir.path(), "openrouter", Mode::Local, SECRET, None)
        .expect("a leftover master.new with no key and no ciphertext is replaced");
    assert!(!key_dir.join("master.new").exists());
    assert!(key_dir.join("master.key").is_file());
    assert_eq!(
        vault.read(dir.path(), "openrouter", None).unwrap().unwrap().as_str(),
        SECRET
    );

    // With ciphertext present and the key gone, nothing is recreated or removed.
    fs::remove_file(key_dir.join("master.key")).unwrap();
    drop(private_fs::open(&key_dir.join("master.new"), true).unwrap());
    assert!(vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .is_err());
    assert!(key_dir.join("master.new").exists(), "evidence stays for recovery");
    assert!(!key_dir.join("master.key").exists());
}

#[test]
fn leaving_keychain_mode_removes_the_entry_this_app_wrote() {
    let dir = tempfile::tempdir().unwrap();
    let store = FakeKeychain::default();
    let vault = vault_with(&store);
    for target in [Mode::Local, Mode::Session] {
        vault
            .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
            .unwrap();
        assert_eq!(store.entry("openai").as_deref(), Some(SECRET));
        let status = vault.save(dir.path(), "openai", target, "", None).unwrap();
        assert!(status.stored, "{target:?}: the key moved");
        assert_eq!(store.entry("openai"), None, "{target:?}: no keychain copy stays behind");
        assert_eq!(
            vault.read(dir.path(), "openai", None).unwrap().unwrap().as_str(),
            SECRET
        );
        vault.delete(dir.path(), "openai").unwrap();
    }
    // Leaving with a new key also removes the old app-written entry.
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    vault
        .save(dir.path(), "openai", Mode::Local, "replacement-fixture", None)
        .unwrap();
    assert_eq!(store.entry("openai"), None);
}

#[test]
fn delete_removes_an_app_written_entry_and_import_cannot_revive_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = FakeKeychain::default();
    let vault = vault_with(&store);
    vault
        .save(dir.path(), "anthropic", Mode::Keychain, SECRET, None)
        .unwrap();
    vault.delete(dir.path(), "anthropic").unwrap();
    assert_eq!(store.entry("anthropic"), None);
    assert!(vault.import_keychain(dir.path(), "anthropic").is_err());
    assert!(vault.read(dir.path(), "anthropic", None).unwrap().is_none());
}

#[test]
fn an_entry_the_user_imported_from_is_never_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let store = FakeKeychain::default();
    store.set("gemini", "users-own-entry").unwrap();
    let vault = vault_with(&store);
    assert!(vault.import_keychain(dir.path(), "gemini").unwrap().stored);
    assert_eq!(
        vault.read(dir.path(), "gemini", None).unwrap().unwrap().as_str(),
        "users-own-entry"
    );
    vault.save(dir.path(), "gemini", Mode::Session, "", None).unwrap();
    vault.delete(dir.path(), "gemini").unwrap();
    assert_eq!(store.entry("gemini").as_deref(), Some("users-own-entry"));

    // Keychain mode without a key written by this app neither reports nor uses that entry,
    // so deleting the key cannot leave a usable one behind.
    vault.save(dir.path(), "gemini", Mode::Keychain, "", None).unwrap();
    assert!(!vault.status(dir.path(), "gemini").unwrap().stored);
    assert!(vault.read(dir.path(), "gemini", None).unwrap().is_none());
    vault.delete(dir.path(), "gemini").unwrap();
    assert_eq!(store.entry("gemini").as_deref(), Some("users-own-entry"));
}

#[test]
fn a_residual_entry_from_an_earlier_version_is_cleaned_on_the_next_save() {
    let dir = tempfile::tempdir().unwrap();
    let store = FakeKeychain::default();
    let vault = vault_with(&store);
    vault
        .save(dir.path(), "comet", Mode::Keychain, SECRET, None)
        .unwrap();
    // An earlier version switched to Local and kept known_keychain=1 and the entry.
    let conn = Connection::open(dir.path().join("credentials/credentials.sqlite")).unwrap();
    conn.execute("UPDATE accounts SET mode='local' WHERE provider='comet'", [])
        .unwrap();
    vault
        .save(dir.path(), "comet", Mode::Local, "replacement-fixture", None)
        .unwrap();
    assert_eq!(store.entry("comet"), None);
}

#[test]
fn a_failed_save_while_leaving_keychain_mode_keeps_the_entry_and_mode() {
    let dir = tempfile::tempdir().unwrap();
    let store = FakeKeychain::default();
    let vault = vault_with(&store);
    vault
        .save(dir.path(), "openai", Mode::Keychain, SECRET, None)
        .unwrap();
    let conn = Connection::open(dir.path().join("credentials/credentials.sqlite")).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_accounts BEFORE UPDATE ON accounts BEGIN SELECT RAISE(ABORT,'fixture metadata failure'); END;").unwrap();
    assert!(vault.save(dir.path(), "openai", Mode::Session, "", None).is_err());
    assert_eq!(store.entry("openai").as_deref(), Some(SECRET));
    assert_eq!(vault.status(dir.path(), "openai").unwrap().mode, Mode::Keychain);
}

#[test]
fn a_custom_key_only_goes_to_the_origin_it_was_saved_for() {
    let dir = tempfile::tempdir().unwrap();
    let store = FakeKeychain::default();
    let vault = vault_with(&store);
    for mode in [Mode::Local, Mode::Session, Mode::Keychain] {
        vault
            .save(dir.path(), "custom", mode, SECRET, Some(ORIGIN))
            .unwrap();
        assert_eq!(
            vault.read(dir.path(), "custom", Some(ORIGIN)).unwrap().unwrap().as_str(),
            SECRET,
            "{mode:?}"
        );
        for other in [Some("https://attacker.example.test"), Some("http://llm.example.test"), None] {
            assert_eq!(
                vault.read(dir.path(), "custom", other).unwrap_err(),
                CODE_KEY_ORIGIN_MISMATCH,
                "{mode:?} {other:?}"
            );
        }
        // Changing only the endpoint (no new key) never rebinds the stored key.
        vault
            .save(dir.path(), "custom", mode, "", Some("https://attacker.example.test"))
            .unwrap();
        assert_eq!(
            vault
                .read(dir.path(), "custom", Some("https://attacker.example.test"))
                .unwrap_err(),
            CODE_KEY_ORIGIN_MISMATCH
        );
        // Entering the key again for the new endpoint binds it there.
        vault
            .save(dir.path(), "custom", mode, SECRET, Some("https://other.example.test"))
            .unwrap();
        assert!(vault.read(dir.path(), "custom", Some("https://other.example.test")).is_ok());
        assert!(vault.read(dir.path(), "custom", Some(ORIGIN)).is_err());
        vault.delete(dir.path(), "custom").unwrap();
        assert!(vault.read(dir.path(), "custom", Some(ORIGIN)).unwrap().is_none());
    }
    // Public providers are pinned elsewhere and carry no origin.
    vault
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    assert!(vault.read(dir.path(), "openai", None).unwrap().is_some());
}

#[test]
fn a_custom_key_saved_without_an_origin_must_be_entered_again() {
    let dir = tempfile::tempdir().unwrap();
    let vault = vault_with_fake();
    vault
        .save(dir.path(), "custom", Mode::Local, SECRET, Some(ORIGIN))
        .unwrap();
    // A key saved by an earlier version has no recorded origin.
    let conn = Connection::open(dir.path().join("credentials/credentials.sqlite")).unwrap();
    conn.execute("DELETE FROM credential_origins", []).unwrap();
    assert_eq!(
        vault.read(dir.path(), "custom", Some(ORIGIN)).unwrap_err(),
        CODE_KEY_ORIGIN_MISMATCH
    );
    assert!(vault.status(dir.path(), "custom").unwrap().stored);
}

#[cfg(target_os = "macos")]
#[test]
fn the_key_folder_is_excluded_from_time_machine() {
    use std::os::unix::ffi::OsStrExt;
    let dir = tempfile::tempdir().unwrap();
    vault_with_fake()
        .save(dir.path(), "openai", Mode::Local, SECRET, None)
        .unwrap();
    let folder =
        std::ffi::CString::new(dir.path().join("credential-key").as_os_str().as_bytes()).unwrap();
    let mut value = [0u8; 128];
    let read = unsafe {
        libc::getxattr(
            folder.as_ptr(),
            BACKUP_EXCLUDE_ATTRIBUTE.as_ptr().cast(),
            value.as_mut_ptr().cast(),
            value.len(),
            0,
            libc::XATTR_NOFOLLOW,
        )
    };
    assert_eq!(read, BACKUP_EXCLUDE_VALUE.len() as isize);
    assert_eq!(&value[..BACKUP_EXCLUDE_VALUE.len()], BACKUP_EXCLUDE_VALUE);
}
