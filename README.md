# Ridge

### Your desktop, one gesture away.

Ridge is a small panel that lives at the top of your Windows screen. Hover to bring forward the things you reach for most—music, clipboard, screenshots, files, and calendar—then get back to what you were doing.

**Music controls. Clipboard history. A shelf for screenshots and files. Your calendar.**

[**Download the latest version**](https://github.com/mrchshrct/Ridge/releases/latest) · Free and open source for Windows.

[![CI](https://github.com/mrchshrct/Ridge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mrchshrct/Ridge/actions/workflows/ci.yml)

## Made to stay out of your way

- **Music at a glance** — see the current track and album art, control playback, and scrub through a song.
- **Clipboard close by** — revisit recent text snippets without leaving your current window.
- **Screenshots and files together** — find screenshots from your Pictures folder or drop files onto the panel.
- **A calendar when you need it** — check the date without opening another app.
- **Your panel, your position** — pin Ridge in place or unlock it and move it where it fits your setup.

## Music, through Windows

Ridge reads the active media session provided by Windows, so compatible browser and desktop players can show up without a Ridge browser extension. What appears depends on whether the player publishes its media session to Windows. The volume control adjusts the Windows default playback device.

The File Shelf watches the `Screenshots` folder inside your Windows Pictures folder and picks up completed PNG screenshots. Clipboard images are saved only when you explicitly paste them with `Ctrl+V`; Ridge does not silently save every image copied to the clipboard.

## Download

Get the latest Windows installer from [GitHub Releases](https://github.com/mrchshrct/Ridge/releases/latest). Choose the `.exe` setup file or the `.msi` installer.

Ridge checks for signed updates from public GitHub releases. Automatic checks are optional, and Ridge asks before installing an update.

## Built for Windows

Ridge is built with Tauri 2, Rust, React, and TypeScript. Its compact bar expands into a 620 × 260 panel with a vertical icon sidebar. The media view includes album art, playback controls, and a track timeline.

## Requirements

- Windows 10 or later with WebView2 Runtime
- Node.js and npm
- Rust stable with the MSVC toolchain and Windows build tools

## Development

```powershell
npm install
npm run tauri -- dev
```

## Checks

```powershell
npm run build
cargo test
cargo fmt --all -- --check
npm audit
```

## Release build

```powershell
npm run tauri -- build
```

The Windows executable and installers are generated under `target\release`. Generated frontend assets are written to `dist`.

## Project layout

- `main.tsx`, `App.tsx`, `NotchPanel.tsx`, `index.css` — React frontend
- `main.rs`, `lib.rs`, `media.rs`, `clipboard.rs` — Tauri and Rust backend
- `Cargo.toml` / `Cargo.lock` — Rust dependencies
- `package.json` / `package-lock.json` — frontend dependencies and scripts
- `tauri.conf.json`, `capabilities`, `icons` — Tauri app configuration and assets

Panel position and lock state are saved in the app configuration directory. The Settings tab also lets you reset the panel position or exit Ridge.

### Publishing updates

The GitHub Actions release workflow runs for version tags (`v*`). Before tagging a release, update the version in `tauri.conf.json`, `Cargo.toml`, and `package.json` to match the tag. The Tauri signing private key (`%USERPROFILE%\.tauri\ridge.key`) is stored as the repository Actions secret `TAURI_SIGNING_PRIVATE_KEY`. Never commit or publish the private key. The matching public key is embedded in `tauri.conf.json`.

The workflow builds the Windows installers and signed NSIS updater package, then uploads `latest.json` to the GitHub Release. Ridge verifies the package signature before installation.

## License

Ridge is licensed under the [MIT License](./LICENSE).
