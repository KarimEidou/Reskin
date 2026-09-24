# Reskin UI & interaction spec

The visual and interaction contract for the box and the editor. Tokens live in
`src/lib/theme/tokens.css`; shared components in `src/lib/ui/`.

## Visual language

* **Mood:** calm, glassy, precise. Dark theme first (light theme equally
  polished). The brand gradient from the logo (violet `#7c5cff` → blue
  `#4f7dff` → cyan `#1fc8e3`) is used sparingly: the primary **Save & Apply**
  button, the box rim when armed, focus rings. When "Use Windows accent" is on,
  the accent replaces the brand violet.
* **Type:** `"Segoe UI Variable Text", "Segoe UI", system-ui` 13 px base;
  `"Segoe UI Variable Display"` for view titles (20–28 px, weight 600).
  Numbers in panels use `font-variant-numeric: tabular-nums`.
* **Shape:** editor panel radius 16 px; cards 12 px; controls 8 px; chips and
  pills fully rounded. Hairline borders (`1px`, ~8 % contrast).
* **Depth:** the editor window is transparent and frameless; the panel draws
  its own soft shadow inside a 12 px transparent margin (the margin is part of
  the window, so the panel rect = window rect inset by 12 px).
* **Icons:** Lucide, 18 px, stroke 1.75, per-icon imports.
* **Motion:** springs for spatial moves (open/close morph, panels, popovers),
  120–180 ms eases for hover/press, 30 ms stagger for panel entrances. Every
  duration goes through `dur()` (speed setting + reduced motion). No looping
  animations except while something is actually happening (busy ring,
  armed particles, marching ants).
* **Density:** comfortable but compact — 32 px control height, 8/12/16 px
  spacing scale. Everything is keyboard reachable with visible focus.

## Editor layout (Edit view)

```
┌ title bar (40): logo · item ▾ · [Edit Library History Settings] · Ctrl+K · ✕ ──┐
│┌rail┐┌ tool options bar (40) ──────────────────────────┐┌ sidebar (300) ──────┐│
││ ▢  ││                                                 ││ tabs: Layers Color  ││
││ ✎  ││           canvas stage (checkerboard,           ││ Adjust Effects      ││
││ ⌫  ││         512² doc fit to view, zoom/pan,         ││ Styles Backdrop     ││
││ ▣  ││         pixel grid, keylines, overlays)         ││ Stickers History    ││
││ ◯  ││                                                 │├ previews ───────────┤│
││ T  ││                                                 ││ 16 20 24 32 … 256   ││
││ ⌖  ││                                                 ││ [desktop] [taskbar] ││
│└────┘└─────────────────────────────────────────────────┘└─────────────────────┘│
└ bottom bar (52): queue · zoom · toggles ·· Save · Export ▾ · Save & Apply ▾ ───┘
```

* **Title bar** is the drag region (`data-tauri-drag-region` on empty space
  only; controls are not draggable): the logo (→ Start), the current item
  ("1/3" when several are queued; its menu lists the queue), the view tabs
  (Edit only while a design is open), the command palette button and Close.
  Close (✕) runs the collapse handoff (`editor_close('user')`); Esc does the
  same when no popover/dialog/tool operation is active.
* **Tool rail** (`workspace/tool-groups.ts`), four clusters separated by
  hairlines:
  * transform & select — Move (V); selection tools: rectangle (M), ellipse
    (Shift+M), lasso (L; freehand or polygonal), magic wand (W);
  * paint — brush tools: brush (B), spray (A); pencil (P); eraser (E);
  * fill, shapes & text — fill tools: fill (G), gradient (Shift+G); shapes
    (U); text (T); eyedropper (I); sticker stamp (S); retouch tools: smudge
    (R), blur / sharpen (Shift+R), dodge / burn (O);
  * view — hand (H, or hold Space) and zoom (Z).

  A slot with several tools shows the one in use (else the last used) with a
  small corner triangle, and opens a flyout on right-click, a long press, →
  or Alt+↓. Icons follow the tools' options (dodge ↔ burn, blur ↔ sharpen,
  freehand ↔ polygonal lasso); tooltips show name + shortcut. The rail is one
  tab stop (↑ / ↓ / Home / End move between slots); the colour chips (swap X,
  reset D) sit at its foot, and it compacts on short windows.
* **Tool keys**: a tool's key selects it. Pressed again, the key of an engine
  group moves on to the group's next tool and round — M rectangle ↔ ellipse,
  B brush ↔ spray, R smudge → blur / sharpen → dodge / burn. A first press
  never cycles (B with the spray picked from the rail selects the brush), and
  a tool chosen another way in between (rail, palette) starts over. Tool keys,
  undo / redo, layer commands and Save & Apply fire from the keyboard only in
  the Edit view.
* **Tool options bar**: context options for the active tool (size, hardness,
  flow, opacity, smoothing, tolerance, contiguous, shape kind, fill/stroke,
  font, spray density and **Reshuffle**, retouch strength and exposure, the
  stamp's sticker and **Choose sticker…**, Apply / Cancel for a pending
  transform…) plus symmetry (off, mirror left–right, top–bottom or both,
  radial with 2–32 rays) for painting tools. Selection tools add the
  **Selection** menu: Select all (Ctrl+A), Deselect (Ctrl+D), Invert
  (Ctrl+Shift+I), Select layer pixels, and Feather… / Grow… / Shrink… /
  Border…, which ask for an amount (1–64 px) in a prompt under the bar (the
  palette opens the same prompt with any tool). Controls the bar has no room
  for fold into **More options**.
* **Canvas stage**: checkerboard transparency; the 512 master scaled to fit
  with 24 px breathing room; wheel = zoom at cursor, Space-drag / middle-drag
  = pan, Ctrl+0 fit, Ctrl+1 100 %, Ctrl+ +/−. Pixel grid appears ≥ 8× (≥ 4×
  in pixel-art documents). Windows keyline guides toggle (K). Before/after:
  hold `\` shows the original icon; split view toggle in the bottom bar.
  Enter commits a transform, text edit or lasso polygon; with the Move tool
  the arrows nudge the layer, or the selected pixels (Shift: 10 px). Delete /
  Backspace clear the selected pixels, or the whole layer without a
  selection (while a lasso polygon is being drawn they remove its last
  corner instead). An image pasted or dropped on the canvas goes through the
  import popover, which opens at the pointer.
* **Sidebar tabs** (panels are independent components in `src/editor/panels/`):
  Layers (Ctrl+click a thumbnail selects that layer's pixels; Shift adds, Alt
  subtracts), Color, Adjust (filters and icon helpers), Effects (layer
  effects), Styles (presets), Backdrop, Stickers, History. The **Previews**
  block is always visible at the bottom of the sidebar: every export size
  rendered through the real export path (crisp at 1:1, labelled), plus "On
  your desktop" (the icon with its label over the actual wallpaper at the
  desktop icon size) and taskbar light/dark previews.
* **Bottom bar**: the batch queue strip (a thumbnail per queued item, the
  current one highlighted, status badges — not started, editing, applying,
  applied, failed; the tooltip adds why an apply did not go through and the
  item's notes) with **Apply style to all**, which replays the current
  item's style — preset, backdrop, adjustments, icon helpers, layer
  effects — on every other queued target and applies it, the same look at
  any size (pixel settings scale with each icon's document); zoom % (click
  to fit), keyline guides, before/after split, pixel-art toggle with grid
  size; **Save to Library** (a design that came from or was saved as a
  Library design names it — Updates "Mono" in your Library — and says so
  when a new name renames it; **Save changes** updates it, **Save as new**
  adds another); **Export ▾** (.ico / .png / copy to clipboard / .reskin
  project); and the primary **Save & Apply ▾** (dropdown: mode — Change in
  place / New desktop shortcut / Personal copy — disabled when not in
  `item.modes`; the item's notes; "Also update Start menu and taskbar
  pins"). The main part uses the item's preferred mode (New desktop shortcut
  for Store app shortcuts, whose own icon Windows ignores). Apply shows a
  ring while working.
* **Queue completion**: only *targets* count — items Save & Apply can change
  (shortcuts, folders, system icons, programs and other files), not design
  sources such as images or projects. While another target still waits,
  Save & Apply keeps the editor open: the item gets its "applied" badge, a
  toast offers **Undo** for 6 s, and the next target not applied yet opens.
  The last target plays the flourish — the window collapses into the box,
  which flies to the icon — when "Fly the new icon to the desktop" is on,
  motion is not reduced and the box may show; otherwise its icon changes in
  place and the editor stays open with the same Undo toast. Queue items
  cannot be switched or removed while a job runs or an item loads (the strip
  and the title bar's queue menu alike show them disabled).

## Views

* **Start** (click on the box): big drop target ("Drag a shortcut, folder or
  image here — or onto the box"), buttons Open image… (Ctrl+O), New blank
  icon (Ctrl+N; asks first when it would replace unsaved changes), System
  icons, Library; recent designs row (from the Library); recent history row
  with Undo; "Restore all icons…" link. A design an earlier launch left
  unsaved shows as a "Continue where you left off" banner (Restore /
  Discard) above the drop target.
* **Welcome** (first run): three short animated cards (drop → design → apply),
  a "Got it" button that collapses the editor into the box and then the box
  shows the hint "drag a shortcut onto me" for a few seconds.
* **System icons**: grid of This PC, Recycle Bin (empty/full), User files,
  Network, Control Panel with their current icons; click → edit.
* **Library**: grid of saved designs (thumb, name, date) with a name filter,
  open / rename / delete / apply to current item. Opening one over unsaved
  changes asks first. The design open in the editor remembers the Library
  design it came from or was saved as (its card says "Editing"): **Save
  changes** updates it, **Save as new** adds a copy. Without that card on
  the page (still loading, or gone from the Library) **Save current design**
  adds a new one — a save never overwrites a design the user cannot see.
* **History**: every change Reskin made (thumb, target, when, state), with
  Undo / Restore original per row and "Restore all".
* **Settings**: Appearance (theme, accent, box skin + live BoxVisual preview,
  box size, idle opacity, editor size), Motion (animation speed, reduced
  motion, open style morph/crossfade, flourish), Behaviour (hotkey recorder,
  start with Windows, Explorer context menu, auto-hide in fullscreen, also
  update pins, sounds), Advanced (compatibility mode, low-memory mode,
  refresh desktop icons (quick / rebuild cache), export sizes, pixel-art
  grid), About (version, build, Releases link, MIT license, and "Open-source
  licenses": a dialog, loaded when first opened, with the third-party
  notices shipped in the app). The hotkey recorder takes one key with Ctrl,
  Alt or Win (F1–F24 also alone); a saved hotkey Windows won't register
  (another app holds it) shows a warning under the recorder, and recording
  it again retries it. The accent swatch follows Windows live.

## Dialogs & overlays

* **Elevation** (apply returned `needsElevation`): explains Public Desktop;
  buttons "Allow (administrator)" → `apply_icon_elevated(ticket)`, "Make a
  personal copy" → apply with mode `personalCopy`, Cancel. After "Apply
  style to all" it asks once about every such icon (listed by name):
  Allow approves them one by one, "Make personal copies" copies the ones
  that can be copied.
* **Import popover** (`shell.askImport`): what is dropped on the window,
  picked with Open image… (the Import dialog's filters: images, icons,
  shortcuts, programs and `.reskin` projects; or projects only) or pasted
  while a design is open. A drop asks where it landed, a paste on the canvas
  at the pointer, anything else (a pick, a paste elsewhere) in the middle.
  Choices: "Add as layer" (another shortcut: "Use its icon as a layer";
  projects join the queue instead) and "Queue as new item" (shortcuts:
  "Queue it"; images and projects become designs of their own); a shortcut
  dropped on a design without a target offers "Apply this design to “…”"
  first (the other items join the queue). Nothing open is replaced, and
  nothing goes in without asking. Work in progress stays: a pending move is
  committed and an adjustment being tuned kept before the new layer, so Undo
  takes back just that layer. With nothing open, things open without asking.
* **Crash recovery** (a design an earlier launch left unsaved): Restore /
  Discard. Restoring brings its shortcut back into the queue when it still
  exists. Only unsaved work is ever offered — a design opened and closed
  without changes, or applied / saved / exported, leaves nothing behind.
* **Command palette** (Ctrl+K): fuzzy search over every command (tools,
  filters and icon helpers — opened in the Adjust panel —, style presets —
  applied from the Styles panel —, views, every settings switch,
  export/apply, open project), shows shortcuts (also the canvas's own keys,
  e.g. Delete for "Clear the selected pixels").
* **Shortcuts overlay** (`?`): grouped keyboard map — every command's keys,
  the tool keys with "Next tool of the group (press again)", and the
  canvas's own keys.
* **Toasts**: bottom-centre stack; success/info/error; optional action
  (e.g. Undo); auto-dismiss 4–6 s. Screen readers hear each toast once:
  the stack is two persistent live regions, warnings/errors (an alert
  region, on top) and info/success (a polite status region below).

## Box

See `BoxVisual.svelte`. The box is 120 px (M; S 96, L 148) of glass — or
Neon, Minimal, Aurora — with a 14 px margin for glow and scale, at the
opacity set for rest; it never animates while idle. States: idle, hover
(lift), armed (swell, bright rim, inward particles, count badge), absorbing
(squash & stretch as the icon falls in), busy (progress ring), flying
(tilt/stretch in flight), celebrate (sparkle ripple), error (shake; a short
message inside the box says why, up to three lines, and stays until it has
been read). After an apply it shows an **Undo** chip for 6 s (`box:undo`):
the box celebrates when the icon is back, or shakes saying why not. A saved
hotkey Windows won't register at start-up (another app holds it) is said
once, in the hint for a few seconds on screen ("Ctrl+Alt+Shift+R is taken —
change it in Settings"; after the first-run hint, and gone as soon as the
hotkey works); the box's tooltip and accessible description say it for as
long as it doesn't work. When the editor opens from elsewhere
(tray, menu, Explorer, first run), the box first takes on the picture the
editor's proxy draws — never the other way round.

* **Pointer and keyboard**: a click (or Enter / Space on the focused box)
  opens the editor's Start view; a drag moves the box (4 px separate a
  click from a drag), with fling and snap to the screen's edges and corners,
  and its place is kept. Right-click opens the menu.
* **Menu** (the box's right-click menu and the tray icon's): Open editor,
  Library, System icons ▸, Restore all icons…, Settings, the box item, Quit
  Reskin. The box item follows the box: *Hide box* while it shows, else
  *Show box*, which shows it — closing an open editor into it — also over a
  fullscreen app, until no fullscreen app has been seen for 30 s or the box
  is hidden again.
* **Hotkey and tray click** toggle the box; with the editor open they close
  it into the box, and while a fullscreen app hides the box they open the
  editor. Starting Reskin again brings the open editor to the front, else
  does what *Show box* does.
