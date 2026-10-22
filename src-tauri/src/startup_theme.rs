//! Give the window its saved light/dark mode before the page has loaded. Without this a dark
//! choice shows the light window background (from tauri.conf.json) until the page script runs.
use std::{fs, path::Path};

use serde_json::Value;
use tauri::{window::Color, App, Manager, Theme};

const LIGHT: Color = Color(0xf9, 0xf8, 0xf7, 0xff);
const DARK: Color = Color(0x12, 0x0f, 0x0b, 0xff);

/// The mode saved in the settings file (or its copy). Anything unreadable means "system".
pub fn saved_choice(data_dir: &Path) -> &'static str {
    for name in ["settings.json", "settings.backup.json"] {
        let Ok(text) = fs::read_to_string(data_dir.join(name)) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        return match value.pointer("/app_prefs/theme").and_then(Value::as_str) {
            Some("light") => "light",
            Some("dark") => "dark",
            _ => "system",
        };
    }
    "system"
}

pub fn apply(app: &App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(app_data) = app.path().app_data_dir() else {
        return;
    };
    let Ok(data) = crate::sidecar_paths::core_data_dir(&app_data, &app.config().identifier) else {
        return;
    };
    let theme = match saved_choice(&data) {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    };
    let _ = window.set_theme(theme);
    let dark = match theme {
        Some(chosen) => chosen == Theme::Dark,
        None => window.theme().is_ok_and(|current| current == Theme::Dark),
    };
    let _ = window.set_background_color(Some(if dark { DARK } else { LIGHT }));
}

#[cfg(test)]
mod tests {
    use super::saved_choice;

    #[test]
    fn reads_the_saved_mode_and_falls_back_to_the_copy_then_system() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(saved_choice(dir.path()), "system");
        std::fs::write(
            dir.path().join("settings.backup.json"),
            r#"{"app_prefs":{"theme":"dark"}}"#,
        )
        .unwrap();
        std::fs::write(dir.path().join("settings.json"), "{ damaged").unwrap();
        assert_eq!(
            saved_choice(dir.path()),
            "dark",
            "a damaged file falls back to its copy"
        );
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"app_prefs":{"theme":"light"}}"#,
        )
        .unwrap();
        assert_eq!(saved_choice(dir.path()), "light");
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"app_prefs":{"theme":"neon"}}"#,
        )
        .unwrap();
        assert_eq!(saved_choice(dir.path()), "system");
    }
}
