//! Media integration via the Windows System Media Transport Controls (SMTC).
//!
//! Any app that shows up in the Windows volume flyout (Spotify, Edge/Chrome
//! tabs, VLC, Media Player, ...) exposes a session here.

use serde::Serialize;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    /// False when no app currently exposes a media session.
    pub has_session: bool,
    pub title: String,
    pub artist: String,
    pub is_playing: bool,
    /// Human-friendly name of the app that owns the session.
    pub source_app: String,
    pub position_ms: u64,
    pub duration_ms: u64,
}

/// Turns an AppUserModelId such as `Spotify.exe`, `MSEdge` or
/// `Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic` into a display name.
fn friendly_app_name(raw: &str) -> String {
    let id = raw.rsplit('!').next().unwrap_or(raw);
    let lower = id.to_lowercase();
    let lower = lower.trim_end_matches(".exe");

    let known: &[(&str, &str)] = &[
        ("spotify", "Spotify"),
        ("msedge", "Microsoft Edge"),
        ("chrome", "Google Chrome"),
        ("firefox", "Firefox"),
        ("brave", "Brave"),
        ("opera", "Opera"),
        ("vlc", "VLC"),
        ("zunemusic", "Media Player"),
        ("itunes", "iTunes"),
    ];
    for (needle, name) in known {
        if lower.contains(needle) {
            return (*name).to_string();
        }
    }

    let trimmed = id.trim_end_matches(".exe").trim_end_matches(".EXE");
    if trimmed.is_empty() {
        "Unknown app".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(windows)]
mod platform {
    use super::{friendly_app_name, MediaInfo};
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
    use windows::core::{Result, HRESULT};
    use windows::{
        Media::Control::{
            GlobalSystemMediaTransportControlsSession as Session,
            GlobalSystemMediaTransportControlsSessionManager as Manager,
            GlobalSystemMediaTransportControlsSessionMediaProperties as MediaProperties,
            GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
        },
        Storage::Streams::DataReader,
        Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED},
        Win32::{
            Media::Audio::{
                eMultimedia, eRender, Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator,
                MMDeviceEnumerator,
            },
            System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED},
        },
    };

    /// Joins the multithreaded apartment for the current worker thread.
    /// Errors are ignored on purpose: "already initialized" is fine.
    fn init_winrt() {
        unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
        }
    }

    fn is_playing(session: &Session) -> bool {
        session
            .GetPlaybackInfo()
            .and_then(|info| info.PlaybackStatus())
            .map(|status| status == Status::Playing)
            .unwrap_or(false)
    }

    /// Prefers a session that is actually playing; otherwise falls back to the
    /// session Windows considers "current" (usually the last active one).
    fn pick_session(manager: &Manager) -> Option<Session> {
        if let Ok(sessions) = manager.GetSessions() {
            for session in sessions {
                if is_playing(&session) {
                    return Some(session);
                }
            }
        }
        manager.GetCurrentSession().ok()
    }

    pub fn current() -> Result<MediaInfo> {
        init_winrt();

        let manager = Manager::RequestAsync()?.get()?;
        let Some(session) = pick_session(&manager) else {
            return Ok(MediaInfo::default());
        };

        let props = session.TryGetMediaPropertiesAsync()?.get()?;
        let source = session
            .SourceAppUserModelId()
            .map(|id| id.to_string())
            .unwrap_or_default();
        let (position_ms, duration_ms) = session
            .GetTimelineProperties()
            .map(|timeline| {
                let start = timeline.StartTime().map(|time| time.Duration).unwrap_or(0);
                let position = timeline
                    .Position()
                    .map(|time| time.Duration.saturating_sub(start).max(0))
                    .unwrap_or(0);
                let duration = timeline
                    .EndTime()
                    .map(|time| time.Duration.saturating_sub(start).max(0))
                    .unwrap_or(0);
                (
                    u64::try_from(position / 10_000).unwrap_or(0),
                    u64::try_from(duration / 10_000).unwrap_or(0),
                )
            })
            .unwrap_or_default();

        Ok(MediaInfo {
            has_session: true,
            title: props.Title()?.to_string(),
            artist: props.Artist()?.to_string(),
            is_playing: is_playing(&session),
            source_app: friendly_app_name(&source),
            position_ms,
            duration_ms,
        })
    }

    fn image_data_uri(props: &MediaProperties) -> Result<Option<String>> {
        let thumbnail = match props.Thumbnail() {
            Ok(thumbnail) => thumbnail,
            Err(error) if error.code() == HRESULT(0x80004003u32 as i32) => return Ok(None),
            Err(error) => return Err(error),
        };
        let stream = thumbnail.OpenReadAsync()?.get()?;
        let size = stream.Size()?;
        const MAX_COVER_SIZE: u64 = 5 * 1024 * 1024;
        if size == 0 || size > MAX_COVER_SIZE || size > u32::MAX as u64 {
            return Ok(None);
        }

        let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
        reader.LoadAsync(size as u32)?.get()?;
        let mut bytes = vec![0; size as usize];
        reader.ReadBytes(&mut bytes)?;

        let mime = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "image/png"
        } else if bytes.starts_with(b"\xff\xd8\xff") {
            "image/jpeg"
        } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
            "image/gif"
        } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            "image/webp"
        } else if bytes.starts_with(b"BM") {
            "image/bmp"
        } else {
            return Ok(None);
        };

        Ok(Some(format!("data:{mime};base64,{}", BASE64.encode(bytes))))
    }

    pub fn current_art() -> Result<Option<String>> {
        init_winrt();

        let manager = Manager::RequestAsync()?.get()?;
        let Some(session) = pick_session(&manager) else {
            return Ok(None);
        };
        let props = session.TryGetMediaPropertiesAsync()?.get()?;
        image_data_uri(&props)
    }

    pub fn control(action: &str) -> Result<bool> {
        init_winrt();

        let manager = Manager::RequestAsync()?.get()?;
        let Some(session) = pick_session(&manager) else {
            return Ok(false);
        };

        match action {
            "toggle" => session.TryTogglePlayPauseAsync()?.get(),
            "next" => session.TrySkipNextAsync()?.get(),
            "previous" => session.TrySkipPreviousAsync()?.get(),
            _ => Ok(false),
        }
    }

    pub fn seek_to(position_ms: u64) -> Result<bool> {
        init_winrt();
        let manager = Manager::RequestAsync()?.get()?;
        let Some(session) = pick_session(&manager) else {
            return Ok(false);
        };
        let timeline = session.GetTimelineProperties()?;
        let start = timeline.StartTime()?.Duration;
        let min = timeline.MinSeekTime()?.Duration.max(start);
        let end = timeline.EndTime()?.Duration;
        let max = timeline.MaxSeekTime()?.Duration.min(end);
        let requested = start.saturating_add(
            i64::try_from(position_ms)
                .unwrap_or(i64::MAX)
                .saturating_mul(10_000),
        );
        let target = requested.clamp(min, max.max(min));
        session.TryChangePlaybackPositionAsync(target)?.get()
    }

    fn init_com() -> Result<()> {
        unsafe {
            let result = CoInitializeEx(None, COINIT_MULTITHREADED);
            if result.is_ok() || result == windows::core::HRESULT(0x80010106u32 as i32) {
                Ok(())
            } else {
                result.ok()
            }
        }
    }

    pub fn system_volume() -> Result<f32> {
        init_com()?;
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
            let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;
            volume.GetMasterVolumeLevelScalar()
        }
    }

    pub fn set_system_volume(level: f32) -> Result<f32> {
        if !level.is_finite() {
            return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                0x80070057u32 as i32,
            )));
        }

        init_com()?;
        let level = level.clamp(0.0, 1.0);
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
            let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;
            volume.SetMasterVolumeLevelScalar(level, std::ptr::null())?;
            volume.GetMasterVolumeLevelScalar()
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::MediaInfo;

    pub fn current() -> Result<MediaInfo, String> {
        Ok(MediaInfo::default())
    }

    pub fn current_art() -> Result<Option<String>, String> {
        Ok(None)
    }

    pub fn control(_action: &str) -> Result<bool, String> {
        Ok(false)
    }

    pub fn seek_to(_position_ms: u64) -> Result<bool, String> {
        Ok(false)
    }

    pub fn system_volume() -> Result<f32, String> {
        Err("System volume control is only available on Windows".to_string())
    }

    pub fn set_system_volume(_level: f32) -> Result<f32, String> {
        Err("System volume control is only available on Windows".to_string())
    }
}

/// Returns what is playing right now, from whichever app owns the session.
///
/// WinRT calls block, so they run on a worker thread instead of the main
/// (UI) thread.
#[tauri::command]
pub async fn get_current_media() -> Result<MediaInfo, String> {
    let joined =
        tauri::async_runtime::spawn_blocking(|| platform::current().map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())?;
    joined
}

#[tauri::command]
pub async fn get_current_media_art() -> Result<Option<String>, String> {
    let joined =
        tauri::async_runtime::spawn_blocking(|| platform::current_art().map_err(|e| e.to_string()))
            .await
            .map_err(|e| e.to_string())?;
    joined
}

/// `action` is one of `"toggle"`, `"next"` or `"previous"`.
/// Returns whether the target app accepted the command.
#[tauri::command]
pub async fn media_control(action: String) -> Result<bool, String> {
    let joined = tauri::async_runtime::spawn_blocking(move || {
        platform::control(&action).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?;
    joined
}

#[tauri::command]
pub async fn media_seek_to(position_ms: u64) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        platform::seek_to(position_ms).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn get_system_volume() -> Result<f32, String> {
    tauri::async_runtime::spawn_blocking(|| {
        platform::system_volume().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn set_system_volume(level: f32) -> Result<f32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        platform::set_system_volume(level).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::friendly_app_name;

    #[test]
    fn maps_known_apps() {
        assert_eq!(friendly_app_name("Spotify.exe"), "Spotify");
        assert_eq!(friendly_app_name("MSEdge"), "Microsoft Edge");
        assert_eq!(friendly_app_name("chrome.exe"), "Google Chrome");
        assert_eq!(
            friendly_app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"),
            "Media Player"
        );
    }

    #[test]
    fn falls_back_to_the_raw_id() {
        assert_eq!(friendly_app_name("SomePlayer.exe"), "SomePlayer");
        assert_eq!(friendly_app_name(""), "Unknown app");
    }
}
