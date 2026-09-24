# Reskin — a floating icon-customizer box for Windows (v1.0 plan)

> This is the approved product/engineering plan. `docs/ARCHITECTURE.md` holds the
> concrete conventions and contracts derived from it. Where they differ on a
> detail, ARCHITECTURE.md wins (it reflects what is actually built).

## Context
- A small, glassy **box floats on the desktop**.
- You drag a desktop app into it, and the box **animates open into an icon editor** loaded with that app's icon.
- You draw, edit and restyle the icon, and **Save & Apply** changes the real desktop icon.
- It must feel smooth, stay lightweight, have lots of features, and be downloadable.

Name **Reskin**. productName `Reskin`, binary `reskin.exe`, identifier `com.karimeidou.reskin`, license MIT.
Once Windows CI is green, v1.0.0 is published as a GitHub Release by pushing a `v1.0.0` tag.

## Stack
- **Tauri 2.11 + WebView2** (~5–8 MB installer, native Win32/COM access).
  - `tauri` 2.11.6 (`tray-icon`), `tauri-build` 2.6.3, `@tauri-apps/cli` 2.11.5, `@tauri-apps/api` 2.11.1
  - plugins: single-instance 2.4.5 (registered first), dialog 2.7.3, opener 2.5.5, global-shortcut 2.3.2. "Start with
    Windows" is Reskin's own quoted HKCU `Run` value (`reskin-core` `settings::autostart`).
- **Front end**: Svelte 5.57 + TypeScript ~5.9.3 + Vite 8.3. `vite build` builds each page on its own (`vite.config.ts`
  `environments`: the editor, then the box, into one outDir), so the box never loads chunks shared with the editor; its
  initial JS stays ≤ 33.5 KB gz (`pnpm bundle:budget`). The dev server serves both pages from one environment.
  `@sveltejs/vite-plugin-svelte` 7.3, `@lucide/svelte` 1.47 (tree-shaken UI icons). UI font: system Segoe UI Variable.
  Sounds synthesized with WebAudio. No font or audio assets ship.
- **Rust**: `windows` = 0.61.3 (same as tauri/tao/webview2-com), `webview2-com` 0.38, `ico` 0.5, `png` 0.17, `sha2`, `base64`,
  `serde`/`serde_json`, `ts-rs` (IPC types for TS). No crates that compile C. `rust-toolchain.toml` pins 1.94.1.
- **Tests**: Vitest 5 (node unit tests), `node --test` for the build scripts. `@playwright/test` 1.56.1 (Chromium 1194).
  `pngjs` for e2e assertions.
- **Bundles**: NSIS setup `.exe` (`installMode: currentUser`, `webviewInstallMode: downloadBootstrapper(silent)`), `.msi`,
  portable `.exe`, `THIRD_PARTY_NOTICES.txt`, `SHA256SUMS.txt`. Release profile: `lto`, `codegen-units=1`, `opt-level="s"`,
  `strip`, `panic="abort"` (a panic hook logs to `reskin.log` and tells the user before the process ends).

## Architecture
- **Two transparent, frameless, `shadow:false` windows**, declared in `tauri.conf.json` with `"create": false` and built in Rust via
  `WebviewWindowBuilder::from_config` (gives `enable_clipboard_access`, `on_page_load`, WebView2 tuning: accelerator keys,
  context menu, pinch zoom and swipe off; memory target LOW while hidden).
  - **box**: 148×148 logical (Medium), 120 px visual (14 px margin for glow/scale); topmost, `skipTaskbar`, `focused(false)`,
    created visible at its saved position; never resized (except when the size setting changes).
  - **editor**: pre-warmed ~1.5 s after launch (10 s with `--autostart`; not at all in low-memory mode, unless the welcome or
    an `--edit` opens it right away); created hidden off-screen, then shown and hidden once ("prime") to dodge wry/tauri
    hidden-window bugs; sizes S/M/L from Settings; never resized while visible.
  - **Transparent windows are only ever hidden, never minimized.** No cursor-event toggling (tauri#15947).
  - **Compatibility (opaque) mode** setting: solid backgrounds and Win11 rounded corners via DWM; the box is clipped to its
    visual with a window region, rebuilt when the box changes size or moves to a monitor with another DPI.
- **Rust animator thread** owns every box movement: time-based `SetWindowPos(..NOSIZE|NOZORDER|NOACTIVATE|ASYNCWINDOWPOS)`
  paced by `DwmFlush()`; HWNDs cross threads as `isize`.
  - **`box_drag`** (JS pointerdown invokes it) runs the move loop with `GetCursorPos` + `GetAsyncKeyState`; 4 px threshold
    separates click from drag; on release applies fling and edge/corner snap springs and saves the position; returns `click|moved`.
    Replaces `data-tauri-drag-region` (eats mouseup, toggles maximize on double-click).
- **Editor command mailbox**: Rust→editor commands go through a sequence-numbered long-poll `invoke('editor_next', {after})`
  with a 25 s heartbeat, not events (events to hidden-created windows can be dropped, tauri#15652). The box uses normal events.
- **One STA COM worker thread** with a message pump runs all shell work. Commands are `async` and never run COM on the main thread.
- **Security**: JS gets opaque `ItemId`s from `inspect_paths`; Rust keeps `ItemId → path`. Mutating commands never accept raw
  paths. Capabilities split per window (`capabilities/box.json`, `capabilities/editor.json`); app-command permissions from
  `build.rs` via `AppManifest::commands`. Strict CSP: `default-src 'self'`, `img-src 'self' data: blob:`,
  `connect-src 'self' ipc: http://ipc.localhost`.
- **Data locations** (folder names match the bundle id so the uninstaller's "delete app data" covers them):
  - `%APPDATA%\com.karimeidou.reskin\`: `settings.json`, `journal.json`, `library\*.reskin`, `autosave.reskin`
  - `%LOCALAPPDATA%\com.karimeidou.reskin\icons\<slug>-<sha256[..12]>.ico`: content-hashed, never overwritten
  - `%ProgramData%\Reskin\icons\`: icons for Public-Desktop items, written by the elevated helper

## UX & animation
**Box states:** `idle` (static glass, no continuous animation, idle CPU ~0), `hover` (lifts slightly), `armed` (drag-enter: swells,
bright rim, particles pulling inward, count badge for multiple items; `inspect_paths` starts right away), `absorbing` (icon flies
from the drop point into the box with squash and stretch), `busy` (progress ring for batch jobs), `flying`, `celebrate`, `error` (shake).

**Box extras:** skins Glass, Neon, Minimal, Aurora; sizes S/M/L; adjustable idle opacity; auto-hides while a fullscreen app runs
(`SHQueryUserNotificationState`). Click opens the editor's Start view. Right-click calls `box_menu` → native popup menu:
Open editor, Library, System icons ▸, Restore all icons…, Settings, Hide box, Quit Reskin. Tray icon has the same menu; its
item follows the box: *Hide box* while it shows, else *Show box*, which shows it (closing an open editor into it) — over a
fullscreen app too (also the one just left for the tray), until no fullscreen app has been seen for 30 s or the box is hidden
again. Global hotkey (default `Ctrl+Alt+Shift+R`,
rebindable) and a tray click toggle the box (while a fullscreen app hides it: open the editor). Starting Reskin again brings
the open editor to the front, else shows the box. **First run** (until the welcome is finished: `Settings.onboarded`;
not at an `--autostart` start): editor opens on a short animated welcome, then morphs down into the box with the hint "drag a
shortcut onto me".

**Open (handoff protocol).** Neither window ever resizes while visible.
1. Rust computes `geom::place_editor(box_rect, work_area, size)` (editor contains the box, grows toward screen centre, clamped to
   the work area) and moves the hidden editor there.
2. Rust sends `Prepare{box_rect_css, items, settings}` via the mailbox. The editor draws a box proxy with the same
   `BoxVisual.svelte` the box uses, waits for `img.decode()` and a double rAF, then acks `Prepared`.
3. Rust shows the editor topmost and sends `Reveal`. Editor acks `Revealed` after a double rAF; Rust hides the box, sends `Expand`.
4. The proxy FLIP-morphs into the panel (transform/opacity/clip-path, ~480 ms spring); panels stagger in; the icon settles onto
   the canvas. Rust then focuses the editor and makes it non-topmost.
5. If `Prepared` doesn't arrive within 400 ms → simple crossfade fallback (also a user setting).

**Collapse** (reverse): Rust makes the editor topmost; the panel collapses into a proxy at the box's home (or nearest in-window
point if the editor moved); editor acks `Collapsed`; Rust shows the box; editor clears to transparent and acks `Cleared`;
Rust hides the editor; if the box isn't home the animator glides it home.

**Invariant:** a window hides only when its content is transparent, and shows only on top of an identical picture.

**Save & Apply:** Apply button morphs into a ring; Rust builds the `.ico`, journals, checks access → editor collapses → if the
desktop icon is visible the box flies an arc to it carrying the new icon → at landing Rust **commits** and calls `SHChangeNotify`
→ sparkle ripple, box flies home. Occluded/unknown → in-place celebration. Toast offers **Undo** for 6 s. Errors: box shakes,
toast shows the fix (elevate, or make a personal copy).

## Features (v1.0)
**Targets:** `.lnk`; `.url` (incl. Steam/Epic); folders; **system icons** from a picker (This PC, Recycle Bin empty/full,
User files, Network, Control Panel); `.exe`/other files → offer a new desktop shortcut with the icon (never modify the exe);
image files → design source; multiple items → batch queue with "Apply style to all" + progress ring; optional "also update
matching Start-menu and taskbar-pin shortcuts"; Store-app (AppsFolder) shortcuts detected, offer a classic shortcut.

**Editor:** 512² master canvas + pixel-art mode (16/24/32/48/64 grids, nearest-neighbour). Layers: raster + editable text,
opacity, 12 blend modes, visibility, lock, rename, pointer-drag reorder, duplicate, merge down, flatten, thumbnails.
Non-destructive layer effects: drop shadow, outer glow, outline, colour overlay, inner shadow.
Tools: brush (spacing, hardness, flow, pressure, 1€ smoothing), pixel-perfect pencil, eraser, spray, smudge, blur, dodge/burn;
fill (scanline, tolerance, contiguous), gradient (linear/radial/conic); shapes rect, rounded, ellipse, line, arrow, polygon, star,
heart, squircle; text with system fonts; eyedropper (+ EyeDropper API if available); move/transform with handles; selections
rect/ellipse/lasso/magic wand with add/subtract/invert/feather + marching ants; sticker & emoji stamp; hand; zoom; symmetry X/Y/radial N.
Adjustments (live preview, in a worker): brightness/contrast, hue/saturation, invert, grayscale, sepia, colorize, duotone/gradient
map, posterize, threshold, blur, sharpen, pixelate, noise, vignette, emboss, sketch/edges, glow, chromatic aberration.
Icon helpers: remove background (flood from corners), auto-trim & center, fit to shape, round corners, add badge.
Backdrop generator: circle, rounded, squircle, hexagon, shield, seeded blob; solid/gradient fill, gloss, border.
Style presets rendered live from your icon: Glass, Neon, Mono Light/Dark, Pastel, Retro Pixel, Sticker, Clay, Gradient Silhouette,
Fluent, Duotone, Sketch. Colour: HSV picker + hex/RGB/alpha + recents; palettes Fluent, Material, Pastel, Neon, Earth, Grayscale;
dominant colours (median cut); gradient editor. Undo/redo + history panel (tile snapshots, 256 MB LRU), zoom/pan, pixel grid,
Windows keyline guides, before/after (hold `\` or split view). Previews 16–256 px through the real export path; icon on your
actual wallpaper with its label; taskbar light/dark previews. Import from dialog (images, icons, shortcuts, programs and
`.reskin` projects), drop, paste, or another shortcut's icon (popover: layer or queue?). Export `.ico`, `.png`, clipboard,
`.reskin`. Library of saved designs + per-target history, Restore original / Restore all. Autosave + crash recovery.

**App:** command palette (Ctrl+K), shortcuts overlay (`?`), toasts; themes dark/light/system + Windows accent; animation speed and
reduced motion (Windows `SPI_GETCLIENTAREAANIMATION`, read live, + media query; the pages re-read accent and animation effects
when their window gains focus); optional sounds, autostart, Explorer context-menu verb "Reskin this icon" (HKCU, toggle);
"Refresh desktop icons" (`SHChangeNotify` or `ie4uinit -show`); low-memory mode (destroy the editor on close, no pre-warm);
About with a link to Releases (private repo: no automatic update check) and the open-source licenses.
Hotkey, autostart and Explorer verb mirror OS state: a change Windows refuses is taken back before it is saved (a new hotkey is
registered before the old one is released), "Start with Windows" follows Task Manager at startup, and a hotkey another app
holds is flagged in Settings.

## Windows integration (`crates/reskin-core/src/win/*`)
- **Extraction ladder:** (a) `.ico` files: all frames; (b) PE `RT_GROUP_ICON`: exact ICO rebuild via
  `LoadLibraryExW(AS_DATAFILE|AS_IMAGE_RESOURCE)`; (c) `IShellItemImageFactory::GetImage(256, ICONONLY|BIGGERSIZEOK)` →
  `GetDIBits`, premultiplied check (straight if any r,g,b > a), alpha-bbox normalisation (small icons in the corner of a 256
  canvas). `.lnk` details: raw path, IDList, IconLocation, expand `%vars%`. Writability probed with `CreateFileW(GENERIC_WRITE)`.
- **ICO build:** sizes `[16,20,24,32,40,48,60,64,72,96,128,256]`; BMP below 256, PNG for 256.
- **Apply:** `.lnk`: `IPersistFile::Load(STGM_READWRITE)` → `IShellLinkW::SetIconLocation` → `Save`. `.url`:
  `CLSID_InternetShortcut` via `IPropertySetStorage`/`FMTID_Intshcut` `PID_IS_ICONFILE`/`ICONINDEX` (handles
  `[InternetShortcut.W]`); a pure-Rust INI reader handles backups and tests. Folders: `SHGetSetFolderCustomSettings(FCSM_ICONFILE,
  FCS_FORCEWRITE)`. System icons: `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\CLSID\{GUID}\DefaultIcon`
  (Recycle Bin `(Default)`/`empty`/`full`). After each apply: `SHChangeNotify(UPDATEITEM, PATHW|FLUSHNOWAIT)` or ASSOCCHANGED.
- **Journal:** `pending` → `applied`, originals first; atomic writes (tmp + rename); reconcile on startup. **Restore** writes
  originals back (empty IconLocation, delete HKCU values, delete Reskin-created shortcuts) then GCs unreferenced `.ico`s.
- **Elevation:** on `E_ACCESSDENIED` (Public Desktop), after asking. Self-contained job `…\jobs\<uuid>.json` (absolute targets +
  embedded ICO bytes, at most 64 ops: one prompt each). `ShellExecuteExW("runas")` → `reskin.exe --elevated-apply <job>`;
  parent waits, then reads the helper's result `%ProgramData%\Reskin\results\<job id>.json` — only a plain file owned by
  Administrators or SYSTEM that agrees with the exit code, else the exit code alone decides; UAC cancel (1223) handled.
  Helper validates: job read once without following a link (size-capped), targets directly on `FOLDERID_PublicDesktop`,
  destination matches `%ProgramData%\Reskin\icons\[a-z0-9-]{1,64}\.ico` (no device names), ICO parses and ≤1 MB. Link-safe
  access (folders from the known-folder API, never the environment): it writes only in the admin-owned `%ProgramData%\Reskin`
  tree (folders created owned by Administrators with a protected DACL, held open while it works); every file is opened
  without following a reparse point, created `CREATE_NEW`, checked by final path and deleted by handle; a Public-Desktop
  shortcut must be a plain file directly there before the shell edits it, and a `.url` rewritten by hand goes through a file
  created beside it the same way and renamed over it by handle. No log. Alternative: "personal copy" on the user's desktop.
- **Desktop icon lookup:** `ShellWindows.FindWindowSW(CSIDL_DESKTOP, SWC_DESKTOP)` → `QueryService(SID_STopLevelBrowser)` →
  `QueryActiveShellView` → `IFolderView2`; match by `SHGDN_FORPARSING`; `GetItemPosition` (relative to `SysListView32`) +
  `MapWindowPoints`; icon size; `FWF_NOICONS`; z-order walk for occlusion (skip own, hidden, minimized, cloaked windows).
- **CLI:** in `main()` before the builder: `--elevated-apply <job>` (exit 0/2/3), `--restore-all [--quiet]`, `--self-test` (JSON).
  In-app: `--edit <path>` (context-menu verb, forwarded by single-instance), `--autostart`, `--smoke-test [--capture-handoff]`.
  Started "as administrator", the app starts itself again unelevated through Explorer (`IShellDispatch2::ShellExecute`,
  marked `--relaunched`) and exits; if that fails it warns and carries on. `--restore-all` with an administrator's full token
  (an elevated terminal or uninstaller) restores nothing itself: it starts itself again as the desktop user
  (`CreateProcessWithTokenW` with Explorer's token, `--relaunched`), waits and returns that run's exit code; when it cannot,
  it refuses with exit 3 (the uninstaller then keeps the data).
- **Uninstall:** NSIS: `src-tauri/windows/hooks.nsh` (`NSIS_HOOK_PREUNINSTALL`; nothing on an update) deletes the Explorer
  verb keys and the "Start with Windows" `Run` value with Task Manager's flag for it (`StartupApproved\Run`); a silent or
  passive uninstall ticks *Delete app data* with `/DELETEAPPDATA`. With it ticked, `reskin.exe --restore-all --quiet` runs
  first (Public-Desktop items ask for approval once per 64; an item deleted since counts as restored; Public-Desktop icons
  nothing needs any more go too); if the restore fails (exit ≠ 0) the uninstaller says so and keeps the data, so the icons
  keep working and can still be restored. MSI: `src-tauri/windows/uninstall.wxs` removes the Explorer verb keys (HKCU) with
  the app and keeps Reskin's data and applied icons.

## Build, CI & release
- Local: `pnpm check && pnpm test && pnpm build && pnpm e2e`; `cargo fmt --all --check && cargo clippy -p reskin-core
  --all-targets -- -D warnings && cargo test -p reskin-core`; `cargo clippy --workspace --all-targets --target
  x86_64-pc-windows-msvc -- -D warnings` (pnpm build first).
- `ci.yml`: web (ubuntu), rust-core (ubuntu, incl. msvc-target clippy + ts-rs bindings diff), windows (windows-latest: build,
  clippy, `cargo test --workspace -- --include-ignored`, ensure-webview2, `pnpm tauri build`, `--smoke-test --capture-handoff`,
  installer round-trip, upload artifacts).
- `release.yml` on `v*` tags: a gate job checks that the tag matches package.json, tauri.conf.json and the Cargo workspace
  version and that `ci.yml` succeeded on the tagged commit (waiting for a run in progress); then build (`pnpm build` under
  `tauri build` also writes `THIRD_PARTY_NOTICES.txt` from the production npm tree and the crates linked into `reskin.exe`,
  `scripts/third-party-notices.mjs`), `--smoke-test --capture-handoff`, stage `Reskin_<v>_x64-setup.exe`,
  `Reskin_<v>_x64_en-US.msi`, `Reskin_<v>_x64_portable.exe`, `THIRD_PARTY_NOTICES.txt`, `SHA256SUMS.txt`; publish with
  `softprops/action-gh-release@v3`.

## Milestones
1. M1 Skeleton + CI  2. M2 Box, drop, inspect, morph  3. M3 Editor core  4. M4 Apply, restore, history
5. M5 Feature breadth  6. M6 Polish & performance  7. M7 Release. (Details and verification per milestone: see the
original plan; summarized in ARCHITECTURE.md "Verification".)

## Risks & fallbacks
Morph glitches → ack protocol + invariant + shared BoxVisual + 400 ms crossfade fallback. Hidden-window IPC/drop bugs → prime,
mailbox, box created visible, recreate editor if mailbox silent 2 s. Transparency failures → no cursor toggling/minimize/idle
animation + compatibility mode. Stale icon cache → content-hashed paths, SHChangeNotify, `ie4uinit -show`. Elevation/UIPI → app
always non-elevated (started as administrator, it restarts unelevated through Explorer; `--restore-all` restarts as the
desktop user); privileged writes only via the validated helper. Desktop lookup fails → celebrate in place. Unsigned exe
SmartScreen → documented. Missing WebView2 → bootstrapper + CI step; the portable exe checks for the runtime before building
any window and offers Microsoft's download.
