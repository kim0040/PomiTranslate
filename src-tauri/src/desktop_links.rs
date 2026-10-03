//! Links and folders the page may open in the system's own apps. A web view would otherwise open a
//! link inside the app window, or not at all. Only known addresses are accepted, so a string from a
//! world, a model list or a provider response can never make the app open something else.
use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime, Url};
use tauri_plugin_opener::OpenerExt;

const HOSTS: &[&str] = &[
    "github.com",
    "www.minecraft.net",
    "minecraft.net",
    "openrouter.ai",
    "aistudio.google.com",
    "ai.google.dev",
    "platform.openai.com",
    "console.anthropic.com",
    "www.cometapi.com",
    "cometapi.com",
];
const CONTACT: &str = "mailto:mini0227kim@gmail.com";

pub fn allowed(url: &str) -> bool {
    if url == CONTACT {
        return true;
    }
    let Ok(parsed) = Url::parse(url) else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.port().is_none()
        && parsed.host_str().is_some_and(|host| HOSTS.contains(&host))
}

#[tauri::command]
pub fn open_external<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    if !allowed(&url) {
        return Err("This address is not opened by PomiTranslate".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| "The link could not be opened".into())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLocations {
    /// Settings, recent worlds, unfinished jobs and world backups.
    pub data: String,
    /// The encrypted key vault and run reports.
    pub app: String,
}

fn locations<R: Runtime>(app: &AppHandle<R>) -> Result<(PathBuf, PathBuf), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "Application data directory is unavailable")?;
    let data = crate::sidecar_paths::core_data_dir(&app_data, &app.config().identifier)?;
    Ok((data, app_data))
}

#[tauri::command]
pub fn data_locations<R: Runtime>(app: AppHandle<R>) -> Result<DataLocations, String> {
    let (data, app_data) = locations(&app)?;
    Ok(DataLocations {
        data: data.to_string_lossy().into_owned(),
        app: app_data.to_string_lossy().into_owned(),
    })
}

/// Show the data folder in Finder or Explorer, creating it if this is the first launch.
#[tauri::command]
pub fn reveal_data_folder<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let (data, _) = locations(&app)?;
    std::fs::create_dir_all(&data).map_err(|_| "The data folder could not be created")?;
    app.opener()
        .open_path(data.to_string_lossy(), None::<&str>)
        .map_err(|_| "The data folder could not be opened".into())
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn every_api_key_page_the_help_screen_lists_opens() {
        for page in [
            "https://platform.openai.com/api-keys",
            "https://aistudio.google.com/app/apikey",
            "https://console.anthropic.com/settings/keys",
            "https://openrouter.ai/settings/keys",
            "https://www.cometapi.com/console/token",
        ] {
            assert!(allowed(page), "{page} must open");
        }
        // The host is exact: a look-alike or a plain-http Comet address never opens.
        for refused in [
            "http://www.cometapi.com/console/token",
            "https://www.cometapi.com.evil.example/console/token",
            "https://api.cometapi.com/console/token",
            "https://cometapi.com@evil.example/console/token",
        ] {
            assert!(!allowed(refused), "{refused} must not open");
        }
    }

    #[test]
    fn only_known_https_addresses_and_the_contact_open() {
        assert!(allowed("https://github.com/kim0040/PomiTranslate/releases/latest"));
        assert!(allowed("https://www.minecraft.net/en-us/eula"));
        assert!(allowed("mailto:mini0227kim@gmail.com"));
        for refused in [
            "http://github.com/",
            "https://github.com.evil.example/",
            "https://user@github.com/",
            "https://github.com:8443/",
            "file:///etc/passwd",
            "mailto:someone@example.com",
            "javascript:alert(1)",
            "smb://server/share",
            "",
        ] {
            assert!(!allowed(refused), "{refused} must not open");
        }
    }
}
