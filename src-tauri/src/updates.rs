//! In-app updates through the official updater: the release publishes `latest.json` next to signed
//! bundles, and the app verifies each download with the public key in `plugins.updater.pubkey`.
//!
//! Without a public key the app can still tell the person that a newer version exists, but it never
//! installs an unverified download; it offers the release page instead.
//!
//! The network never holds the operation gate (EX-2): the check has a 30 second limit, the download
//! gives up when no bytes arrive for a minute and can be cancelled, and only the final install step,
//! which replaces the program, takes the gate (so it cannot start during a scan or write).
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;

use crate::{
    error::{code, IpcError},
    sidecar::ActiveSidecar,
};

pub const RELEASES_URL: &str = "https://github.com/kim0040/PomiTranslate/releases/latest";
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// A download that receives nothing for this long is abandoned.
const STALL_TIMEOUT: Duration = Duration::from_secs(60);
const TICK: Duration = Duration::from_millis(250);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// "available" or "current".
    pub status: &'static str,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
    /// True only when this build carries a signing key, so the download can be verified.
    pub can_install: bool,
    pub release_url: &'static str,
}

/// The state of a download in progress, shared with the quit flow and the cancel command.
#[derive(Default)]
pub struct UpdateControl {
    active: AtomicBool,
    cancelled: AtomicBool,
}

impl UpdateControl {
    pub fn active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    pub fn cancel(&self) {
        if self.active() {
            self.cancelled.store(true, Ordering::SeqCst);
        }
    }
}

struct ActiveGuard<'a>(&'a UpdateControl);

impl<'a> ActiveGuard<'a> {
    fn begin(control: &'a UpdateControl) -> Result<Self, IpcError> {
        if control.active.swap(true, Ordering::SeqCst) {
            return Err(IpcError::new(
                code::UPDATE_BUSY,
                "An update is already being downloaded",
            ));
        }
        control.cancelled.store(false, Ordering::SeqCst);
        Ok(Self(control))
    }
}

impl Drop for ActiveGuard<'_> {
    fn drop(&mut self) {
        self.0.active.store(false, Ordering::SeqCst);
        self.0.cancelled.store(false, Ordering::SeqCst);
    }
}

/// A build is able to verify updates only when its configuration carries the public key.
pub fn verification_key<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
}

/// Network and manifest errors read the same to the person: the release could not be reached.
fn classify(text: &str) -> &'static str {
    let lower = text.to_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        code::UPDATE_TIMEOUT
    } else if lower.contains("signature") {
        code::UPDATE_SIGNATURE_INVALID
    } else if text.contains("404")
        || text.contains("release JSON")
        || text.contains("ReleaseNotFound")
    {
        code::UPDATE_NOT_PUBLISHED
    } else {
        code::UPDATE_UNREACHABLE
    }
}

fn check_error(error: tauri_plugin_updater::Error) -> IpcError {
    let text = error.to_string();
    let kind = classify(&text);
    // A bad signature is an install problem; for a check it just means unreachable.
    let kind = if kind == code::UPDATE_SIGNATURE_INVALID {
        code::UPDATE_UNREACHABLE
    } else {
        kind
    };
    IpcError::new(kind, text)
}

pub async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<UpdateInfo, IpcError> {
    let current = app.package_info().version.to_string();
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(check_error)?;
    let found = tokio::time::timeout(CHECK_TIMEOUT + Duration::from_secs(5), updater.check())
        .await
        .map_err(|_| IpcError::new(code::UPDATE_TIMEOUT, "The update check timed out"))?
        .map_err(check_error)?;
    let can_install = verification_key(app).is_some();
    Ok(match found {
        Some(update) => UpdateInfo {
            status: "available",
            current_version: current,
            version: Some(update.version.clone()),
            notes: update
                .body
                .clone()
                .map(|body| body.chars().take(4000).collect()),
            date: update.date.map(|date| date.to_string()),
            can_install,
            release_url: RELEASES_URL,
        },
        None => UpdateInfo {
            status: "current",
            current_version: current,
            version: None,
            notes: None,
            date: None,
            can_install,
            release_url: RELEASES_URL,
        },
    })
}

#[derive(Clone, Serialize)]
pub struct Progress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// Download, verify and install, then restart into the new version.
pub async fn install<R: Runtime>(
    app: &AppHandle<R>,
    control: &UpdateControl,
    sidecar: &ActiveSidecar,
) -> Result<(), IpcError> {
    if verification_key(app).is_none() {
        return Err(IpcError::new(
            code::UPDATE_UNSIGNED_BUILD,
            "This build has no update signing key",
        ));
    }
    // No point downloading while a job holds the core; the person retries when it is done.
    if sidecar.busy() {
        return Err(IpcError::new(code::UPDATE_BUSY, "A job is running"));
    }
    let _active = ActiveGuard::begin(control)?;
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(check_error)?;
    let checked = tokio::time::timeout(CHECK_TIMEOUT + Duration::from_secs(5), updater.check())
        .await
        .map_err(|_| IpcError::new(code::UPDATE_TIMEOUT, "The update check timed out"))?
        .map_err(check_error)?;
    let Some(mut update) = checked else {
        return Err(IpcError::new(
            code::UPDATE_NONE,
            "There is no newer version",
        ));
    };
    // The 30 second request limit belongs to the check; a download is bounded by its stall limit.
    update.timeout = None;

    let window = app.get_webview_window("main");
    let last_chunk = Arc::new(Mutex::new(Instant::now()));
    let progress_clock = last_chunk.clone();
    let task = {
        let update = update.clone();
        tauri::async_runtime::spawn(async move {
            let mut downloaded = 0u64;
            update
                .download(
                    move |chunk, total| {
                        downloaded += chunk as u64;
                        if let Ok(mut clock) = progress_clock.lock() {
                            *clock = Instant::now();
                        }
                        if let Some(window) = &window {
                            let _ =
                                window.emit("pomi-update-progress", Progress { downloaded, total });
                        }
                    },
                    || {},
                )
                .await
        })
    };
    let mut task = task;
    let bytes = loop {
        if control.cancelled.load(Ordering::SeqCst) {
            task.abort();
            return Err(IpcError::new(
                code::UPDATE_CANCELLED,
                "The update download was cancelled",
            ));
        }
        match tokio::time::timeout(TICK, &mut task).await {
            Ok(joined) => {
                break joined
                    .map_err(|_| {
                        IpcError::new(
                            code::UPDATE_INSTALL_FAILED,
                            "The download task ended unexpectedly",
                        )
                    })?
                    .map_err(|error| {
                        let text = error.to_string();
                        let kind = classify(&text);
                        let kind = if kind == code::UPDATE_UNREACHABLE
                            || kind == code::UPDATE_NOT_PUBLISHED
                        {
                            code::UPDATE_INSTALL_FAILED
                        } else {
                            kind
                        };
                        IpcError::new(kind, text)
                    })?;
            }
            Err(_) => {
                let idle = last_chunk
                    .lock()
                    .map_or(Duration::ZERO, |clock| clock.elapsed());
                if idle >= STALL_TIMEOUT {
                    task.abort();
                    return Err(IpcError::new(
                        code::UPDATE_STALLED,
                        "The update download stopped receiving data",
                    ));
                }
            }
        }
    };

    // Installing replaces the program: hold the gate so no job can start halfway through.
    let _gate = sidecar.request_gate.try_lock().map_err(|_| {
        IpcError::new(
            code::UPDATE_BUSY,
            "A job started while the update was downloading",
        )
    })?;
    update
        .install(bytes)
        .map_err(|error| IpcError::new(code::UPDATE_INSTALL_FAILED, error.to_string()))?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_errors_are_classified_into_stable_codes() {
        assert_eq!(
            classify("error sending request: operation timed out"),
            code::UPDATE_TIMEOUT
        );
        assert_eq!(
            classify("Download request failed with status: 404 Not Found"),
            code::UPDATE_NOT_PUBLISHED
        );
        assert_eq!(
            classify("could not fetch a valid release JSON"),
            code::UPDATE_NOT_PUBLISHED
        );
        assert_eq!(
            classify("minisign signature verification failed"),
            code::UPDATE_SIGNATURE_INVALID
        );
        assert_eq!(
            classify("dns error: failed to lookup address"),
            code::UPDATE_UNREACHABLE
        );
    }

    #[test]
    fn only_one_download_runs_and_cancel_is_ignored_when_idle() {
        let control = UpdateControl::default();
        control.cancel();
        assert!(
            !control.cancelled.load(Ordering::SeqCst),
            "nothing to cancel"
        );
        let first = ActiveGuard::begin(&control).unwrap();
        assert!(control.active());
        assert_eq!(
            ActiveGuard::begin(&control).err().unwrap().code,
            code::UPDATE_BUSY
        );
        control.cancel();
        assert!(control.cancelled.load(Ordering::SeqCst));
        drop(first);
        assert!(!control.active());
        assert!(
            !control.cancelled.load(Ordering::SeqCst),
            "a new download starts uncancelled"
        );
    }
}
