//! The window comes back where and how large it was (tauri-plugin-window-state does the saving and
//! the first restore). This adds the guard rails the plugin lacks: a saved size is never smaller
//! than the window's minimum, a window that would open off-screen is brought back, and a size that
//! was only the full screen (the window closed while in full screen) is not kept as a normal size.
use tauri::{App, Manager, PhysicalSize};
use tauri_plugin_window_state::StateFlags;

/// The configured minimum and default size (tauri.conf.json), in logical pixels.
const MIN_LOGICAL: (f64, f64) = (840.0, 620.0);
const DEFAULT_LOGICAL: (f64, f64) = (1180.0, 800.0);
/// At least this much of the title bar area (physical pixels) must be on a screen to be grabbed.
const REACHABLE: (i64, i64) = (160, 60);

/// What is saved: size, position and maximized. Full screen is never restored or recorded, and
/// "visible"/"decorations" stay as the configuration says.
pub fn flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
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
    let home = monitors
        .iter()
        .copied()
        .map(|monitor| (monitor, monitor.overlap(placed)))
        .filter(|(_, (w, h))| *w >= REACHABLE.0.min(placed.w) && *h >= REACHABLE.1.min(placed.h))
        .max_by_key(|(_, (w, h))| w * h)
        .map(|(monitor, _)| monitor);
    let Some(home) = home else {
        let monitor = monitors[0];
        let fitted = fit(scaled(DEFAULT_LOGICAL, scale).max(size), monitor);
        return Plan::Apply { size: Some(fitted), center: true };
    };
    // A window as large as its screen that is not maximized is a full-screen leftover.
    if placed.w >= home.w && placed.h >= home.h {
        return Plan::Apply { size: Some(fit(scaled(DEFAULT_LOGICAL, scale), home)), center: true };
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

/// Run after the window exists and the plugin restored its saved state.
pub fn guard(app: &App) {
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
    let current = Rect {
        x: i64::from(position.x),
        y: i64::from(position.y),
        w: i64::from(size.width),
        h: i64::from(size.height),
    };
    if let Plan::Apply { size, center } = plan(current, scale, maximized, fullscreen, &monitors) {
        if let Some((w, h)) = size {
            let _ = window.set_size(PhysicalSize::new(w as u32, h as u32));
        }
        if center {
            let _ = window.center();
        }
    }
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
        assert_eq!(plan, Plan::Apply { size: Some((1180, 800)), center: true });
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
    fn only_size_position_and_maximized_are_saved() {
        let flags = flags();
        assert!(flags.contains(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED));
        assert!(!flags.intersects(StateFlags::FULLSCREEN | StateFlags::VISIBLE | StateFlags::DECORATIONS));
    }
}
