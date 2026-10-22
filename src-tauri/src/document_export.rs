use serde::Deserialize;
use serde_json::Value;
use std::{io::Write, time::Duration};
use tauri_plugin_dialog::DialogExt;

use crate::{
    error::{code, IpcError},
    sidecar::ActiveSidecar,
};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentKind {
    Settings,
    ScanReport,
    TranslationReport,
}

impl DocumentKind {
    fn filename(&self) -> &'static str {
        match self {
            Self::Settings => "pomi-settings.json",
            Self::ScanReport => "scan-report.json",
            Self::TranslationReport => "translate-report.json",
        }
    }
}

/// The destination comes from a native dialog, never from renderer path input.
///
/// The data is read while the operation gate is held; the gate is released before the save dialog
/// opens, so a dialog left open never blocks paging, estimates or closing the window (EX-3).
#[tauri::command]
pub async fn export_document(
    app: tauri::AppHandle,
    state: tauri::State<'_, ActiveSidecar>,
    kind: DocumentKind,
    document: Option<Value>,
) -> Result<bool, IpcError> {
    let filename = kind.filename();
    let bytes = {
        let _gate = state
            .request_gate
            .try_lock()
            .map_err(|_| IpcError::new(code::BUSY, "Another operation is running"))?;
        match kind {
            DocumentKind::Settings => {
                let value = document
                    .ok_or_else(|| IpcError::new(code::INVALID_REQUEST, "Missing public settings"))?;
                serde_json::to_vec_pretty(&value)
                    .map_err(|_| IpcError::new(code::INVALID_REQUEST, "Invalid public settings"))?
            }
            _ => {
                let path = crate::app_data_root(&app)?.join("reports").join(filename);
                let bytes = std::fs::read(path).map_err(|_| {
                    IpcError::new(code::EXPORT_REPORT_MISSING, "The latest report is unavailable")
                })?;
                serde_json::from_slice::<Value>(&bytes).map_err(|_| {
                    IpcError::new(code::EXPORT_REPORT_MISSING, "The report is not valid JSON")
                })?;
                bytes
            }
        }
    };
    let failed = |message: &str| IpcError::new(code::EXPORT_FAILED, message.to_owned());
    tauri::async_runtime::spawn_blocking(move || {
        let Some(destination) = app
            .dialog()
            .file()
            .add_filter("JSON", &["json"])
            .set_file_name(filename)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let destination = destination
            .into_path()
            .map_err(|_| failed("Invalid export destination"))?;
        if destination.extension().and_then(|ext| ext.to_str()) != Some("json") {
            return Err(IpcError::new(code::EXPORT_BAD_EXTENSION, "Choose a JSON file for the export"));
        }
        if std::fs::symlink_metadata(&destination).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(failed("Cannot export through a symbolic link"));
        }
        let parent = destination.parent().ok_or_else(|| failed("Invalid export destination"))?;
        let mut temporary =
            tempfile::NamedTempFile::new_in(parent).map_err(|_| failed("Cannot create export file"))?;
        temporary
            .write_all(&bytes)
            .map_err(|_| failed("Cannot write export file"))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| failed("Cannot finish export file"))?;
        // A scanner or indexer can hold the new file for a moment on Windows.
        let mut delay = Duration::from_millis(40);
        for attempt in 0..4 {
            match temporary.persist(&destination) {
                Ok(_) => return Ok(true),
                Err(error) if attempt < 3 => {
                    temporary = error.file;
                    std::thread::sleep(delay);
                    delay *= 2;
                }
                Err(_) => break,
            }
        }
        Err(failed("Cannot save export file"))
    })
    .await
    .map_err(|_| failed("Export could not finish"))?
}
