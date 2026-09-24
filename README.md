# Reskin

**A small glass box that floats on your Windows desktop.** Drag a shortcut onto
it and the box opens into an icon editor loaded with that app's icon. Draw,
restyle or start from a preset, then press **Save & Apply**: the box carries
the new icon back to the desktop and drops it onto the real shortcut.

- ~5 MB installer, no admin rights needed, no telemetry, no account.
- Every change is journaled and can be undone — one icon or all of them.
- Works on Windows 10 and 11 (x64).

<p align="center"><img src="docs/screenshots/box-skins.png" alt="The floating box in its four skins" width="720"></p>

## Download

Get the latest version from the **[Releases](https://github.com/KarimEidou/Reskin/releases)** page:

| File | What it is |
| --- | --- |
| `Reskin_<version>_x64-setup.exe` | Recommended. Installs for your user only (no admin prompt), adds a Start-menu entry and an uninstaller. |
| `Reskin_<version>_x64_en-US.msi` | The same app as an MSI package (per-machine; for managed deployments). |
| `Reskin_<version>_x64_portable.exe` | Runs without installing (see [Portable use](#portable-use)). |
| `SHA256SUMS.txt` | Checksums — verify with `Get-FileHash .\Reskin_*_x64-setup.exe` in PowerShell. |

### "Windows protected your PC"

Reskin isn't code-signed yet, so Microsoft Defender SmartScreen may warn the
first time you run the installer. Click **More info → Run anyway**. You can
compare the file's SHA-256 with `SHA256SUMS.txt` from the same release first.

Reskin needs the Microsoft Edge **WebView2 Runtime**, which ships with
Windows 11 and current Windows 10. The installer downloads it automatically
if it is missing.

## Using Reskin

1. **Drop** a desktop shortcut (or several), a folder, an internet shortcut
   (Steam and Epic games included), a program or an image onto the box.
   Clicking the box opens the Start page; right-click it for the menu.
2. **Edit** the icon: brushes, shapes, text, fills and gradients, selections,
   layers with blend modes and effects, 20+ adjustments, a backdrop generator
   and style presets that restyle *your* icon (Glass, Neon, Clay, Sticker,
   Retro Pixel…). Previews show every Windows icon size, the icon on your
   real wallpaper and on the taskbar.
3. **Save & Apply.** The editor folds back into the box, the box flies to the
   shortcut on your desktop and swaps its icon as it lands. An **Undo** chip
   stays on the box for a few seconds.

<p align="center"><img src="docs/screenshots/editor.png" alt="The editor" width="860"></p>

| Drop this | Reskin does |
| --- | --- |
| Shortcut (`.lnk`) | Changes its icon in place. |
| Internet shortcut (`.url`) | Changes its icon in place (Steam / Epic too). |
| Folder | Sets a custom folder icon (`desktop.ini`). |
| Program (`.exe`) or any file | Creates a new desktop shortcut with your icon — Reskin never modifies programs. |
| Image (`.png`, `.jpg`, `.ico`, …) | Starts a design from it (or adds it as a layer). |
| Several items | Queues them; design one and use **Apply style to all**. |
| System icons | Right-click the box → **System icons** (This PC, Recycle Bin, User files, Network, Control Panel). |

Shortcuts on the **Public Desktop** (shared by all users) need administrator
approval: Reskin asks first, and offers a *personal copy* on your own desktop
instead.

### Handy keys

| Key | Action |
| --- | --- |
| `Ctrl+Alt+Shift+R` | Show / hide the box (change it in Settings) |
| `Ctrl+K` | Command palette |
| `?` | All keyboard shortcuts |
| `B` `P` `E` `G` `U` `T` `I` `V` `H` `Z` | Brush, pencil, eraser, fill, shapes, text, eyedropper, move, hand, zoom |
| hold `\` | Compare with the original icon |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |

### Settings worth knowing

- **Appearance:** dark / light / system theme, Windows accent colour, box
  skin (Glass, Neon, Minimal, Aurora), size and idle opacity.
- **Motion:** animation speed and reduced motion (follows Windows by
  default).
- **Behaviour:** start with Windows, Explorer context-menu entry
  *Reskin this icon*, hide the box during fullscreen apps, also update
  matching Start-menu and taskbar-pin shortcuts, sounds.
- **Advanced:** compatibility mode (opaque windows for remote desktop or
  unusual graphics drivers), low-memory mode, refresh desktop icons.

## Restoring icons

- **One icon:** the Undo chip on the box right after applying, or
  **History → Undo / Restore original** in the editor.
- **Everything:** right-click the box → **Restore all icons…**, or run
  `reskin.exe --restore-all` from a terminal.
- **Uninstalling:** if you tick *delete app data* in the uninstaller, Reskin
  first restores every icon it changed.

Reskin stores its icons in `%LOCALAPPDATA%\com.karimeidou.reskin\icons`
(Public-Desktop icons in `%ProgramData%\Reskin\icons`). Its settings,
history journal and Library live in `%APPDATA%\com.karimeidou.reskin`.
If Explorer keeps showing an old icon, use **Settings → Refresh desktop
icons**.

## Portable use

`Reskin_<version>_x64_portable.exe` runs from anywhere (a USB stick, a
folder). It still keeps settings and icons in the folders above, and it
needs the WebView2 Runtime to be installed. Keep the exe where it is while
customised icons are in use, and use **Restore all** before deleting it.

## Privacy

Reskin works entirely offline. It has no telemetry, no update pings and no
accounts; the only network access is the WebView2 bootstrapper the installer
may run. Diagnostics go to `%TEMP%\reskin.log` on your machine only.

## Building from source

Requirements: Windows 10/11 x64, [Node.js](https://nodejs.org) 22 with
pnpm 10 (`corepack enable`), Rust via [rustup](https://rustup.rs) (the
toolchain is pinned in `rust-toolchain.toml`), the Visual Studio C++ build
tools and the WebView2 Runtime.

```powershell
pnpm install
pnpm tauri dev        # run with hot reload
pnpm tauri build      # installers in target\release\bundle
```

Checks (the same as CI):

```powershell
pnpm check; pnpm test; pnpm build; pnpm bundle:budget; pnpm e2e
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace -- --include-ignored   # includes real shell tests
```

Helper modes: `reskin.exe --self-test` prints a JSON health report,
`--smoke-test [--capture-handoff]` exercises the packaged app end to end,
`--restore-all [--quiet]` puts every icon back.

## How it's built

A [Tauri 2](https://tauri.app) app: Rust for the Windows side and a Svelte 5
+ TypeScript front end in two transparent WebView2 windows, the box and the
editor, which hand over to each other seamlessly. The image engine is plain
TypeScript and runs in a worker where it pays off. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the contracts and
[`docs/UI.md`](docs/UI.md) for the interaction design.

## License

MIT — see [LICENSE](LICENSE).
