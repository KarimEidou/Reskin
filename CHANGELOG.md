# Changelog

All notable changes to Reskin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-09-25

The first release: a small glass box that floats on your Windows desktop.
Drop a desktop item onto it, redesign its icon in a full editor, and Save &
Apply changes the real icon — every change journaled and undoable.

### Added

#### The box

- A floating box in four skins — Glass, Neon, Minimal and Aurora — and three
  sizes, with adjustable opacity at rest. It stays perfectly still while
  idle.
- Drag it anywhere: it follows the pointer, can be flung, snaps to screen
  edges and corners, and remembers its place. Unplugging a monitor never
  strands it: it stays on a screen you have, and its place on that monitor
  counts again once the monitor is back.
- It reacts to what you do: lifts on hover, swells with a count badge while
  you drag items over it, swallows the dropped icon, shows a progress ring
  during Restore all, and shakes with a short message saying why when
  something fails.
- After Save & Apply it flies to the icon on your desktop, drops the new
  icon onto it as it lands and flies home; an **Undo** chip stays on it for
  6 seconds.
- Click it (or press Enter on it) for the Start page; right-click it or the
  tray icon for the menu: Open editor, Library, System icons, Restore all
  icons…, Settings, Hide box / Show box and Quit.
- A global shortcut (Ctrl+Alt+Shift+R by default) shows and hides it. The
  box hides while a full-screen app runs (optional); **Show box** in the
  tray brings it back over one.
- A first-run welcome, and a hint on the box when the saved shortcut is
  taken by another app. Its hints and messages stay readable over any
  wallpaper.

#### Opening and closing the editor

- The box grows into the editor with a morph, and the editor folds back
  into the box when you close it — or they crossfade: if you prefer it,
  with reduced motion, in compatibility mode, or when the editor needs a
  moment longer. The icon you dropped lands right on the canvas.
- The two windows hand the box's picture over in a single frame, so the box
  never shows twice or flickers on the way; its hint and Undo chip fade
  back in just after.
- The editor opens from the box, the tray and box menus, the Explorer entry
  *Reskin this icon*, or a second start of Reskin with a path.
- Closing the editor over unsaved work asks first (**Close anyway** /
  Cancel). When Reskin closes it — the global shortcut, the tray — nothing
  is asked and the work is kept: the next open without new items comes
  back to it.

#### Editor

- **Canvas:** a 512 px master design, or pixel art on a 16–64 px grid with
  crisp scaling; zoom and pan (wheel, Space-drag, Ctrl+0 / Ctrl+1 /
  Ctrl+plus / Ctrl+minus), pixel grid, Windows keyline guides, and
  before/after — hold `\` or use the split view.
- **Tools** (with keys): move/transform (V) with scale and rotate handles;
  rectangle and ellipse select (M, Shift+M), freehand or polygonal lasso
  (L) and magic wand (W); brush (B) with hardness, flow, pressure and
  smoothing, spray (A), pixel-perfect pencil (P) and eraser (E); fill (G)
  and linear, radial or conic gradients (Shift+G); shapes (U) — rectangle,
  rounded rectangle, ellipse, line, arrow, polygon, star, heart, squircle;
  text (T) with your system fonts, editable later; eyedropper (I); sticker
  and emoji stamp (S); smudge (R), blur / sharpen (Shift+R) and dodge / burn
  (O); hand (H) and zoom (Z). Painting tools mirror strokes left–right,
  top–bottom, both ways or radially.
- **Tool rail and options bar:** related tools share a slot with a flyout,
  pressing M, B or R again cycles through their group, and every tool's
  options sit in the bar above the canvas.
- **Selections:** add, subtract and intersect with Shift and Alt; select
  all, deselect, invert, select a layer's pixels, feather, grow, shrink and
  border; Delete clears the selected pixels, and with the Move tool the
  arrow keys nudge them (or the whole layer).
- **Layers:** image and text layers with 12 blend modes, opacity,
  visibility, lock, rename, drag or keyboard reordering, duplicate, merge
  down, flatten and live thumbnails.
- **Adjust:** 22 adjustments with live preview, from brightness/contrast,
  levels and hue/saturation to duotone, gradient map, pixelate, noise,
  sketch, glow and chromatic aberration, applied to the selection when
  there is one — plus icon helpers: remove background, auto-trim & center,
  fit to shape, round corners and add badge.
- **Effects:** non-destructive drop shadow, outer glow, outline, colour
  overlay and inner shadow on any layer.
- **Styles:** twelve looks rebuilt from your own icon — Glass, Neon, Mono
  Light, Mono Dark, Pastel, Retro Pixel, Sticker, Clay, Gradient, Fluent,
  Duotone and Sketch — tunable, and applied as one undo step.
- **Backdrop:** a plate behind the icon — circle, rounded, squircle,
  hexagon, shield or a seeded blob — with solid or gradient fills, gloss
  and border, and eight starter styles.
- **Stickers:** 32 recolourable vector stickers and a searchable emoji
  grid, added as a layer or loaded into the stamp.
- **Colour:** HSV picker, hex/RGB/alpha entry, recent colours, six palettes,
  the original icon's dominant colours, the system eyedropper where
  available, and a gradient editor.
- **Previews:** every icon size from 16 to 256 px, rendered exactly as it
  will be saved, plus the icon with its label on your real wallpaper and
  on light and dark taskbars.
- **History:** undo and redo for everything, and a History panel to jump to
  any step.
- **Import:** drop files on the editor, use Open image… (images, icons,
  shortcuts, programs and `.reskin` projects) or paste an image. While a
  design is open you choose what it becomes — a layer, a new item in the
  queue, or the shortcut the design is for; nothing is ever replaced
  behind your back.
- **Export:** `.ico` (the sizes you choose in Settings), `.png`, copy to
  the clipboard, or a `.reskin` project.
- **Library:** save designs to reuse them on other icons; save changes to
  the design you opened, or save it as new; rename, delete, and apply a
  saved design to the item you are editing. Ctrl+S on a design opened from
  the Library (or saved there) opens the save form, which names that
  design, instead of saving over it.
- **Queue:** drop several items at once and design them one by one; each
  keeps its own design, and removing one with unsaved changes asks first.
  **Apply style to all** gives every other queued icon the current look —
  preset, backdrop, adjustments, helpers and effects, scaled to each
  icon — and applies them in one go.
- **Autosave and recovery:** unsaved designs are saved in the background
  and offered again after a crash.
- **Command palette** (Ctrl+K) with every command, adjustment, icon helper,
  style and setting; a keyboard shortcuts overlay (`?`); toasts with Undo.
- **Views:** Start, Welcome, System icons, Library, History and Settings.

#### Apply, restore and history

- Changes the icon of shortcuts (`.lnk`), internet shortcuts (`.url`,
  Steam and Epic games included), folders and system icons (This PC,
  Recycle Bin empty and full, User files, Network, Control Panel).
- Programs and other files get a new desktop shortcut with your icon —
  Reskin never modifies a program. Store app shortcuts, whose own icon
  Windows ignores, get a classic shortcut by default.
- Public Desktop shortcuts: change them with administrator approval, or
  make a personal copy on your own desktop.
- Optionally also updates the Start-menu and taskbar-pin shortcuts of the
  same app, undone together with the icon — once the icon itself is back,
  so declining the approval to undo a Public Desktop change leaves the
  pins as they are too.
- Every change is journaled before Reskin touches anything. Undo one
  change, restore an icon's original, or restore all icons — from the box,
  the tray, the History view, or `reskin.exe --restore-all` (exit code 0
  when every icon is back); an item you deleted since counts as restored.
- Icons are written as multi-size `.ico` files (16 to 256 px) that are
  never overwritten; Explorer is told to refresh, and **Refresh desktop
  icons** can rebuild its icon cache.

#### Windows integration

- Reads icons the way Windows shows them: `.ico` files, program resources
  (byte for byte), images and the shell's own rendering, including
  Unicode paths and non-Western code pages in `.url` and `desktop.ini`
  files.
- Finds the icon on your desktop for the fly-to-icon animation, and
  celebrates in place when the icon is hidden or covered.
- Start with Windows (respecting Task Manager's on/off switch), the
  Explorer context-menu entry *Reskin this icon*, a global shortcut that
  warns when another app holds it, a tray icon, and a single running
  instance.
- Follows the Windows accent colour and the "Animation effects" setting
  live.
- A missing WebView2 Runtime is detected at start-up, with a link to
  Microsoft's download.

#### Settings

- Appearance: theme (system, light, dark), Windows accent colour, box
  skin, box size, opacity at rest and editor size (S, M, L).
- Motion: animation speed, reduced motion (follows Windows by default),
  morph or crossfade, and whether the new icon flies to the desktop.
- Behaviour: global shortcut, start with Windows, Explorer entry, hide
  during full-screen apps, also update pins, sounds.
- Advanced: compatibility mode (opaque windows for remote desktop or
  unusual graphics drivers), low-memory mode, refresh desktop icons, the
  sizes written into `.ico` files and the pixel-art grid.
- About: version, Releases page and the open-source licenses.

#### Accessibility

- Everything works from the keyboard, with visible focus: the tool rail is
  one tab stop with arrow keys and keyboard flyouts, gradient stops and
  colour wells are keyboard editable, and dialogs return focus where it
  was (questions that destroy something start on Cancel).
- Screen readers hear every toast once, the box's state and messages, and
  a warning when the global shortcut doesn't work.
- Reduced motion follows Windows (or your choice) and turns movement into
  fades; dark and light themes; compatibility mode for opaque windows.
- Text, controls and the focus ring meet WCAG AA contrast in both themes,
  whatever the Windows accent colour.

#### Performance

- The box idles at no CPU cost and loads only a small script of its own
  (at most 33.5 KB compressed).
- The editor is prepared shortly after start, so it opens without a wait;
  low-memory mode closes it completely instead.
- Adjustments, effects, styles, thumbnails and saving run off the main
  thread, so dragging a slider stays smooth; undo keeps only the changed
  parts of the image (up to 256 MB). Library, autosave and project files
  are read and written in the background, so the windows never wait for
  them.

#### Installers and releases

- A per-user installer (no admin prompt), an MSI package and a portable
  exe, with `THIRD_PARTY_NOTICES.txt` and `SHA256SUMS.txt` on every
  release. The installer fetches the WebView2 Runtime when it is missing.
- The uninstaller removes the Explorer entry and "Start with Windows"; with
  *Delete app data* (also `/S /DELETEAPPDATA`) it first puts every icon
  back, and keeps the data if one can't be.
- Continuous integration builds and tests every commit, including the real
  Windows shell integration, a smoke test of the packaged app and an
  install–uninstall round trip; a release is only published for a commit
  that passed.

### Security

- Started as administrator, Reskin restarts itself as a normal user before
  it writes anything, even its log (and warns you when it can't). Public
  Desktop changes go through a separate helper that Windows asks you to
  approve; it accepts only validated jobs, edits only shortcuts that are
  plain files directly on the Public Desktop, creates files only in an
  administrator-owned `%ProgramData%\Reskin` folder and never over an
  existing one, refuses links and hard-linked files, and keeps no log.
- `reskin.exe --restore-all` started as administrator restores nothing
  itself: it runs again as the signed-in user (or refuses).
- Several Reskin processes share the history safely; the editor pages
  work with opaque item handles and a strict content security policy, and
  damaged or oversized `.reskin` files are refused.
- A damaged or crafted icon — an `.ico` file, a program's icon — can't make
  Reskin run out of memory: its sizes are checked before anything is read
  or decoded.

[Unreleased]: https://github.com/KarimEidou/Reskin/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/KarimEidou/Reskin/releases/tag/v1.0.0
