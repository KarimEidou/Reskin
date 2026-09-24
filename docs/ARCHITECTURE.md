# Reskin architecture & contracts

Read `docs/PLAN.md` first for the product spec. This file pins down the
concrete contracts every module builds against. If you change a contract,
update this file in the same change.

## Repository map

```
box.html editor.html            Vite pages, each built on its own (vite.config.ts `environments`)
src/box/                        floating box page — NO engine imports, tiny (≤33 KB gz JS)
src/editor/                     editor page: App.svelte, morph/MorphController.ts, panels/*, dialogs/*
src/engine/                     pure-TS image engine (no Svelte, no DOM in core logic) — unit tested in node
src/lib/ipc/                    commands.ts (typed invoke wrappers), events.ts, mailbox.ts, types.ts, bindings/ (ts-rs, generated)
src/lib/ui/                     shared Svelte components incl. BoxVisual.svelte (used by the box AND the editor proxy)
src/lib/{motion,theme,sound,settings}/
src/testing/tauri-mock.ts       e2e-only fake backend (installed when built with `--mode e2e`)
e2e/*.spec.ts                   Playwright specs against the e2e build
scripts/                        bundle budget, third-party notices (unit tested with node --test)
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
  `box:collapse`, `box:shown`, `settings:changed`, `box:undo`).
* `inspect_paths(paths)` inspects at most the first 64 paths (each costs
  shell work on the STA and a ≤256 px preview, while the user is still
  dragging); the first returned item's optional `skipped` says how many
  were left out. `history_list` reads the journal as it is on disk (another
  Reskin process may have changed it). `restore({type:'entry', id})` undoes
  the entry and the entries applied with it (its `group`: the matching
  pins); `ApplyOutcome.applied.skippedPins` counts matching pins Reskin could
  not change.
* Rust → editor: **mailbox only** (`editor_next(after)` long-poll, returns
  `Envelope[]` with increasing `seq`; returns `[{seq, cmd:{type:'heartbeat'}}]`
  after 25 s of silence). The editor processes envelopes strictly in order and
  awaits each handler before the next; `after` advances only once a handler
  finished (a later poll acknowledges it, so a reloaded page gets it again).
* Liveness: Rust recreates an editor whose mailbox has been silent for 2 s
  (`morph.rs` `ALIVE_GRACE`). So no handler may hold the mailbox with long
  work — `SmokeCycle` runs detached — and while any handler runs longer than
  500 ms, `startMailbox` sends keep-alive polls every 500 ms. They poll from
  the last *handled* envelope, so they acknowledge nothing (Rust answers at
  once with the envelope still being handled) and their answers are dropped.
* Windows state that changes behind a page's back (accent colour, animation
  effects, a hotkey another app took): `app_boot` reads it live
  (`BootInfo.accent`, `systemReducedMotion`, `hotkeyError`), and
  `src/lib/boot.ts` calls it again whenever the page's window gains focus
  or becomes visible (`settings/system.svelte.ts`: `system`,
  `refreshSystem()`); no event needed.
* `settings_set(settings)`: the settings that mirror OS state (hotkey,
  "Start with Windows", Explorer verb) are applied before saving; a part
  Windows refuses is taken back (the old hotkey stays registered: the new
  one is registered first; autostart / verb take the state Windows
  reports), the rest is saved and pushed to both pages (`settings:changed`,
  `Settings` mailbox command), and the command then fails with what was
  refused. A saved hotkey that isn't registered is retried with every
  change, quietly (`BootInfo.hotkeyError` says why it doesn't work).

### Morph / handoff protocol (session numbers increase per open)

```
open_editor(items, view)                     [box → Rust]
Rust: place_editor(), move hidden editor     (editor never resizes while visible)
Prepare{session, boxRect(css px, editor-relative), items, view, settings, morph}
   editor: render BoxVisual proxy at boxRect (same skin/size/state as the box),
           await img.decode() + double rAF → editor_ack(session,'prepared')
Rust: show editor (topmost), Reveal{session}
   editor: double rAF → editor_ack(session,'revealed')
Rust: hide box; Expand{session, morph}
   morph=true : FLIP proxy → panel (~480 ms spring, scaled by animation speed),
                regions stagger in ([data-stagger], the workspace's
                [data-panel]), the box's icon lands exactly on the document
                (stage.docRect(); waits ≤ 250 ms for the item to reach the
                canvas) → editor_ack(session,'expanded')
   morph=false: crossfade the panel in (Prepared came later than 400 ms, the
                box was hidden, reduced motion, or the user chose crossfade)
Rust: focus editor, not topmost.

editor_close(reason)                          [editor → Rust]
Rust: editor topmost; Collapse{session, boxRect, then, icon, morph}
   editor: panel → proxy at boxRect (or fade out when morph=false), showing
           handoffProps(collapseItems(then, icon)) → editor_ack(session,'collapsed')
Rust: box:collapse{session, then, icon} to the still hidden box
   box: takes over that picture (the same collapseItems → BoxVisual props:
        empty after `hide`, the new icon after `fly`/`celebrate`)
Rust: show box right under the (topmost) editor — it may show its last
      picture until it paints again — + box:shown
   box: keeps the picture; its icon decoded (from box:collapse on), double
        rAF (hidden windows run no rAF, so only now) → box_painted(session)
        [the box confirms anyway after 250 ms; Rust waits 300 ms, logs a timeout]
Rust: Clear{session}
   editor: clear to fully transparent, double rAF → editor_ack(session,'cleared')
Rust: hide editor, box back to the top of the topmost band (+ low-memory:
      destroy the editor); glide box home if needed.
```
Invariant: a window hides only when its content is transparent and shows only
over an identical picture (the editor over the box at open; the box under
the editor's proxy at close, which goes only once the box has painted it).
Acks for an old session are ignored.
After a plain close the box rests on the picture it took over; after an
apply it stays frozen on the new icon until its flight (`depart` /
`celebrate`) carries it on (or 8 s pass without one).

`then` on Collapse: `hide` (plain close), `fly` (the box will fly to the
desktop icon carrying `icon`), `celebrate` (in-place celebration). The apply
flow drives these itself (`editor_close('applied')` is a no-op).

`SmokeCycle{item}` (only under `--smoke-test`): the editor renders its current
design through the export pipeline, calls `apply_icon` (mode inPlace,
flourish false) on `item`, then `restore({type:'item', item})`, and reports
`smoke_ready({window:'editor', detail:'cycle:ok'})` or
`'cycle:fail:<reason>'`. It runs detached from the mailbox (it can take 20 s
and more); the report is its only answer.

### Box events

`box:flight` (`BoxFlight{phase, icon, durationMs, message}`) — depart/land/
return/home legs of the fly-to-icon, `celebrate`, and `error` (shake, with
message; exactly one per failed apply, sent only once the editor has
collapsed). `box:progress` (`BoxProgress{done, total}`: the batch ring while
Restore all runs; `done == total` clears it), `box:collapse` (`BoxCollapse{session,
then, icon}`, see the close handoff; answered with `box_painted(session)`),
`box:shown` (keeps a picture taken over with `box:collapse`, else resets the
box), `settings:changed`, and `box:undo` (payload: history entry id) — after
a successful apply the box shows an **Undo** chip for 6 s; clicking it calls
`restore({type:'entry', id})`.

### Editor keyboard and paste

Escape closes the editor, and a pasted image outside the canvas joins the
design (or starts one), only when nothing else used the event: whatever
handles Escape (a dialog, popover or menu, a text field, a drag, a pending
transform, a text edit, a lasso polygon, a panel editor) or a paste (the
canvas adds pasted images as layers) calls `preventDefault` or stops it.
Escape also never closes while the engine had a gesture, a pending
transform or a text edit when the key went down. The App decides in a
window listener added while the event is on its way
(`chrome/last-listener.ts`), so it runs after every other listener — the
workspace's window listeners are added long after the App's. Files dropped
from Explorer (Tauri drag-drop events) stay the App's (import popover).

## Rust: reskin-core module contracts

Error type: `reskin_core::Error { AccessDenied, NotFound, Unsupported, Cancelled, Other }`
with `Result<T> = std::result::Result<T, Error>`; `From<windows_core::Error>`
maps `E_ACCESSDENIED`. Pixels: `pixels::Rgba` (straight alpha RGBA8).

Pure (all hosts, unit tested on Linux):

* `ico` — `build_ico(&[Rgba])`, `build_ico_from_pngs(&[SizedPng])`, `parse_ico`,
  `best_frame`, `validate_ico`, `MAX_ICO_BYTES` (1 MiB). <256 → 32-bpp BMP + AND
  mask; 256 → PNG.
* `geom` — `place_editor`, `snap_target`, `fling_projection`, `spring_step`,
  `arc_point`, `clamp_into`, `nearest_point_in`, `ease_in_out`.
* `pixels` — `Rgba`, PNG/base64/data-URL helpers, `bgra_to_rgba`,
  `looks_premultiplied_bgra`, `normalize_corner_icon`.
* `grpicon` — `GroupEntry`, `parse_group`, `rebuild_ico(group, get_icon)`
  (byte-exact ICO from RT_GROUP_ICON + RT_ICON blobs).
* `urlini` — `UrlFile::parse(bytes)` (infallible; UTF-16LE/BE, UTF-8, ANSI
  1252; `[InternetShortcut.W]` UTF-7 values preferred) with `url()`,
  `icon_file()`, `icon_index()`, `get`, `entries`, `shortcut_value`, writers
  `set`, `remove`, `set_url`, `set_icon`, `set_shortcut_value`,
  `to_ini_string()`, `to_bytes()` (original encoding); `utf7_encode/decode`.
* `paths` — `APP_ID`, `AppDirs { roaming, local, program_data }`
  (`from_env()` is infallible; `at(root)` for tests) with `settings_file()`,
  `journal_file()`, `library_dir()`, `autosave_file()`, `icons_dir()`,
  `jobs_dir()`, `public_icons_dir()`, `ensure()`; `slugify`, `sha256_hex`,
  `icon_file_name(name, ico) -> "<slug>-<sha256[..12]>.ico"`,
  `is_valid_public_icon_name`, and string-based Windows path helpers
  (`normalize_for_compare`, `is_directly_under`, `has_parent_traversal`,
  `is_unc`, …) that behave the same on every host.
* `store` — `write_atomic`, `read_json`, `write_json`, `store_icon(dir, name,
  ico)` (content-hashed, reuses identical files, never overwrites), `new_id()`,
  `Library::new(dir)` with `list/save/load/delete` (files
  `{format:"reskin-library", version, id, name, thumb, updatedAt, data}`),
  `autosave_write/autosave_read`.
* `settings` — `load(path) -> Settings` (damaged files backed up; first run
  = `!onboarded`: a missing file, or one written before the welcome was
  finished; recovered defaults count as onboarded), `save(path, &Settings)
  -> Result<Settings>`, `normalize`, `parse_hotkey(&str) ->
  Result<Option<Hotkey>>` (`""` = disabled); `Hotkey` `Display` gives
  "Ctrl+Alt+Shift+R", `to_accelerator()` gives the global-shortcut plugin
  form ("Control+Alt+Shift+KeyR"). Settings that mirror OS state:
  `trait SystemSettings` (hotkey registration, autostart entry, Explorer
  verb), `apply_system_change(sys, old, new) -> (Settings, errors)` (a
  refused change is taken back), `reconcile_system_settings(sys, saved)`
  (startup: hotkey registered, "Start with Windows" follows Task Manager,
  a missing entry is recreated, an unreadable one left alone, the verb
  re-pointed).
  `settings::autostart`: `run_command(exe)` (`"<exe>" --autostart`, quoted),
  `is_run_command_for`, `run_target(value)`, `repaired_run_command(value,
  exe, exists)` (quoted, and pointed at `exe` only when the executable it
  starts is gone: another copy of Reskin keeps it), `is_approved(flags)`
  (Task Manager's `StartupApproved`), `StartupEntry::{Missing, Enabled,
  Disabled}`; on Windows `state(name)`, `enable(name, exe)`,
  `disable(name)`, `repoint(name, exe)` (repairs the value, keeps Task
  Manager's choice) for `HKCU\…\Run\Reskin` (`ENTRY_NAME`).
* `history` — `Journal` persisted as `{version, entries, failures}`:
  `load` (missing → empty; damaged → backed up; newer version → error),
  `entries`, `get`, `failure(id)`, `pending`, `entries_for`, `active_for`,
  `original_for`, `begin(NewEntry) -> id` (persists *pending* first; applying
  over an active entry inherits the chain's first `original`, sets
  `supersedes`; refuses a second pending entry for the same target;
  `NewEntry.group` = the apply's main entry for the pins it also changed),
  `commit`, `fail`, `mark_restored`; planning: `plan_undo(id)`,
  `plan_restore_target`, `plan_restore_all` → `RestorePlan { entry_id, kind,
  target, name, system_icon, elevated, to: RestoreTo::{Original, Icon,
  Delete}, scope }`, `finish_plan(&plan, ok)`; steps planned when they run:
  `undo_steps(id)` (the entry and its group), `restore_all_steps()`,
  `plan_step(&RestoreStep::{Undo, Target})`; `reconcile(probe)`,
  `reconcile_settled(probe, IN_FLIGHT_GRACE)` (leaves young pending entries
  to the process making them); `referenced_icons`, `gc_icons` (10-minute
  grace), `gc_icons_older_than`, `icons_released_by(plans, dir)`.
  **Sharing between processes:** every read-modify-write holds an exclusive
  lock on `journal.json.lock` (`LockFileEx`; waits up to `LOCK_TIMEOUT` =
  30 s, then fails saying another Reskin process holds it) and reloads the
  file first (skipped when its SHA-256 is unchanged); `locked(f)` holds it
  across several steps, `refresh()` just reloads. The app keeps one
  `Journal` behind a mutex and takes that first. Holders keep the lock for
  one read-modify-write or one shell write, never across a UAC prompt.
* `job` — `ElevatedJob { version, id, created_at, ops }`,
  `JobOp::{SetShortcutIcon, SetUrlIcon, RestoreShortcutIcon, RestoreUrlIcon,
  DeleteIcon}` (`JobOp::set_icon`, `restore_icon`, `delete_icon`), `new_job`,
  `validate_job`, `is_elevation_target` (shared with the access probe),
  `trait JobExec`, `execute_job` (deletions last), `write_job`, `job_id_of`
  (the helper's argument: a local absolute `…\<id>.json`), `parse_job`,
  `run_job(id, bytes, …)`, `result_file`, `encode_result`, `result_for(id,
  code, ops, file)` (the app's reading of a result), `is_stale_result`,
  `is_plain_file_name`, `final_path_matches`. Exit codes `EXIT_OK` 0 /
  `EXIT_INVALID` 2 / `EXIT_FAILED` 3.

Windows (`win/`, `#[cfg(windows)]`, type-checked on Linux with
`--target x86_64-pc-windows-msvc`, run on Windows CI):

* `sta` — `Sta::spawn() -> Result<Sta>`; `run(f) -> Result<R>` (blocking; runs
  inline on the STA itself; panics become errors), `try_run`, `is_current`.
  Tauri async commands call it inside `spawn_blocking`.
* `known` — `desktop`, `public_desktop`, `program_data`, `start_menu`,
  `common_start_menu`, `roaming_app_data`, `local_app_data`, `windows_dir`,
  `taskbar_pins` (all `Result<PathBuf>`).
* `extract` — `Inspected` (+ `icon_data_url()`), `classify`, `inspect_path`,
  `icon_frames` (largest first), `inspect_system_icon`, `system_icon_frames`,
  `to_icon_frames`. Ladder: .ico frames → RT_GROUP_ICON rebuild (incl. `.mun`
  fallback) → WIC for images → IShellItemImageFactory.
* `shortcut` — `LinkInfo` (+ `icon_path()`), `read_link`, `set_link_icon(path,
  Option<(&str, i32)>)` (None clears; verified by read-back), `create_link(dest,
  target, args, Option<(&Path, i32)>, description)`.
* `urlfile` — `read_url_icon`, `set_url_icon` (InternetShortcut COM object,
  direct-file fallback if the change didn't stick).
* `folder` — `read_folder_icon`, `set_folder_icon(path, Option<(&Path, i32)>)`
  (clear removes the keys and an empty desktop.ini).
* `sysicons` — `read_system_icon`, `set_system_icon`, `restore_system_icon`,
  `effective_system_icon`.
* `notify` — `item_updated`, `assoc_changed`, `rebuild_icon_cache() -> Result`.
* `access` — `probe_writable(path) -> Access` (`NeedsElevation` only for a
  denied `.lnk` / `.url` directly on the Public Desktop, else `ReadOnly`),
  `probe_creatable(dir)`, `location_of(path) -> ItemLocation`; for the
  elevated helper (see "Elevation"): `AdminDir::open(base, parts)` with
  `read`, `create`, `put`, `remove`, `files`; `TrustedDir::open(dir)` with
  `check_file`; `read_plain_file(path, max)`; and for the app
  `read_admin_file(path, max)`.
* `desktop` — `find_desktop_icon(path) -> Result<Option<DesktopSpot>>` (also
  `::{CLSID}`), `desktop_icon_size()`.
* `elevate` — `run_elevated(exe, args) -> Result<i32>` (blocks ≤ 5 min; call
  off the STA; `Error::Cancelled` on UAC cancel), `is_uac_elevated()` (the
  full token of a UAC administrator), `run_unelevated(exe, args)` (through
  Explorer: `IShellDispatch2::ShellExecute` on the desktop's view).
  `WinJobExec` lives in `src-tauri/src/helper.rs`.
* `fonts` — `system_fonts()`.
* `wallpaper` — `wallpaper_path`, `wallpaper_info(Option<(w, h)>)`,
  `accent_color`, `client_area_animation`, `is_windows11`.
* `contextmenu` — `install(exe)`, `uninstall()`, `is_installed()`,
  `is_installed_for(exe)`, `installed_exe()`, `VERB_LABEL`.
* `fullscreen` — `is_fullscreen_busy()`, `query_fullscreen_busy()`.

## Rust: src-tauri

* `main.rs` handles `--elevated-apply`, `--restore-all [--quiet]`, `--self-test`
  before building Tauri; otherwise exits with `reskin_lib::run(argv)`.
* `lib.rs` `run`: panic hook (`reskin.log`, and an error box: release builds
  abort on panic); started as administrator (`is_uac_elevated`) it restarts
  unelevated through Explorer (`--relaunched`) and returns; no WebView2
  Runtime → an error box offering Microsoft's download, exit 1. Builder:
  single-instance first, then dialog, opener, global-shortcut; `setup`
  creates the box (visible; a failure is reported, not returned into Tauri),
  reconciles the OS-backed settings on a thread (`commands::settings::
  reconcile_at_startup`) and schedules the editor pre-warm (skipped in
  low-memory mode unless the welcome or `--edit` opens it; the welcome,
  due while `!onboarded`, never opens at an `--autostart` start);
  `invoke_handler` registers every command in `commands.ts`. Error boxes
  never show under `--smoke-test`.
* `hotkey.rs`: `apply(app, hotkey)` registers the new shortcut before
  releasing the old one; `registered()`, `problem(saved)` (why the saved one
  doesn't work, for `BootInfo.hotkeyError`).
* `AppState::system_reduced_motion()` reads `SPI_GETCLIENTAREAANIMATION` live;
  `first_run()` clears once the welcome sets `onboarded`.
* `windows/{box_window,editor_window}.rs` build windows `from_config` + WebView2
  tuning (compatibility mode: the box's clip region is rebuilt on
  `ScaleFactorChanged`); `windows/mailbox.rs` (seq queue + long-poll);
  `windows/morph.rs` (handoff FSM with acks/timeouts/fallback);
  `windows/animator.rs` (box motion, drag loop, fling/snap, flights).
* `apply.rs`: Save & Apply. Before anything is journaled or collapsed it
  probes the target again (`access::probe_writable`, or `probe_creatable`
  on the desktop for a new shortcut / personal copy): a Public-Desktop link
  gets an elevation ticket, anything else Windows refuses a `Failed`
  outcome with a hint. With the flourish a new shortcut is created before
  the collapse (a failure leaves the editor open); a failure after the
  collapse reaches the box as exactly one `error` flight; without a
  visible desktop icon the box celebrates in place and glides home. System
  icons fly to `::{CLSID}` (the Recycle Bin only in the state whose icon
  changed). Matching pins join the apply's group, also after an elevated
  apply; `box:undo` carries the main entry.
* `restore.rs`: `execute_steps` plans, runs and records each step under the
  journal lock; Public-Desktop steps go to the helper in jobs of at most 64
  ops (a declined prompt ends the batch), the last job also deleting the
  Public-Desktop icons no entry needs any more; their results are recorded
  under the lock only if the step still plans the same. Restore all emits
  `box:progress {done, total}` after each step and `done == total` at the
  end.
* `helper.rs`: `--elevated-apply`, `run_elevated_job` and `--restore-all`
  (see "Elevation"; `--restore-all` runs alongside the app thanks to the
  journal lock, asks once for approval — also under `--quiet` — and exits
  3 unless everything is back, so the uninstaller keeps Reskin's data).
* `commands/*.rs`: `boot, box_cmds, editor_cmds, items, apply, library, system, settings`.
* Permissions: `build.rs` lists every command in `AppManifest::commands`;
  `capabilities/box.json` and `capabilities/editor.json` grant per window.

## Elevation

The app never runs elevated. A Public-Desktop `.lnk` / `.url` the user may
not change (`probe_writable` → `NeedsElevation`, the same rule as
`job::is_elevation_target`) is changed by `reskin.exe --elevated-apply
<job>` started through UAC (`runas`), after the user agreed; so are the
restores of such items (one prompt per 64 of them, the uninstaller's
restore included). Following Microsoft's guidance for code that runs
with administrator rights, the helper treats everything a standard user can
touch as hostile:

* **Input.** The job path must be a local absolute `…\<id>.json`
  (`job_id_of`). The file is opened once without following a link at its
  name, must be a plain file with a single name, is read up to
  `MAX_JOB_FILE_BYTES`, and only those bytes are parsed and validated
  (`run_job`): targets directly on the Public Desktop, icon names
  `[a-z0-9-]{1,64}.ico` that are not device names, icons that parse and
  are ≤ 1 MiB, local icon locations for restores. A malformed file is
  reported by position only. Folders come from the known-folder API
  (`FOLDERID_ProgramData`, `FOLDERID_PublicDesktop`), never from
  environment variables. The helper writes no log (`%TEMP%` is the
  user's).
* **Where it writes.** Only inside `%ProgramData%\Reskin` (`AdminDir`):
  `icons\` (Public-Desktop icons) and `results\` (its result files). Each
  folder of that tree is created owned by Administrators with a protected
  DACL — SYSTEM and Administrators full control, Users read — so standard
  users can create nothing in it. An existing folder must be a real folder
  (not a reparse point) owned by Administrators or SYSTEM, else the helper
  refuses ("delete it so that Reskin can create it again"); its DACL is
  then reset (earlier versions left it writable for Users, as
  `%ProgramData%` makes every new folder). The helper holds every folder of
  the tree open without `FILE_SHARE_DELETE` while it works, so none can be
  renamed or replaced, and checks that each one's final path continues its
  parent's.
* **How it writes.** Every file is opened with
  `FILE_FLAG_OPEN_REPARSE_POINT`; reparse points, folders and hard-linked
  files are refused, and so is any file whose final path
  (`GetFinalPathNameByHandleW`) is not directly in the folder it expects.
  Files are created with `CREATE_NEW` (owner Administrators, the same
  DACL), never overwritten: an icon file that already holds exactly the
  new bytes and belongs to an administrator is kept, anything else by that
  name is deleted through its own handle (a link goes, never what it leads
  to) and created anew. `DeleteIcon` ops delete the same way, and only
  icons no Public Desktop shortcut still shows.
* **Public Desktop shortcuts** are edited in place by the shell objects
  (`IShellLinkW` / `CLSID_InternetShortcut`). Only administrators can write
  to that folder; before each edit the helper still checks that the target
  is a plain file with a single name directly in it, by final path
  (`TrustedDir::check_file`).
* **The result.** The helper writes `results\<job id>.json` there (and
  removes results older than an hour nobody read) and exits with 0 / 2 / 3.
  The app, which cannot delete it, reads it only when it is a plain file
  owned by Administrators or SYSTEM (`read_admin_file`) that agrees with
  the exit code (`job::result_for`); otherwise the exit code alone decides
  (a failure then counts every op as failed).

Icons of `%ProgramData%\Reskin\icons` are machine-wide: one content-hashed
name may serve several accounts' shortcuts. A restore deletes those its own
journal no longer needs (`icons_released_by`, existing files only), and the
helper keeps any a Public Desktop shortcut still shows.

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
* Build: `vite build` builds each page on its own (the app builder runs the
  `client` environment for editor.html, then `box` for box.html into the
  same outDir), so the box never loads chunks shared with the editor (they
  would carry the union of both pages' Svelte runtime and library code);
  the dev server serves both pages from one environment.
  `pnpm bundle:budget` guards the box's initial JS. Under `tauri build`
  (which sets `TAURI_ENV_*`) `pnpm build` also runs
  `scripts/third-party-notices.mjs`: `dist/THIRD_PARTY_NOTICES.txt` (production
  npm tree + Svelte runtime, crates `cargo tree` links into `reskin.exe`,
  license texts deduplicated), embedded in the app (Settings › About ›
  Open-source licenses fetches it) and attached to each release; `pnpm
  notices` writes it by hand.
* Every page entry (`src/*/main.ts`) starts with
  `if (__E2E__) (await import('../testing/tauri-mock')).install('<box|editor>')`
  so the e2e build runs against the fake backend; production builds drop it.
* Unit tests: `src/**/*.test.ts` (Vitest, node env) and `scripts/*.test.mjs`
  (`node --test`), both in `pnpm test`. E2E: `e2e/*.spec.ts`; tests drive
  the fake backend through `window.__e2e` (see tauri-mock.ts).

## Checks (all must pass before pushing)

```
pnpm check && pnpm test && pnpm build && pnpm e2e && pnpm bundle:budget
cargo fmt --all --check
cargo clippy -p reskin-core --all-targets -- -D warnings
cargo test -p reskin-core
cargo clippy --workspace --all-targets --target x86_64-pc-windows-msvc -- -D warnings   # after pnpm build
```
