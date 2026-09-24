# Reskin architecture & contracts

Read `docs/PLAN.md` first for the product spec. This file pins down the
concrete contracts every module builds against. If you change a contract,
update this file in the same change.

## Repository map

```
box.html editor.html            Vite pages (multi-page build)
src/box/                        floating box page — NO engine imports, tiny (≤45 KB gz JS)
src/editor/                     editor page: App.svelte, morph/MorphController.ts, panels/*, dialogs/*
src/engine/                     pure-TS image engine (no Svelte, no DOM in core logic) — unit tested in node
src/lib/ipc/                    commands.ts (typed invoke wrappers), events.ts, mailbox.ts, types.ts, bindings/ (ts-rs, generated)
src/lib/ui/                     shared Svelte components incl. BoxVisual.svelte (used by the box AND the editor proxy)
src/lib/{motion,theme,sound,settings}/
src/testing/tauri-mock.ts       e2e-only fake backend (installed when built with `--mode e2e`)
e2e/*.spec.ts                   Playwright specs against the e2e build
crates/reskin-core/             platform logic (pure modules + `win/` for Windows shell)
src-tauri/                      the Tauri app (windows, animator, mailbox, commands, CLI, tray, smoke test)
```

## IPC contract

* Types: `crates/reskin-core/src/model.rs` → ts-rs → `src/lib/ipc/bindings/*.ts`
  (`pnpm bindings`; re-export new types in `src/lib/ipc/types.ts`). CI fails if
  bindings drift. Wire format: camelCase fields, tagged enums use `type` with
  camelCase variant names (e.g. `{ "type": "needsElevation", ... }`), unit
  enums are camelCase/lowercase strings (see bindings).
* Commands: `src/lib/ipc/commands.ts` is the source of truth for names and
  argument shapes (Rust param `snake_case` ↔ JS key `camelCase`). Rust
  handlers live in `src-tauri/src/commands/*.rs`; the e2e fake in
  `src/testing/tauri-mock.ts` must implement every name in `COMMAND_NAMES`.
* Errors: commands return `Result<T, String>`; JS sees a rejected promise with
  the message string.
* Rust → box: events in `src/lib/ipc/events.ts` (`box:flight`, `box:progress`,
  `box:shown`, `settings:changed`).
* Rust → editor: **mailbox only** (`editor_next(after)` long-poll, returns
  `Envelope[]` with increasing `seq`; returns `[{seq, cmd:{type:'heartbeat'}}]`
  after 25 s of silence). The editor processes envelopes strictly in order and
  awaits each handler before the next.

### Morph / handoff protocol (session numbers increase per open/close)

```
open_editor(items, view)                     [box → Rust]
Rust: place_editor(), move hidden editor     (editor never resizes while visible)
Prepare{session, boxRect(css px, editor-relative), items, view, settings, morph}
   editor: render BoxVisual proxy at boxRect (same skin/size/state as the box),
           await img.decode() + double rAF → editor_ack(session,'prepared')
   (no ack within 400 ms → Rust proceeds with morph=false crossfade)
Rust: show editor (topmost), Reveal{session}
   editor: double rAF → editor_ack(session,'revealed')
Rust: hide box; Expand{session}
   editor: FLIP proxy → panel (~480 ms spring, scaled by animation speed),
           panels stagger in → editor_ack(session,'expanded')
Rust: focus editor, not topmost.

editor_close(reason)                          [editor → Rust]
Rust: editor topmost; Collapse{session, boxRect, then, icon}
   editor: panel → proxy at boxRect → editor_ack(session,'collapsed')
Rust: show box (+ box:shown, box:flight when then=fly/celebrate); Clear{session}
   editor: clear to fully transparent, double rAF → editor_ack(session,'cleared')
Rust: hide editor (+ low-memory: destroy); glide box home if needed.
```
Invariant: a window hides only when its content is transparent and shows only
on top of an identical picture.

## Rust: reskin-core module contracts

Error type: `reskin_core::Error { AccessDenied, NotFound, Unsupported, Cancelled, Other }`
with `Result<T> = std::result::Result<T, Error>`; `From<windows_core::Error>`
maps `E_ACCESSDENIED`. Pixels: `pixels::Rgba` (straight alpha RGBA8).

Pure (all hosts, unit tested on Linux):

* `ico` — `build_ico(&[Rgba])`, `build_ico_from_pngs(&[SizedPng])`, `parse_ico`,
  `validate_ico`, `MAX_ICO_BYTES` (1 MiB). <256 → 32-bpp BMP + AND mask; 256 → PNG.
* `geom` — `place_editor`, `snap_target`, `fling_projection`, `spring_step`,
  `arc_point`, `clamp_into`, `nearest_point_in`, `ease_in_out`.
* `pixels` — `Rgba`, PNG/base64/data-URL helpers, `bgra_to_rgba`,
  `looks_premultiplied_bgra`, `normalize_corner_icon`.
* `grpicon` — `rebuild_ico(group: &[u8], get_icon: impl Fn(u16) -> Option<Vec<u8>>) -> Result<Vec<u8>>`
  (GRPICONDIR/GRPICONDIRENTRY → ICONDIR with file offsets).
* `urlini` — pure INI reader/writer for `.url` files (`[InternetShortcut]` and
  `[InternetShortcut.W]`, UTF-8/UTF-16LE/ANSI input): `UrlFile::parse(bytes)`,
  `.url()`, `.icon_file()`, `.icon_index()`.
* `paths` — `APP_ID`, `AppDirs { roaming, local, program_data }` (`from_env()`,
  `at(root)` for tests) with `settings_file()`, `journal_file()`, `library_dir()`,
  `autosave_file()`, `icons_dir()` (local), `jobs_dir()` (local),
  `public_icons_dir()` (`%ProgramData%\Reskin\icons`); `slugify`,
  `icon_file_name(name, ico) -> "<slug>-<sha256[..12]>.ico"`,
  `is_valid_public_icon_name`, `sha256_hex`.
* `store` — `write_atomic`, `read_json`, `write_json`, `store_icon(dir, name, ico) -> PathBuf`
  (content-hashed, never overwrites), `Library` (`list/save/load/delete`),
  `autosave_write/autosave_read`.
* `settings` — `load(path) -> (Settings, first_run)`, `save`, `normalize`,
  `parse_hotkey`.
* `history` — `Journal` (`load`, `entries`, `begin(NewEntry) -> id` (persists
  *pending* before the target is touched), `commit`, `fail`, `mark_restored`,
  `active_for(target)`, `original_for(target)`, `pending`, `reconcile(probe)`,
  `referenced_icons`, `gc_icons(dir)`). Applying over an active entry: new
  entry keeps the chain's first `original`, sets `supersedes`, old entry →
  `superseded`.
* `job` — elevated job file: `ElevatedJob { version, id, ops: Vec<JobOp> }`,
  `JobOp::{SetShortcutIcon, SetUrlIcon, RestoreShortcutIcon, RestoreUrlIcon}`,
  `validate_job(job, public_desktop, public_icons_dir)`, `trait JobExec`,
  `execute_job(validated, &mut impl JobExec) -> JobResult`, `result_path(job_path)`.
  Validation: target absolute, no `..`, not UNC, directly under the Public
  Desktop (case-insensitive), extension matches op; icon name matches
  `^[a-z0-9-]{1,64}\.ico$`; ICO parses and ≤1 MiB.

Windows (`win/`, `#[cfg(windows)]`, type-checked on Linux with
`--target x86_64-pc-windows-msvc`, run on Windows CI):

* `sta` — `Sta::spawn()`, `Sta::run(f) -> R` (blocking; one STA thread with a
  message pump; COM initialised apartment-threaded). Tauri async commands wrap
  calls in `spawn_blocking`.
* `known` — `desktop()`, `public_desktop()`, `program_data()`, `start_menu()`,
  `common_start_menu()`, `taskbar_pins()`, `roaming_app_data()`, `local_app_data()`
  (SHGetKnownFolderPath).
* `extract` — `Inspected` + `inspect_path(&Path)`, `icon_frames(&Path)`,
  `inspect_system_icon(SystemIconId)`, `system_icon_frames(SystemIconId)`
  (ladder: .ico frames → RT_GROUP_ICON rebuild → IShellItemImageFactory).
* `shortcut` — `LinkInfo`, `read_link`, `set_link_icon(path, Option<(&str, i32)>)`
  (None clears), `create_link(dest, target, args, icon, description)`.
* `urlfile` — `read_url_icon`, `set_url_icon` (CLSID_InternetShortcut + IPropertySetStorage).
* `folder` — `read_folder_icon`, `set_folder_icon(path, Option<(&Path, i32)>)`.
* `sysicons` — `read_system_icon(id) -> OriginalIcon`, `set_system_icon(id, icon)`,
  `restore_system_icon(id, &OriginalIcon)`.
* `notify` — `item_updated(path)`, `assoc_changed()`, `rebuild_icon_cache()`.
* `access` — `probe_writable(path) -> Access`, `location_of(path) -> ItemLocation`.
* `desktop` — `find_desktop_icon(path) -> Option<DesktopSpot>` (IFolderView2 +
  occlusion walk).
* `elevate` — `run_elevated(exe, args) -> Result<i32>` (runas, wait,
  `Error::Cancelled` on 1223) and `WinJobExec: job::JobExec`.
* `fonts` — `system_fonts() -> Vec<String>` (DirectWrite).
* `wallpaper` — `wallpaper_path()`, `wallpaper_info(monitor) -> WallpaperInfo`,
  `accent_color()`, `client_area_animation() -> bool`, `is_windows11()`.
* `contextmenu` — `install(exe)`, `uninstall()`, `is_installed()` (HKCU verbs for
  lnkfile, InternetShortcut, Directory).
* `fullscreen` — `is_fullscreen_busy()` (SHQueryUserNotificationState).

## Rust: src-tauri

* `main.rs` handles `--elevated-apply`, `--restore-all [--quiet]`, `--self-test`
  before building Tauri; otherwise `reskin_lib::run()`.
* `lib.rs` builder: single-instance first, then dialog, opener, autostart,
  global-shortcut; `setup` creates the box (visible) and schedules the editor
  pre-warm; `invoke_handler` registers every command in `commands.ts`.
* `windows/{box_window,editor_window}.rs` build windows `from_config` + WebView2
  tuning; `windows/mailbox.rs` (seq queue + long-poll); `windows/morph.rs`
  (handoff FSM with acks/timeouts/fallback); `windows/animator.rs` (box motion,
  drag loop, fling/snap, flights).
* `commands/*.rs`: `boot, box_cmds, editor_cmds, items, apply, library, system, settings`.
* Permissions: `build.rs` lists every command in `AppManifest::commands`;
  `capabilities/box.json` and `capabilities/editor.json` grant per window.

## Web conventions

* Svelte 5 runes only (`$state`, `$derived`, `$effect`, `$props`); shared
  reactive state in `*.svelte.ts` modules. No external state libs.
* TypeScript strict; `svelte-check --fail-on-warnings` must pass (a11y
  warnings included — use real buttons/labels, `aria-*`, keyboard handlers).
* Import Lucide icons per-icon: `import Brush from '@lucide/svelte/icons/brush'`.
* Aliases: `$lib/…`, `$engine/…`.
* The box page must not import `$engine` or editor code.
* Styles: CSS variables from `src/lib/theme/tokens.css`; font stack
  `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`. No web fonts.
* Motion: every duration goes through `src/lib/motion` (`dur(ms)` applies the
  speed setting and reduced motion). Only animate `transform`, `opacity`,
  `clip-path`, `filter` (sparingly). No idle/continuous animations in the box.
* CSP: no inline scripts, no `eval`, no remote URLs. Images via `data:`/`blob:`.
* Every page entry (`src/*/main.ts`) starts with
  `if (__E2E__) (await import('../testing/tauri-mock')).install('<box|editor>')`
  so the e2e build runs against the fake backend; production builds drop it.
* Unit tests: `src/**/*.test.ts` (Vitest, node env). E2E: `e2e/*.spec.ts`;
  tests drive the fake backend through `window.__e2e` (see tauri-mock.ts).

## Checks (all must pass before pushing)

```
pnpm check && pnpm test && pnpm build && pnpm e2e && pnpm bundle:budget
cargo fmt --all --check
cargo clippy -p reskin-core --all-targets -- -D warnings
cargo test -p reskin-core
cargo clippy --workspace --all-targets --target x86_64-pc-windows-msvc -- -D warnings   # after pnpm build
```
