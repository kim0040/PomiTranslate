//! The plugin restores maximized state; this module stores normal geometry separately so fullscreen
//! resize events cannot replace the last usable size or position. Saved geometry is clamped to the
//! configured minimum and recentered when its monitor is gone or its title bar cannot be reached.
use std::{
    fs,
    path::PathBuf,
    sync::{atomic::{AtomicBool, Ordering}, Mutex},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, Window};
use tauri_plugin_window_state::{StateFlags, WindowExt};

/// The configured minimum and default size (tauri.conf.json), in logical pixels.
const MIN_LOGICAL: (f64, f64) = (840.0, 620.0);
const DEFAULT_LOGICAL: (f64, f64) = (1180.0, 800.0);
/// At least this much of the title bar area (physical pixels) must be on a screen to be grabbed.
const REACHABLE: (i64, i64) = (160, 60);
const GEOMETRY_FILE: &str = ".window-geometry.json";
static READY: AtomicBool = AtomicBool::new(false);
const WRITE_INTERVAL: Duration = Duration::from_millis(500);
static WRITES: Mutex<GeometryWrites> = Mutex::new(GeometryWrites { pending: None, scheduled: false });

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

struct GeometryWrites {
    pending: Option<Geometry>,
    scheduled: bool,
}

impl GeometryWrites {
    fn queue(&mut self, geometry: Geometry, maximized: bool, fullscreen: bool, minimized: bool) -> bool {
        if maximized || fullscreen || minimized { return false; }
        self.pending = Some(geometry);
        if self.scheduled { return false; }
        self.scheduled = true;
        true
    }
}

/// The plugin keeps the maximized flag. Normal size and position use our guarded geometry file so
/// resize/move events while fullscreen cannot overwrite the last usable window rectangle.
pub fn flags() -> StateFlags {
    StateFlags::MAXIMIZED
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

impl Rect {
    fn overlap(self, other: Rect) -> (i64, i64) {
        let w = (self.x + self.w).min(other.x + other.w) - self.x.max(other.x);
        let h = (self.y + self.h).min(other.y + other.h) - self.y.max(other.y);
        (w.max(0), h.max(0))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    Keep,
    /// Resize to `size` when given, and center on the screen the window is on when `center`.
    Apply { size: Option<(i64, i64)>, center: bool },
}

fn scaled(logical: (f64, f64), scale: f64) -> (i64, i64) {
    ((logical.0 * scale).ceil() as i64, (logical.1 * scale).ceil() as i64)
}

pub fn plan(window: Rect, scale: f64, maximized: bool, fullscreen: bool, monitors: &[Rect]) -> Plan {
    if maximized || fullscreen || monitors.is_empty() {
        return Plan::Keep;
    }
    let (min_w, min_h) = scaled(MIN_LOGICAL, scale);
    let mut size = (window.w, window.h);
    let mut resized = false;
    if size.0 < min_w || size.1 < min_h {
        size = (size.0.max(min_w), size.1.max(min_h));
        resized = true;
    }
    let placed = Rect { w: size.0, h: size.1, ..window };
    // The screen holding most of the window; none at all means it would open off-screen.
    let overlapping: Vec<(Rect, (i64, i64))> = monitors
        .iter()
        .copied()
        .map(|monitor| (monitor, monitor.overlap(placed)))
        .collect();
    let home = overlapping
        .iter()
        .copied()
        .filter(|(_, (w, h))| *w >= REACHABLE.0.min(placed.w) && *h >= REACHABLE.1.min(placed.h))
        .max_by_key(|(_, (w, h))| w * h)
        .map(|(monitor, _)| monitor);
    let Some(home) = home else {
        // A mostly off-screen window can still have a visible strip that identifies its monitor.
        // Bring it back without changing its saved size. Only a fully off-screen window needs the
        // default size before it is centered.
        if let Some((monitor, _)) = overlapping
            .into_iter()
            .filter(|(_, (w, h))| *w > 0 && *h > 0)
            .max_by_key(|(_, (w, h))| w * h)
        {
            let fitted = (size.0.min(monitor.w), size.1.min(monitor.h));
            let fitted_size = (fitted != size).then_some(fitted).or_else(|| resized.then_some(size));
            return Plan::Apply { size: fitted_size, center: true };
        }
        let monitor = monitors[0];
        let fitted = fit(scaled(DEFAULT_LOGICAL, scale).max(size), monitor);
        return Plan::Apply { size: Some(fitted), center: true };
    };
    // A window as large as its screen that is not maximized is a full-screen leftover.
    if placed.w >= home.w && placed.h >= home.h {
        return Plan::Apply { size: Some(fit(scaled(DEFAULT_LOGICAL, scale), home)), center: true };
    }
    let fitted = fit(size, home);
    if fitted != size {
        return Plan::Apply { size: Some(fitted), center: true };
    }
    // The title bar must stay on the screen, or the window cannot be dragged back.
    if placed.y < home.y || placed.y > home.y + home.h - REACHABLE.1 {
        return Plan::Apply { size: resized.then_some(size), center: true };
    }
    if resized {
        Plan::Apply { size: Some(size), center: false }
    } else {
        Plan::Keep
    }
}

/// Keep a size inside a screen while staying above the minimum where the screen allows.
fn fit(size: (i64, i64), monitor: Rect) -> (i64, i64) {
    (size.0.min(monitor.w), size.1.min(monitor.h))
}

fn geometry_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|directory| directory.join(GEOMETRY_FILE))
}

fn load_geometry<R: Runtime>(app: &AppHandle<R>) -> Option<Geometry> {
    let bytes = fs::read(geometry_path(app)?).ok()?;
    let geometry: Geometry = serde_json::from_slice(&bytes).ok()?;
    (geometry.width > 0 && geometry.height > 0).then_some(geometry)
}

fn write_geometry<R: Runtime>(app: &AppHandle<R>, geometry: Geometry) {
    let Some(path) = geometry_path(app) else { return; };
    let Some(parent) = path.parent() else { return; };
    if fs::create_dir_all(parent).is_err() { return; }
    let Ok(bytes) = serde_json::to_vec(&geometry) else { return; };
    let temporary = path.with_extension("json.tmp");
    if fs::write(&temporary, bytes).is_ok() {
        let _ = fs::rename(temporary, path);
    }
}

/// Record regular window geometry only. Fullscreen and maximized rectangles never replace it.
pub fn save_normal_geometry<R: Runtime>(window: &Window<R>) {
    if !READY.load(Ordering::SeqCst)
        || window.label() != "main"
        || window.is_fullscreen().unwrap_or(true)
        || window.is_maximized().unwrap_or(true)
        || window.is_minimized().unwrap_or(true)
    {
        return;
    }
    let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    if size.width == 0 || size.height == 0 { return; }
    let Ok(mut writes) = WRITES.lock() else { return; };
    let schedule = writes.queue(Geometry {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        }, false, false, false);
    drop(writes);
    if schedule {
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(WRITE_INTERVAL).await;
            // Serialize background and close-time writes so an older snapshot cannot win.
            if let Ok(mut writes) = WRITES.lock() {
                if let Some(geometry) = writes.pending.take() { write_geometry(&app, geometry); }
                writes.scheduled = false;
            }
        });
    }
}

pub fn flush_pending_geometry<R: Runtime>(app: &AppHandle<R>) {
    if let Ok(mut writes) = WRITES.lock() {
        if let Some(geometry) = writes.pending.take() { write_geometry(app, geometry); }
    }
}

/// Closing while maximized/fullscreen still flushes the last queued normal rectangle.
pub fn flush_normal_geometry<R: Runtime>(window: &Window<R>) {
    save_normal_geometry(window);
    flush_pending_geometry(window.app_handle());
}

/// Restore normal geometry first; the plugin applies its saved maximized flag afterwards.
pub fn guard<R: Runtime>(app: &AppHandle<R>) {
    if READY.load(Ordering::SeqCst) { return; }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let (Ok(size), Ok(position), Ok(scale)) =
        (window.inner_size(), window.outer_position(), window.scale_factor())
    else {
        return;
    };
    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    let monitors: Vec<Rect> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| Rect {
            x: i64::from(monitor.position().x),
            y: i64::from(monitor.position().y),
            w: i64::from(monitor.size().width),
            h: i64::from(monitor.size().height),
        })
        .collect();
    if monitors.is_empty() || fullscreen {
        let _ = window.restore_state(flags());
        return;
    }
    let saved = load_geometry(app);
    let current = if let Some(saved) = saved {
        Rect {
            x: i64::from(saved.x),
            y: i64::from(saved.y),
            w: i64::from(saved.width),
            h: i64::from(saved.height),
        }
    } else {
        Rect {
            x: i64::from(position.x),
            y: i64::from(position.y),
            w: i64::from(size.width),
            h: i64::from(size.height),
        }
    };
    // `current` is the normal rectangle, even when the saved display mode is maximized.
    if maximized { let _ = window.unmaximize(); }
    let action = plan(current, scale, false, false, &monitors);
    let (planned_size, center) = match action {
        Plan::Keep => (None, false),
        Plan::Apply { size, center } => (size, center),
    };
    if let Some((w, h)) = planned_size {
        let _ = window.set_size(PhysicalSize::new(w as u32, h as u32));
    } else if saved.is_some() {
        let _ = window.set_size(PhysicalSize::new(current.w as u32, current.h as u32));
    }
    if center {
        let _ = window.center();
    } else if let Some(saved) = saved {
        let _ = window.set_position(PhysicalPosition::new(saved.x, saved.y));
    }
    if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
        write_geometry(
            app,
            Geometry {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            },
        );
    }
    let _ = window.restore_state(flags());
}

/// Enable persistence after initial restore and the geometry guard have completed.
pub fn mark_ready() {
    READY.store(true, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect { x: 0, y: 0, w: 2560, h: 1440 };
    const SECOND: Rect = Rect { x: 2560, y: 0, w: 1920, h: 1080 };

    fn win(x: i64, y: i64, w: i64, h: i64) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn a_normal_saved_window_is_left_alone() {
        assert_eq!(plan(win(200, 100, 1180, 800), 1.0, false, false, &[SCREEN]), Plan::Keep);
    }

    #[test]
    fn maximized_relaunch_plans_the_saved_normal_rectangle_before_maximizing() {
        let normal = win(2700, 100, 1180, 800);
        assert_eq!(plan(normal, 1.0, false, false, &[SCREEN, SECOND]), Plan::Keep);
        // The startup guard supplies the normal rectangle, not the maximized display rectangle.
        assert_eq!(plan(normal, 1.0, false, false, &[SCREEN]),
            Plan::Apply { size: Some((1180, 800)), center: true });
        assert_eq!(plan(win(200, 100, 1180, 800), 2.0, false, false, &[SCREEN]),
            Plan::Apply { size: Some((1680, 1240)), center: false });
        assert_eq!(plan(win(200, 100, 1680, 1240), 1.0, false, false, &[SCREEN]), Plan::Keep);
    }

    #[test]
    fn writes_coalesce_and_mode_changes_never_replace_the_normal_rectangle() {
        let mut writes = GeometryWrites { pending: None, scheduled: false };
        let first = Geometry { x: 100, y: 80, width: 1000, height: 700 };
        let last = Geometry { x: 200, y: 100, width: 1180, height: 800 };
        assert!(writes.queue(first, false, false, false));
        assert!(!writes.queue(last, false, false, false));
        let maximized = Geometry { x: 0, y: 0, width: 2560, height: 1440 };
        for (max, full, min) in [(true, false, false), (false, true, false), (false, false, true)] {
            assert!(!writes.queue(maximized, max, full, min));
            assert_eq!(writes.pending, Some(last));
        }
        // Close while maximized flushes normal geometry; relaunch/unmaximize uses that rectangle.
        let saved = writes.pending.take().unwrap();
        assert_eq!(saved, last);
        assert_eq!(plan(win(saved.x.into(), saved.y.into(), saved.width.into(), saved.height.into()),
            1.0, false, false, &[SCREEN]), Plan::Keep);
        assert_eq!(WRITE_INTERVAL, Duration::from_millis(500));
    }

    #[test]
    fn a_window_smaller_than_the_minimum_is_grown_not_moved() {
        assert_eq!(
            plan(win(200, 100, 500, 400), 1.0, false, false, &[SCREEN]),
            Plan::Apply { size: Some((840, 620)), center: false }
        );
        // The minimum is in logical pixels, so a 2x display needs twice the physical size.
        assert_eq!(
            plan(win(200, 100, 1000, 800), 2.0, false, false, &[SCREEN]),
            Plan::Apply { size: Some((1680, 1240)), center: false }
        );
    }

    #[test]
    fn a_window_that_would_open_off_screen_is_brought_back_centered() {
        let plan = plan(win(9000, 100, 1180, 800), 1.0, false, false, &[SCREEN, SECOND]);
        assert_eq!(plan, Plan::Apply { size: Some((1180, 800)), center: true });
    }

    #[test]
    fn a_window_with_only_a_sliver_on_screen_is_centered() {
        let plan = plan(win(-1100, 100, 1180, 800), 1.0, false, false, &[SCREEN]);
        assert_eq!(plan, Plan::Apply { size: None, center: true });
    }

    #[test]
    fn a_title_bar_above_or_below_the_screen_is_centered() {
        assert_eq!(
            plan(win(100, -300, 1180, 800), 1.0, false, false, &[SCREEN]),
            Plan::Apply { size: None, center: true }
        );
        assert_eq!(
            plan(win(100, 1420, 1180, 800), 1.0, false, false, &[SCREEN]),
            Plan::Apply { size: None, center: true }
        );
    }

    #[test]
    fn a_window_on_a_second_screen_stays_there() {
        assert_eq!(plan(win(2700, 100, 1180, 800), 1.0, false, false, &[SCREEN, SECOND]), Plan::Keep);
    }

    #[test]
    fn a_full_screen_sized_leftover_returns_to_the_default_size() {
        assert_eq!(
            plan(win(0, 0, 2560, 1440), 1.0, false, false, &[SCREEN]),
            Plan::Apply { size: Some((1180, 800)), center: true }
        );
    }

    #[test]
    fn maximized_full_screen_and_unknown_screens_are_never_touched() {
        assert_eq!(plan(win(0, 0, 2560, 1440), 1.0, true, false, &[SCREEN]), Plan::Keep);
        assert_eq!(plan(win(0, 0, 2560, 1440), 1.0, false, true, &[SCREEN]), Plan::Keep);
        assert_eq!(plan(win(9000, 0, 100, 100), 1.0, false, false, &[]), Plan::Keep);
    }

    #[test]
    fn a_default_size_never_exceeds_a_small_screen() {
        let small = Rect { x: 0, y: 0, w: 1024, h: 700 };
        assert_eq!(
            plan(win(9000, 0, 1180, 800), 1.0, false, false, &[small]),
            Plan::Apply { size: Some((1024, 700)), center: true }
        );
    }

    #[test]
    fn plugin_persists_only_maximized_state() {
        let flags = flags();
        assert!(flags.contains(StateFlags::MAXIMIZED));
        assert!(!flags.intersects(StateFlags::SIZE | StateFlags::POSITION | StateFlags::FULLSCREEN | StateFlags::VISIBLE | StateFlags::DECORATIONS));
    }
}
