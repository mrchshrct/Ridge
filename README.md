# Ridge

Ridge is a compact panel for the top of your Windows screen. Hover to open quick access to your music controls, clipboard history, screenshots, file shelf, and calendar—then move on without losing your place.

Built for Windows with Tauri, Rust, React, and TypeScript.

[![CI](https://github.com/mrchshrct/Ridge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/mrchshrct/Ridge/actions/workflows/ci.yml)

## Download

Download the latest Windows installer from the [Ridge Releases page](https://github.com/mrchshrct/Ridge/releases/latest). Choose the `.exe` setup file or the `.msi` installer.

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

The File Shelf watches the current Windows Pictures known folder's `Screenshots` subfolder and adds completed PNG files directly from disk. Clipboard image saving is not monitored automatically; images are only saved when explicitly pasted with Ctrl+V. The media panel reads position and duration from the active GSMTC session; its volume control changes the Windows default playback device's master volume.

The Settings tab lets you unlock and drag the panel to a new screen position, lock it in place, or fully exit Ridge. The lock state and panel position are saved in the app configuration directory.

The Updates section displays the installed version and can check for signed GitHub releases. Automatic checks run at startup and once per day; Ridge always asks before installing an update. The public release manifest and signed updater package are available without authentication.

### Publishing updates

The GitHub Actions release workflow runs for version tags (`v*`). Before tagging a release, update the version in `tauri.conf.json`, `Cargo.toml`, and `package.json` to match the tag. The Tauri signing private key (`%USERPROFILE%\.tauri\ridge.key`) is stored as the repository Actions secret `TAURI_SIGNING_PRIVATE_KEY`. Never commit or publish the private key. The matching public key is embedded in `tauri.conf.json`.

The workflow builds the Windows installers and signed NSIS updater package, then uploads `latest.json` to the GitHub Release. The app verifies the package signature before installation.

The expanded 620×260 panel uses a vertical icon sidebar with the active section name in its header. The media player follows a compact wide layout with a 128px cover, playback controls, and a timeline under the track details.

## License

Ridge is licensed under the [MIT License](./LICENSE).
