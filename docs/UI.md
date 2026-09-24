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
┌ title bar (40) ─ logo · item name ▾ · [Edit Library History Settings] ·· ⌘K  ✕ ┐
│┌rail┐┌ tool options bar (40) ──────────────────────────┐┌ sidebar (300) ─────┐│
││ ▢  ││                                                 ││ tabs: Layers Color  ││
││ ✎  ││             canvas stage (checkerboard,         ││ Adjust Effects      ││
││ ⌫  ││             512² doc fit to view, zoom/pan,     ││ Styles Backdrop     ││
││ ▣  ││             pixel grid, keylines, overlays)     ││ Stickers History    ││
││ ◯  ││                                                 │├ previews ──────────┤│
││ T  ││                                                 ││ 16 20 24 32 … 256  ││
││ ⌖  ││                                                 ││ [desktop] [taskbar]││
│└────┘└─────────────────────────────────────────────────┘└────────────────────┘│
└ bottom bar (52): queue strip · zoom · pixel-art · before/after ·· Export ▾  [Save & Apply ▾] ┘
```

* **Title bar** is the drag region (`data-tauri-drag-region` on empty space
  only; controls are not draggable). Close (✕) runs the collapse handoff
  (`editor_close('user')`); Esc does the same when no popover/dialog/tool
  operation is active.
* **Tool rail**: move/transform (V), rect/ellipse/lasso/wand selection (M/L/W),
  brush (B), pencil (P), eraser (E), fill (G), gradient (Shift+G), shapes (U),
  text (T), eyedropper (I), sticker/emoji stamp (S), smudge/blur/dodge-burn
  group (R), hand (H / hold Space), zoom (Z). Groups show a small corner
  triangle and open a flyout. Tooltips show name + shortcut.
* **Tool options bar**: context options for the active tool (size, hardness,
  flow, opacity, smoothing, tolerance, contiguous, shape kind, fill/stroke,
  font…) plus symmetry toggle (X / Y / radial N) for painting tools.
* **Canvas stage**: checkerboard transparency; the 512 master scaled to fit
  with 24 px breathing room; wheel = zoom at cursor, Space-drag / middle-drag
  = pan, Ctrl+0 fit, Ctrl+1 100 %, Ctrl+ +/−. Pixel grid appears ≥ 8×. Windows
  keyline guides toggle (K). Before/after: hold `\` shows the original icon;
  split view toggle in the bottom bar.
* **Sidebar tabs** (panels are independent components in `src/editor/panels/`):
  Layers, Color, Adjust (filters), Effects (layer effects), Styles (presets),
  Backdrop, Stickers, History. The **Previews** block is always visible at the
  bottom of the sidebar: every export size rendered through the real export
  path (crisp at 1:1, labelled), plus "On your desktop" (the icon with its
  label over the actual wallpaper at the desktop icon size) and taskbar
  light/dark previews.
* **Bottom bar**: batch queue strip (thumbnails of every item dropped; current
  one highlighted; status badges; the tooltip adds why an apply did not go
  through and the item's notes; "Apply style to all" replays the current
  item's style on every other queued icon), zoom %, pixel-art
  toggle with grid size, before/after split, **Save to Library**, **Export ▾**
  (.ico / .png / copy to clipboard / .reskin project), and the primary
  **Save & Apply ▾** (dropdown: mode — Change in place / New desktop shortcut /
  Personal copy — disabled when not in `item.modes`; the item's notes;
  "Also update Start menu and taskbar pins"). The main part uses the item's
  preferred mode (New desktop shortcut for Store app shortcuts, whose own
  icon Windows ignores). Apply shows a ring while working. With other
  queued items still waiting the editor stays open: the item gets its
  "applied" badge, a toast offers **Undo** for 6 s, and the next item not
  applied yet opens. The last one collapses the window into the box.
  Queue items cannot be switched or removed while a job runs or an item
  loads (the strip and the title bar's queue menu alike show them
  disabled).

## Views

* **Start** (click on the box): big drop target ("Drag a shortcut, folder or
  image here — or onto the box"), buttons Open image…, System icons, Library;
  recent designs row (from the Library); recent history row with Undo;
  "Restore all icons…" link.
* **Welcome** (first run): three short animated cards (drop → design → apply),
  a "Got it" button that collapses the editor into the box and then the box
  shows the hint "drag a shortcut onto me" for a few seconds.
* **System icons**: grid of This PC, Recycle Bin (empty/full), User files,
  Network, Control Panel with their current icons; click → edit.
* **Library**: grid of saved designs (thumb, name, date), open / rename /
  delete / apply to current item. Opening one over unsaved changes asks
  first. The design open in the editor remembers the Library design it came
  from or was saved as (its card says "Editing"): **Save changes** updates it,
  **Save as new** adds a copy.
* **History**: every change Reskin made (thumb, target, when, state), with
  Undo / Restore original per row and "Restore all".
* **Settings**: Appearance (theme, accent, box skin + live BoxVisual preview,
  box size, idle opacity), Motion (animation speed, reduced motion, open style
  morph/crossfade, flourish), Behaviour (hotkey recorder, start with Windows,
  Explorer context menu, auto-hide in fullscreen, also update pins, sounds),
  Advanced (compatibility mode, low-memory mode, refresh desktop icons (quick /
  rebuild cache), export sizes), About (version, build, Releases link, MIT
  license, and "Open-source licenses": a dialog, loaded when first opened,
  with the third-party notices shipped in the app). A saved hotkey Windows
  won't register (another app holds it) shows a warning under the recorder;
  recording it again retries it. The accent swatch follows Windows live.

## Dialogs & overlays

* **Elevation** (apply returned `needsElevation`): explains Public Desktop;
  buttons "Allow (administrator)" → `apply_icon_elevated(ticket)`, "Make a
  personal copy" → apply with mode `personalCopy`, Cancel. After "Apply
  style to all" it asks once about every such icon (listed by name):
  Allow approves them one by one, "Make personal copies" copies the ones
  that can be copied.
* **Import popover** (files dropped, picked or pasted while a design is
  open): "Add as layer" (another shortcut: "Use its icon as a layer") or
  "Queue as new item" (shortcuts: "Queue it"); nothing open is replaced.
  A shortcut dropped on a design without a target offers "Apply this design
  to “…”" first. With nothing open, things open without asking.
* **Crash recovery** (a design an earlier launch left unsaved): Restore /
  Discard. Restoring brings its shortcut back into the queue when it still
  exists. Only unsaved work is ever offered — a design opened and closed
  without changes, or applied / saved / exported, leaves nothing behind.
* **Command palette** (Ctrl+K): fuzzy search over every command (tools,
  filters, presets, views, settings toggles, export/apply), shows shortcuts.
* **Shortcuts overlay** (`?`): grouped keyboard map.
* **Toasts**: bottom-centre stack; success/info/error; optional action
  (e.g. Undo); auto-dismiss 4–6 s; `aria-live="polite"`.

## Box

See `BoxVisual.svelte`. The box is 120 px (M) of glass with a 14 px margin
for glow and scale; it never animates while idle. States: idle, hover (lift),
armed (swell, bright rim, inward particles, count badge), absorbing
(squash & stretch as the icon falls in), busy (progress ring), flying
(tilt/stretch in flight), celebrate (sparkle ripple), error (shake). After an
apply it shows an **Undo** chip for 6 s (`box:undo`).
