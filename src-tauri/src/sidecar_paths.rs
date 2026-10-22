use std::{
    ffi::OsString,
    path::{Path, PathBuf},
};

const PRODUCTION_IDENTIFIER: &str = "app.pomitranslate.desktop";

/// The folder of the translation core inside the bundle's resources (`bundle.resources` in
/// `tauri.conf.json` maps the PyInstaller onedir output to it) and inside `build/sidecar/dist/`.
pub const SIDECAR_DIR: &str = "pomi-sidecar";

/// Keep the existing CLI/desktop public data in place. Alternate app identifiers
/// (including evaluation builds) must never fall back to that production data.
pub fn core_data_dir(app_data: &Path, identifier: &str) -> Result<PathBuf, String> {
    if identifier == PRODUCTION_IDENTIFIER {
        app_data
            .parent()
            .map(|parent| parent.join("PomiTranslate"))
            .ok_or_else(|| "Application data directory has no parent".into())
    } else {
        Ok(app_data.join("core"))
    }
}

pub fn arguments(data_dir: &Path, report_dir: &Path, cancel_path: &Path) -> Vec<String> {
    vec![
        "--jsonl".into(),
        "--data-dir".into(),
        data_dir.to_string_lossy().into_owned(),
        "--report-dir".into(),
        report_dir.to_string_lossy().into_owned(),
        "--cancel-file".into(),
        cancel_path.to_string_lossy().into_owned(),
    ]
}

pub fn executable_name() -> &'static str {
    if cfg!(windows) {
        "pomi-sidecar.exe"
    } else {
        "pomi-sidecar"
    }
}

/// `<resources>/pomi-sidecar/pomi-sidecar[.exe]`, where the installer puts the onedir folder.
pub fn bundled_executable(resource_dir: &Path) -> PathBuf {
    resource_dir.join(SIDECAR_DIR).join(executable_name())
}

/// `<project>/build/sidecar/dist/pomi-sidecar/pomi-sidecar[.exe]`, where `pnpm sidecar:build` puts it.
pub fn built_executable(project_root: &Path) -> PathBuf {
    project_root
        .join("build")
        .join("sidecar")
        .join("dist")
        .join(SIDECAR_DIR)
        .join(executable_name())
}

/// How the core is started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreCommand {
    /// The packaged (or locally built) onedir executable.
    Executable(PathBuf),
    /// Development only (`POMI_SIDECAR_DEV=python`): the entry script under a Python interpreter.
    Script {
        python: PathBuf,
        script: PathBuf,
        project_root: PathBuf,
    },
}

impl CoreCommand {
    /// The program, its leading arguments and the extra environment this command needs.
    pub fn program_and_args(&self) -> (PathBuf, Vec<OsString>, Vec<(OsString, OsString)>) {
        match self {
            Self::Executable(path) => (path.clone(), vec![], vec![]),
            Self::Script {
                python,
                script,
                project_root,
            } => (
                python.clone(),
                // -u: protocol lines are not held back by Python's pipe buffering.
                vec![
                    "-X".into(),
                    "utf8".into(),
                    "-u".into(),
                    script.clone().into_os_string(),
                ],
                // The entry script lives in packaging/; the modules it imports sit at the root.
                vec![("PYTHONPATH".into(), project_root.clone().into_os_string())],
            ),
        }
    }
}

/// Development lookups. Release builds pass `None`: an environment variable never changes which
/// program an installed app starts.
#[derive(Debug, Clone)]
pub struct DevOptions {
    pub project_root: PathBuf,
    /// `POMI_SIDECAR_DEV=python`.
    pub use_python_script: bool,
    /// `POMI_PYTHON`, else `python` (`python3` outside Windows).
    pub python: PathBuf,
}

/// The development options of a debug build, `None` in a release build.
pub fn dev_options() -> Option<DevOptions> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let project_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .to_path_buf();
    Some(DevOptions {
        project_root,
        use_python_script: std::env::var("POMI_SIDECAR_DEV").is_ok_and(|value| value == "python"),
        python: std::env::var_os("POMI_PYTHON")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "python" } else { "python3" })),
    })
}

fn launchable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|meta| meta.is_file() && is_executable(&meta))
}

#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_: &std::fs::Metadata) -> bool {
    true
}

/// Find the core. Development (debug builds): the Python script when asked for, else the locally
/// built onedir folder. Otherwise, and as the development fallback, the bundled resource folder.
/// The error names every place that was looked at, for the log.
pub fn resolve(
    resource_dir: Option<&Path>,
    dev: Option<&DevOptions>,
) -> Result<CoreCommand, String> {
    let mut tried: Vec<String> = Vec::new();
    if let Some(dev) = dev {
        if dev.use_python_script {
            let script = dev.project_root.join("packaging").join("pomi_desktop.py");
            if script.is_file() {
                return Ok(CoreCommand::Script {
                    python: dev.python.clone(),
                    script,
                    project_root: dev.project_root.clone(),
                });
            }
            tried.push(format!("{} (POMI_SIDECAR_DEV=python)", script.display()));
        }
        let built = built_executable(&dev.project_root);
        if launchable(&built) {
            return Ok(CoreCommand::Executable(built));
        }
        tried.push(built.display().to_string());
    }
    if let Some(dir) = resource_dir {
        let bundled = bundled_executable(dir);
        if launchable(&bundled) {
            return Ok(CoreCommand::Executable(bundled));
        }
        tried.push(bundled.display().to_string());
    }
    Err(if tried.is_empty() {
        "no place to look for the translation core".to_owned()
    } else {
        format!(
            "translation core not found or not executable; looked at: {}",
            tried.join(" | ")
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn production_preserves_existing_public_data_without_moving_credentials() {
        let root = Path::new("user-data").join(PRODUCTION_IDENTIFIER);
        assert_eq!(
            core_data_dir(&root, PRODUCTION_IDENTIFIER).unwrap(),
            Path::new("user-data/PomiTranslate")
        );
    }

    #[test]
    fn alternate_identifiers_are_isolated_and_pass_an_explicit_core_root() {
        let root = Path::new("test data").join("app.pomitranslate.eval");
        let core = core_data_dir(&root, "app.pomitranslate.eval").unwrap();
        assert_eq!(core, root.join("core"));
        let args = arguments(&core, &root.join("reports"), &root.join("cancel"));
        assert_eq!(
            &args[1..3],
            &["--data-dir".to_owned(), core.to_string_lossy().into_owned()]
        );
        assert!(!args.iter().any(|arg| arg.ends_with("/PomiTranslate")));
    }

    fn fake_core(dir: &Path) -> PathBuf {
        let exe = dir.join(executable_name());
        fs::create_dir_all(dir).unwrap();
        fs::write(&exe, b"not really a program").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        }
        exe
    }

    #[test]
    fn the_bundled_core_is_found_under_a_unicode_install_path_with_spaces() {
        let temp = tempfile::tempdir().unwrap();
        let install = temp
            .path()
            .join("프로그램 파일")
            .join("Pomi Translate 설치 폴더");
        let exe = fake_core(&install.join(SIDECAR_DIR));
        assert_eq!(bundled_executable(&install), exe);
        assert_eq!(
            resolve(Some(&install), None).unwrap(),
            CoreCommand::Executable(exe)
        );
    }

    #[test]
    fn a_missing_core_reports_where_it_looked() {
        let temp = tempfile::tempdir().unwrap();
        let error = resolve(Some(temp.path()), None).unwrap_err();
        assert!(error.contains(SIDECAR_DIR), "{error}");
        assert!(resolve(None, None).is_err());
        // A directory with the right name is not a core.
        fs::create_dir_all(bundled_executable(temp.path())).unwrap();
        assert!(resolve(Some(temp.path()), None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_core_without_the_executable_bit_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let exe = fake_core(&temp.path().join(SIDECAR_DIR));
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(resolve(Some(temp.path()), None).is_err());
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(resolve(Some(temp.path()), None).is_ok());
    }

    #[test]
    fn development_prefers_the_local_build_then_falls_back_to_the_bundle() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("저장소 root");
        let install = temp.path().join("install");
        let bundled = fake_core(&install.join(SIDECAR_DIR));
        let dev = DevOptions {
            project_root: project.clone(),
            use_python_script: false,
            python: "python".into(),
        };
        // No local build yet: the bundled copy is used.
        assert_eq!(
            resolve(Some(&install), Some(&dev)).unwrap(),
            CoreCommand::Executable(bundled)
        );
        let built = fake_core(
            &project
                .join("build")
                .join("sidecar")
                .join("dist")
                .join(SIDECAR_DIR),
        );
        assert_eq!(built, built_executable(&project));
        assert_eq!(
            resolve(Some(&install), Some(&dev)).unwrap(),
            CoreCommand::Executable(built)
        );
    }

    #[test]
    fn the_python_script_is_used_only_when_development_asks_for_it() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("repo");
        fs::create_dir_all(project.join("packaging")).unwrap();
        fs::write(project.join("packaging").join("pomi_desktop.py"), "").unwrap();
        let mut dev = DevOptions {
            project_root: project.clone(),
            use_python_script: true,
            python: "py".into(),
        };
        let command = resolve(None, Some(&dev)).unwrap();
        let (program, args, env) = command.program_and_args();
        assert_eq!(program, PathBuf::from("py"));
        assert_eq!(
            args.last().unwrap(),
            project
                .join("packaging")
                .join("pomi_desktop.py")
                .as_os_str()
        );
        assert!(args.iter().any(|arg| arg == "-u"));
        assert_eq!(
            env,
            [(
                OsString::from("PYTHONPATH"),
                project.clone().into_os_string()
            )]
        );
        dev.use_python_script = false;
        assert!(resolve(None, Some(&dev)).is_err());
    }

    #[test]
    fn a_release_build_has_no_development_lookup() {
        // Whatever the environment says, release builds hand `None` to `resolve`.
        if !cfg!(debug_assertions) {
            assert!(dev_options().is_none());
        }
    }
}
