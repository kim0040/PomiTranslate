//! Where the main window opens: the size, position and maximized state of the last session
//! (`tauri-plugin-window-state`), kept on a monitor that is still connected.
//!
//! The plugin restores a saved position only when the saved rectangle still meets a monitor, but it
//! restores the saved size as it is. A window saved on a large monitor and reopened on a laptop
//! screen would be bigger than the screen and partly out of reach. `clamp` runs right after the
//! restore and brings the rectangle back into the visible work area of the monitor it mostly sits on.
use tauri::{plugin::TauriPlugin, PhysicalPosition, PhysicalSize, Wry};
use tauri_plugin_window_state::StateFlags;

/// Size, position and maximized state. The visible flag is the app's own business: the window is
/// shown by the page when it is ready, not by the plugin.
const RESTORED: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

/// A window must keep at least this much of itself on a monitor to count as reachable.
const MIN_VISIBLE: (i32, i32) = (160, 64);

/// A rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn right(&self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    fn bottom(&self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    /// Width and height of the overlap with `other` (zero when they do not meet).
    fn overlap(&self, other: &Rect) -> (i64, i64) {
        let width = self.right().min(other.right()) - i64::from(self.x).max(i64::from(other.x));
        let height = self.bottom().min(other.bottom()) - i64::from(self.y).max(i64::from(other.y));
        (width.max(0), height.max(0))
    }

    fn overlap_area(&self, other: &Rect) -> i64 {
        let (width, height) = self.overlap(other);
        width * height
    }
}

/// The rectangle the window should have, or `None` when it is already fine. `areas` are the usable
/// areas (work areas) of the connected monitors; the window is moved onto the one it overlaps most
/// (the first when it overlaps none), shrunk to fit it, and kept inside it.
pub fn clamp(window: Rect, areas: &[Rect]) -> Option<Rect> {
    let target = areas
        .iter()
        .max_by_key(|area| window.overlap_area(area))
        .copied()?;
    let width = window.width.min(target.width);
    let height = window.height.min(target.height);
    let (overlap_width, overlap_height) = window.overlap(&target);
    let reachable = overlap_width >= i64::from(MIN_VISIBLE.0).min(i64::from(width))
        && overlap_height >= i64::from(MIN_VISIBLE.1).min(i64::from(height));
    let (x, y) = if reachable {
        // Keep it where it is, but not hanging over an edge of the monitor.
        (
            window.x.clamp(
                target.x,
                target.x.saturating_add((target.width - width) as i32),
            ),
            window.y.clamp(
                target.y,
                target.y.saturating_add((target.height - height) as i32),
            ),
        )
    } else {
        // Out of reach (a disconnected monitor, a changed layout): centre it on the monitor.
        (
            target.x.saturating_add(((target.width - width) / 2) as i32),
            target
                .y
                .saturating_add(((target.height - height) / 2) as i32),
        )
    };
    let fitted = Rect {
        x,
        y,
        width,
        height,
    };
    (fitted != window).then_some(fitted)
}

/// The plugin that saves and restores the window's size, position and maximized state.
pub fn state_plugin() -> TauriPlugin<Wry> {
    tauri_plugin_window_state::Builder::default()
        .with_state_flags(RESTORED)
        .build()
}

/// Runs after [`state_plugin`] has restored the window: keeps it on a connected monitor.
pub fn clamp_plugin() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::new("window-geometry")
        .on_window_ready(|window| {
            if window.is_maximized().unwrap_or(false) {
                return;
            }
            let (Ok(position), Ok(size), Ok(monitors)) = (
                window.outer_position(),
                window.outer_size(),
                window.available_monitors(),
            ) else {
                return;
            };
            let areas: Vec<Rect> = monitors
                .iter()
                .map(|monitor| {
                    let area = monitor.work_area();
                    Rect {
                        x: area.position.x,
                        y: area.position.y,
                        width: area.size.width,
                        height: area.size.height,
                    }
                })
                .collect();
            let current = Rect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            };
            if let Some(fitted) = clamp(current, &areas) {
                let _ = window.set_size(PhysicalSize::new(fitted.width, fitted.height));
                let _ = window.set_position(PhysicalPosition::new(fitted.x, fitted.y));
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: Rect = Rect {
        x: 0,
        y: 0,
        width: 1536,
        height: 816,
    };
    const BIG_RIGHT: Rect = Rect {
        x: 1536,
        y: 0,
        width: 2560,
        height: 1400,
    };

    fn window(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn a_window_inside_a_monitor_is_left_alone() {
        assert_eq!(clamp(window(100, 50, 1180, 700), &[LAPTOP]), None);
        assert_eq!(
            clamp(window(1600, 100, 1180, 800), &[LAPTOP, BIG_RIGHT]),
            None
        );
    }

    #[test]
    fn a_window_bigger_than_the_monitor_is_shrunk_to_it() {
        // Saved on a large monitor, reopened on the laptop screen alone.
        let fitted = clamp(window(40, 30, 2200, 1300), &[LAPTOP]).unwrap();
        assert_eq!(fitted, LAPTOP);
    }

    #[test]
    fn a_window_that_lost_its_monitor_is_centred_on_one_that_exists() {
        // It was on the second monitor, which is gone now.
        let fitted = clamp(window(2000, 200, 1180, 700), &[LAPTOP]).unwrap();
        assert_eq!(fitted, window(178, 58, 1180, 700));
    }

    #[test]
    fn a_window_hanging_over_an_edge_is_pulled_back_in() {
        let fitted = clamp(window(900, 400, 1180, 700), &[LAPTOP]).unwrap();
        assert_eq!(fitted, window(356, 116, 1180, 700));
        let fitted = clamp(window(-300, -40, 1180, 700), &[LAPTOP]).unwrap();
        assert_eq!(fitted, window(0, 0, 1180, 700));
    }

    #[test]
    fn the_monitor_with_the_larger_overlap_wins() {
        // Mostly on the big monitor, partly over the border.
        let fitted = clamp(window(1400, 100, 1180, 700), &[LAPTOP, BIG_RIGHT]).unwrap();
        assert_eq!(fitted, window(1536, 100, 1180, 700));
    }

    #[test]
    fn a_sliver_on_a_monitor_is_not_reachable() {
        // Only 20 px of the window are visible: it is moved back, not left there.
        let fitted = clamp(window(1516, 100, 1180, 700), &[LAPTOP]).unwrap();
        assert_eq!(fitted, window(178, 58, 1180, 700));
        assert_eq!(clamp(window(0, 0, 100, 100), &[]), None);
    }
}
