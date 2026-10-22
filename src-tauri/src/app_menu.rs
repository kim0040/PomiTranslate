//! The native menu bar, built explicitly from a layout instead of `Menu::default()`.
//!
//! Why not the default: on Windows it contains a predefined Quit item that posts `WM_QUIT` and so
//! skips both `CloseRequested` and `ExitRequested`; File → Quit then ended the app in the middle of a
//! write (EX-1). Here Windows and Linux get their own Quit item that goes through `exit_gate`, and macOS
//! keeps the application menu's Cmd+Q, which does reach `ExitRequested`.
//!
//! Every label, including the predefined Edit/Window/App items, comes from the page's catalog and the
//! whole menu is rebuilt when the interface language changes (NX-2). A choice of an app command is
//! forwarded to the window as `pomi-menu`; the page decides whether it applies to the current screen.
use std::sync::{
    atomic::{AtomicU16, Ordering},
    Mutex,
};

use serde::Deserialize;
use tauri::{
    menu::{
        AboutMetadata, CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu,
    },
    AppHandle, Emitter, Manager, State, Wry,
};

use crate::error::{code, IpcError};

pub const OPEN_WORLD: &str = "pomi-open-world";
pub const SETTINGS: &str = "pomi-settings";
pub const FIND: &str = "pomi-find";
pub const HELP: &str = "pomi-help";
pub const TOUR: &str = "pomi-tour";
pub const SHORTCUTS: &str = "pomi-shortcuts";
pub const LICENSES: &str = "pomi-licenses";
pub const REPORT: &str = "pomi-report";
pub const UPDATES: &str = "pomi-updates";
pub const THEME_SYSTEM: &str = "pomi-theme-system";
pub const THEME_LIGHT: &str = "pomi-theme-light";
pub const THEME_DARK: &str = "pomi-theme-dark";
pub const QUIT: &str = "pomi-quit";
const ZOOM_PREFIX: &str = "pomi-zoom-";
const ZOOM_LEVELS: [u16; 6] = [75, 100, 125, 150, 175, 200];
const THEMES: [(&str, &str); 3] = [
    ("system", THEME_SYSTEM),
    ("light", THEME_LIGHT),
    ("dark", THEME_DARK),
];

// --- layout (pure data, tested) ---------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Platform {
    Mac,
    Other,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Other
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Maximize,
    CloseWindow,
    Quit,
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Fullscreen,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Title {
    App,
    File,
    Edit,
    View,
    Window,
    Help,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Entry {
    /// One of this app's own commands, by id.
    Item(&'static str),
    Predefined(Kind),
    Separator,
    Appearance,
    Zoom,
}

pub fn layout(platform: Platform) -> Vec<(Title, Vec<Entry>)> {
    use Entry::{Appearance, Item, Predefined as P, Separator as S, Zoom};
    let edit = vec![
        P(Kind::Undo),
        P(Kind::Redo),
        S,
        P(Kind::Cut),
        P(Kind::Copy),
        P(Kind::Paste),
        P(Kind::SelectAll),
        S,
        Item(FIND),
    ];
    match platform {
        Platform::Mac => vec![
            (
                Title::App,
                vec![
                    P(Kind::About),
                    S,
                    Item(UPDATES),
                    S,
                    Item(SETTINGS),
                    S,
                    P(Kind::Services),
                    S,
                    P(Kind::Hide),
                    P(Kind::HideOthers),
                    P(Kind::ShowAll),
                    S,
                    P(Kind::Quit),
                ],
            ),
            (Title::File, vec![Item(OPEN_WORLD), S, P(Kind::CloseWindow)]),
            (Title::Edit, edit),
            (
                Title::View,
                vec![Appearance, S, Zoom, S, P(Kind::Fullscreen)],
            ),
            (
                Title::Window,
                vec![P(Kind::Minimize), P(Kind::Maximize), S, P(Kind::CloseWindow)],
            ),
            (
                Title::Help,
                vec![Item(HELP), Item(TOUR), Item(SHORTCUTS), S, Item(LICENSES), Item(REPORT)],
            ),
        ],
        Platform::Other => vec![
            (
                Title::File,
                vec![
                    Item(OPEN_WORLD),
                    S,
                    Item(SETTINGS),
                    S,
                    P(Kind::CloseWindow),
                    // Deliberately not `Predefined(Quit)`: that one bypasses the job gate.
                    Item(QUIT),
                ],
            ),
            (Title::Edit, edit),
            (Title::View, vec![Appearance, S, Zoom]),
            (Title::Window, vec![P(Kind::Minimize), P(Kind::Maximize)]),
            (
                Title::Help,
                vec![
                    Item(HELP),
                    Item(TOUR),
                    Item(SHORTCUTS),
                    S,
                    Item(UPDATES),
                    Item(LICENSES),
                    Item(REPORT),
                    S,
                    P(Kind::About),
                ],
            ),
        ],
    }
}

// --- labels -----------------------------------------------------------------------------------

/// Menu texts from the page's catalog. A missing or blank one keeps its English default.
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct MenuLabels {
    pub open_world: String,
    pub settings: String,
    pub find: String,
    pub help: String,
    pub tour: String,
    pub shortcuts: String,
    pub licenses: String,
    pub report: String,
    pub updates: String,
    pub appearance: String,
    pub theme_system: String,
    pub theme_light: String,
    pub theme_dark: String,
    pub quit_item: String,
    pub file_menu: String,
    pub edit_menu: String,
    pub view_menu: String,
    pub window_menu: String,
    pub help_menu: String,
    pub undo: String,
    pub redo: String,
    pub cut: String,
    pub copy: String,
    pub paste: String,
    pub select_all: String,
    pub minimize: String,
    pub maximize: String,
    pub close_window: String,
    pub about: String,
    pub services: String,
    pub hide: String,
    pub hide_others: String,
    pub show_all: String,
    pub fullscreen: String,
}

fn clean(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(60).collect::<String>().trim().to_owned()
}

impl MenuLabels {
    pub fn english() -> Self {
        let s = |text: &str| text.to_owned();
        Self {
            open_world: s("Open World…"),
            settings: s("Settings…"),
            find: s("Find…"),
            help: s("PomiTranslate Help"),
            tour: s("Getting Started"),
            shortcuts: s("Keyboard Shortcuts"),
            licenses: s("Open-Source Licenses"),
            report: s("Report a Problem…"),
            updates: s("Check for Updates…"),
            appearance: s("Appearance"),
            theme_system: s("System"),
            theme_light: s("Light"),
            theme_dark: s("Dark"),
            quit_item: s("Quit PomiTranslate"),
            file_menu: s("File"),
            edit_menu: s("Edit"),
            view_menu: s("View"),
            window_menu: s("Window"),
            help_menu: s("Help"),
            undo: s("Undo"),
            redo: s("Redo"),
            cut: s("Cut"),
            copy: s("Copy"),
            paste: s("Paste"),
            select_all: s("Select All"),
            minimize: s("Minimize"),
            maximize: s("Zoom"),
            close_window: s("Close Window"),
            about: s("About PomiTranslate"),
            services: s("Services"),
            hide: s("Hide PomiTranslate"),
            hide_others: s("Hide Others"),
            show_all: s("Show All"),
            fullscreen: s("Enter Full Screen"),
        }
    }

    /// `self` with every non-blank field of `incoming` (cleaned) replacing it.
    pub fn merged(&self, incoming: &MenuLabels) -> Self {
        let mut merged = self.clone();
        macro_rules! take {
            ($($field:ident),*) => {$(
                let value = clean(&incoming.$field);
                if !value.is_empty() { merged.$field = value; }
            )*};
        }
        take!(
            open_world, settings, find, help, tour, shortcuts, licenses, report, updates,
            appearance, theme_system, theme_light, theme_dark, quit_item, file_menu, edit_menu,
            view_menu, window_menu, help_menu, undo, redo, cut, copy, paste, select_all, minimize,
            maximize, close_window, about, services, hide, hide_others, show_all, fullscreen
        );
        merged
    }

    fn title(&self, title: Title) -> &str {
        match title {
            Title::App => "PomiTranslate",
            Title::File => &self.file_menu,
            Title::Edit => &self.edit_menu,
            Title::View => &self.view_menu,
            Title::Window => &self.window_menu,
            Title::Help => &self.help_menu,
        }
    }

    fn item(&self, id: &str) -> &str {
        match id {
            OPEN_WORLD => &self.open_world,
            SETTINGS => &self.settings,
            FIND => &self.find,
            HELP => &self.help,
            TOUR => &self.tour,
            SHORTCUTS => &self.shortcuts,
            LICENSES => &self.licenses,
            REPORT => &self.report,
            UPDATES => &self.updates,
            QUIT => &self.quit_item,
            _ => "",
        }
    }

    fn predefined(&self, kind: Kind) -> &str {
        match kind {
            Kind::Undo => &self.undo,
            Kind::Redo => &self.redo,
            Kind::Cut => &self.cut,
            Kind::Copy => &self.copy,
            Kind::Paste => &self.paste,
            Kind::SelectAll => &self.select_all,
            Kind::Minimize => &self.minimize,
            Kind::Maximize => &self.maximize,
            Kind::CloseWindow => &self.close_window,
            Kind::Quit => &self.quit_item,
            Kind::About => &self.about,
            Kind::Services => &self.services,
            Kind::Hide => &self.hide,
            Kind::HideOthers => &self.hide_others,
            Kind::ShowAll => &self.show_all,
            Kind::Fullscreen => &self.fullscreen,
        }
    }
}

fn accelerator(id: &str) -> Option<&'static str> {
    match id {
        OPEN_WORLD => Some("CmdOrCtrl+O"),
        SETTINGS => Some("CmdOrCtrl+,"),
        FIND => Some("CmdOrCtrl+F"),
        HELP => Some(if cfg!(target_os = "macos") { "CmdOrCtrl+?" } else { "F1" }),
        QUIT => Some("CmdOrCtrl+Q"),
        _ => None,
    }
}

// --- building ---------------------------------------------------------------------------------

struct Handles {
    zoom: Vec<(u16, CheckMenuItem<Wry>)>,
    themes: Vec<(&'static str, CheckMenuItem<Wry>)>,
}

pub struct MenuState {
    labels: Mutex<MenuLabels>,
    handles: Mutex<Option<Handles>>,
    zoom: AtomicU16,
    theme: Mutex<String>,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn predefined(
    app: &AppHandle,
    kind: Kind,
    labels: &MenuLabels,
) -> tauri::Result<PredefinedMenuItem<Wry>> {
    let text = Some(labels.predefined(kind));
    match kind {
        Kind::Undo => PredefinedMenuItem::undo(app, text),
        Kind::Redo => PredefinedMenuItem::redo(app, text),
        Kind::Cut => PredefinedMenuItem::cut(app, text),
        Kind::Copy => PredefinedMenuItem::copy(app, text),
        Kind::Paste => PredefinedMenuItem::paste(app, text),
        Kind::SelectAll => PredefinedMenuItem::select_all(app, text),
        Kind::Minimize => PredefinedMenuItem::minimize(app, text),
        Kind::Maximize => PredefinedMenuItem::maximize(app, text),
        Kind::CloseWindow => PredefinedMenuItem::close_window(app, text),
        Kind::Quit => PredefinedMenuItem::quit(app, text),
        Kind::Services => PredefinedMenuItem::services(app, text),
        Kind::Hide => PredefinedMenuItem::hide(app, text),
        Kind::HideOthers => PredefinedMenuItem::hide_others(app, text),
        Kind::ShowAll => PredefinedMenuItem::show_all(app, text),
        Kind::Fullscreen => PredefinedMenuItem::fullscreen(app, text),
        Kind::About => PredefinedMenuItem::about(
            app,
            text,
            Some(AboutMetadata {
                name: Some("PomiTranslate".into()),
                version: Some(app.package_info().version.to_string()),
                ..Default::default()
            }),
        ),
    }
}

fn build(
    app: &AppHandle,
    labels: &MenuLabels,
    zoom: u16,
    theme: &str,
) -> tauri::Result<(Menu<Wry>, Handles)> {
    let mut handles = Handles {
        zoom: Vec::new(),
        themes: Vec::new(),
    };
    let menu = Menu::new(app)?;
    for (title, entries) in layout(Platform::current()) {
        let submenu = Submenu::new(app, labels.title(title), true)?;
        for entry in entries {
            match entry {
                Entry::Item(id) => {
                    submenu.append(&MenuItem::with_id(app, id, labels.item(id), true, accelerator(id))?)?
                }
                Entry::Predefined(kind) => submenu.append(&predefined(app, kind, labels)?)?,
                Entry::Separator => submenu.append(&PredefinedMenuItem::separator(app)?)?,
                Entry::Appearance => {
                    let texts = [&labels.theme_system, &labels.theme_light, &labels.theme_dark];
                    let mut items = Vec::new();
                    for ((name, id), text) in THEMES.iter().zip(texts) {
                        let item = CheckMenuItem::with_id(app, *id, text, true, *name == theme, None::<&str>)?;
                        handles.themes.push((*name, item.clone()));
                        items.push(item);
                    }
                    let refs: Vec<&dyn IsMenuItem<Wry>> =
                        items.iter().map(|item| item as &dyn IsMenuItem<Wry>).collect();
                    submenu.append(&Submenu::with_items(app, &labels.appearance, true, &refs)?)?;
                }
                Entry::Zoom => {
                    for level in ZOOM_LEVELS {
                        let shortcut = match level {
                            100 => Some("CmdOrCtrl+0"),
                            200 => Some("CmdOrCtrl+2"),
                            _ => None,
                        };
                        let item = CheckMenuItem::with_id(
                            app,
                            format!("{ZOOM_PREFIX}{level}"),
                            format!("{level}%"),
                            true,
                            level == zoom,
                            shortcut,
                        )?;
                        submenu.append(&item)?;
                        handles.zoom.push((level, item));
                    }
                }
            }
        }
        #[cfg(target_os = "macos")]
        if title == Title::Help {
            let _ = submenu.set_as_help_menu_for_nsapp();
        }
        menu.append(&submenu)?;
    }
    Ok((menu, handles))
}

pub fn install(app: &mut tauri::App) -> tauri::Result<()> {
    let labels = MenuLabels::english();
    let (menu, handles) = build(app.handle(), &labels, 100, "system")?;
    app.manage(MenuState {
        labels: Mutex::new(labels),
        handles: Mutex::new(Some(handles)),
        zoom: AtomicU16::new(100),
        theme: Mutex::new("system".into()),
    });
    app.set_menu(menu)?;
    Ok(())
}

/// Rebuild the bar from the stored labels, zoom and appearance.
fn rebuild(app: &AppHandle, state: &MenuState) -> tauri::Result<()> {
    let labels = locked(&state.labels).clone();
    let theme = locked(&state.theme).clone();
    let (menu, handles) = build(app, &labels, state.zoom.load(Ordering::Relaxed), &theme)?;
    app.set_menu(menu)?;
    *locked(&state.handles) = Some(handles);
    Ok(())
}

// --- events -----------------------------------------------------------------------------------

/// Handle a menu click. Returns false for ids this module does not own.
pub fn select(app: &AppHandle, id: &str) -> bool {
    if id == QUIT {
        crate::exit_gate::request_exit(app);
        return true;
    }
    if let Some(level) = id.strip_prefix(ZOOM_PREFIX).and_then(|n| n.parse::<u16>().ok()) {
        apply_zoom(app, level);
        return true;
    }
    let action = match id {
        OPEN_WORLD => "open-world",
        SETTINGS => "settings",
        FIND => "find",
        HELP => "help",
        TOUR => "tour",
        SHORTCUTS => "shortcuts",
        LICENSES => "licenses",
        REPORT => "report",
        UPDATES => "updates",
        THEME_SYSTEM => "theme-system",
        THEME_LIGHT => "theme-light",
        THEME_DARK => "theme-dark",
        _ => return false,
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("pomi-menu", action);
    }
    true
}

fn apply_zoom(app: &AppHandle, level: u16) {
    let Some(state) = app.try_state::<MenuState>() else {
        return;
    };
    if !ZOOM_LEVELS.contains(&level) {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let tick = |selected: u16| {
        if let Some(handles) = locked(&state.handles).as_ref() {
            for (value, item) in &handles.zoom {
                let _ = item.set_checked(*value == selected);
            }
        }
    };
    if window.set_zoom(f64::from(level) / 100.0).is_err() {
        tick(state.zoom.load(Ordering::Relaxed));
        let _ = window.emit("pomi-zoom-failed", ());
        return;
    }
    state.zoom.store(level, Ordering::Relaxed);
    tick(level);
}

/// The page sends its own wording so the menu speaks the selected interface language.
#[tauri::command]
pub fn set_menu_labels(
    app: AppHandle,
    state: State<'_, MenuState>,
    labels: MenuLabels,
) -> Result<(), IpcError> {
    {
        let mut stored = locked(&state.labels);
        let merged = stored.merged(&labels);
        *stored = merged;
    }
    rebuild(&app, &state).map_err(|error| {
        IpcError::new(code::MENU_UPDATE_FAILED, format!("Menu could not be rebuilt: {error}"))
    })
}

/// Tick the current appearance. A menu click also toggles the clicked item, so this always resets
/// all three from the page's choice.
#[tauri::command]
pub fn set_menu_theme(state: State<'_, MenuState>, choice: String) -> Result<(), IpcError> {
    if !THEMES.iter().any(|(name, _)| *name == choice) {
        return Err(IpcError::new(code::INVALID_REQUEST, "Unknown appearance"));
    }
    *locked(&state.theme) = choice.clone();
    if let Some(handles) = locked(&state.handles).as_ref() {
        for (name, item) in &handles.themes {
            item.set_checked(*name == choice)
                .map_err(|_| IpcError::new(code::MENU_UPDATE_FAILED, "Menu could not be updated"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_entries(platform: Platform) -> Vec<Entry> {
        layout(platform).into_iter().flat_map(|(_, entries)| entries).collect()
    }

    #[test]
    fn windows_and_linux_have_no_predefined_quit_but_their_own() {
        let entries = all_entries(Platform::Other);
        assert!(
            !entries.contains(&Entry::Predefined(Kind::Quit)),
            "the predefined Quit posts WM_QUIT and skips the job gate"
        );
        assert_eq!(entries.iter().filter(|e| **e == Entry::Item(QUIT)).count(), 1);
        assert_eq!(accelerator(QUIT), Some("CmdOrCtrl+Q"));
    }

    #[test]
    fn macos_keeps_the_application_menu_quit_that_reaches_exit_requested() {
        let entries = all_entries(Platform::Mac);
        assert_eq!(entries.iter().filter(|e| **e == Entry::Predefined(Kind::Quit)).count(), 1);
        assert!(!entries.contains(&Entry::Item(QUIT)));
    }

    #[test]
    fn every_app_command_appears_exactly_once_on_each_platform() {
        for platform in [Platform::Mac, Platform::Other] {
            let entries = all_entries(platform);
            for id in [OPEN_WORLD, SETTINGS, FIND, HELP, TOUR, SHORTCUTS, LICENSES, REPORT, UPDATES] {
                assert_eq!(
                    entries.iter().filter(|e| **e == Entry::Item(id)).count(),
                    1,
                    "{id} on {platform:?}"
                );
            }
            assert_eq!(entries.iter().filter(|e| **e == Entry::Appearance).count(), 1);
            assert_eq!(entries.iter().filter(|e| **e == Entry::Zoom).count(), 1);
        }
    }

    #[test]
    fn every_menu_text_has_an_english_default_and_a_catalog_override() {
        let english = MenuLabels::english();
        let platforms = [Platform::Mac, Platform::Other];
        for platform in platforms {
            for (title, entries) in layout(platform) {
                assert!(!english.title(title).is_empty());
                for entry in entries {
                    match entry {
                        Entry::Predefined(kind) => assert!(!english.predefined(kind).is_empty(), "{kind:?}"),
                        Entry::Item(id) => assert!(!english.item(id).is_empty(), "{id}"),
                        _ => {}
                    }
                }
            }
        }
        let korean = MenuLabels {
            cut: "잘라내기".into(),
            file_menu: "  파일\n".into(),
            copy: "   ".into(),
            ..Default::default()
        };
        let merged = english.merged(&korean);
        assert_eq!(merged.cut, "잘라내기");
        assert_eq!(merged.file_menu, "파일");
        assert_eq!(merged.copy, "Copy", "a blank text keeps the default");
        assert_eq!(merged.title(Title::File), "파일");
    }

    #[test]
    fn labels_deserialize_from_the_camel_case_the_page_sends() {
        let labels: MenuLabels = serde_json::from_value(serde_json::json!({
            "openWorld": "월드 열기…", "themeSystem": "시스템", "selectAll": "모두 선택", "quitItem": "종료"
        }))
        .unwrap();
        assert_eq!(labels.open_world, "월드 열기…");
        assert_eq!(labels.theme_system, "시스템");
        assert_eq!(labels.select_all, "모두 선택");
        assert_eq!(labels.quit_item, "종료");
    }
}
