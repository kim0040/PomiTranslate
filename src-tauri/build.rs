use std::{
    path::Path,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

/// `git <args>` output, trimmed; `None` when git or the repository is not available (a source
/// archive build has no history).
fn git(args: &[&str]) -> Option<String> {
    let output = Command::new("git").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

/// UTC calendar date of a Unix timestamp (days-from-civil, no date dependency for a build stamp).
fn civil_date(seconds: u64) -> String {
    let z = (seconds / 86_400) as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

fn emit_build_metadata() {
    println!("cargo:rerun-if-env-changed=POMI_BUILD_SHA");
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    for path in ["HEAD", "index"] {
        if let Some(found) = git(&["rev-parse", "--git-path", path]) {
            println!("cargo:rerun-if-changed={found}");
        }
    }

    let sha = std::env::var("POMI_BUILD_SHA")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| git(&["rev-parse", "--short=12", "HEAD"]))
        .unwrap_or_else(|| "unknown".into());
    // A tree with uncommitted changes is marked, so a diagnostics bundle never claims a clean commit.
    let dirty = std::env::var("POMI_BUILD_SHA").is_err()
        && git(&["status", "--porcelain", "--untracked-files=no"]).is_some();
    let sha = if dirty { format!("{sha}+dirty") } else { sha };

    let seconds = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .or_else(|| {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()
                .map(|elapsed| elapsed.as_secs())
        })
        .unwrap_or(0);
    println!("cargo:rustc-env=POMI_BUILD_SHA={sha}");
    println!("cargo:rustc-env=POMI_BUILD_DATE={}", civil_date(seconds));
}

/// A release build is what `tauri build` bundles. Without the real onedir sidecar the installer
/// would start but never translate, so that is refused here instead of discovered by the user.
fn require_sidecar_for_release() {
    println!("cargo:rerun-if-env-changed=POMI_ALLOW_MISSING_SIDECAR");
    if std::env::var("PROFILE").as_deref() != Ok("release")
        || std::env::var("POMI_ALLOW_MISSING_SIDECAR").is_ok()
    {
        return;
    }
    let exe = if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        "pomi-sidecar.exe"
    } else {
        "pomi-sidecar"
    };
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let path = Path::new(&manifest)
        .join("..")
        .join("build")
        .join("sidecar")
        .join("dist")
        .join("pomi-sidecar")
        .join(exe);
    println!("cargo:rerun-if-changed={}", path.display());
    assert!(
        path.is_file(),
        "the translation core is not built ({} is missing); run `pnpm sidecar:build:clean` first, or set POMI_ALLOW_MISSING_SIDECAR=1 for a build that is not shipped",
        path.display()
    );
}

fn main() {
    emit_build_metadata();
    require_sidecar_for_release();
    tauri_build::build()
}
