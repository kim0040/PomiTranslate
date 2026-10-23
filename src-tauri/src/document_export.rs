use serde::Deserialize;
use serde_json::Value;
use std::{io::Write, time::Duration};
use tauri_plugin_dialog::DialogExt;

use crate::{
    error::{code, IpcError},
    sidecar::ActiveSidecar,
};

/// The most glossary text the shell writes: far above a full 2,000-entry export, far below anything
/// that would stall the IPC channel.
const GLOSSARY_TEXT_LIMIT: usize = 16 * 1024 * 1024;

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DocumentKind {
    Settings,
    ScanReport,
    TranslationReport,
    GlossaryCsv,
    GlossaryTsv,
}

impl DocumentKind {
    fn filename(&self) -> &'static str {
        match self {
            Self::Settings => "pomi-settings.json",
            Self::ScanReport => "scan-report.json",
            Self::TranslationReport => "translate-report.json",
            Self::GlossaryCsv => "pomi-glossary.csv",
            Self::GlossaryTsv => "pomi-glossary.tsv",
        }
    }

    /// The file type of a glossary export; the other kinds are JSON.
    fn glossary_extension(&self) -> Option<&'static str> {
        match self {
            Self::GlossaryCsv => Some("csv"),
            Self::GlossaryTsv => Some("tsv"),
            _ => None,
        }
    }
}

/// The name the save dialog starts with. The renderer may suggest `pomi-glossary-<global|world>.<ext>`
/// for the kind's own extension; anything else (a path, another scope, the other file type) is ignored
/// and the fixed default is used, so request text never shapes a path.
fn glossary_file_name(kind: DocumentKind, requested: Option<&str>) -> String {
    let default = kind.filename();
    let (Some(extension), Some(requested)) = (kind.glossary_extension(), requested) else {
        return default.to_owned();
    };
    let valid = requested
        .strip_prefix("pomi-glossary-")
        .and_then(|rest| rest.split_once('.'))
        .is_some_and(|(scope, found)| matches!(scope, "global" | "world") && found == extension);
    if valid {
        requested.to_owned()
    } else {
        default.to_owned()
    }
}

/// The glossary text exactly as `glossary.export` returned it (a JSON string): the bytes written are its
/// UTF-8, byte-order mark included, never a JSON rendering of it.
fn glossary_bytes(document: Option<Value>) -> Result<Vec<u8>, IpcError> {
    match document {
        Some(Value::String(text)) if text.len() <= GLOSSARY_TEXT_LIMIT => Ok(text.into_bytes()),
        Some(Value::String(_)) => Err(IpcError::new(
            code::INVALID_REQUEST,
            "The glossary export is too large",
        )),
        _ => Err(IpcError::new(
            code::INVALID_REQUEST,
            "The glossary export must be text",
        )),
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
    file_name: Option<String>,
) -> Result<bool, IpcError> {
    if let Some(extension) = kind.glossary_extension() {
        // The text comes from the renderer and nothing of the sidecar's is read, so unlike the
        // reports this needs no operation gate: it cannot see a half-written file, and a save dialog
        // left open must not hold up anything else.
        let bytes = glossary_bytes(document)?;
        let name = glossary_file_name(kind, file_name.as_deref());
        return save_glossary(app, extension, name, bytes).await;
    }
    let filename = kind.filename();
    let bytes = {
        let _gate = state
            .request_gate
            .try_lock()
            .map_err(|_| IpcError::new(code::BUSY, "Another operation is running"))?;
        match kind {
            DocumentKind::Settings => {
                let value = document.ok_or_else(|| {
                    IpcError::new(code::INVALID_REQUEST, "Missing public settings")
                })?;
                serde_json::to_vec_pretty(&value)
                    .map_err(|_| IpcError::new(code::INVALID_REQUEST, "Invalid public settings"))?
            }
            _ => {
                let path = crate::app_data_root(&app)?.join("reports").join(filename);
                let bytes = std::fs::read(path).map_err(|_| {
                    IpcError::new(
                        code::EXPORT_REPORT_MISSING,
                        "The latest report is unavailable",
                    )
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
            return Err(IpcError::new(
                code::EXPORT_BAD_EXTENSION,
                "Choose a JSON file for the export",
            ));
        }
        write_atomically(&destination, &bytes)?;
        Ok(true)
    })
    .await
    .map_err(|_| failed("Export could not finish"))?
}

/// Ask where to save a glossary export and write it. `Ok(false)` when the dialog was dismissed. It is
/// only text: a name typed without an extension gets the file type's, any other is kept.
async fn save_glossary(
    app: tauri::AppHandle,
    extension: &'static str,
    name: String,
    bytes: Vec<u8>,
) -> Result<bool, IpcError> {
    let failed = |message: &str| IpcError::new(code::EXPORT_FAILED, message.to_owned());
    tauri::async_runtime::spawn_blocking(move || {
        let Some(destination) = app
            .dialog()
            .file()
            .add_filter(extension.to_uppercase(), &[extension])
            .set_file_name(name)
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let mut destination = destination
            .into_path()
            .map_err(|_| failed("Invalid export destination"))?;
        if destination.extension().is_none() {
            destination.set_extension(extension);
        }
        write_atomically(&destination, &bytes)?;
        Ok(true)
    })
    .await
    .map_err(|_| failed("Export could not finish"))?
}

/// Write `bytes` to `destination` through a temporary file in the same folder, so a half-written
/// export never replaces an existing file. A symbolic link at the destination is refused.
pub fn write_atomically(destination: &std::path::Path, bytes: &[u8]) -> Result<(), IpcError> {
    let failed = |message: &str| IpcError::new(code::EXPORT_FAILED, message.to_owned());
    if std::fs::symlink_metadata(destination).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(failed("Cannot export through a symbolic link"));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| failed("Invalid export destination"))?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| failed("Cannot create export file"))?;
    temporary
        .write_all(bytes)
        .map_err(|_| failed("Cannot write export file"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| failed("Cannot finish export file"))?;
    // A scanner or indexer can hold the new file for a moment on Windows.
    let mut delay = Duration::from_millis(40);
    for attempt in 0..4 {
        match temporary.persist(destination) {
            Ok(_) => return Ok(()),
            Err(error) if attempt < 3 => {
                temporary = error.file;
                std::thread::sleep(delay);
                delay *= 2;
            }
            Err(_) => break,
        }
    }
    Err(failed("Cannot save export file"))
}

/// Save the diagnostics bundle (`diagnostics.export`): a plain UTF-8 text file the person can read
/// before sending it. The destination comes from a native save dialog. `Ok(false)` when the dialog
/// was dismissed, `Ok(true)` once the file is written.
#[tauri::command]
pub async fn diagnostics_export(app: tauri::AppHandle) -> Result<bool, IpcError> {
    let failed = |message: &str| IpcError::new(code::EXPORT_FAILED, message.to_owned());
    let text = crate::diagnostics::global().bundle(&app.package_info().version.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let Some(destination) = app
            .dialog()
            .file()
            .add_filter("Text", &["txt"])
            .set_file_name(crate::diagnostics::bundle_file_name())
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let mut destination = destination
            .into_path()
            .map_err(|_| failed("Invalid export destination"))?;
        // It is only text: a name typed without an extension gets one, any other is kept.
        if destination.extension().is_none() {
            destination.set_extension("txt");
        }
        write_atomically(&destination, text.as_bytes())?;
        Ok(true)
    })
    .await
    .map_err(|_| failed("Export could not finish"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn kind(name: &str) -> DocumentKind {
        serde_json::from_value(json!(name)).expect("a known kind")
    }

    #[test]
    fn glossary_kinds_are_named_like_the_renderer_sends_them() {
        assert_eq!(kind("glossary_csv"), DocumentKind::GlossaryCsv);
        assert_eq!(kind("glossary_tsv"), DocumentKind::GlossaryTsv);
        assert!(serde_json::from_value::<DocumentKind>(json!("glossary")).is_err());
        assert_eq!(DocumentKind::GlossaryCsv.glossary_extension(), Some("csv"));
        assert_eq!(DocumentKind::GlossaryTsv.glossary_extension(), Some("tsv"));
        for json_kind in [
            DocumentKind::Settings,
            DocumentKind::ScanReport,
            DocumentKind::TranslationReport,
        ] {
            assert_eq!(json_kind.glossary_extension(), None);
            assert!(json_kind.filename().ends_with(".json"));
        }
    }

    #[test]
    fn a_glossary_file_name_is_the_suggestion_or_the_fixed_default() {
        let csv = DocumentKind::GlossaryCsv;
        let tsv = DocumentKind::GlossaryTsv;
        assert_eq!(glossary_file_name(csv, None), "pomi-glossary.csv");
        assert_eq!(glossary_file_name(tsv, None), "pomi-glossary.tsv");
        for good in ["pomi-glossary-global.csv", "pomi-glossary-world.csv"] {
            assert_eq!(glossary_file_name(csv, Some(good)), good);
        }
        assert_eq!(
            glossary_file_name(tsv, Some("pomi-glossary-world.tsv")),
            "pomi-glossary-world.tsv"
        );
        for bad in [
            "",
            "pomi-glossary-global.tsv",
            "pomi-glossary-all-worlds.csv",
            "pomi-glossary-global.csv.exe",
            "pomi-glossary-global.CSV",
            "pomi-glossary-.csv",
            "pomi-glossary-global",
            "pomi-glossary-global.csv\n",
            "../pomi-glossary-global.csv",
            "dir/pomi-glossary-global.csv",
            "dir\\pomi-glossary-global.csv",
            "C:\\pomi-glossary-global.csv",
            "notes.csv",
        ] {
            assert_eq!(
                glossary_file_name(csv, Some(bad)),
                "pomi-glossary.csv",
                "{bad:?}"
            );
        }
        // The other file type's name is refused, and the reports ignore any suggestion.
        assert_eq!(
            glossary_file_name(tsv, Some("pomi-glossary-global.csv")),
            "pomi-glossary.tsv"
        );
        assert_eq!(
            glossary_file_name(DocumentKind::Settings, Some("pomi-glossary-global.csv")),
            "pomi-settings.json"
        );
    }

    #[test]
    fn a_glossary_document_is_written_as_the_text_it_is() {
        let text = "\u{feff}source,target,mode,note,caseSensitive\r\n\"a,b\",,keep,\"two\nlines\",false\r\n";
        let bytes = glossary_bytes(Some(json!(text))).expect("text is accepted");
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(bytes, text.as_bytes());
        assert!(glossary_bytes(Some(json!("")))
            .expect("empty text")
            .is_empty());
    }

    #[test]
    fn a_glossary_document_that_is_not_text_is_refused() {
        for bad in [
            None,
            Some(Value::Null),
            Some(json!(7)),
            Some(json!(true)),
            Some(json!(["a"])),
            Some(json!({ "text": "a" })),
        ] {
            let error = glossary_bytes(bad.clone()).expect_err("not text");
            assert_eq!(error.code, code::INVALID_REQUEST, "{bad:?}");
        }
        let at_limit = Value::String("a".repeat(GLOSSARY_TEXT_LIMIT));
        assert!(glossary_bytes(Some(at_limit)).is_ok());
        let too_large = Value::String("a".repeat(GLOSSARY_TEXT_LIMIT + 1));
        let error = glossary_bytes(Some(too_large)).expect_err("too large");
        assert_eq!(error.code, code::INVALID_REQUEST);
    }
}
