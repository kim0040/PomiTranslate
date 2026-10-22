use super::*;

const EP: &str = "https://models.example.test/v1";
const SECRET: &str = "fixture-secret-never-persist-in-plaintext-1942";
#[test]
fn failed_metadata_write_preserves_previous_ciphertext_mode_and_session() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
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
    let vault = Credentials::default();
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
    let restarted = Credentials::default();
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
        .save(
            dir.path(),
            "openrouter",
            Mode::Local,
            "replacement-fixture",
            None,
        )
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
    let vault = Credentials::default();
    vault
        .save(dir.path(), "custom", Mode::Session, SECRET, Some(EP))
        .unwrap();
    assert_eq!(
        vault
            .read(dir.path(), "custom", Some(EP))
            .unwrap()
            .unwrap()
            .as_str(),
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
        !Credentials::default()
            .status(dir.path(), "custom")
            .unwrap()
            .stored
    );
}

#[test]
fn local_to_session_removes_the_persisted_key_and_cannot_reactivate_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "custom", Mode::Local, SECRET, Some(EP))
        .unwrap();
    vault
        .save(dir.path(), "custom", Mode::Session, "", Some(EP))
        .unwrap();
    assert_eq!(
        vault
            .read(dir.path(), "custom", Some(EP))
            .unwrap()
            .unwrap()
            .as_str(),
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
    let restarted = Credentials::default();
    assert!(!restarted.status(dir.path(), "custom").unwrap().stored);
    assert!(
        !restarted
            .save(dir.path(), "custom", Mode::Local, "", Some(EP))
            .unwrap()
            .stored
    );
    assert!(restarted
        .read(dir.path(), "custom", Some(EP))
        .unwrap()
        .is_none());
}

#[test]
fn an_expired_session_does_not_reactivate_a_legacy_local_copy() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
    vault
        .save(dir.path(), "custom", Mode::Local, SECRET, Some(EP))
        .unwrap();
    let conn = Connection::open(dir.path().join("credentials/credentials.sqlite")).unwrap();
    // Reproduce metadata/ciphertext left by an earlier application version.
    conn.execute(
        "UPDATE accounts SET mode='session' WHERE provider='custom'",
        [],
    )
    .unwrap();
    let restarted = Credentials::default();
    assert!(
        !restarted
            .save(dir.path(), "custom", Mode::Local, "", Some(EP))
            .unwrap()
            .stored
    );
    assert!(restarted
        .read(dir.path(), "custom", Some(EP))
        .unwrap()
        .is_none());
}
#[test]
fn tamper_missing_key_bad_schema_and_aad_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let vault = Credentials::default();
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
    let vault = Credentials::default();
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
                Credentials::default()
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
            Credentials::default()
                .read(dir.path(), provider, None)
                .unwrap()
                .unwrap()
                .as_str(),
            SECRET
        );
    }
}
