#[cfg(windows)]
use std::time::Duration as ClipboardDuration;
use std::{
    collections::{HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

const MAX_ITEMS: usize = 40;
const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Default)]
struct History {
    last_sequence: Option<u32>,
    items: VecDeque<String>,
}

#[derive(Clone, Default)]
pub struct ClipboardHistory(Arc<Mutex<History>>);

#[derive(Clone, Default)]
pub struct ScreenshotCapture(Arc<Mutex<ScreenshotState>>);

#[derive(Default)]
struct ScreenshotState {
    last: Option<(u64, PathBuf)>,
    suppressed: Option<u64>,
}

impl ClipboardHistory {
    pub fn poll(&self) -> Result<Vec<String>, String> {
        self.capture()?;
        self.items()
    }

    fn capture(&self) -> Result<(), String> {
        if let Some((sequence, text)) = platform::read_text().map_err(|error| error.to_string())? {
            self.record(sequence, text)?;
        }
        Ok(())
    }

    fn record(&self, sequence: u32, text: Option<String>) -> Result<(), String> {
        let mut history = self
            .0
            .lock()
            .map_err(|error| format!("clipboard history lock failed: {error}"))?;
        if history.last_sequence == Some(sequence) {
            return Ok(());
        }
        history.last_sequence = Some(sequence);
        if let Some(text) = text.filter(|text| !text.trim().is_empty()) {
            if history.items.front() != Some(&text) {
                history.items.push_front(text);
                history.items.truncate(MAX_ITEMS);
            }
        }
        Ok(())
    }

    pub fn items(&self) -> Result<Vec<String>, String> {
        self.0
            .lock()
            .map(|history| history.items.iter().cloned().collect())
            .map_err(|error| format!("clipboard history lock failed: {error}"))
    }

    pub fn clear(&self) -> Result<(), String> {
        self.0
            .lock()
            .map(|mut history| history.items.clear())
            .map_err(|error| format!("clipboard history lock failed: {error}"))
    }
}

pub fn start_monitor(history: ClipboardHistory) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        thread::Builder::new()
            .name("clipboard-history".to_string())
            .spawn(move || loop {
                if let Err(error) = history.capture() {
                    eprintln!("clipboard monitor failed: {error}");
                    thread::sleep(ClipboardDuration::from_secs(1));
                } else {
                    thread::sleep(ClipboardDuration::from_millis(150));
                }
            })?;
    }

    #[cfg(not(windows))]
    {
        let _ = history;
    }

    Ok(())
}

pub fn start_screenshot_watcher(app: tauri::AppHandle) -> notify::Result<()> {
    use notify::{RecommendedWatcher, RecursiveMode, Watcher};
    use std::sync::mpsc;

    use tauri::Manager;

    let directory = app
        .path()
        .picture_dir()
        .map_err(|error| notify::Error::io(std::io::Error::other(error)))?
        .join("Screenshots");
    std::fs::create_dir_all(&directory).map_err(notify::Error::io)?;

    let (sender, receiver) = mpsc::channel();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |event| {
        if sender.send(event).is_err() {
            eprintln!("screenshot watcher event receiver stopped");
        }
    })?;
    watcher.watch(&directory, RecursiveMode::NonRecursive)?;

    thread::Builder::new()
        .name("screenshot-folder-watcher".to_string())
        .spawn(move || {
            let _watcher = watcher;
            let mut emitted = HashSet::new();
            loop {
                match receiver.recv() {
                    Ok(Ok(event)) => {
                        for path in event.paths {
                            if !is_png(&path) {
                                continue;
                            }
                            if matches!(&event.kind, notify::EventKind::Remove(_)) {
                                emitted.remove(&normalize_event_path(&path));
                                continue;
                            }
                            if let Some(path) = wait_for_completed_png(&path) {
                                if !emitted.insert(path.clone()) {
                                    continue;
                                }
                                if let Err(error) = tauri::Emitter::emit(
                                    &app,
                                    "screenshot-captured",
                                    path.to_string_lossy().into_owned(),
                                ) {
                                    eprintln!("failed to emit screenshot path: {error}");
                                }
                            }
                        }
                    }
                    Ok(Err(error)) => eprintln!("screenshot folder watcher failed: {error}"),
                    Err(error) => {
                        eprintln!("screenshot folder watcher stopped: {error}");
                        break;
                    }
                }
            }
        })
        .map_err(notify::Error::io)?;

    Ok(())
}

fn is_png(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
}

fn wait_for_completed_png(path: &Path) -> Option<PathBuf> {
    let mut previous_size = None;
    for _ in 0..5 {
        thread::sleep(Duration::from_millis(100));
        let metadata = std::fs::metadata(path).ok()?;
        if !metadata.is_file() {
            return None;
        }
        let size = metadata.len();
        if previous_size == Some(size) && size > 0 {
            return std::fs::canonicalize(path).ok();
        }
        previous_size = Some(size);
    }
    None
}

fn normalize_event_path(path: &Path) -> PathBuf {
    if let Ok(path) = std::fs::canonicalize(path) {
        return path;
    }

    match (path.parent(), path.file_name()) {
        (Some(parent), Some(file_name)) => std::fs::canonicalize(parent)
            .map(|parent| parent.join(file_name))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    }
}

pub fn ensure_screenshots_directory(app: &tauri::AppHandle) -> std::io::Result<()> {
    use tauri::Manager;

    let pictures = app.path().picture_dir().map_err(std::io::Error::other)?;
    std::fs::create_dir_all(pictures.join("Screenshots"))
}

#[tauri::command]
pub async fn get_clipboard_history(
    history: tauri::State<'_, ClipboardHistory>,
) -> Result<Vec<String>, String> {
    let history = history.inner().clone();
    tauri::async_runtime::spawn_blocking(move || history.poll())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn clear_clipboard_history(history: tauri::State<'_, ClipboardHistory>) -> Result<(), String> {
    history.clear()
}

#[tauri::command]
pub async fn paste_clipboard_items(
    app: tauri::AppHandle,
    screenshots: tauri::State<'_, ScreenshotCapture>,
) -> Result<Vec<String>, String> {
    let screenshots = screenshots.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        platform::paste_items(&app, &screenshots).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn get_shelf_image_preview(path: String) -> Result<String, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            platform::get_shelf_image_preview(path).map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())?
    }

    #[cfg(not(windows))]
    {
        let _ = path;
        Err("Image previews are only available on Windows".to_string())
    }
}

#[tauri::command]
pub async fn copy_image_to_clipboard(app: tauri::AppHandle, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || platform::copy_image_to_clipboard(&app, path))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn delete_managed_screenshot(
    app: tauri::AppHandle,
    screenshots: tauri::State<'_, ScreenshotCapture>,
    path: String,
) -> Result<bool, String> {
    let screenshots = screenshots.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        platform::delete_managed_screenshot(&app, &screenshots, path)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn get_existing_shelf_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .filter_map(|path| match std::path::Path::new(&path).try_exists() {
                Ok(true) => Some(Ok(path)),
                Ok(false) => None,
                Err(error) => Some(Err(format!("could not check shelf file {path}: {error}"))),
            })
            .collect()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn list_screenshots(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || platform::list_screenshots(&app))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(windows)]
mod platform {
    use std::{
        borrow::Cow,
        ffi::OsString,
        hash::{Hash, Hasher},
        io::Cursor,
        os::windows::ffi::OsStringExt,
        path::{Path, PathBuf},
        slice,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{ScreenshotCapture, MAX_IMAGE_BYTES};
    use arboard::{Clipboard, ImageData};
    use image::{ImageFormat, ImageReader, Limits, RgbaImage};
    use tauri::Manager;
    use windows::{
        core::Result as WinResult,
        Win32::{
            Foundation::{HGLOBAL, HWND},
            System::{
                DataExchange::{
                    CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
                },
                Memory::{GlobalLock, GlobalSize, GlobalUnlock},
            },
            UI::Shell::{DragQueryFileW, HDROP},
        },
    };

    const CF_UNICODETEXT: u32 = 13;
    const CF_HDROP: u32 = 15;
    const MAX_TEXT_BYTES: usize = 1024 * 1024;
    const MAX_CLIPBOARD_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
    const MAX_PREVIEW_SOURCE_BYTES: u64 = 32 * 1024 * 1024;
    const MAX_PREVIEW_DIMENSION: u32 = 8192;
    const MAX_PREVIEW_ALLOCATION: u64 = 128 * 1024 * 1024;
    static SCREENSHOT_COUNTER: AtomicU64 = AtomicU64::new(0);

    pub fn get_shelf_image_preview(path: String) -> Result<String, String> {
        let path = PathBuf::from(path);
        if !matches!(
            path.extension()
                .and_then(|extension| extension.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("png" | "jpg" | "jpeg")
        ) {
            return Err("Only PNG and JPEG files can be previewed".to_string());
        }

        let metadata = std::fs::metadata(&path)
            .map_err(|error| format!("could not read image metadata: {error}"))?;
        if !metadata.is_file() || metadata.len() > MAX_PREVIEW_SOURCE_BYTES {
            return Err("Image is not a file or exceeds the preview size limit".to_string());
        }

        let bytes = std::fs::read(&path)
            .map_err(|error| format!("could not read image for preview: {error}"))?;
        let mut reader = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|error| format!("could not detect image format: {error}"))?;
        if !matches!(reader.format(), Some(ImageFormat::Png | ImageFormat::Jpeg)) {
            return Err("Only PNG and JPEG files can be previewed".to_string());
        }

        let mut limits = Limits::default();
        limits.max_image_width = Some(MAX_PREVIEW_DIMENSION);
        limits.max_image_height = Some(MAX_PREVIEW_DIMENSION);
        limits.max_alloc = Some(MAX_PREVIEW_ALLOCATION);
        reader.limits(limits);

        let thumbnail = reader
            .decode()
            .map_err(|error| format!("could not decode image preview: {error}"))?
            .thumbnail(256, 176);
        let mut png = Cursor::new(Vec::new());
        thumbnail
            .write_to(&mut png, ImageFormat::Png)
            .map_err(|error| format!("could not encode image preview: {error}"))?;

        use base64::Engine;
        Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png.get_ref())
        ))
    }

    pub fn copy_image_to_clipboard(app: &tauri::AppHandle, path: String) -> Result<(), String> {
        let directory = screenshots_directory(app)?;
        let path = resolve_managed_screenshot(Path::new(&path), &directory)?
            .ok_or_else(|| "Only images in the Screenshots folder can be copied".to_string())?;
        let metadata = std::fs::metadata(&path)
            .map_err(|error| format!("could not read image metadata: {error}"))?;
        if metadata.len() > MAX_CLIPBOARD_IMAGE_BYTES {
            return Err("Image exceeds the clipboard size limit".to_string());
        }

        let mut reader = ImageReader::open(&path)
            .map_err(|error| format!("could not open image: {error}"))?
            .with_guessed_format()
            .map_err(|error| format!("could not detect image format: {error}"))?;
        if !matches!(reader.format(), Some(ImageFormat::Png | ImageFormat::Jpeg)) {
            return Err("Only PNG and JPEG files can be copied".to_string());
        }
        let mut limits = Limits::default();
        limits.max_image_width = Some(MAX_PREVIEW_DIMENSION);
        limits.max_image_height = Some(MAX_PREVIEW_DIMENSION);
        limits.max_alloc = Some(MAX_PREVIEW_ALLOCATION);
        reader.limits(limits);
        let rgba = reader
            .decode()
            .map_err(|error| format!("could not decode image: {error}"))?
            .to_rgba8();

        let mut clipboard =
            Clipboard::new().map_err(|error| format!("could not open clipboard: {error}"))?;
        clipboard
            .set_image(ImageData {
                width: rgba.width() as usize,
                height: rgba.height() as usize,
                bytes: Cow::Owned(rgba.into_raw()),
            })
            .map_err(|error| format!("could not copy image to clipboard: {error}"))
    }

    pub fn delete_managed_screenshot(
        app: &tauri::AppHandle,
        screenshots: &ScreenshotCapture,
        path: String,
    ) -> Result<bool, String> {
        let path = PathBuf::from(path);
        let directory = screenshots_directory(app)?;
        let mut state = screenshots
            .0
            .lock()
            .map_err(|error| format!("screenshot state lock failed: {error}"))?;
        let Some(path) = remove_managed_screenshot_file(&path, &directory)? else {
            return Ok(false);
        };
        let fingerprint = state
            .last
            .as_ref()
            .filter(|(_, last_path)| last_path == &path)
            .map(|(fingerprint, _)| *fingerprint);
        if let Some(fingerprint) = fingerprint {
            state.suppressed = Some(fingerprint);
        }
        Ok(true)
    }

    fn screenshots_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        let pictures = app
            .path()
            .picture_dir()
            .map_err(|error| format!("could not locate the Pictures folder: {error}"))?;
        Ok(pictures.join("Screenshots"))
    }

    pub(super) fn resolve_managed_screenshot(
        path: &std::path::Path,
        directory: &PathBuf,
    ) -> Result<Option<PathBuf>, String> {
        if !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "png" | "jpg" | "jpeg"
                )
            })
        {
            return Ok(None);
        }

        let metadata = match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("could not inspect screenshot: {error}")),
        };
        if !metadata.file_type().is_file() {
            return Ok(None);
        }

        let Some(parent) = path.parent() else {
            return Ok(None);
        };
        let canonical_parent = match std::fs::canonicalize(parent) {
            Ok(parent) => parent,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("could not resolve screenshot folder: {error}")),
        };
        let canonical_directory = match std::fs::canonicalize(directory) {
            Ok(directory) => directory,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("could not resolve Screenshots folder: {error}")),
        };
        if canonical_directory != canonical_parent {
            return Ok(None);
        }

        let canonical_path = std::fs::canonicalize(path)
            .map_err(|error| format!("could not resolve screenshot path: {error}"))?;
        if canonical_path.parent() != Some(canonical_parent.as_path()) {
            return Ok(None);
        }
        Ok(Some(canonical_path))
    }

    pub(super) fn remove_managed_screenshot_file(
        path: &std::path::Path,
        directory: &PathBuf,
    ) -> Result<Option<PathBuf>, String> {
        let Some(path) = resolve_managed_screenshot(path, directory)? else {
            return Ok(None);
        };
        std::fs::remove_file(&path)
            .map_err(|error| format!("could not delete screenshot: {error}"))?;
        Ok(Some(path))
    }

    pub fn list_screenshots(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
        let directory = screenshots_directory(app)?;
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("could not create Screenshots folder: {error}"))?;
        let entries = std::fs::read_dir(&directory)
            .map_err(|error| format!("could not list Screenshots folder: {error}"))?;
        let mut paths = Vec::new();
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("could not read screenshot entry: {error}"))?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|error| format!("could not read screenshot metadata: {error}"))?;
            if metadata.is_file()
                && matches!(
                    path.extension()
                        .and_then(|extension| extension.to_str())
                        .map(str::to_ascii_lowercase)
                        .as_deref(),
                    Some("png" | "jpg" | "jpeg")
                )
            {
                let path = std::fs::canonicalize(path)
                    .map_err(|error| format!("could not resolve screenshot path: {error}"))?;
                paths.push(path.to_string_lossy().into_owned());
            }
        }
        paths.sort_unstable();
        Ok(paths)
    }

    pub fn read_text() -> WinResult<Option<(u32, Option<String>)>> {
        unsafe {
            if OpenClipboard(HWND::default()).is_err() {
                return Ok(None);
            }

            let result = read_open_clipboard();
            let close_result = CloseClipboard();
            close_result?;
            result
        }
    }

    unsafe fn read_open_clipboard() -> WinResult<Option<(u32, Option<String>)>> {
        let sequence = GetClipboardSequenceNumber();
        let Ok(handle) = GetClipboardData(CF_UNICODETEXT) else {
            return Ok(Some((sequence, None)));
        };
        let memory = HGLOBAL(handle.0);
        let size = GlobalSize(memory);
        if !(2..=MAX_TEXT_BYTES).contains(&size) {
            return Ok(Some((sequence, None)));
        }

        let pointer = GlobalLock(memory).cast::<u16>();
        if pointer.is_null() {
            return Err(windows::core::Error::from_win32());
        }

        let units = slice::from_raw_parts(pointer, size / 2);
        let length = units
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(units.len());
        let text = String::from_utf16_lossy(&units[..length]);
        let _ = GlobalUnlock(memory);

        Ok(Some((sequence, Some(text))))
    }

    pub fn paste_items(
        app: &tauri::AppHandle,
        screenshots: &ScreenshotCapture,
    ) -> Result<Vec<String>, String> {
        let files = read_file_paths().map_err(|error| error.to_string())?;
        if !files.is_empty() {
            return Ok(files);
        }

        if let Ok(mut clipboard) = Clipboard::new() {
            if let Ok(image) = clipboard.get_image() {
                let path = save_clipboard_image(app, screenshots, image)?;
                return Ok(path
                    .map(|path| vec![path.to_string_lossy().into_owned()])
                    .unwrap_or_default());
            }
        }

        Ok(Vec::new())
    }

    fn save_clipboard_image(
        app: &tauri::AppHandle,
        screenshots: &ScreenshotCapture,
        data: ImageData<'_>,
    ) -> std::result::Result<Option<PathBuf>, String> {
        let width = u32::try_from(data.width).map_err(|_| "image width is too large")?;
        let height = u32::try_from(data.height).map_err(|_| "image height is too large")?;
        let byte_count = data
            .width
            .checked_mul(data.height)
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or("image dimensions overflow")?;
        if byte_count == 0 || byte_count > MAX_IMAGE_BYTES || data.bytes.len() != byte_count {
            return Err("clipboard image has invalid or unsupported dimensions".to_string());
        }

        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        data.width.hash(&mut hasher);
        data.height.hash(&mut hasher);
        data.bytes.as_ref().hash(&mut hasher);
        let fingerprint = hasher.finish();

        let mut state = screenshots
            .0
            .lock()
            .map_err(|error| format!("screenshot state lock failed: {error}"))?;
        if state.suppressed == Some(fingerprint) {
            return Ok(None);
        }
        if let Some((previous, path)) = state.last.as_ref() {
            if *previous == fingerprint {
                if path.is_file() {
                    return Ok(Some(path.clone()));
                }
                state.suppressed = Some(fingerprint);
                return Ok(None);
            }
        }

        let rgba = RgbaImage::from_raw(width, height, data.bytes.into_owned())
            .ok_or_else(|| "could not decode clipboard image pixels".to_string())?;
        let directory = app
            .path()
            .picture_dir()
            .map_err(|error| format!("could not locate the Pictures folder: {error}"))?
            .join("Screenshots");
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("could not create screenshot directory: {error}"))?;
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("system clock is invalid: {error}"))?
            .as_millis();
        let sequence = SCREENSHOT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!("screenshot-{timestamp}-{sequence}.png"));
        image::DynamicImage::ImageRgba8(rgba)
            .save_with_format(&path, ImageFormat::Png)
            .map_err(|error| format!("could not save screenshot: {error}"))?;
        let path = std::fs::canonicalize(path)
            .map_err(|error| format!("could not resolve saved screenshot path: {error}"))?;

        state.last = Some((fingerprint, path.clone()));
        state.suppressed = None;
        drop(state);

        Ok(Some(path))
    }

    fn read_file_paths() -> WinResult<Vec<String>> {
        unsafe {
            if OpenClipboard(HWND::default()).is_err() {
                return Ok(Vec::new());
            }

            let result = read_open_file_paths();
            let close_result = CloseClipboard();
            close_result?;
            result
        }
    }

    unsafe fn read_open_file_paths() -> WinResult<Vec<String>> {
        let Ok(handle) = GetClipboardData(CF_HDROP) else {
            return Ok(Vec::new());
        };
        let drop = HDROP(handle.0);
        let count = DragQueryFileW(drop, u32::MAX, None);
        let mut paths = Vec::with_capacity(count as usize);

        for index in 0..count {
            let length = DragQueryFileW(drop, index, None) as usize;
            let mut buffer = vec![0u16; length + 1];
            let copied = DragQueryFileW(drop, index, Some(&mut buffer)) as usize;
            if copied == 0 || copied > length {
                continue;
            }
            paths.push(
                OsString::from_wide(&buffer[..copied])
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        Ok(paths)
    }
}

#[cfg(not(windows))]
mod platform {
    use super::ScreenshotCapture;

    pub fn read_text() -> Result<Option<(u32, Option<String>)>, String> {
        Ok(None)
    }

    pub fn paste_items(
        _app: &tauri::AppHandle,
        _screenshots: &ScreenshotCapture,
    ) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    pub fn delete_managed_screenshot(
        _app: &tauri::AppHandle,
        _screenshots: &ScreenshotCapture,
        _path: String,
    ) -> Result<bool, String> {
        Err("Screenshot deletion is only available on Windows".to_string())
    }

    pub fn list_screenshots(_app: &tauri::AppHandle) -> Result<Vec<String>, String> {
        Err("Screenshot listing is only available on Windows".to_string())
    }

    pub fn copy_image_to_clipboard(_app: &tauri::AppHandle, _path: String) -> Result<(), String> {
        Err("Image clipboard copying is only available on Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{ClipboardHistory, MAX_ITEMS};

    #[test]
    fn stores_only_the_latest_forty_items() {
        let history = ClipboardHistory::default();
        for sequence in 1..=45 {
            history
                .record(sequence, Some(format!("item {sequence}")))
                .expect("record clipboard item");
        }

        let items = history.items().expect("read clipboard history");
        assert_eq!(items.len(), MAX_ITEMS);
        assert_eq!(items.first().map(String::as_str), Some("item 45"));
        assert_eq!(items.last().map(String::as_str), Some("item 6"));
    }

    #[test]
    fn ignores_repeated_sequences_and_empty_text() {
        let history = ClipboardHistory::default();
        history
            .record(1, Some("same text".to_string()))
            .expect("record clipboard item");
        history
            .record(1, Some("same text".to_string()))
            .expect("ignore unchanged clipboard");
        history
            .record(2, Some("  ".to_string()))
            .expect("ignore whitespace-only clipboard");

        assert_eq!(
            history.items().expect("read clipboard history"),
            vec!["same text"]
        );
    }

    #[test]
    fn clearing_history_keeps_the_current_clipboard_from_reappearing() {
        let history = ClipboardHistory::default();
        history
            .record(7, Some("copied text".to_string()))
            .expect("record clipboard item");
        history.clear().expect("clear clipboard history");
        history
            .record(7, Some("copied text".to_string()))
            .expect("ignore unchanged clipboard");

        assert!(history.items().expect("read clipboard history").is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn creates_png_previews_for_shelf_images() {
        use image::{DynamicImage, GenericImageView, ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};

        let directory = std::env::temp_dir().join("Ridge");
        std::fs::create_dir_all(&directory).expect("create preview test directory");
        for (extension, format, image) in [
            (
                "png",
                ImageFormat::Png,
                DynamicImage::ImageRgba8(RgbaImage::from_pixel(320, 180, Rgba([20, 40, 60, 255]))),
            ),
            (
                "jpg",
                ImageFormat::Jpeg,
                DynamicImage::ImageRgb8(RgbImage::from_pixel(320, 180, Rgb([20, 40, 60]))),
            ),
        ] {
            let path = directory.join(format!(
                "shelf-preview-test-{}-{extension}.{extension}",
                std::process::id()
            ));
            image
                .save_with_format(&path, format)
                .expect("write preview test image");

            let preview =
                super::platform::get_shelf_image_preview(path.to_string_lossy().into_owned())
                    .expect("create preview");
            let encoded = preview
                .strip_prefix("data:image/png;base64,")
                .expect("preview is a PNG data URI");
            use base64::Engine;
            let png = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .expect("decode preview data URI");
            let thumbnail = image::load_from_memory(&png).expect("decode preview PNG");
            assert_eq!(thumbnail.dimensions(), (256, 144));
            std::fs::remove_file(path).expect("remove preview test image");
        }
    }

    #[cfg(windows)]
    #[test]
    fn only_deletes_image_files_directly_inside_screenshots_folder() {
        let directory =
            std::env::temp_dir().join(format!("ridge-screenshots-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create managed screenshot directory");
        let screenshot = directory.join("Screenshot (1).png");
        std::fs::write(&screenshot, b"test").expect("create managed screenshot");
        let external = directory.join("photo.txt");
        std::fs::write(&external, b"test").expect("create non-managed image");
        let directory = directory
            .canonicalize()
            .expect("canonicalize Screenshots folder");

        let managed = super::platform::remove_managed_screenshot_file(&screenshot, &directory)
            .expect("delete screenshot");
        assert!(managed.is_some());
        assert!(!screenshot.exists());
        let unmanaged = super::platform::remove_managed_screenshot_file(&external, &directory)
            .expect("reject non-image file");
        assert!(unmanaged.is_none());
        assert!(external.exists());

        std::fs::remove_dir_all(directory).expect("remove test directory");
    }
}
