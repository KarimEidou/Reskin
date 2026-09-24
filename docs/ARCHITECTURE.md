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
  `box:handoff`, `box:collapse`, `box:shown`, `settings:changed`, `box:undo`).
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
  A destroyed page's poll can outlive it by up to 25 s: `Mailbox::reset`
  (called whenever the editor window is destroyed) starts a new generation,
  sends the old polls back empty and stops them counting as a live page.
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
open_editor(items, view)                     [box → Rust; or tray, menu, Explorer…]
Rust: place_editor(), move hidden editor     (editor never resizes while visible)
Rust: box:handoff{session: box session, icon: items[0].icon, count} to the
      visible box, which freezes on that picture — the one the proxy draws
      (already its picture when the box asked for the open) — and answers
      box_painted once it is on screen (decoded + double rAF); a drop it was
      still absorbing asks open_editor for its items all the same (handed
      over once the editor is open)
Prepare{session, boxRect(css px, editor-relative; null: box hidden), items,
        view, settings, morph}
   editor: render BoxVisual proxy at boxRect (same skin/size/state as the box),
           await img.decode() + double rAF → editor_ack(session,'prepared');
           no boxRect: no proxy (morph is false)
Rust: waits for prepared (400 ms) and box_painted (300 ms from box:handoff)
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
Rust: box:collapse{session: box session, then, icon} to the still hidden box
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
Box sessions number the pictures handed to the box (`box:handoff`,
`box:collapse`), apart from the editor's sessions: an open's picture and the
close's of the same editor session never stand for each other.

One handoff runs at a time (`morph.rs` holds `busy` through it; outside it
the editor is open or closed). An open or a close that comes during a
handoff waits for it. An open that then finds the editor open hands its
items over (`AddItems`, or `Navigate` without items) — never earlier, when
they could reach an opening editor before its `Prepare` or a closing one on
its way out — else it opens the editor. A close handoff that fails (a
window went missing) still ends in the closed state (`morph::close`): the
editor hidden, not topmost, without a taskbar button, memory low; the box on
the empty picture (`box:collapse` hide + `box:shown`) when it may show.

The box at rest is shown exactly when it may be (`rules::box_allowed`): the
user has not hidden it (tray / menu / hotkey / Settings) and no fullscreen
app runs. Outside a handoff `settle_box` enforces that (on each toggle and
every 1.5 s from the fullscreen watcher); while the editor is open a wish is
only recorded, and the close asks the same question — a box that stays hidden
is not moved. The hotkey / tray click closes an open editor, toggles the
box, or — while a fullscreen app hides it — opens the editor. The tray's
Hide / Show label follows the box's actual visibility.
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
message: shown inside the box, which stays in the error state long enough to
read it). `box:progress` (batch ring), `box:handoff` (`BoxHandoff{session,
icon, count}`, see the open handoff) and `box:collapse` (`BoxCollapse{session,
then, icon}`, see the close handoff), both answered with
`box_painted(session)`, `box:shown` (keeps a picture taken over with
`box:collapse`, else resets the box), `settings:changed`, and `box:undo`
(payload: history entry id) — after a successful apply the box shows an
**Undo** chip for 6 s; clicking it calls `restore({type:'entry', id})`, then
celebrates, or shakes saying why the icon is not back (a failed entry, or
the administrator prompt was cancelled).

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
from Explorer (Tauri drag-drop events) stay the App's (import popover). An
image pasted into an open design (on the canvas or elsewhere) becomes a
layer at once and says so in a toast with **Undo** (`workspace/pasted.ts`).

The canvas stage owns Enter, Escape, the arrows, Delete and Backspace
(`workspace/keys.ts` `STAGE_KEYS`): they go to the active tool, and Delete /
Backspace the tool does not use clear the selected pixels (the whole layer
without a selection). Palette commands may show such a key (`stageKey`)
but never bind it. The palette also lists every adjustment, icon helper and
style preset (`palette/panel-commands.ts`, loaded with the palette); running
one switches the sidebar tab and asks the panel through
`panels/requests.svelte.ts`.

### Editor session (`src/editor/state/session.svelte.ts`)

* **Designs and the queue.** The open design belongs to the current queue
  entry or, with an empty queue, stands alone. Every entry keeps its own
  design (`project`), recipe, Library link and unsaved state while another
  is edited. Nothing is dropped: a standalone design gets an entry of its
  own (its source file's `ItemInfo`, or a stand-in of kind `project` with
  an id `design-<n>` that never reaches Rust) before anything else is
  queued, and a target that arrives while the open design has none takes
  that design over, history included (`meta.source` follows it). Imports
  (drops and picks; `ImportSource` also takes decoded pictures, for
  pastes) go through `shell.askImport(sources, at)`: with nothing open
  they open; otherwise the import popover asks — `layer` (projects still
  join the queue), `queue` (images/projects become design entries,
  `modes: []`), or `adopt` (offered for a target that `canAdopt`: not
  queued, or queued and not opened yet).
* **`designToken`** changes when a design starts to load and again once it
  is in. Code that awaits (worker renders, icon loads) reads it first and
  lands its result only when `isOpenDesign(token)` — the same design is
  open and no other is on its way in (work started half-way through a
  switch is dropped too).
* **Queue lock.** `queueLocked` (a job in `busy`, or a switch loading):
  `switchTo(i)` and `remove(i)` — the queue strip and the title bar's
  queue menu — are refused, and `apply` / `applyStyleToAll` do not start.
* **Save & Apply** uses `preferredMode(item)` (`workspace/apply-modes.ts`:
  a classic shortcut for Store apps). It sends `flourish` only when every
  other queued item is applied; otherwise the editor stays open, the item
  is marked applied, the next one not applied opens, and — while the
  editor is interactive — a toast offers Undo for 6 s
  (`restore({type:'entry'})` per journal entry). "Apply style to all"
  replays the current item's recipe on a scratch engine per other queued
  target (the current design and its history are untouched), keeps each
  failure's reason on its entry (`problem`), and asks about every
  `needsElevation` at once (`elevation.requests`, approved ticket by
  ticket, or personal copies with the icons already rendered).
* **Library.** `libraryId` is the Library design the open design came from
  or was saved as; `saveToLibrary` updates it (`asNew` makes another), and
  the design takes its Library name. Opening a Library design over unsaved
  changes asks first (`shell.openLibraryDesign`).
* **Autosave.** A design is *unsaved* when it came with unsaved changes (a
  recovered draft) or its history moved since it was loaded, applied,
  saved to the Library or exported as a project (`engine.currentEntryId`,
  sealed at each save). Only unsaved designs are written:
  `autosave(json)` 2 s after the last change, at least every 10 s while
  editing goes on, before another design opens and when the editor
  closes. The JSON is encoded off the main thread (`ProjectEncoder`: the
  page only copies the layer pixels). Once the open design is safe the
  live slot takes another queued unsaved design, or empties
  (`autosave('')`). Rust keeps two slots (`AutosaveSlots`): each launch
  first turns what the previous one left live into the recovery offer
  (`autosave_load`), so a crashed design survives the next session's
  autosaves; `autosave(null)` (Discard, or a restored draft) clears both.
  Restoring re-inspects `meta.source` (`inspect_paths`, or the system
  icons) and queues the draft for that item when it still exists.

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
  `autosave_write/autosave_read`, `AutosaveSlots::new(autosave_file)` with
  `rotate()` (a non-blank live `autosave.reskin` becomes
  `recovery.reskin`, `RECOVERY_FILE`), `rotate_once(&Mutex<bool>)` (once
  per launch; a failed rotation is retried on the next call and the app
  leaves the slots alone until it succeeds), `write(data)` (empty data
  removes the live slot), `discard()` (both slots), `read_recovery()`.
* `settings` — `load(path) -> Settings` (damaged files backed up; first run
  = `!onboarded`: a missing file, or one written before the welcome was
  shown; recovered defaults count as onboarded), `save(path, &Settings)
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
  `supersedes`; refuses a second pending entry for the same target), `commit`,
  `fail`, `mark_restored`; planning: `plan_undo(id)`, `plan_restore_target`,
  `plan_restore_all` → `RestorePlan { entry_id, kind, target, name,
  system_icon, elevated, to: RestoreTo::{Original, Icon, Delete}, scope }`,
  `finish_plan(&plan, ok)`; `reconcile(probe)`; `referenced_icons`,
  `gc_icons` (10-minute grace), `gc_icons_older_than`.
* `job` — `ElevatedJob { version, id, created_at, ops }`,
  `JobOp::{SetShortcutIcon, SetUrlIcon, RestoreShortcutIcon, RestoreUrlIcon}`
  (`JobOp::set_icon`, `JobOp::restore_icon`), `new_job`, `validate_job`,
  `trait JobExec`, `execute_job`, `write_job`, `read_job`, `write_result`,
  `read_result`, `result_path`, and `run_job_file` (the whole
  `--elevated-apply` helper). Exit codes `EXIT_OK` 0 / `EXIT_INVALID` 2 /
  `EXIT_FAILED` 3.

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
* `access` — `probe_writable(path) -> Access`, `location_of(path) -> ItemLocation`.
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
  `ScaleFactorChanged`); `windows/mailbox.rs` (seq queue + long-poll,
  generations); `windows/morph.rs` (handoff FSM with acks/timeouts/fallback,
  the box at rest); `windows/rules.rs` (its decisions, unit tested: who hands
  over, when the box may show, what the hotkey does); `windows/animator.rs`
  (box motion, drag loop, fling/snap, flights).
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
