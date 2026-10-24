//! Links and folders the page may open in the system's own apps. A web view would otherwise open a
//! link inside the app window, or not at all. Only known addresses are accepted, so a string from a
//! world, a model list or a provider response can never make the app open something else.
use std::path::PathBuf;

use tauri::{AppHandle, Manager, Runtime, Url};
use tauri_plugin_opener::OpenerExt;

use crate::error::{code, IpcError};

const HOSTS: &[&str] = &[
    "github.com",
    "www.minecraft.net",
    "minecraft.net",
    "openrouter.ai",
    "aistudio.google.com",
    "ai.google.dev",
    "platform.openai.com",
    "developers.openai.com",
    "console.anthropic.com",
    "platform.claude.com",
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
pub fn open_external<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), IpcError> {
    if !allowed(&url) {
        return Err(IpcError::new(
            code::LINK_NOT_ALLOWED,
            "This address is not opened by PomiTranslate",
        ));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|_| IpcError::new(code::LINK_OPEN_FAILED, "The link could not be opened"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLocations {
    /// Settings, recent worlds, unfinished jobs and world backups.
    pub data: String,
    /// The encrypted key vault and run reports.
    pub app: String,
}

fn locations<R: Runtime>(app: &AppHandle<R>) -> Result<(PathBuf, PathBuf), IpcError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| IpcError::new(code::INTERNAL, "Application data directory is unavailable"))?;
    let data = crate::sidecar_paths::core_data_dir(&app_data, &app.config().identifier)
        .map_err(|message| IpcError::new(code::INTERNAL, message))?;
    Ok((data, app_data))
}

#[tauri::command]
pub fn data_locations<R: Runtime>(app: AppHandle<R>) -> Result<DataLocations, IpcError> {
    let (data, app_data) = locations(&app)?;
    Ok(DataLocations {
        data: data.to_string_lossy().into_owned(),
        app: app_data.to_string_lossy().into_owned(),
    })
}

/// Show the data folder in Finder or Explorer, creating it if this is the first launch.
#[tauri::command]
pub fn reveal_data_folder<R: Runtime>(app: AppHandle<R>) -> Result<(), IpcError> {
    let (data, _) = locations(&app)?;
    let failed = |message: &str| IpcError::new(code::FOLDER_OPEN_FAILED, message.to_owned());
    std::fs::create_dir_all(&data).map_err(|_| failed("The data folder could not be created"))?;
    app.opener()
        .open_path(data.to_string_lossy(), None::<&str>)
        .map_err(|_| failed("The data folder could not be opened"))
}

/// The world folder the page names, if it really is a Java world: an existing absolute folder with
/// a `level.dat` that is not a link.
fn world_folder(world_dir: &str) -> Result<PathBuf, IpcError> {
    let failed = |message: &str| IpcError::new(code::FOLDER_OPEN_FAILED, message.to_owned());
    let supplied = PathBuf::from(world_dir);
    if !supplied.is_absolute() || !supplied.is_dir() {
        return Err(failed("Select an existing Java world folder first"));
    }
    let world = supplied
        .canonicalize()
        .map_err(|_| failed("The world folder is unavailable"))?;
    let level = world.join("level.dat");
    let is_file = level
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_file());
    if !is_file {
        return Err(failed("The selected folder must contain level.dat"));
    }
    Ok(world)
}

/// Show a world in Finder or Explorer with its `level.dat` selected. Opening the folder itself
/// would launch it on macOS when the folder is a bundle such as `Foo.app`.
#[tauri::command]
pub fn reveal_world_folder<R: Runtime>(
    app: AppHandle<R>,
    world_dir: String,
) -> Result<(), IpcError> {
    let world = world_folder(&world_dir)?;
    app.opener()
        .reveal_item_in_dir(world.join("level.dat"))
        .map_err(|_| {
            IpcError::new(
                code::FOLDER_OPEN_FAILED,
                "The world folder could not be opened",
            )
        })
}

/// A folder the core made for files a recovery would not overwrite: an existing absolute
/// folder, not a link, directly inside a folder named `quarantine`.
fn quarantine_folder(path: &str) -> Result<PathBuf, IpcError> {
    let failed = |message: &str| IpcError::new(code::FOLDER_OPEN_FAILED, message.to_owned());
    let supplied = PathBuf::from(path);
    let plain_dir = supplied
        .symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_dir());
    if !supplied.is_absolute() || !plain_dir {
        return Err(failed("The quarantine folder is unavailable"));
    }
    let folder = supplied
        .canonicalize()
        .map_err(|_| failed("The quarantine folder is unavailable"))?;
    if folder.parent().and_then(|parent| parent.file_name()) != Some("quarantine".as_ref()) {
        return Err(failed("Only a quarantine folder can be shown"));
    }
    Ok(folder)
}

/// Show the quarantine folder a recovery reported, selected in its parent.
#[tauri::command]
pub fn reveal_quarantine_folder<R: Runtime>(
    app: AppHandle<R>,
    path: String,
) -> Result<(), IpcError> {
    let folder = quarantine_folder(&path)?;
    app.opener().reveal_item_in_dir(folder).map_err(|_| {
        IpcError::new(
            code::FOLDER_OPEN_FAILED,
            "The quarantine folder could not be opened",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{allowed, quarantine_folder, world_folder};

    #[test]
    fn only_a_real_folder_inside_quarantine_is_revealed() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir
            .path()
            .join("quarantine")
            .join("20261024T000000Z-abcd1234");
        std::fs::create_dir_all(&folder).unwrap();
        assert!(quarantine_folder(folder.to_str().unwrap()).is_ok());
        assert!(
            quarantine_folder(dir.path().to_str().unwrap()).is_err(),
            "not inside quarantine"
        );
        assert!(quarantine_folder("quarantine/x").is_err(), "relative");
        let file = dir.path().join("quarantine").join("file");
        std::fs::write(&file, b"x").unwrap();
        assert!(quarantine_folder(file.to_str().unwrap()).is_err(), "a file");
        assert!(quarantine_folder(
            dir.path()
                .join("quarantine")
                .join("missing")
                .to_str()
                .unwrap()
        )
        .is_err());
    }

    #[test]
    fn only_a_folder_with_a_real_level_dat_is_revealed() {
        let dir = tempfile::tempdir().unwrap();
        let world = dir.path().join("Foo.app");
        std::fs::create_dir(&world).unwrap();
        assert!(
            world_folder(world.to_str().unwrap()).is_err(),
            "no level.dat"
        );
        std::fs::write(world.join("level.dat"), b"x").unwrap();
        assert!(world_folder(world.to_str().unwrap()).is_ok());
        assert!(world_folder("relative/world").is_err());
        assert!(world_folder(dir.path().join("missing").to_str().unwrap()).is_err());
    }

    #[test]
    fn only_known_https_addresses_and_the_contact_open() {
        assert!(allowed(
            "https://github.com/kim0040/PomiTranslate/releases/latest"
        ));
        assert!(allowed("https://www.minecraft.net/en-us/eula"));
        assert!(allowed("mailto:mini0227kim@gmail.com"));
        // The three pricing pages the cost note links, each at its exact host.
        for pricing in [
            "https://ai.google.dev/gemini-api/docs/pricing",
            "https://developers.openai.com/api/docs/pricing",
            "https://platform.claude.com/docs/en/about-claude/pricing",
        ] {
            assert!(allowed(pricing), "{pricing} must open");
        }
        for refused in [
            "http://github.com/",
            "https://github.com.evil.example/",
            "https://user@github.com/",
            "https://github.com:8443/",
            "https://developers.openai.com.evil.example/api/docs/pricing",
            "https://evil.platform.claude.com.example/",
            "https://docs.claude.com/",
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
