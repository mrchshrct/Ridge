# Ridge — сборка и запуск

## Требования
- Windows 10 или новее с WebView2 Runtime
- Node.js и npm
- Rust стабильный с MSVC toolchain и Windows build tools

## Установка зависимостей

```powershell
npm install
```

## Запуск в режиме разработки

Запускает Vite dev server и Tauri приложение с горячей перезагрузкой:

```powershell
npm run tauri -- dev
```

Приложение появится вверху по центру экрана в виде узкой панели. Наведите курсор на неё, чтобы развернуть.

## Сборка.release

Собирает фронтенд и Rust бэкенд, упаковывает в `.exe` и инсталяторы (`.msi`, `.nsis`):

```powershell
npm run tauri -- build
```

Результат:
- `target\release\ridge.exe` — исполняемый файл
- `target\release\bundle\msi\` — MSI инсталятор
- `target\release\bundle\nsis\` — NSIS инсталятор
- `dist\` — собранные frontend ассеты

## Проверка (lint + тесты + формат)

```powershell
npm run build        # сборка фронтенда (TypeScript + Vite)
cargo test           # Rust unit-тесты
cargo fmt --all -- --check  # проверка форматирования Rust
npm audit            # проверка уязвимостей npm-зависимостей
```

## Форматирование

```powershell
cargo fmt --all      # применить форматирование Rust
```

## Code signing (Windows)

По умолчанию приложение не подписано доверенным сертификatem, поэтому Windows SmartScreen предупреждает при установке.

### Вариант 1: Сертификат от CA (Code Signing Certificate)
1. Купить сертификат у CA (Sectigo, DigiCert и др.) — ~$200-400/год
2. Экспортировать в `.pfx`, закодировать в base64:
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("codesign.pfx")) | Set-Clipboard
   ```
3. Добавить в GitHub Secrets: `WINDOWS_CERTIFICATE` (base64) и `WINDOWS_CERTIFICATE_PASSWORD`

### Вариант 2: Azure Trusted Signing (~$10/мес)
1. Создать аккаунт Azure Trusted Signing: https://learn.microsoft.com/azure/trusted-signing/
2. Создать Trusted Signing Account и Certificate Profile
3. Зарегистрировать приложение в Azure AD (App Registration)
4. Добавить в GitHub Secrets:
   - `AZURE_CLIENT_ID` — Client ID приложения
   - `AZURE_TENANT_ID` — Tenant ID
   - `AZURE_CLIENT_SECRET` — Client Secret
   - `AZURE_TRUSTED_SIGNING_ACCOUNT` — имя аккаунта Trusted Signing
   - `AZURE_TRUSTED_SIGNING_PROFILE` — имя профиля сертификата
   - `AZURE_TRUSTED_SIGNING_ENDPOINT` — endpoint (напр. `https://eus.codesigning.azure.net`)
5. CI автоматически подпишет `.exe` и `.msi` при наличии секретов

Без секретов сборка проходит нормально, но бинарники останутся неподписанными.

- `main.tsx`, `App.tsx`, `NotchPanel.tsx`, `index.css` — React фронтенд
- `main.rs`, `lib.rs`, `media.rs`, `clipboard.rs` — Tauri/Rust бэкенд
- `Cargo.toml` / `Cargo.lock` — зависимости Rust
- `package.json` / `package-lock.json` — зависимости фронтенда
- `tauri.conf.json` — конфигурация Tauri
- `capabilities`, `icons` — ресурсы Tauri

## Исправления в этой версии

1. **Прогресс-бар музыки** — состояние прогресса (`seekPosition`, `isSeeking`, `mediaError`) и rAF-цикл вынесены из `MediaTab` в `NotchPanel`, чтобы анимация не сбрасывалась при разворачивании/сворачивании панели. Базовая позиция корректируется из опроса `positionMs` без перезапуска анимации (нет скачков и отставания).
2. **Краши** — убран `panic = "abort"` из release-профиля, добавлены паник-хуки, чтение текста из буфера обмена переписано на `arboard` (без небезопасного `GlobalLock`/`slice::from_raw_parts`), фоновые потоки (история буфера обмена и наблюдение за скриншотами) обёрнуты в супервайзеры с `catch_unwind` и автоматическим перезапуском.
