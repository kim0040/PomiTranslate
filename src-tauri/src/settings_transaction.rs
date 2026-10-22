//! Coordinate public sidecar preferences with the native credential commit.
//! The caller holds its request gate for this entire operation, including recovery.
use serde_json::{json, Value};
use std::future::Future;

use crate::error::{code, IpcError};

pub struct CommitError {
    pub uncertain: bool,
    /// The `VAULT_*` / `KEYCHAIN_*` reason when the credential store could not be used.
    pub reason: Option<&'static str>,
}
impl From<IpcError> for CommitError {
    fn from(error: IpcError) -> Self {
        Self {
            uncertain: false,
            reason: Some(error.code),
        }
    }
}

fn ok(message: &Value) -> bool {
    message.get("type").and_then(Value::as_str) == Some("response.ok")
}

fn settings(message: &Value) -> Result<Value, IpcError> {
    message
        .get("payload")
        .and_then(|p| p.get("settings"))
        .filter(|s| s.is_object())
        .cloned()
        .ok_or_else(|| {
            IpcError::new(
                code::CORE_PROTOCOL,
                "Translation core returned invalid settings",
            )
        })
}

fn failure(id: &str, recovery_required: bool) -> Value {
    json!({"v": 1, "id": id, "type": "response.error", "error": {
        "code": if recovery_required { code::SETTINGS_RECONCILIATION_REQUIRED } else { code::CREDENTIAL_SAVE_FAILED },
        "message": if recovery_required {
            "Credential storage failed and preferences could not be restored. Reload current settings before translating."
        } else {
            "Credential storage failed. Previous preferences were restored; the new API key was not saved."
        }
    }})
}

pub async fn save<T, Exchange, F, Commit>(
    request: Value,
    mut exchange: Exchange,
    commit: Commit,
) -> Result<(Value, Option<T>), IpcError>
where
    Exchange: FnMut(Value) -> F,
    F: Future<Output = Result<Value, IpcError>>,
    Commit: FnOnce() -> Result<T, CommitError>,
{
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| IpcError::new(code::INVALID_REQUEST, "Missing request id"))?
        .to_owned();
    let snapshot = exchange(
        json!({"v":1, "id":format!("{id}-snapshot"), "type":"settings.get",
        "payload":{"credentialOwner":"rust"}}),
    )
    .await?;
    if !ok(&snapshot) {
        // Nothing was saved; the core's own error (with its code) is the answer.
        return Ok((snapshot, None));
    }
    let previous = settings(&snapshot)?;
    let response = match exchange(request).await {
        Ok(response) => response,
        // The core might have written the preferences before its reply was lost. Do not
        // claim rollback or commit the credential when its outcome is unknown.
        Err(_) => return Ok((failure(&id, true), None)),
    };
    if !ok(&response) {
        return Ok((response, None));
    }
    let expected = match settings(&response) {
        Ok(expected) => expected,
        Err(_) => return Ok((failure(&id, true), None)),
    };
    match commit() {
        Ok(status) => Ok((response, Some(status))),
        Err(error) => {
            // CAS recovery also protects a public settings file changed by a separate CLI.
            let recovered = exchange(json!({"v":1, "id":format!("{id}-rollback"),
                "type":"settings.restore", "payload":{"credentialOwner":"rust",
                    "settings":previous, "expectedSettings":expected}}))
            .await;
            let restored =
                recovered.is_ok_and(|r| ok(&r) && settings(&r).ok().as_ref() == Some(&previous));
            let mut response = failure(&id, !restored);
            if error.uncertain {
                response["error"]["code"] = json!(code::CREDENTIAL_SAVE_UNCERTAIN);
                response["error"]["message"] = json!("OS credential recovery could not be verified. Re-enter or delete the API key before translating.");
            } else if restored {
                if let Some(reason) = error.reason {
                    // Say why the store refused: the page offers the matching next step.
                    response["error"]["code"] = json!(code::CREDENTIAL_UNAVAILABLE);
                    response["error"]["detail"] = json!(reason);
                }
            }
            Ok((response, None))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, collections::VecDeque};

    fn response(settings: Value) -> Value {
        json!({"type":"response.ok","payload":{"settings":settings}})
    }
    fn request() -> Value {
        json!({"v":1,"id":"save","type":"settings.set","payload":{"provider":"openrouter"}})
    }
    fn run(replies: Vec<Result<Value, IpcError>>, commit_ok: bool) -> (Value, Vec<Value>, bool) {
        let replies = RefCell::new(VecDeque::from(replies));
        let requests = RefCell::new(Vec::new());
        let committed = RefCell::new(false);
        let (result, _) = tauri::async_runtime::block_on(save(
            request(),
            |r| {
                requests.borrow_mut().push(r);
                std::future::ready(
                    replies
                        .borrow_mut()
                        .pop_front()
                        .expect("unexpected exchange"),
                )
            },
            || {
                *committed.borrow_mut() = true;
                if commit_ok {
                    Ok(())
                } else {
                    Err(CommitError {
                        uncertain: false,
                        reason: None,
                    })
                }
            },
        ))
        .unwrap();
        (result, requests.into_inner(), committed.into_inner())
    }

    #[test]
    fn public_save_precedes_credential_commit_and_success_never_rolls_back() {
        let (r, requests, committed) = run(
            vec![
                Ok(response(json!({}))),
                Ok(response(json!({"model":"new"}))),
            ],
            true,
        );
        assert!(ok(&r));
        assert!(committed);
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["type"], "settings.get");
        assert_eq!(requests[1]["type"], "settings.set");
    }

    #[test]
    fn failed_vault_commit_restores_exact_snapshot_including_first_save() {
        let before = json!({"recent_worlds":[],"unknownPreference":true});
        let after = json!({"model":"new","ui_language":"en"});
        let (r, requests, committed) = run(
            vec![
                Ok(response(before.clone())),
                Ok(response(after.clone())),
                Ok(response(before.clone())),
            ],
            false,
        );
        assert!(committed);
        assert_eq!(r["error"]["code"], "CREDENTIAL_SAVE_FAILED");
        assert_eq!(requests[2]["payload"]["settings"], before);
        assert_eq!(requests[2]["payload"]["expectedSettings"], after);
    }

    #[test]
    fn failed_or_mismatched_recovery_requires_reconciliation() {
        for reply in [
            Err(IpcError::new("CORE_STOPPED", "fixture closed")),
            Ok(json!({"type":"response.error"})),
            Ok(response(json!({"model":"unexpected"}))),
        ] {
            let (r, _, _) = run(
                vec![
                    Ok(response(json!({}))),
                    Ok(response(json!({"model":"new"}))),
                    reply,
                ],
                false,
            );
            assert_eq!(r["error"]["code"], "SETTINGS_RECONCILIATION_REQUIRED");
        }
    }

    #[test]
    fn core_rejection_never_commits_credential_and_lost_reply_is_unknown() {
        let (r, requests, committed) = run(
            vec![
                Ok(response(json!({}))),
                Ok(json!({"type":"response.error","error":{"code":"INVALID_REQUEST"}})),
            ],
            true,
        );
        assert_eq!(r["error"]["code"], "INVALID_REQUEST");
        assert!(!committed);
        assert_eq!(requests.len(), 2);
        let (r, _, committed) = run(
            vec![
                Ok(response(json!({}))),
                Err(IpcError::new("CORE_STOPPED", "lost reply")),
            ],
            true,
        );
        assert_eq!(r["error"]["code"], "SETTINGS_RECONCILIATION_REQUIRED");
        assert!(!committed);
    }

    #[test]
    fn uncertain_os_credential_recovery_is_not_reported_as_a_verified_rollback() {
        let replies = RefCell::new(VecDeque::from(vec![
            Ok(response(json!({}))),
            Ok(response(json!({"model":"new"}))),
            Ok(response(json!({}))),
        ]));
        let (result, _) = tauri::async_runtime::block_on(save::<(), _, _, _>(
            request(),
            |_| std::future::ready(replies.borrow_mut().pop_front().unwrap()),
            || {
                Err(CommitError {
                    uncertain: true,
                    reason: None,
                })
            },
        ))
        .unwrap();
        assert_eq!(result["error"]["code"], "CREDENTIAL_SAVE_UNCERTAIN");
    }
}
