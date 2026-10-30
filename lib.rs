mod clipboard;
mod media;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{
    Emitter, LogicalSize, Manager, PhysicalPosition, Position, Size, State, WebviewWindow,
};

#[derive(Clone, Default)]
struct FileDragState(Arc<AtomicBool>);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedPanelSettings {
    locked: bool,
    x: Option<i32>,
    y: Option<i32>,
}

impl Default for SavedPanelSettings {
    fn default() -> Self {
        Self {
            locked: true,
            x: None,
            y: None,
        }
    }
}

#[derive(Clone)]
struct PanelPreferences(Arc<PanelPreferencesInner>);

struct PanelPreferencesInner {
    path: PathBuf,
    settings: Mutex<SavedPanelSettings>,
}

impl PanelPreferences {
    fn load(app: &tauri::AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let directory = app.path().app_config_dir()?;
        std::fs::create_dir_all(&directory)?;
        let path = directory.join("panel-settings.json");
        let settings = match std::fs::read(&path) {
            Ok(contents) => serde_json::from_slice(&contents)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                SavedPanelSettings::default()
            }
            Err(error) => return Err(error.into()),
        };
        Ok(Self(Arc::new(PanelPreferencesInner {
            path,
            settings: Mutex::new(settings),
        })))
    }

    fn snapshot(&self) -> Result<SavedPanelSettings, String> {
        self.0
            .settings
            .lock()
            .map(|settings| settings.clone())
            .map_err(|error| format!("panel settings lock failed: {error}"))
    }

    fn update(
        &self,
        update: impl FnOnce(&mut SavedPanelSettings),
    ) -> Result<SavedPanelSettings, String> {
        let mut settings = self
            .0
            .settings
            .lock()
            .map_err(|error| format!("panel settings lock failed: {error}"))?;
        update(&mut settings);
        let contents = serde_json::to_vec_pretty(&*settings)
            .map_err(|error| format!("could not serialize panel settings: {error}"))?;
        std::fs::write(&self.0.path, contents)
            .map_err(|error| format!("could not save panel settings: {error}"))?;
        Ok(settings.clone())
    }
}

fn save_window_position(
    window: &WebviewWindow,
    preferences: &PanelPreferences,
) -> Result<PhysicalPosition<i32>, String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let width = window
        .outer_size()
        .map_err(|error| error.to_string())?
        .width;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = saved_collapsed_position(position, width, scale);
    preferences.update(|settings| {
        settings.x = Some(position.x);
        settings.y = Some(position.y);
    })?;
    Ok(position)
}

fn saved_collapsed_position(
    position: PhysicalPosition<i32>,
    width: u32,
    scale: f64,
) -> PhysicalPosition<i32> {
    let x = collapsed_position_x(position.x, width, scale);
    PhysicalPosition::new(x, position.y)
}

fn collapsed_position_x(current_x: i32, current_width: u32, scale: f64) -> i32 {
    let collapsed_width = (COLLAPSED.0 * scale).round() as i64;
    let horizontal_offset = (i64::from(current_width) - collapsed_width) / 2;
    (i64::from(current_x) + horizontal_offset).clamp(i64::from(i32::MIN), i64::from(i32::MAX))
        as i32
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDragEvent {
    phase: &'static str,
    paths: Vec<String>,
}

/// Logical (DPI-independent) sizes. Keep in sync with NotchPanel.tsx.
const COLLAPSED: (f64, f64) = (320.0, 28.0);
const EXPANDED: (f64, f64) = (620.0, 260.0);

/// Resizes the window to `logical` and pins it to the top-center of the
/// primary monitor (falling back to the monitor the window is on).
///
/// The window is resized together with the visual panel on purpose: a
/// transparent expanded window would swallow clicks meant for whatever sits
/// below the thin bar while the panel is collapsed.
fn place_top_center(window: &WebviewWindow, logical: (f64, f64)) -> tauri::Result<()> {
    let monitor = match window.primary_monitor()? {
        Some(m) => m,
        None => match window.current_monitor()? {
            Some(m) => m,
            None => return Ok(()),
        },
    };

    let scale = monitor.scale_factor();
    let monitor_size = monitor.size(); // physical pixels
    let monitor_pos = monitor.position(); // physical pixels (non-zero on multi-monitor setups)

    let window_width_px = (logical.0 * scale).round() as i32;
    let x = monitor_pos.x + (monitor_size.width as i32 - window_width_px) / 2;
    let y = monitor_pos.y;

    window.set_size(Size::Logical(LogicalSize::new(logical.0, logical.1)))?;
    window.set_position(Position::Physical(PhysicalPosition::new(x, y)))?;
    Ok(())
}

fn resize_window(window: &WebviewWindow, logical: (f64, f64)) -> tauri::Result<()> {
    let old_size = window.outer_size()?;
    let scale = window.scale_factor()?;
    let position = window.outer_position()?;
    let new_width = (logical.0 * scale).round() as i64;
    let horizontal_offset = (i64::from(old_size.width) - new_width) / 2;

    window.set_size(Size::Logical(LogicalSize::new(logical.0, logical.1)))?;
    if horizontal_offset != 0 {
        let x = (i64::from(position.x) + horizontal_offset)
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
        window.set_position(Position::Physical(PhysicalPosition::new(x, position.y)))?;
    }
    Ok(())
}

fn position_fits_monitor(
    position: PhysicalPosition<i32>,
    logical: (f64, f64),
    monitor: &tauri::Monitor,
) -> bool {
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let scale = monitor.scale_factor();
    position_fits_bounds(
        (position.x, position.y),
        (
            (logical.0 * scale).round() as i64,
            (logical.1 * scale).round() as i64,
        ),
        (monitor_position.x, monitor_position.y),
        (monitor_size.width, monitor_size.height),
    )
}

fn position_fits_bounds(
    position: (i32, i32),
    window_size: (i64, i64),
    monitor_position: (i32, i32),
    monitor_size: (u32, u32),
) -> bool {
    let left = i64::from(position.0);
    let top = i64::from(position.1);
    let monitor_left = i64::from(monitor_position.0);
    let monitor_top = i64::from(monitor_position.1);

    left >= monitor_left
        && top >= monitor_top
        && left + window_size.0 <= monitor_left + i64::from(monitor_size.0)
        && top + window_size.1 <= monitor_top + i64::from(monitor_size.1)
}

#[tauri::command]
fn get_panel_locked(preferences: State<'_, PanelPreferences>) -> Result<bool, String> {
    Ok(preferences.snapshot()?.locked)
}

#[tauri::command]
fn set_panel_locked(
    window: WebviewWindow,
    preferences: State<'_, PanelPreferences>,
    locked: bool,
) -> Result<bool, String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let width = window
        .outer_size()
        .map_err(|error| error.to_string())?
        .width;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = saved_collapsed_position(position, width, scale);
    let settings = preferences.update(|settings| {
        settings.locked = locked;
        settings.x = Some(position.x);
        settings.y = Some(position.y);
    })?;
    Ok(settings.locked)
}

#[tauri::command]
fn reset_panel_position(
    window: WebviewWindow,
    preferences: State<'_, PanelPreferences>,
) -> Result<(), String> {
    place_top_center(&window, EXPANDED).map_err(|error| error.to_string())?;
    save_window_position(&window, &preferences)?;
    Ok(())
}

#[tauri::command]
fn start_panel_drag(
    window: WebviewWindow,
    preferences: State<'_, PanelPreferences>,
) -> Result<(), String> {
    if preferences.snapshot()?.locked {
        return Err("Unlock the panel position before moving it".to_string());
    }
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
fn quit_app(
    app: tauri::AppHandle,
    window: WebviewWindow,
    preferences: State<'_, PanelPreferences>,
) -> Result<(), String> {
    save_window_position(&window, &preferences)?;
    app.exit(0);
    Ok(())
}

/// Called by the frontend right before it expands (`true`) and after its
/// collapse animation has finished (`false`).
#[tauri::command]
fn set_panel_expanded(
    window: WebviewWindow,
    expanded: bool,
    drag_state: State<'_, FileDragState>,
) -> Result<(), String> {
    if !expanded && drag_state.0.load(Ordering::Acquire) {
        return Ok(());
    }

    let size = if expanded { EXPANDED } else { COLLAPSED };
    resize_window(&window, size).map_err(|e| e.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(FileDragState::default())
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            match event {
                tauri::WindowEvent::CloseRequested { .. } => {
                    let preferences = window.app_handle().state::<PanelPreferences>();
                    match window.app_handle().get_webview_window(window.label()) {
                        Some(webview) => {
                            if let Err(error) = save_window_position(&webview, &preferences) {
                                eprintln!("could not save panel position before closing: {error}");
                            }
                        }
                        None => eprintln!("could not find panel window while closing"),
                    }
                }
                tauri::WindowEvent::Moved(_) => {
                    let preferences = window.app_handle().state::<PanelPreferences>();
                    match preferences.snapshot() {
                        Ok(settings) if !settings.locked => {
                            let saved_position = window
                                .outer_position()
                                .and_then(|position| {
                                    window.outer_size().map(|size| (position, size.width))
                                })
                                .and_then(|(position, width)| {
                                    window.scale_factor().map(|scale| {
                                        saved_collapsed_position(position, width, scale)
                                    })
                                });
                            match saved_position {
                                Ok(position) => {
                                    if let Err(error) = preferences.update(|settings| {
                                        settings.x = Some(position.x);
                                        settings.y = Some(position.y);
                                    }) {
                                        eprintln!("failed to save panel position: {error}");
                                    }
                                }
                                Err(error) => {
                                    eprintln!("could not read panel position: {error}");
                                }
                            }
                        }
                        Ok(_) => {}
                        Err(error) => eprintln!("could not read panel settings: {error}"),
                    }
                }
                tauri::WindowEvent::DragDrop(drag_event) => {
                    let drag_state = window.app_handle().state::<FileDragState>();

                    let (phase, paths, active) = match drag_event {
                        tauri::DragDropEvent::Enter { paths, .. } => (
                            "enter",
                            paths
                                .iter()
                                .map(|path| path.to_string_lossy().into_owned())
                                .collect(),
                            true,
                        ),
                        tauri::DragDropEvent::Over { .. } => ("over", Vec::new(), true),
                        tauri::DragDropEvent::Drop { paths, .. } => (
                            "drop",
                            paths
                                .iter()
                                .map(|path| path.to_string_lossy().into_owned())
                                .collect(),
                            false,
                        ),
                        tauri::DragDropEvent::Leave => ("leave", Vec::new(), false),
                        _ => return,
                    };

                    if active {
                        let was_active = drag_state.0.swap(true, Ordering::AcqRel);
                        if !was_active {
                            if let Some(webview) =
                                window.app_handle().get_webview_window(window.label())
                            {
                                if let Err(error) = resize_window(&webview, EXPANDED) {
                                    eprintln!("failed to expand window during file drag: {error}");
                                }
                            }
                        }
                        if phase == "over" && was_active {
                            return;
                        }
                    } else {
                        drag_state.0.store(false, Ordering::Release);
                    }

                    if let Err(error) = window
                        .app_handle()
                        .emit("ridge-file-drag", FileDragEvent { phase, paths })
                    {
                        eprintln!("failed to notify frontend about file drag: {error}");
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            let preferences = PanelPreferences::load(app.handle())?;
            let saved_position = preferences.snapshot()?;
            app.manage(preferences.clone());

            let clipboard_history = clipboard::ClipboardHistory::default();
            let screenshot_capture = clipboard::ScreenshotCapture::default();
            app.manage(clipboard_history.clone());
            app.manage(screenshot_capture.clone());
            clipboard::ensure_screenshots_directory(app.handle())?;
            clipboard::start_monitor(clipboard_history)?;
            clipboard::start_screenshot_watcher(app.handle().clone())?;

            let window = app
                .get_webview_window("main")
                .ok_or("main window not found")?;

            if let (Some(x), Some(y)) = (saved_position.x, saved_position.y) {
                let position = PhysicalPosition::new(x, y);
                let monitors = window.available_monitors()?;
                if monitors
                    .iter()
                    .any(|monitor| position_fits_monitor(position, COLLAPSED, monitor))
                {
                    window.set_size(Size::Logical(LogicalSize::new(COLLAPSED.0, COLLAPSED.1)))?;
                    window.set_position(Position::Physical(position))?;
                } else {
                    place_top_center(&window, COLLAPSED)?;
                }
            } else {
                place_top_center(&window, COLLAPSED)?;
            }
            window.set_always_on_top(true)?;
            // The window starts hidden (see tauri.conf.json) so it never
            // flashes at the wrong position before being placed.
            window.show()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_panel_expanded,
            get_panel_locked,
            set_panel_locked,
            reset_panel_position,
            start_panel_drag,
            quit_app,
            media::get_current_media,
            media::get_current_media_art,
            media::media_control,
            media::media_seek_to,
            media::get_system_volume,
            media::set_system_volume,
            clipboard::get_clipboard_history,
            clipboard::clear_clipboard_history,
            clipboard::paste_clipboard_items,
            clipboard::get_shelf_image_preview,
            clipboard::copy_image_to_clipboard,
            clipboard::delete_managed_screenshot,
            clipboard::get_existing_shelf_paths,
            clipboard::list_screenshots,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ridge");
}

#[cfg(test)]
mod tests {
    use super::{collapsed_position_x, position_fits_bounds};

    #[test]
    fn expanded_panel_saves_the_same_collapsed_left_edge() {
        assert_eq!(collapsed_position_x(100, 320, 1.0), 100);
        assert_eq!(collapsed_position_x(250, 620, 1.0), 400);
        assert_eq!(collapsed_position_x(100, 480, 1.5), 100);
        assert_eq!(collapsed_position_x(325, 930, 1.5), 550);
    }

    #[test]
    fn saved_panel_position_must_fit_entire_monitor() {
        let monitor_origin = (0, 0);
        let monitor_size = (1920, 1080);

        assert!(position_fits_bounds(
            (20, 10),
            (320, 28),
            monitor_origin,
            monitor_size
        ));
        assert!(!position_fits_bounds(
            (-1, 10),
            (320, 28),
            monitor_origin,
            monitor_size
        ));
        assert!(!position_fits_bounds(
            (1601, 10),
            (320, 28),
            monitor_origin,
            monitor_size
        ));
        assert!(!position_fits_bounds(
            (20, 1060),
            (320, 28),
            monitor_origin,
            monitor_size
        ));
    }

    #[test]
    fn saved_panel_position_supports_monitors_left_of_primary() {
        assert!(position_fits_bounds(
            (-1900, 0),
            (320, 28),
            (-1920, 0),
            (1920, 1080)
        ));
    }
}
