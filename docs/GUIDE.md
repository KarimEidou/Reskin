# Reskin user guide

Everything Reskin can do, and how to undo all of it. New here? The
[README](../README.md) gets you going in a minute.

- [Install](#install)
- [Using Reskin](#using-reskin)
- [Handy keys](#handy-keys)
- [Settings worth knowing](#settings-worth-knowing)
- [Restoring icons](#restoring-icons)
- [Uninstalling](#uninstalling)
- [Portable use](#portable-use)
- [Troubleshooting](#troubleshooting)
- [Privacy](#privacy)

## Install

Download from the **[latest release](https://github.com/KarimEidou/Reskin/releases/latest)**:

| File | What it is |
| --- | --- |
| [`Reskin-Setup.exe`](https://github.com/KarimEidou/Reskin/releases/latest/download/Reskin-Setup.exe) | **Recommended.** Installs for your user only (no admin prompt), adds a Start-menu entry and an uninstaller. |
| [`Reskin-Portable.exe`](https://github.com/KarimEidou/Reskin/releases/latest/download/Reskin-Portable.exe) | Runs without installing (see [Portable use](#portable-use)). |
| [`Reskin.msi`](https://github.com/KarimEidou/Reskin/releases/latest/download/Reskin.msi) | The same app as an MSI package (per-machine; for managed deployments). |
| `THIRD_PARTY_NOTICES.txt` | Licenses of the open-source software inside Reskin (also in **Settings → About → Open-source licenses**). |
| `SHA256SUMS.txt` | Checksums — verify with `Get-FileHash .\Reskin-Setup.exe` in PowerShell. |

Reskin works on Windows 10 and 11 (64-bit).

### "Windows protected your PC"

Reskin isn't code-signed yet, so Microsoft Defender SmartScreen may warn the
first time you run the installer. Click **More info → Run anyway**. You can
compare the file's SHA-256 with `SHA256SUMS.txt` from the same release first.
Your browser may also say the file "isn't commonly downloaded": choose
**Keep**.

Reskin needs the Microsoft Edge **WebView2 Runtime**, which ships with
Windows 11 and current Windows 10. The installer downloads it automatically
if it is missing.

## Using Reskin

1. **Drop** a desktop shortcut (or several), a folder, an internet shortcut
   (Steam and Epic games included), a program or an image onto the box — or
   right-click a shortcut or folder in Explorer → **Reskin this icon** (turn
   it on in Settings; on Windows 11 it is under *Show more options*).
   Clicking the box opens the Start page; right-click it, or the tray icon,
   for the menu.
2. **Edit** the icon: brush, spray, pencil, shapes, text, fills and
   gradients, selections (rectangle, ellipse, lasso, magic wand), smudge,
   blur / sharpen and dodge / burn, stickers and emoji, layers with blend
   modes and effects, 20+ adjustments, a backdrop generator and style presets
   that restyle *your* icon (Glass, Neon, Clay, Sticker, Retro Pixel…).
   Previews show every icon size from 16 to 256 px, the icon on your real
   wallpaper and on the taskbar.
3. **Save & Apply.** The editor folds back into the box, the box flies to the
   shortcut on your desktop and swaps its icon as it lands. An **Undo** chip
   stays on the box for a few seconds. With several items queued, each apply
   opens the next one (with an Undo of its own) until the last flies home.

<p align="center"><img src="screenshots/editor.png" alt="The editor: a shortcut's icon in the Neon style, with the tool rail, the Styles panel and the size previews" width="860"></p>

| Drop this | Reskin does |
| --- | --- |
| Shortcut (`.lnk`) | Changes its icon in place. A Store app's shortcut, whose own icon Windows ignores, gets a classic shortcut with your icon instead. |
| Internet shortcut (`.url`) | Changes its icon in place (Steam / Epic too). |
| Folder | Sets a custom folder icon (`desktop.ini`). |
| Program (`.exe`) or any file | Creates a new desktop shortcut with your icon — Reskin never modifies programs. |
| Image (`.png`, `.jpg`, `.ico`, …) | Starts a design from it (or adds it as a layer). |
| Reskin project (`.reskin`) | Opens the saved design. |
| Several items | Queues them; design one and use **Apply style to all**. |
| System icons | Right-click the box → **System icons** (This PC, Recycle Bin, User files, Network, Control Panel). |

**Open image…** (`Ctrl+O`) picks images, icons, shortcuts, programs and
`.reskin` projects. While a design is open, whatever you drop, pick or paste
asks first whether it becomes a layer or a new item in the queue — nothing
you are editing is replaced.

Shortcuts on the **Public Desktop** (shared by all users) need administrator
approval: Reskin asks first, and offers a *personal copy* on your own desktop
instead. Other items Windows won't let you change (read-only shortcuts, the
all-users Start menu) can't be changed in place; Reskin says so before it
touches anything and offers the personal copy for shortcuts.

The box comes in four skins — pick one in **Settings → Appearance**:

<p align="center"><img src="screenshots/box-skins.png" alt="The floating box in its four skins: Glass, Neon, Minimal and Aurora" width="720"></p>

## Handy keys

| Key | Action |
| --- | --- |
| `Ctrl+Alt+Shift+R` | Show / hide the box (change it in Settings) |
| `Ctrl+K` | Command palette — every command, adjustment and style |
| `?` | All keyboard shortcuts |
| `V` · `M` `Shift+M` · `L` · `W` | Move, rectangle / ellipse select, lasso, magic wand |
| `B` · `A` · `P` · `E` | Brush, spray, pencil, eraser |
| `G` · `Shift+G` · `U` · `T` · `I` · `S` | Fill, gradient, shapes, text, eyedropper, sticker stamp |
| `R` · `Shift+R` · `O` | Smudge, blur / sharpen, dodge / burn |
| `H` · `Z` · hold `Space` | Hand, zoom, pan while held |
| `M`, `B` or `R` again | Next tool of the group: rectangle ↔ ellipse, brush ↔ spray, smudge → blur / sharpen → dodge / burn |
| `X` / `D` | Swap / reset the colours |
| hold `\` | Compare with the original icon |
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+S` / `Ctrl+Enter` | Save to Library / Save & Apply |

## Settings worth knowing

- **Appearance:** dark / light / system theme, Windows accent colour, box
  skin (Glass, Neon, Minimal, Aurora), box size, opacity at rest and editor
  size.
- **Motion:** animation speed, reduced motion (follows Windows by default),
  morph or crossfade when the editor opens, and whether the new icon flies
  to the desktop.
- **Behaviour:** the global shortcut (a key with Ctrl, Alt or Win; F1–F24
  also with just Shift), start with Windows, Explorer context-menu entry
  *Reskin this icon*, hide the box during full-screen apps (**Show box** in
  the tray brings it back over one), also update matching Start-menu and
  taskbar-pin shortcuts (undone together with the icon), sounds.
- **Advanced:** compatibility mode (opaque windows for remote desktop or
  unusual graphics drivers), low-memory mode (closes the editor completely
  when you're done), refresh desktop icons (or rebuild the icon cache), the
  sizes written into `.ico` files and the pixel-art grid.

## Restoring icons

- **One icon:** the Undo chip on the box right after applying, or
  **History → Undo / Restore original** in the editor. Undo also undoes the
  matching Start-menu and taskbar pins the apply changed.
- **Everything:** right-click the box (or the tray icon) → **Restore all
  icons…**, **History → Restore all…**, or run `reskin.exe --restore-all`
  from a terminal — also while Reskin is running. It exits with code 0 when
  every icon is back and 3 otherwise. Public-Desktop items ask for
  administrator approval once (per 64 items). From a terminal run as
  administrator it starts itself again as the signed-in user and restores
  their icons (if it can't, it changes nothing and exits with 3). An item
  you have deleted since counts as restored: nothing of it is left to put
  back.

Reskin is a windowed program, so a terminal doesn't wait for it to finish
(a `.cmd` script does). To wait for `--restore-all` and see its exit code,
run it from the folder that holds `reskin.exe` (`%LOCALAPPDATA%\Reskin` when
installed with the setup). In Command Prompt:

```bat
start /wait reskin.exe --restore-all
echo %ERRORLEVEL%
```

In PowerShell:

```powershell
(Start-Process .\reskin.exe -ArgumentList '--restore-all' -Wait -PassThru).ExitCode
```

## Uninstalling

- **Installer (`Reskin-Setup.exe`):** open Windows **Settings → Apps**, find
  Reskin and choose **Uninstall**. The uninstaller removes the Explorer entry
  and "Start with Windows". If you tick *Delete app data*, Reskin first puts
  back every icon it changed (as the signed-in user, even when the
  uninstaller runs as administrator; Public-Desktop items ask for
  administrator approval); if any icon can't be put back, it says so and
  keeps its data, so your icons keep working and can still be restored. For
  a silent uninstall that does the same, run
  `uninstall.exe /S /DELETEAPPDATA`. The restore also deletes the
  Public-Desktop icons it no longer needs (unless a Public Desktop shortcut
  still shows them); the shared `%ProgramData%\Reskin` folder itself stays,
  since other accounts on the PC may use its icons.
- **MSI package:** uninstalling removes the Explorer entry but leaves
  Reskin's data and the icons it applied alone. Use **Restore all icons…**
  and turn off **Start with Windows** first.

Reskin stores its icons in `%LOCALAPPDATA%\com.karimeidou.reskin\icons`
(Public-Desktop icons in `%ProgramData%\Reskin\icons`, a folder only
administrators can change). Its settings, history journal, Library and
unsaved-design backup live in `%APPDATA%\com.karimeidou.reskin`.

## Portable use

`Reskin-Portable.exe` runs from anywhere (a USB stick, a folder). It keeps
settings and icons in the same folders as the installed app, and it needs
the WebView2 Runtime: when that is missing, Reskin says so as it starts and
offers to open Microsoft's download page. Your new icons keep working
without the exe. Before you delete it, turn off **Start with Windows** and
the Explorer entry, and use **Restore all icons…** if you want the original
icons back.

## Troubleshooting

- **The box is gone.** Press `Ctrl+Alt+Shift+R`, or use **Show box** in the
  menu of Reskin's tray icon (in the notification area of the taskbar). The
  box hides by itself while a full-screen app or game runs. After a restart,
  start Reskin from the Start menu — or turn on **Settings → Start with
  Windows** so the box is always there.
- **The shortcut key does nothing.** Another app may use it: Reskin says so
  in Settings, where you can pick another one.
- **Explorer still shows the old icon.** Use **Settings → Refresh desktop
  icons** (it can also rebuild Windows' icon cache).
- **The windows look wrong over remote desktop or with an unusual graphics
  driver.** Turn on **Settings → Advanced → Compatibility mode**.
- **Something else went wrong.** Reskin writes what it did to
  `%TEMP%\reskin.log`. [Open an issue](https://github.com/KarimEidou/Reskin/issues/new/choose)
  and attach that file.

## Privacy

Reskin works entirely offline. It has no telemetry, no update pings and no
accounts; the only network access is the WebView2 bootstrapper the installer
may run (links such as Releases open in your browser). Diagnostics go to
`%TEMP%\reskin.log` on your machine only.
