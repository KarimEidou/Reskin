# Reskin architecture & contracts

Read `docs/PLAN.md` first for the product spec. This file pins down the
concrete contracts every module builds against. If you change a contract,
update this file in the same change.

## Repository map

```
box.html editor.html            Vite pages, each built on its own (vite.config.ts `environments`)
src/box/                        floating box page — NO engine imports, tiny (≤33.5 KB gz JS)
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
  `box:handoff`, `box:conceal`, `box:collapse`, `box:reveal`, `box:shown`,
  `box:released`, `settings:changed`, `box:undo`).
* `inspect_paths(paths)` inspects at most the first 64 paths (each costs
  shell work on the STA and a ≤256 px preview, while the user is still
  dragging); the first returned item's optional `skipped` says how many
  were left out. `history_list` reads the journal as it is on disk (another
  Reskin process may have changed it). `restore({type:'entry', id})` undoes
  the entry and, once that went through, the entries applied with it (its
  `group`: the matching pins); `ApplyOutcome.applied.skippedPins` counts
  matching pins Reskin could not change.
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
  `refreshSystem()`). One change can come while nothing gains focus: Rust's
  start-up check registers the saved hotkey on a thread of its own and may
  find it taken after the pages read `app_boot`, so it then emits
  `system:changed` (`commands::settings::SYSTEM_CHANGED`) to both pages,
  which read it again — the box then says so. `boot.ts` listens before its
  first `app_boot`, so the change is never missed.
* `settings_set(settings)`: the settings that mirror OS state (hotkey,
  "Start with Windows", Explorer verb) are applied before saving; a part
  Windows refuses is taken back (the old hotkey stays registered: the new
  one is registered first; autostart / verb take the state Windows
  reports), the rest is saved and pushed to both pages (`settings:changed`,
  `Settings` mailbox command), and the command then fails with what was
  refused. A saved hotkey that isn't registered is retried with every
  change, quietly (`BootInfo.hotkeyError` says why it doesn't work).

### Morph / handoff protocol (session numbers increase per open)

Both windows are translucent glass. Where they overlap, the box's picture
painted by both — the proxy over the box — shows darker glass and both
windows' contents at once, so at every moment exactly one of them paints
it: the window that shows over the other paints nothing at first (the
editor holds its proxy, the box its picture), and then the two **swap**.
Rust sends both halves of a swap at once (`Reveal` + `box:conceal` on open,
`Clear` + `box:reveal` on close); each page makes its change on its next
frame (in a rAF callback), and both are driven by the display's vsync, so
the two changes land in the same composed frame — at worst a frame apart.

```
open_editor(items, view)                     [box → Rust; or tray, menu, Explorer…]
Rust: place_editor(), move hidden editor     (editor never resizes while visible)
Rust: box:handoff{session: box session, icon: items[0].icon, count} to the
      visible box, which freezes on that picture — the one the proxy draws
      (already its picture when the box asked for the open) — and answers
      box_painted once it is on screen (decoded + double rAF); a drop it was
      still absorbing asks open_editor for its items all the same (handed
      over once the editor is open)
Rust: show editor (topmost): transparent, it paints nothing until Reveal,
      and it draws by the swap — a window that was hidden runs no frames
      for a moment after it shows, and `prepared` comes after a double rAF.
      An opaque one (compatibility mode) would cover the box with an empty
      window meanwhile: it shows once prepared (rules::shows_while_preparing)
Prepare{session, boxRect(css px, editor-relative; null: box hidden), items,
        view, settings, morph}
   editor: lay out the BoxVisual proxy at boxRect (same skin/size/state as
           the box) HELD (not painted), await img.decode() + double rAF →
           editor_ack(session,'prepared'); no boxRect: no proxy (morph is
           false). The items start loading (the icon's resample to the
           design runs in the panels worker) and the view gets ready behind
           the proxy: the panel is laid out and drawn there, only
           transparent (its shield takes the pointer)
Rust: waits for prepared (400 ms) and box_painted (300 ms from box:handoff)
Rust: the swap: Reveal{session} + box:conceal{session: box session}
   editor: on its next frame paints the proxy; double rAF →
           editor_ack(session,'revealed')
   box:    on its next frame stops painting (and stays blank, hidden, until
           told what to show); double rAF → box_painted(session)
Rust: waits for revealed (1.5 s; not when prepared came late) and the box's
      box_painted (300 ms from box:conceal); hide box (it paints nothing,
      so shown again it shows nothing until it paints anew);
      Expand{session, morph}
   editor: waits (≤ 1 s, READY_WAIT_MS) until the view is ready — the items
           Prepare loads are in, the Edit workspace mounted, laid out and its
           canvas drawn (stage.docRect()) — so nothing loads while the panel
           animates; draws the animation's first frame (the picture on screen
           already), then plays it:
   morph=true : FLIP proxy → panel (~480 ms spring, scaled by animation speed),
                regions fade in one after another ([data-stagger], the
                workspace's [data-panel]), the box's icon lands exactly on
                the document, which shows only as the icon settles on it
                (the two cross-fade; `[data-morph-landing]`)
                → editor_ack(session,'expanded')
   morph=false: crossfade the panel in (Prepared came later than 400 ms, the
                box was hidden, reduced motion, or the user chose crossfade)
Rust: focus editor, not topmost.

editor_close(reason)                          [editor → Rust]
Rust: editor topmost; Collapse{session, boxRect, then, icon, morph}
   editor: panel → proxy at boxRect (or fade out when morph=false), showing
           handoffProps(collapseItems(then, icon)) → editor_ack(session,'collapsed')
Rust: box:collapse{session: box session, then, icon, held} to the still
      hidden box — held when the close morphed: the proxy shows that
      picture over it (rules::box_return); after a fade out nothing covers it
   box: takes over that picture (the same collapseItems → BoxVisual props:
        empty after `hide`, the new icon after `fly`/`celebrate`); held:
        laid out, its icon decoded, painting nothing
Rust: show box right under the (topmost) editor — until it paints it shows
      its last frame: nothing, as the open's swap left it — + box:shown
   box: keeps the picture (held: still unpainted, frozen); its icon decoded
        (from box:collapse on), double rAF (hidden windows run no rAF, so
        only now) → box_painted(session)
        [the box confirms anyway after 250 ms; Rust waits 300 ms, logs a timeout]
Rust: the swap: Clear{session} + (held) box:reveal{session: box session}
   editor: on its next frame clears to fully transparent; double rAF →
           editor_ack(session,'cleared')
   box:    on its next frame paints the picture it holds, still frozen;
           double rAF → box_painted(session)
Rust: waits for cleared (1 s) and the box's box_painted (300 ms from
      box:reveal); hide editor, box back to the top of the topmost band +
      box:released (+ low-memory: destroy the editor); glide box home if
      needed — its saved home while the box, at that monitor's scale, fits
      there on a monitor still connected, else where it is
      (`monitors::resting_home`)
   box: box:released → the box unfreezes (a pending hint shows now): the
        proxy is gone, so after a plain close the picture is its own again.
        What only the box shows — the hint, the Undo chip — is never in the
        proxy nor over it: it comes 250 ms after the box shows its picture
        on its own again, fading in (the mark moves up out of the hint's
        way from where the proxy had it)
```
Box sessions number the pictures handed to the box (`box:handoff`,
`box:collapse`) and the box's halves of the swaps (`box:conceal`,
`box:reveal`), apart from the editor's sessions: an open's picture and the
close's of the same editor session never stand for each other, nor does a
picture's confirmation stand for the swap that follows it.

One handoff runs at a time (`morph.rs` holds `busy` through it; outside it
the editor is open or closed). An open or a close that comes during a
handoff waits for it. An open that then finds the editor open hands its
items over (`AddItems`, or `Navigate` without items) — never earlier, when
they could reach an opening editor before its `Prepare` or a closing one on
its way out — else it opens the editor. A close handoff that fails (a
window went missing) still ends in the closed state (`morph::close`): the
editor hidden, not topmost, without a taskbar button, memory low; the box on
the empty picture (`box:collapse` hide + `box:shown` + `box:released`) when
it may show.

The box at rest is shown exactly when it may be (`rules::box_allowed`): the
user has not hidden it (tray / menu / hotkey / Settings) and no fullscreen
app hides it — one runs in front (with auto-hide on) and the user has not
shown the box over it (`state::FullscreenHide`). Outside a handoff `settle_box`
enforces that (on each toggle and every 1.5 s from the fullscreen watcher);
while the editor is open a wish is only recorded, and the close asks the
same question — a box that stays hidden is not moved. The hotkey / tray
click closes an open editor, toggles the box, or — while a fullscreen app
hides it — opens the editor. The menus' box item (tray and box, `menu.rs`)
follows the box's actual visibility and does what it says: *Hide box*
hides it; *Show box* shows it — closing an open editor into it — and keeps
it on screen over a fullscreen app until that app goes away or the user
hides the box again. A fullscreen app only counts while it is in front, and
reaching the tray takes the user out of it, so both ends are measured with
`SHOWN_ANYWAY_GRACE` (30 s): *Show box* covers a fullscreen app seen that
recently, and the app has gone away once none has been seen for that long.
Reskin started again without paths (single-instance) brings the open editor
to the front, else does what *Show box* does.
Invariant: a window hides only when its content is transparent and shows only
over an identical picture (the editor over the box at open; the box under
the editor's proxy at close), and exactly one window paints the box's
picture at every moment: the one that shows over the other paints nothing
until the two swap. Acks for an old session are ignored.
After a plain close the box rests on the picture it took over, frozen until
`box:released`; after an apply it stays frozen on the new icon until its
flight (`depart` / `celebrate`) carries it on (or 8 s pass without either).

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
read it; exactly one per failed apply, sent only once the editor has
collapsed). `box:progress` (`BoxProgress{done, total}`: the batch ring while
Restore all runs; `done == total` clears it), `box:handoff`
(`BoxHandoff{session, icon, count}`, see the open handoff), `box:collapse`
(`BoxCollapse{session, then, icon, held}`, see the close handoff) and the
box's halves of the swaps, `box:conceal` / `box:reveal`
(`BoxSwap{session}`), all answered with `box_painted(session)`,
`box:shown` (keeps a picture taken over with `box:collapse`, frozen, else
resets the box), `box:released` (the close is over, the editor's proxy
gone: after a plain close that picture is the box's own again),
`settings:changed`, and `box:undo`
(payload: history entry id) — after a successful apply the box shows an
**Undo** chip for 6 s; clicking it calls `restore({type:'entry', id})`, then
celebrates, or shakes saying why the icon is not back (a failed entry, or
the administrator prompt was cancelled). `system:changed` (no payload) goes
to both pages: Windows state they show changed behind their back, read it
again (`refreshSystem`).

A saved hotkey Windows would not register (`system.hotkeyError`, from
`app_boot` or a later `system:changed`) is said once in the box's hint
bubble ("Ctrl+Alt+Shift+R is taken — change it in Settings", at most three
lines in the small box; `box/hotkey-hint.ts`). Its few seconds run only
while it is the hint on screen — after the first-run hint, paused by a
handoff or a drag — and it goes as soon as the hotkey works again. The
box's tooltip and accessible description say it in full for as long as the
hotkey doesn't work.

### Editor keyboard and paste

Escape closes the editor only when nothing else used the key: whatever
handles it (a dialog, popover or menu, a text field or the hotkey recorder,
a drag, a pending transform, a text edit, a lasso polygon, a panel editor)
calls `preventDefault` or stops it, and it never closes while the engine
had a gesture, a pending transform or a text edit when the key went down.
An adjustment still previewing on the canvas is cancelled by that Escape
instead of the editor closing. The App decides in a window listener added
while the event is on its way (`chrome/last-listener.ts`), so it runs after
every other listener — the workspace's window listeners are added long
after the App's.

A pasted image goes through `shell.askImport` like every other import
(`workspace/pasted.ts`): with nothing open it starts a design, with a
design open the import popover asks what it becomes (a layer, or a design
of its own in the queue). The canvas takes the pastes it gets (asking at
the pointer) and image files dropped on it; the App takes an image pasted
where nothing else took it (a text field keeps its paste), asking in the
middle of the window. Files dropped from Explorer (Tauri drag-drop events)
are the App's too, through the same popover. A layer imported while work
is in progress keeps that work: an adjustment still being tuned is kept
(`session.keepPreview`) and pending tool work is committed, so Undo takes
back just the layer.

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
  a classic shortcut for Store apps). Only queued *targets* count: it
  sends `flourish` only when every other queued target is applied (design
  sources — entries without a target — keep nothing open), otherwise the
  editor stays open, the item is marked applied, the next target not
  applied opens, and — while the editor is interactive — a toast offers
  Undo for 6 s (`restore({type:'entry'})` per journal entry). When the
  flourish closed the editor, the page tells Rust once the apply is
  settled — its outcome handled, the autosave settled
  (`editor_close('applied')`): low-memory mode destroys the editor only
  then. "Apply style to all" replays the current item's recipe on a
  scratch engine per other queued target (the current design and its
  history are untouched), keeps each failure's reason on its entry
  (`problem`), and asks about every `needsElevation` at once
  (`elevation.requests`, approved ticket by ticket, or personal copies
  with the icons already rendered).
* **Recipe.** `recipe` is the open design's style (the Styles, Backdrop,
  Adjust and Effects panels chain their steps onto it), and it follows the
  design's history: a panel sets it right after its change, so each value
  belongs to a history step — undo brings back the recipe before the step,
  redo brings the step's back, a step undone and replaced by another
  change is gone for good, and steps the history lets go of (its memory
  cap, Clear history) stay. "Apply style to all" never replays a look the
  design no longer has, and a look comes out the same at any document
  size: presets and backdrops are measured in fractions of the document,
  and the steps with pixel settings (adjustments, icon helpers, layer
  effects) remember the size they were chosen on and scale those settings
  to the document they replay on (`panels/styles/recipe.ts`).
* **Library.** `libraryId` is the Library design the open design came from
  or was saved as, `libraryName` that design's name as the Library has it
  (kept per queue entry too, and through renames in the Library view): the
  design goes by it. A Library design is only ever saved over from a form
  that names it — Save to Library says "Updates …" (Save changes / Save as
  new); without that notice it saves as new: Ctrl+S and the palette's Save
  to Library save an unlinked design as new at once (pressed again while
  that save runs, they join it) and open that form for a linked one
  (`shell.requestSaveToLibrary`, the form's open state is
  `shell.saveFormOpen`), and the Library view's "Save current design" adds
  a new design when the linked one is not on the page — so no design is
  overwritten unseen. "Save as new" under the linked design's own name
  saves "<name> copy". Opening a Library design over unsaved changes asks
  first (`shell.openLibraryDesign`).
* **Autosave.** A design is *unsaved* when it came with unsaved changes (a
  recovered draft) or its history moved since it was loaded, applied,
  saved to the Library or exported as a project (`engine.currentEntryId`,
  sealed at each save). Only unsaved designs are written:
  `autosave(json)` 2 s after the last change, at least every 10 s while
  editing goes on, before another design opens and when the editor
  closes — also a close Rust starts (the hotkey, the tray, an apply): the
  collapse calls `flushAutosave` with the design as it is then, so an open
  right after (whose Prepare may reset the session) cannot cancel it, and
  Clear waits (time-boxed) for that write before the editor may be
  destroyed. The autosave keeps one design, so closing never drops unsaved
  work unasked: Close (✕, Esc, the palette: `shell.requestClose`) over
  unsaved changes — the open design's or another queued one's — asks
  first, and work closed anyway (`shell.discardOnReopen`) is reset at the
  next Prepare; a close Rust starts asks nothing, and while unsaved work
  is open the next Prepare without items keeps the session (its view as
  asked, Edit included) instead of resetting it. A Prepare with items
  starts over. The JSON is encoded off the main thread (`ProjectEncoder`:
  the page only copies the layer pixels). Once the open design is safe the
  live slot takes another queued unsaved design, or empties
  (`autosave('')`). Rust keeps two slots (`AutosaveSlots`): each launch
  first turns what the previous one left live into the recovery offer
  (`autosave_load`), so a crashed design survives the next session's
  autosaves; `autosave(null)` (Discard, or a restored draft) clears both.
  Restoring re-inspects `meta.source` (`inspect_paths`, or the system
  icons) and queues the draft for that item when it still exists.

## Rust: reskin-core module contracts

Error type: `reskin_core::Error { AccessDenied, NotFound, Unsupported,
Cancelled, Busy, Other }` with `Result<T> = std::result::Result<T, Error>`;
`From<windows_core::Error>` maps `E_ACCESSDENIED`. `Busy`: another process
held what was needed (the journal lock) for longer than the call waits;
trying again later can work. Pixels: `pixels::Rgba` (straight alpha RGBA8).

Pure (all hosts, unit tested on Linux):

* `ico` — `build_ico(&[Rgba])`, `build_ico_from_pngs(&[SizedPng])`, `parse_ico`,
  `best_frame`, `validate_ico`, `MAX_ICO_BYTES` (1 MiB, what Reskin writes).
  <256 → 32-bpp BMP + AND mask; 256 → PNG. What an icon claims is checked
  before it is allocated for: `parse_ico` first checks the directory against
  the file (each entry's data lies inside it; all of them together claim no
  more than it holds), then skips frames over `MAX_FRAME_PX` (1024) and,
  broken ones included, those after `MAX_DECODE_PX` (sixteen such frames)
  is spent. `read_ico_file(path)` refuses a file over `MAX_READ_ICO_BYTES`
  (16 MiB, also the most `grpicon` rebuilds) by its size, before reading.
* `geom` — `place_editor`, `snap_target`, `fling_projection`, `spring_step`,
  `arc_point`, `clamp_into`, `nearest_point_in`, `ease_in_out`.
* `pixels` — `Rgba` (`decode_png` refuses a PNG over `MAX_PNG_PX` = 4096
  on a side from its header, before allocating), PNG/base64/data-URL
  helpers, `bgra_to_rgba`, `looks_premultiplied_bgra`,
  `normalize_corner_icon`.
* `grpicon` — `GroupEntry`, `parse_group` (at most `MAX_GROUP_ENTRIES` =
  256), `rebuild_ico(group, get_icon)` (byte-exact ICO from RT_GROUP_ICON +
  RT_ICON blobs, which `get_icon` lends: each id is fetched and copied
  once, however often the group lists it, and a result over
  `ico::MAX_READ_ICO_BYTES` is refused before anything is copied).
* `urlini` — `UrlFile::parse(bytes)` (infallible; UTF-16LE/BE, UTF-8, ANSI
  1252; `[InternetShortcut.W]` UTF-7 values preferred) with `url()`,
  `icon_file()`, `icon_index()`, `has_icon(Option<(file, index)>)` (the
  read-back check of a write), `get`, `entries`, `shortcut_value`, writers
  `set`, `remove`, `set_url`, `set_icon`, `set_shortcut_value`,
  `to_ini_string()`, `to_bytes()` (original encoding); `utf7_encode/decode`.
* `paths` — `APP_ID`, `AppDirs { roaming, local, program_data }`
  (`from_env()` is infallible; `at(root)` for tests) with `settings_file()`,
  `journal_file()`, `library_dir()`, `autosave_file()`, `icons_dir()`,
  `jobs_dir()`, `public_icons_dir()`, `ensure()`; `slugify`, `sha256_hex`,
  `icon_file_name(name, ico) -> "<slug>-<sha256[..12]>.ico"`,
  `is_valid_public_icon_name`, `rewrite_temp_name(name)`
  (`<name>.reskin-tmp`: the file beside one that a rewrite of it goes
  through), and string-based Windows path helpers
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
  30 s, then fails with `Error::Busy` saying another Reskin process holds
  it) and reloads the file first (skipped when its SHA-256 is unchanged);
  `locked(f)` holds it across several steps, `refresh()` just reloads. The
  app keeps one `Journal` behind a mutex and takes that first. Holders keep
  the lock for one read-modify-write or one shell write, never across a UAC
  prompt.
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
  `to_icon_frames`. Ladder: .ico frames (`ico::read_ico_file`: a file over
  the limit goes to the shell) → RT_GROUP_ICON rebuild (resources are
  borrowed from the module mapped as data; only the rebuilt icon is a
  copy; incl. `.mun` fallback) → WIC for images → IShellItemImageFactory.
* `shortcut` — `LinkInfo` (+ `icon_path()`), `read_link`, `set_link_icon(path,
  Option<(&str, i32)>)` (None clears; verified by read-back), `create_link(dest,
  target, args, Option<(&Path, i32)>, description)`.
* `urlfile` — `read_url_icon`, `set_url_icon` (InternetShortcut COM object,
  direct-file fallback if the change didn't stick: rewritten through
  `<name>.reskin-tmp`), `set_url_icon_in(dir: &TrustedDir, path, icon)`
  (the elevated helper's: `check_file` first; the fallback reads and
  rewrites only through `dir`'s `read_file` / `replace_file`).
* `folder` — `read_folder_icon`, `folder_icon_path` (the custom icon as the
  shell resolves it: `%VARS%` expanded, a relative location against the
  folder), `set_folder_icon(path, Option<(&Path, i32)>)` (clear removes the
  keys and an empty desktop.ini).
* `sysicons` — `read_system_icon`, `set_system_icon`, `restore_system_icon`,
  `effective_system_icon`.
* `notify` — `item_updated`, `assoc_changed`, `rebuild_icon_cache() -> Result`.
* `access` — `probe_writable(path) -> Access` (`NeedsElevation` only for a
  denied `.lnk` / `.url` directly on the Public Desktop, else `ReadOnly`),
  `probe_creatable(dir)`, `location_of(path) -> ItemLocation`; for the
  elevated helper (see "Elevation"): `AdminDir::open(base, parts)` with
  `read`, `create`, `put`, `remove`, `files`; `TrustedDir::open(dir)` with
  `check_file`, `read_file(path, max)`, `replace_file(path, bytes)`;
  `read_plain_file(path, max)`; and for the app `read_admin_file(path,
  max)`.
* `desktop` — `find_desktop_icon(path) -> Result<Option<DesktopSpot>>` (also
  `::{CLSID}`), `desktop_icon_size()`.
* `elevate` — `run_elevated(exe, args) -> Result<i32>` (blocks ≤ 5 min; call
  off the STA; `Error::Cancelled` on UAC cancel), `is_uac_elevated()` (the
  full token of a UAC administrator), `run_unelevated(exe, args)` (through
  Explorer: `IShellDispatch2::ShellExecute` on the desktop's view; does not
  wait), `run_as_desktop_user(exe, args) -> Result<i32>` (with the token of
  the desktop's shell process, `CreateProcessWithTokenW`; waits for the exit
  code; refuses when the shell runs elevated too).
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
  `--self-test` must run without administrator rights: as administrator
  (`is_uac_elevated`) it only reads — it leaves out the checks that write
  the app data (`app-data`, `journal`, `icon-store`) and its log line —
  and reports a failed `elevation` check and exits 1.
* `lib.rs` `run`: started as administrator (`is_uac_elevated`) it first
  restarts unelevated through Explorer (`--relaunched`) and returns, having
  written nothing (not even `reskin.log`: the new start's first log line
  says `relaunched=true`); only then the log is rotated and started, and
  the panic hook installed (`reskin.log`, and an error box: release builds
  abort on panic). When that restart fails it carries on, and once the log
  is started it logs why and warns. No WebView2 Runtime → an error box
  offering Microsoft's download, exit 1; a history that cannot be loaded →
  an error box saying which of three it is (another Reskin process holds
  the journal lock, `Error::Busy`: try again in a moment; a journal a newer
  Reskin wrote; a file it cannot read, or cannot set aside when it is
  damaged), exit 1. Builder: single-instance first (a
  second start with `--edit` paths opens them, without paths
  `actions::bring_forward`: the open editor to the front, else *Show
  box*), then dialog, opener, global-shortcut; `setup` creates the box
  (visible; a failure is reported, not returned into Tauri), reconciles the
  OS-backed settings on a thread (`commands::settings::
  reconcile_at_startup`; a saved hotkey found taken is announced with
  `system:changed`) and schedules the editor pre-warm (skipped in
  low-memory mode unless the welcome or `--edit` opens it; the welcome,
  due while `!onboarded`, never opens at an `--autostart` start);
  `invoke_handler` registers every command in `commands.ts`. Error boxes
  never show under `--smoke-test`.
* `hotkey.rs`: `apply(app, hotkey)` registers the new shortcut before
  releasing the old one; `registered()`, `problem(saved)` (why the saved one
  doesn't work, for `BootInfo.hotkeyError`).
* `AppState::system_reduced_motion()` reads `SPI_GETCLIENTAREAANIMATION` live;
  `first_run()` clears once the welcome sets `onboarded`;
  `hidden_for_fullscreen()` follows `FullscreenHide` (the watcher's
  `set_fullscreen_busy(busy, elapsed)`, `show_box_anyway()` for *Show box*,
  ended by no fullscreen app for `SHOWN_ANYWAY_GRACE` or
  `set_box_hidden_by_user(true)`).
* `menu.rs` / `tray.rs`: one menu for the box's popup and the tray; its box
  item is `hide-box` ("Hide box") while the box shows, else `show-box`
  ("Show box", `actions::show_box`). A tray click and the hotkey run
  `actions::toggle_box` (`rules::toggle`). The Import dialog (`pick_files`)
  offers images, icons, shortcuts, programs and `.reskin` projects, and
  projects on their own.
* `windows/{box_window,editor_window}.rs` build windows `from_config` + WebView2
  tuning (compatibility mode: the box's clip region is rebuilt on
  `ScaleFactorChanged`); `windows/mailbox.rs` (seq queue + long-poll,
  generations); `windows/morph.rs` (handoff FSM with acks/timeouts/fallback,
  the box at rest); `windows/rules.rs` (its decisions, unit tested: who hands
  over, when the box may show, what the hotkey does, what a close does with
  the editor); `windows/animator.rs`
  (box motion, drag loop, fling/snap, flights).
* `apply.rs`: Save & Apply. Before anything is journaled or collapsed it
  probes the target again (`access::probe_writable`, or `probe_creatable`
  on the desktop for a new shortcut / personal copy): a Public-Desktop link
  gets an elevation ticket, anything else Windows refuses a `Failed`
  outcome with a hint. The flourish plays only while the box may be on
  screen (`morph::box_allowed`: not hidden by the user or a fullscreen
  app); otherwise the change is made in place. With the flourish a new
  shortcut is created before the collapse (a failure leaves the editor
  open); a failure after the collapse reaches the box as exactly one
  `error` flight; without a visible desktop icon the box celebrates in
  place and glides home. System
  icons fly to `::{CLSID}` (the Recycle Bin only in the state whose icon
  changed). Matching pins join the apply's group, also after an elevated
  apply; `box:undo` carries the main entry.
* `restore.rs`: `execute_steps` plans, runs and records each step under the
  journal lock; an item that no longer exists while its drive is there
  (`is_gone`) has nothing left to put back, so its whole chain is recorded
  as restored without touching anything (else it would fail every restore
  and keep the uninstaller from deleting Reskin's data); Public-Desktop
  steps go to the helper in jobs of at most 64
  ops (a declined prompt ends the batch), the last job also deleting the
  Public-Desktop icons no entry needs any more; their results are recorded
  under the lock only if the step still plans the same. Restore all emits
  `box:progress {done, total}` after each step and `done == total` at the
  end. `execute_undo` (`restore({type:'entry'})`) runs the entry's own step
  first (`execute_steps_then`) and its group only once that went through,
  so a declined prompt or a failure leaves the whole apply in place; that
  first step's elevated job also deletes the Public-Desktop icons the group
  releases, since the group's own steps ask for no approval. The helper is
  reached through the `Elevation` trait (implemented by `AppDirs`), so the
  tests can decline or approve it.
* `helper.rs`: `--elevated-apply`, `run_elevated_job` and `--restore-all`
  (see "Elevation"; `--restore-all` runs alongside the app thanks to the
  journal lock, asks once for approval — also under `--quiet` — and exits
  3 unless everything is back, so the uninstaller keeps Reskin's data; run
  with an administrator's full token it restarts as the desktop user, see
  "Elevation").
* `smoke.rs` (`--smoke-test [--capture-handoff]`): once both pages report
  ready it runs its scenarios on a thread of its own, logs `smoke: finished
  with exit code N after S s` and exits with N through `exit_with` (Tauri's
  `AppHandle::exit` drops the code on Windows). CI and the release job
  pass a run only when the exit code is 0 and `reskin.log` has that line
  with 0.
* `commands/*.rs`: `boot, box_cmds, editor_cmds, library, system, settings`
  (and the commands of `items.rs`, `apply.rs`, `restore.rs`). Tauri runs a
  synchronous command on the main thread, where both windows and the
  handoff run, so every command that uses COM or reads or writes files (a
  log line aside) is `async` and does that work off it: in `spawn_blocking`
  (shell work through `Sta::run`), except that `box_drag` saves the
  position it returns on the async runtime. The synchronous ones only read
  or record state, read Windows settings, show or hide a window or the box
  menu, add a log line, hand a link to the opener plugin, start their work
  on a thread of their own (`editor_close`, `smoke_ready`) or quit.
  `settings::rebuild_windows` (compatibility mode) and the low-memory drop
  destroy the editor through `morph::destroy_editor`, which returns once
  tauri has released its label and the mailbox moved on, so the next open
  never meets a half-destroyed editor. What a close does with the editor
  is `rules::after_close`: in low-memory mode a plain close destroys it at
  once, an apply's close (`fly` / `celebrate`) only once the page settled
  that apply (`editor_close('applied')` → `morph::apply_settled`; an open
  meanwhile keeps it) — the close's autosave still held the design being
  applied, and only the page empties it.
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
  (`TrustedDir::check_file`). When the shell object drops a `.url` change,
  the helper rewrites the INI itself (`urlfile::set_url_icon_in`) under the
  same rules: it reads the file through the handle it checked
  (`TrustedDir::read_file`) and writes `<name>.reskin-tmp` beside it with
  `CREATE_NEW` and `FILE_FLAG_OPEN_REPARSE_POINT` (whatever had that name —
  a leftover, a planted link — is deleted through its own handle first),
  checks it is a plain file directly in the folder, writes through the
  handle, gives it the original's DACL, attributes and creation time, and
  renames it over the original by handle
  (`SetFileInformationByHandle(FileRenameInfoEx)`, POSIX semantics, else
  `FileRenameInfo`): `TrustedDir::replace_file`. A failure deletes the
  new file and leaves the original as it was.
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

**`--restore-all` run as administrator.** Started with an administrator's
full token (`is_uac_elevated`: from an elevated terminal, or an uninstaller
run as administrator), `--restore-all` would restore the user's items with
administrator rights: it would write the journal, the user's icons folder
and their shortcuts — all places the user, and anything they run, can
redirect with a link — and would read the history of whichever account
approved the prompt. So it restores nothing itself and writes nothing, not
even the log: it starts `reskin.exe --restore-all --quiet --relaunched`
as the desktop user (`elevate::run_as_desktop_user`: the token of the
desktop's shell process, the signed-in user's own and unelevated), waits
for it and exits with its verdict (0 when everything is back, else 3).
That run restores every item as any unelevated restore does; the
Public-Desktop ones go through the helper's checked jobs, so Windows asks
for approval once more when there are any. If Reskin cannot start itself
that way (no desktop shell, or the shell runs elevated too) — or a
`--relaunched` run still holds a full token — it refuses with exit 3 and a
message to run it from a terminal that isn't run as administrator; the
uninstaller then keeps Reskin's data, so nothing is lost.

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
  license texts deduplicated; on msvc targets also the WebView2 SDK, whose
  `WebView2LoaderStatic.lib` `webview2-com-sys` links in, with its license
  from `scripts/licenses/` — a `webview2-com-sys` version the script
  doesn't know fails it), embedded in the app (Settings › About ›
  Open-source licenses fetches it) and attached to each release; `pnpm
  notices` writes it by hand.
* Every page entry (`src/*/main.ts`) starts with
  `if (__E2E__) (await import('../testing/tauri-mock')).install('<box|editor>')`
  so the e2e build runs against the fake backend; production builds drop it.
* Unit tests: `src/**/*.test.ts` (Vitest, node env) and `scripts/*.test.mjs`
  (`node --test`), both in `pnpm test`. E2E: `e2e/*.spec.ts`; tests drive
  the fake backend through `window.__e2e` (see tauri-mock.ts).

## Performance

Budgets, and what enforces them:

* **Animations** (`e2e/perf.spec.ts`, Chromium with the CPU throttled 4×
  through CDP): the open handoff with its morph (into the Edit view with an
  item, and into the Start view), the collapse from each, and the box's
  hover → armed → absorb never block the main thread for more than 50 ms —
  no long task (PerformanceObserver) and no gap between two animation
  frames longer than that — and run at 55 fps or better (median frame
  ≤ 18.2 ms). A handoff is timed from the moment its animations play (the
  morph frame's `data-transition`) to `expanded`, or for a close to
  `cleared` (the median over the motion, up to `collapsed`). What comes
  before shows a picture that is already on screen — the proxy, drawn just
  like the box — so it is waiting, not jank; how long the open waited is
  printed with its numbers. The handoffs are driven the way Rust drives
  them, one command at a time. Each scenario runs up to three times on a
  freshly loaded page and the best attempt counts; every attempt's numbers
  are printed. Work that only exists in the test (the fake backend on the
  page's thread — its wallpaper and item frames are made before measuring —
  and Playwright's injected scripts) is done before measuring.
* **No whole-view restyle** (same spec, Chromium trace): neither an open
  morph nor a collapse runs a style recalc of half the Edit view's
  elements or more (it has ~580; a change they all inherit restyles
  nearly all of them, the targeted changes a few dozen).
* **Counted work of the open morph** (same spec, Chromium trace from the
  morph's `data-transition` to `expanded`; counted, not timed, so they
  hold on a machine of any speed): the box proxy is rastered in at most
  two of the morph's frames (as it gets its layer, and once at the size it
  grows to), the canvas is never handed to the compositor again (no
  `CanvasResource…::ProduceCanvasResource` / `PrepareTransferableResource`:
  it holds still, see below), and the page rasters at most
  `MORPH_TILES_PER_FRAME` (16) tiles per frame it commits — the morph
  rastered 21–23 before the measures below, ~12 with them.
* **Idle** (same spec): the box at rest, and the editor in the Edit view
  with nothing happening, run no animation-frame callback, no animation,
  no style recalc and no layout for 2 s (< 20 ms of tasks: idle CPU ~0).
* **Initial JS** (`pnpm bundle:budget`, gzip -9, entry + modulepreloads):
  box ≤ 33.5 KB, editor ≤ 220 KB — about 10 % over their sizes when set,
  so growth is a decision.
* **Memory** (`--smoke-test`, `src-tauri/src/memory.rs`): the whole process
  tree — reskin.exe and every WebView2 process below it — is logged idle
  after start and again after the handoffs and the apply/restore cycle,
  with the editor hidden (its WebView2 memory target low): working set
  and private bytes (`PROCESS_MEMORY_COUNTERS_EX.PrivateUsage`, what a
  leak makes grow). Private bytes over 450 MB log a warning, over 700 MB
  fail the run (exit 3). WebView2 dominates the total: its browser, GPU and
  utility processes and one renderer per window (box and editor);
  reskin.exe itself is a small share, and shared DLL pages count once per
  process in the working set. Low-memory mode destroys the editor after a
  close — after an apply's close only once its page is done with the apply
  (`editor_close('applied')`) — and skips the pre-warm.
* **The real morph on Windows** (`--smoke-test --capture-handoff`): the
  CI runner reports reduced motion, so on its own it would only ever run
  the crossfade. The smoke test captures two round trips, each forcing a
  path through the handoff's settings (`smoke::HandoffPath`, smoke-only):
  the morph (full motion — Rust and the editor both follow the `Prepare`
  settings), then the crossfade. Each must take its path (`morph: session N
  open (morph=true)` / `closed (morph=true)` in the log) and keep the
  handoff invariant on its captured frames
  (`%TEMP%\reskin-handoff-<path>-<frame>.png`); either failing exits 3.
  The frames are probed where the picture on screen is certain — each after
  the pages confirmed theirs (`smoke::HANDOFF_FRAMES`): the open's swap with
  the box still shown (`1-swapped`), the box hidden (`2-revealed`), the
  panel (`3-expanded`), the box shown under the proxy before the close's
  swap (`5-collapsed`), after it with the editor still shown (`6-cleared`)
  and hidden (`9-after-close`). None may look like the bare desktop, and all
  but the panel like the box (mean colour difference ≤ 14): both windows
  painting the box's picture, one over the other, differ by more (25 was
  measured at `5-collapsed` before the swap).

Measured in a Linux container (headless Chromium with software rendering,
4× CPU): `pnpm e2e e2e/perf.spec.ts` several times, once and with
`--repeat-each=3`, and in full `pnpm e2e` runs. Frame gaps fall on the
60 Hz grid; the ranges are over the passing attempts.

| Scenario | Longest frame | Median frame | Motion started |
| --- | --- | --- | --- |
| Open, Edit view (22–29 frames) | 33.4–50.1 ms | 16.7–16.8 ms | 377–638 ms after Expand |
| Collapse, Edit view (27–30 frames) | 33.3–50.1 ms | 16.7 ms | 41–56 ms after Collapse |
| Open, Start view (33–36 frames) | 16.8–33.4 ms | 16.7 ms | 35–65 ms after Expand |
| Collapse, Start view (28–32 frames) | 16.7–50.0 ms | 16.7 ms | 31–45 ms after Collapse |
| Box hover → armed → absorb (115–118 frames) | 16.8–33.4 ms | 16.7 ms | — |

No passing attempt had a long task over 50 ms. The first attempt of the
Edit-view open — the first page of a new browser context — misses the
budget in about 4 runs of 10 (a 66.7–83.4 ms frame, a 51–55 ms task, or
— with a second test worker taking the CPU — a 33 ms median frame) and
the second attempt has passed every time; the collapse's first
attempt misses about 1 in 8 (a 54–73 ms task). Traced, those are mostly
the software renderer rather than the page's work: the display compositor
draws each frame of the morph on the CPU in 24–32 ms, so a frame with more
to draw takes three or four vsyncs, and in the collapse the page's main
thread waits 30–50 ms in its commit for that compositor. The page's own
task among them is the panel settling into `open` after the motion's last
frame (~45–55 ms at 4×: the focus, and the work the open panel lets go).
Idle, both pages ran 0 frame callbacks, 0 animations, 0 style recalcs and
0 layouts, with 0.0–0.4 ms of tasks in 2 s. Initial JS: box 31.2 KB,
editor 201.1 KB. On the Windows smoke run the idle working set of the
process tree has been ~370 MB.

What an open morph costs per frame (Edit view with an item, 4× CPU, CPU
time per thread from the trace), against the morph before the held
canvas, the laid-out content clip, the custom-property fade and the
settled corners (below). With every animation stepped through the same 30
frame states: the page's main thread 17.0 → 12.6 ms per frame (−26 %),
the display compositor 19.2 → 12.7 ms per drawn frame (−34 %), raster
10.1 → 7.0 ms (−31 %), 25.5 → 13.1 tiles. Played in real time (slowed 4×
to see every frame): main thread 11.6–13.6 → 8.3–10.0 ms per frame (−22
to −28 %), the compositor's draw 15.8–16.9 → 13.0–13.6 ms (−17 to −20 %),
23 → 11 tiles. (Medians of 4–8 alternated runs each, three sets.) The
collapse and the Start view keep their main-thread time (within ±10 %,
the spread between runs) and the compositor draws 35–45 % less.

What gets the open ready before its motion (the Edit view with an item):

* `Prepare` starts loading the item; the design is made from its icon
  while the proxy shows, and the resample of the icon to the master size
  (256 → 512 px) runs in the panels worker (`fit`), not on the page.
* `Expand` waits — up to a second (`READY_WAIT_MS` in App.svelte), within
  the step's time box — until the item is in and the Edit workspace is
  mounted, laid out and its canvas drawn, all behind the proxy; then the
  morph starts on a view that is ready, and the box's icon lands on the
  canvas. The document is drawn there all along, so it is hidden while the
  icon flies and fades in under it as the icon fades out on landing (the
  canvas and its shadow, `data-morph-landing`): the two never show side by
  side. An item that takes longer arrives in the open panel.
* Behind the proxy the panel is transparent through the opacity of its
  three parts (shadow, shell, content), not `visibility`: every element of
  the view inherits that, and showing the panel restyled them all as the
  morph started.
* The morph's animations are made paused and play two frames later
  (MorphFrame's `play`): the frame that starts them — the mode change, new
  layers — lands before the motion, not in its first frame.
* What the open panel needs only once it is used waits for it
  (`session.whenInteractive()`): the panels worker holds its background
  (low-priority) jobs; the desktop preview reads the wallpaper, decoded
  off the page's thread (`createImageBitmap`); the sidebar's idle
  prefetch, the workspace's preloads and the Backdrop panel's previews
  start then. A preview's canvas exists only once something is drawn on
  it: each canvas is a layer of its own that every frame of the morph
  would commit.
* The regions enter by fading only: a region that moved would give every
  layer painted above it a layer of its own for its whole entrance (the
  compositor assumes they overlap).

What keeps the morph cheap (`src/editor/morph/`):

* Proxy, flyer and panel regions animate transform and opacity only; the
  proxy and the flyer carry a constant non-compositable property so they
  stay on the main thread's clock with the shell (`MAIN_THREAD`).
* The shell's radius changes as it grows, so the shell is repainted at
  those frames: it carries only its fill, hairline and highlight. Once its
  counter-scaled corners are within half a pixel of its radius at rest
  (the last ~third of the open's frames) they keep that radius, and the
  shell only moves. The blurred drop shadow is a layer of its own that
  never moves — it fades in as the shell settles and out as the collapse
  starts. (In software rendering — CI runners, VMs — repainting the blurred
  shadow with the shell doubled the raster work of every frame, ~50 ms per
  frame at the panel's size, and the main thread waits for raster at every
  commit.)
* The content is revealed by a rounded clip (`.content`) laid out on the
  shell's rect — its offset, size and radius animated — with the content
  (`.views`, panel-sized) moved by the opposite offset so it stays in
  place. A `clip-path` did this before: the compositor drew the whole
  content through a mask it rastered anew at every frame. The clip moves
  only while the content shows (from its fade-in on open; for the ~110 ms
  of its fade-out on close).
* The content fades in by a registered custom property
  (`--morph-content-o`, its `opacity`), not an `opacity` animation: an
  animated opacity keeps the whole content in a render pass of its own for
  as long as it runs, even while opaque. The collapse's short fade-out is
  an `opacity` animation; once transparent the content is not drawn.
* The canvas holds still while the open morph plays (`stage.hold`,
  CanvasStage): a 2D canvas on the page is handed to the compositor anew
  at every frame the page commits, drawn or not — ~3 ms of each frame's
  main thread at 4×, a sixth of it. A still picture of it (an `ImageBitmap` on a
  `bitmaprenderer` canvas, handed over once) takes its place — same pixels,
  same box, what the icon lands on — until the panel is open; what the
  canvas was asked to draw meanwhile it draws then. A collapse does not
  hold it: its content is gone after ~110 ms, and taking the picture first
  would delay the motion.
* What is transparent holds still: the proxy's animation stops once it
  has faded, and what the icon lands on starts only as it shows.
* The panel is never `inert` (toggling it restyles every element in it):
  a shield takes the pointer while it animates and focus is kept out.
* Floating layers (tooltips, menus, popovers) are portalled to `<body>`
  and marked `data-floating-layer` (`src/lib/ui/floating.ts`); App.svelte
  hides them while the panel is not open with a rule keyed on that
  attribute. (A rule on `body > :not(#app)` cannot be keyed by the style
  engine: every `data-stage` change restyled the whole document, ~730
  elements and 50–85 ms at 4× as a collapse started.)
* After a collapse the content rests with `content-visibility: hidden`
  until the next open shows or morphs it, so hiding the panel (and the
  page's `data-stage` changes) skip the elements of the view; the next
  open usually replaces the view before it is rendered again.
* Animations are tracked and cancelled directly (no DOM queries or layout
  reads to find them).

## Checks (all must pass before pushing)

```
pnpm check && pnpm test && pnpm build && pnpm e2e && pnpm bundle:budget
cargo fmt --all --check
cargo clippy -p reskin-core --all-targets -- -D warnings
cargo test -p reskin-core
cargo clippy --workspace --all-targets --target x86_64-pc-windows-msvc -- -D warnings   # after pnpm build
```
