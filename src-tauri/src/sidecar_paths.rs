use std::path::{Path, PathBuf};

const PRODUCTION_IDENTIFIER: &str = "app.pomitranslate.desktop";

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
        // The core watches this process: if the app goes away mid-job, the core cancels at its
        // next safe point instead of running on unattended.
        "--parent-pid".into(),
        std::process::id().to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let parent = args.iter().position(|arg| arg == "--parent-pid").unwrap();
        assert_eq!(args[parent + 1], std::process::id().to_string());
    }
}
