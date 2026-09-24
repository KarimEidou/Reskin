# Reskin image engine (`$engine`)

Pure-TypeScript image engine behind the editor: document model, painting
tools, undo history, compositing, export to icon PNGs and `.reskin` project
files. It has no Svelte and no DOM in its core, so every piece is unit tested
in Node (`pnpm test`). Browser-only helpers (canvas view, font rendering,
image decoding) are kept in separate modules.

```ts
import { Engine, Viewport, toSizedPngs, parseColor } from '$engine/index'; // pure core
import { CanvasView, createCanvasTextRasterizer, decodeImage } from '$engine/dom'; // browser only
```

The box page must not import `$engine` (see docs/ARCHITECTURE.md).

---

## Conventions

| Topic | Rule |
| --- | --- |
| Document size | Square. **512×512** normally (`MASTER_SIZE`); **grid×grid** (16/24/32/48/64) in pixel-art mode. |
| Coordinates | Document px, continuous: pixel *(i, j)* covers `[i, i+1) × [j, j+1)`, its centre is `(i+0.5, j+0.5)`. Pointer input is in these units. |
| Pixel storage | `Surface`: RGBA8, **straight (non-premultiplied) alpha** — the same as `ImageData`, PNG and the IPC `SizedPng`. |
| Maths | Compositing, resampling and filters run on premultiplied `Float32` (`FloatImage`, 0..1). Conversion happens only at the boundary, once. |
| Colours | `Rgba = { r, g, b: 0..255, a: 0..1 }`, straight, like CSS. |
| Layer order | `doc.layers[0]` is the **bottom** layer. A Layers panel lists them reversed. |
| Angles | Degrees for user-facing values (text rotation, effect light angle); radians inside transform maths. |
| Time | Pointer timestamps in ms (use `PointerEvent.timeStamp`). |

---

## Quick start: an editor canvas

```ts
import { Engine, Viewport, toPointerInputs } from '$engine/index';
import { CanvasView, createCanvasTextRasterizer } from '$engine/dom';

const engine = new Engine({ textRasterizer: createCanvasTextRasterizer() });
const viewport = new Viewport({ viewWidth: stageW, viewHeight: stageH });
engine.attachViewport(viewport); // hand/zoom tools and handle sizes use it

let frame = 0;
const requestRender = () => (frame ||= requestAnimationFrame(render));
const view = new CanvasView(engine, { onInvalidate: requestRender });
viewport.subscribe(requestRender);

function render() {
  frame = 0;
  view.render(ctx, viewport, { dpr: devicePixelRatio, showKeylines });
  canvasEl.style.cursor = engine.cursor.css;
}

// Pointer → document coordinates (canvas CSS px → doc px).
const toDoc = (cx: number, cy: number) => {
  const r = canvasEl.getBoundingClientRect();
  const sx = cx - r.left, sy = cy - r.top;
  const d = viewport.screenToDoc(sx, sy);
  return { x: d.x, y: d.y, screenX: sx, screenY: sy };
};
let button = 0;
canvasEl.onpointerdown = (e) => {
  canvasEl.setPointerCapture(e.pointerId);
  button = e.button;
  engine.pointerDown(toPointerInputs(e, toDoc, button).at(-1)!);
};
canvasEl.onpointermove = (e) => engine.pointerMove(toPointerInputs(e, toDoc, button)); // coalesced samples
canvasEl.onpointerup = (e) => engine.pointerUp(toPointerInputs(e, toDoc, button).at(-1)!);
canvasEl.onpointercancel = () => engine.pointerCancel();
canvasEl.onpointerleave = () => engine.pointerHover(null);
canvasEl.onwheel = (e) => viewport.zoomStep(e.deltaY < 0 ? 1 : -1, e.offsetX, e.offsetY);
// Stage resize: viewport.setViewSize(w, h); size the canvas to w·dpr × h·dpr.
```

Keyboard: forward `keydown` to `engine.keyDown(e.key, modifiersOf(e))` (Enter
commits a transform or closes a lasso polygon, Escape cancels, Backspace
removes the last polygon corner, arrows nudge; it returns false for keys the
tool did not use, so the UI's own shortcuts can run) and modifier changes
during a drag to `engine.updateModifiers(...)` so Shift-constrain reacts
without moving the mouse. Hold-Space panning:
`engine.setToolOverride('hand')` on keydown, `setToolOverride(null)` on keyup
(overrides never commit pending work).

**Svelte wrapping.** The engine is framework-agnostic. A typical
`*.svelte.ts` store keeps a `$state` version counter per event kind and bumps
it from `engine.subscribe(...)`; components read `engine.doc`,
`engine.historyEntries`, etc. inside `$derived`s keyed on those counters.
Coalesce redraws with `requestAnimationFrame` as above.

---

## `Engine`

`new Engine(opts?)` — `opts`: `doc`, `textRasterizer`, `historyBytes`
(default 256 MB), `viewport`, `primary`, `secondary`, `tool`.

### Events — `engine.subscribe(listener) → unsubscribe`

| `kind` | Payload | Meaning |
| --- | --- | --- |
| `pixels` | `layerId, rect` | A layer's pixels changed (text re-renders too). Redraw `rect`. |
| `layers` | | Layer list/order/props or the active layer changed. |
| `selection` | | Selection mask changed. |
| `history` | | Undo stack changed (entries or index). |
| `tool` | | Tool, tool options or cursor changed. |
| `color` | | Primary/secondary changed. |
| `symmetry` | | Symmetry settings changed. |
| `document` | | Document replaced or resized (pixel-art toggle, load): reset views. |
| `overlay` | | Tool overlay needs a redraw (hover, drag preview). |
| `interaction` | `active` | A pointer gesture started/ended. |
| `textEdit` | `layerId \| null` | Open/close the inline text editor for a text layer. |
| `preview` | `layerId, state` | A layer preview opened (`'open'`) or ended (`'committed'`, `'cancelled'`, `'stale'`). |
| `message` | `level, text` | Show a toast, e.g. "Layer 2 is locked". |

Events fire synchronously; batch UI work per animation frame.

### State

`doc`, `activeLayer`, `getLayer(id)`, `toolId` (effective, incl. override),
`selectedToolId`, `primary`, `secondary`, `symmetry`, `cursor`
(`{ css, radius }`), `isInteracting`, `hasPending`, `canUndo`, `canRedo`,
`historyEntries`, `historyIndex`, `currentEntryId`, `preview` (the open
layer preview or null), `textEditLayerId`, `viewport`, `subscriberCount`
(live listeners, for leak checks),
`textMeasurer`, `history` (read it; mutate through the engine), `tools`
(the concrete tool objects: `tools.move.params` is the pending transform,
`tools.lasso.polygon` the polygon being built), `transformBox` (the box the
move tool shows: pending transform, else the active layer's content bounds
or text block; null when there is nothing to move — for W/H/angle fields).

### Input

`pointerDown(p)`, `pointerMove(p | p[])`, `pointerUp(p)`, `pointerCancel()`,
`pointerHover(p | null)`, `updateModifiers(mods)`, `keyDown(key, mods) →
handled`, `drawOverlay(painter)`. Build inputs with `toPointerInputs(event,
toDoc, button)` (coalesced samples) or `pointerInput({ x, y, ... })`. Mouse
pressure is normalised to 1.

### Tools

Pending work (`hasPending`: a transform session, a lasso polygon being
built) is finished with `commitPending()` (Enter) or dropped with
`cancelPending()` (Esc); undo cancels it too.

`setTool(id)` commits pending work; `setToolOverride('hand' | 'zoom' |
'eyedropper' | null)` (pending work of the selected tool — a transform box,
a lasso polygon — stays drawn underneath); `getToolOptions(id)`,
`setToolOptions(id, patch)`. Tools clamp numeric options into the ranges
below when they use them.

| id | Shortcut | Options (defaults) |
| --- | --- | --- |
| `move` | V | `handleTolerance` 7 (screen px). The content box and its handles show as soon as the tool is active on a visible, unlocked layer with content (raster: its pixels, or base × selection); the first drag inside moves, on a handle scales (Shift keeps ratio, Alt from centre; the nearest handle wins), on the rotate handle / outside a corner rotates (Shift 15°); anywhere else it moves. On a box too small for its handles (under 4× `handleTolerance` on screen) a press inside always moves; its handles are grabbed from just outside. Enter/tool switch commits the whole session as one entry; undo or Esc cancels it — Esc (or pointercancel) *during* a drag reverts only that drag. Moves the selected pixels and the selection when there is one. **Text layers** stay text: drag inside = move (x/y), corner handles = resize through the font size (uniform only, so no edge handles; Alt about the centre), rotate handle = rotation about the block centre (Shift 15°). Each drag is one entry ("Move text" / "Resize text" / "Rotate text"), arrow nudges merge into one "Move text", Esc during a drag reverts. |
| `selectRect` / `selectEllipse` | M / Shift+M | `mode` replace/add/subtract/intersect, `antialias` (default off for rectangles — they snap to whole pixels — on for ellipses; always off in pixel-art documents), `feather`. Shift/Alt at press = add/subtract (both = intersect); during drag Shift = square, Alt = from centre; click = deselect. |
| `lasso` | L | `kind` 'freehand' / 'polygon', `mode` 'replace', `antialias` true (off in pixel-art), `feather` 0. Same Shift/Alt ops at the first press. Freehand: drag; release closes (self-crossing outlines select every enclosed lobe); a click — an outline enclosing less than 1 px² — deselects. Polygon: clicks add corners (drag a press to place it; Shift snaps the edge to 45°); a double-click (two presses ≤ 500 ms and ≤ 5 screen px apart — the UI may also forward `dblclick` as Enter), Enter, or a click on the first corner closes it; Backspace removes the last corner; Esc or undo discard it; a tool switch closes it. One "Lasso select" entry. |
| `magicWand` | W | `mode` 'replace', `tolerance` 32 (0..255, same metric as fill), `contiguous` true, `sampleMerged` false (active layer vs visible composite), `antialias` true (1 px soft edge, the marching ants are unchanged; off in pixel-art), `feather` 0. Same Shift/Alt ops. One "Magic wand" entry per click. |
| `brush` | B | `size` 24, `hardness` 0.8, `spacing` 0.15 (× diameter), `flow` 1, `opacity` 1, `pressureSize` true, `pressureOpacity` false (pressure caps how opaque each dab can build up to, so a light touch stays light), `minSize` 0.2, `smoothing` 0.3 (1€), `catchUp` true. Right button paints the secondary colour. |
| `spray` | A | `radius` 24 (1..256), `density` 0.5 (0..1; at 1 a dab scatters dots covering ≈ 10 % of the disc), `dotSize` 1.5 (0.5..32), `flow` 0.8 (per dot), `opacity` 1 (stroke cap), `pressureDensity` true, `seed` 1. Dots come from a seeded PRNG per stroke (seed ⊕ stroke counter ⊕ start point): identical input gives identical pixels. Dabs every radius/2 px along the path (holding still does not keep spraying). Right button sprays the secondary colour. |
| `pencil` | P | `size` 1, `pixelPerfect` true (removes L-corners), `opacity` 1. |
| `eraser` | E | Same as brush (hardness 0.9). |
| `fill` | G | `tolerance` 32 (0..255, max channel Δ on premultiplied RGBA), `contiguous` true, `sampleMerged` false, `opacity` 1. |
| `gradient` | Shift+G | `kind` linear/radial/conic, `spread` pad/repeat/reflect, `source` 'colors' (primary→secondary) or 'custom' (`stops`), `reverse`, `opacity`, `dither` true. Shift snaps 15°. |
| `shape` | U | `kind` rect/roundedRect/ellipse/line/arrow/polygon/star/heart/squircle, `fill`, `stroke`, `strokeWidth` 8, `cornerRadius` 64, `sides` 6, `innerRatio` 0.5, `opacity`. Fill = primary; stroke = secondary when both are on. Shift constrains, Alt from centre. |
| `text` | T | `fontFamily` 'Segoe UI', `fontSize` 64, `weight` 600, `italic`, `align` 'center'. Click empty space → new text layer + `textEdit` (closing the previous edit first); click text → edit; drag text → move (one "Move text" entry on release; Esc reverts). |
| `eyedropper` | I | `sample` composite/layer, `size` 1/3/5. Right button/Alt → secondary. |
| `stamp` | S | `stamp` (a `Surface` — sticker, emoji, any image — or null), `scale` 1 (0.01..16), `rotation` 0 (degrees, clockwise), `opacity` 1. A click stamps it centred on the pointer; a drag previews it live (rendered into the layer, selection clipping included) and stamps once where released. Quarter-turn rotations snap to whole pixels (unscaled stamps land pixel-exact); bilinear otherwise, nearest in pixel-art. Hover shows its outline (every symmetric copy). Without a stamp: a `message`, cursor `not-allowed`. One "Stamp" entry. |
| `smudge` | R | `size` 24, `hardness` 0.5, `strength` 0.5 (0..1; 1 = finger painting), `spacing` 0.1, `pressureStrength` true. Classic accumulation in premultiplied space: smudging into transparency fades alpha and never darkens colour. |
| `blurSharpen` | Shift+R | `mode` 'blur' / 'sharpen', `size` 32, `hardness` 0.5, `strength` 0.5, `blurRadius` 1.5 (Gaussian σ, 0.3..16), `spacing` 0.25, `pressureStrength` true. Each dab blurs its footprint (+ 3σ margin) with the filters' Gaussian core: blur mixes premultiplied colour (edges fade, never darken); sharpen is an unsharp mask of the straight colour against the alpha-weighted blur with alpha kept, like the Sharpen filter (a silhouette's edge is not brightened by the transparency around it). Cumulative (scrubbing keeps going). Entries "Blur" / "Sharpen". |
| `dodgeBurn` | O | `mode` 'dodge' / 'burn', `range` 'shadows' / 'midtones' / 'highlights' (weights (1−L)², 4L(1−L), L²), `exposure` 0.5, `size` 32, `hardness` 0.5, `spacing` 0.15, `pressureExposure` true. Changes Rec.709 luminance only (W3C SetLum: hue and alpha kept); one stroke changes a pixel by at most `exposure` however often it passes over it. Entries "Dodge" / "Burn". |
| `hand` | H | — (needs `screenX/screenY` on input and a viewport) |
| `zoom` | Z | `zoomOut` false. Click steps, horizontal drag scrubs. |

`TOOL_ORDER` is the rail order. `TOOL_META[id]` is `{ id, label, shortcut,
icon, group, usesSymmetry }`, available without an engine: `icon` is a
Lucide icon name (`'lasso'`, `'wand-sparkles'`, `'spray-can'`, `'pointer'`,
`'droplets'`, `'sun'`, `'stamp'`…) and `toolIcon(id, options)` follows the
mode (burn → `'moon'`, polygon lasso → `'lasso-select'`, sharpen →
`'triangle'`). `group` hints which tools can share a rail slot with a
flyout: `'marquee'` (rect/ellipse), `'brush'` (brush/spray), `'retouch'`
(smudge, blur/sharpen, dodge/burn); null = its own slot. Shortcuts are
proposals shown in tooltips; the UI owns the key bindings.

All painting tools (brush, pencil, eraser, spray, smudge, blur/sharpen,
dodge/burn, stamp) refuse hidden, locked and text layers with a `message`,
are clipped to the selection, record one history entry per stroke (only the
changed 64×64 tiles, so undo is byte-exact), use whole-pixel footprints in
pixel-art documents and only process the footprint of each dab. Their
`engine.cursor.radius` is the footprint radius (draw a ring when the UI
hides the overlay).

**Symmetry** (`setSymmetry({ mode: 'off'|'x'|'y'|'xy'|'radial', rays, mirror, cx, cy })`)
applies to brush, pencil, eraser, spray, smudge, blur/sharpen, dodge/burn and
stamp (mirrored stamps are mirror images); guides are drawn by
`drawOverlay`.

### Layers (every change is one undo step)

`addLayer({ name?, index? }) → id`, `addTextLayer(props?) → id`,
`importImage(surface, name, fit?) → id` (fits and centres any image),
`deleteLayer(id?)`, `duplicateLayer(id?) → id`, `renameLayer(id, name)`,
`moveLayer(id, toIndex)` (bottom = 0), `mergeDown(id?)`, `flatten()`,
`replaceLayers(layers, opts)` (see below),
`rasterizeLayer(id?)`, `setLayerProps(id, { name, visible, locked, opacity,
blend, effects }, { merge?: key })` — pass `merge` for sliders so a drag is
one entry — `setActiveLayer(id)` (not an undo step), `clearPixels(id?)`
(Delete: clears the selection or the whole layer), `editLayerPixels(id,
label, fn(surface))` (any custom pixel edit as one undo step; only changed
tiles are stored), `layerThumbnail(id, size)`, `thumbnail(size)`.

**Replacing the whole stack** — `replaceLayers(layers, { label,
activeLayerId?, mergeKey?, mergeWindowMs? }) → entry id | null`: the new
layer list (bottom → top, layer objects used as given — build them with
`createRasterLayer`) and active layer become ONE undo step; undo/redo swap
the lists, so both directions are byte-identical. Style presets, inserted
stickers and backdrops use it (`applyPresetResult`, `insertLayer` in
`$engine/presets`). The active layer defaults to the current one when it is
kept, else the top layer. A pending transform and an inline text edit are
settled first. Replacements with the same `mergeKey` within
`mergeWindowMs` (default 1000; `Infinity` = while it is the latest change)
merge into one entry that keeps the first one's "before" and id — the
Styles panel re-styles an applied look in place this way. Throws
`RangeError` for an empty stack, a raster layer of another size, a repeated
layer or an active layer that is not in the stack.

Refused operations (locked layer, last layer, nothing below to merge…)
return `false`/`null` and emit a `message`. Values are clamped into the
supported ranges (opacity 0..1, effect sizes/distances and font size up to
`MAX_PARAM_PX` = 4096, line height 0.5..10, weight 100..900, colours; non-finite
numbers are ignored — see `normalizeEffect`, `normalizeTextProps`,
`clampRgba`), the same ranges the `.reskin` loader accepts, so every document
the engine produces can be saved and loaded again.

Blend modes (`BLEND_MODES`): normal, multiply, screen, overlay, darken,
lighten, color-dodge, color-burn, hard-light, soft-light, difference,
exclusion. Effects: `createEffect('dropShadow' | 'outerGlow' | 'outline' |
'colorOverlay' | 'innerShadow', overrides)`; set the whole list with
`setLayerProps(id, { effects })`. A styled layer is rendered as one group
(shadows/glow/outer outline behind, content with colour overlay and inner
shadow, inner outline on top) and blended with the layer's mode and opacity.

### Text

`beginTextEdit(id)`, `updateText(id, patch)` (typing merges into one entry
per edit session), `endTextEdit()` (a new text left empty disappears without
history entries; an existing text emptied is deleted as one step). Undo while
a new text is still empty removes it (and nothing else). The engine emits
`textEdit: null` itself whenever the edited layer goes away (deleted, merged,
rasterized, undone). `textLayout(layer)` (measured lines; use with `textQuad`
to place an inline editor). Text layers keep `text, fontFamily, fontSize,
weight, italic, align, color, x, y, rotation, lineHeight`; `(x, y)` is the top
of the first line at the left/centre/right edge per `align`, rotation is
about that anchor. They render through the `TextRasterizer`
(`createCanvasTextRasterizer()`; call `ensureFontLoaded(props)` for web
fonts). Without one (Node) text layers stay unrendered.

### Selection

Every command is one undo step (`op` is `'replace' | 'add' | 'subtract' |
'intersect'`):

| Method | Does |
| --- | --- |
| `selectAll()`, `deselect()`, `invertSelection()` | — |
| `selectShape('rect' or 'ellipse', rect, op?, antialias?)` | Marquee shapes. |
| `selectPolygon(points, op?, antialias = true) → boolean` | Closed polygon, flat `[x0, y0, x1, y1, …]`, nonzero rule; false for fewer than 3 points. |
| `featherSelection(radius)` | Gaussian soft edge. |
| `growSelection(px) → boolean` | Expands by `px` (anti-aliased; convex corners round off). |
| `shrinkSelection(px) → boolean` | Contracts by `px`; canvas edges do not count as selection edges. |
| `borderSelection(px) → boolean` | A band `px` wide centred on the edge. |
| `selectByAlpha(layerId?, op?) → boolean` | "Select layer pixels": the layer's alpha (a text layer's rendering) as coverage. |
| `setSelection(mask or null, label)` | Any mask. |

Grow/shrink/border return false without a selection, and refuse (with a
`message`) when nothing would be left; in pixel-art documents they and
`selectByAlpha` produce whole pixels. `doc.selection` is a `SelectionMask`
(`Uint8Array` coverage per pixel) or `null` (= everything). Painting tools,
fill, gradient and shapes are clipped to it. Mask building blocks:
`polygonMask`, `rectMask`, `ellipseMask`, `combineMasks(current, shape, op)`,
`transformMask`, `featherMask`, `growMask` / `shrinkMask` /
`borderMask(mask, px, { binary })`, `alphaMask(surface)`, `wandMask(rgba, w,
h, x, y, { tolerance, contiguous, antialias })`, `antialiasRegion`;
`selectionOutline(mask)` gives marching-ants segments.

### Layer previews

A live, cancellable edit of one raster layer (adjustments and icon helpers
being tuned): every result shows on the canvas at once, but the history only
learns about it when it is committed.

```ts
const p = engine.beginPreview('Adjust: Blur', { layerId }); // null (+ message) for text / locked layers
p.update(pixels);                       // same-size straight RGBA: shown now, not recorded
p.update((surface) => blur(surface));   // or edit in place — the surface holds the ORIGINAL pixels
p.commit();                             // ONE entry with only the changed tiles (false: nothing changed)
p.cancel();                             // original restored byte for byte; history and redo steps untouched
```

`p.original` is the layer's pixels when it began (a private copy: send a
copy of it to a worker), `p.changed` tells whether anything differs,
`p.state` is `'open' | 'committed' | 'cancelled' | 'stale'` and every
change of it is a `preview` event. Updates redraw only the 64×64 tiles that
change. Beginning a preview commits pending tool work, an inline text edit
and any other open preview. The engine ends a preview itself — restoring the
original, state `'stale'` — as soon as anything else would change the
document or move the history: any edit through the history (including
locking or deleting its layer), a gesture of an editing tool (hand, zoom and
eyedropper keep it), redo, `jumpTo`, `clearHistory`, a new document,
`dispose()`. So tools never capture preview pixels as their "before".
**Undo** while it shows a change commits it and undoes it at once (redo
brings it back); an unchanged preview just ends and undo proceeds.

### History

`undo()` (cancels a pending transform first), `redo()`, `jumpTo(n)` where
`n` = number of applied entries (0 = oldest reachable state; entry `i` in
`historyEntries` is "applied" when `i < historyIndex`), `clearHistory()`.
Entries: `{ id, label, bytes, time }`; `currentEntryId` is the id of the
newest applied entry (what undo reverts; ids never repeat, a merged entry
keeps its id), e.g. to know whether a step is still the latest change. Pixel
edits store only changed 64×64 tiles; the stack drops its oldest entries past
256 MB (`history.droppedCount` tells you it did).

Continuous controls pass a merge key (`setLayerProps(…, { merge })`,
`replaceLayers(…, { mergeKey })`) so one drag is one entry; call
`sealHistory()` when a new drag begins so two drags within the merge window
stay two steps (keyboard steps keep merging). Read `history` for
information only — change it through the engine (`replaceLayers`, previews,
`sealHistory`), never with `history.push` / `discardRedo`.

### Document & files

`newDocument({ pixelArt?, name?, source?, background? })`,
`loadDocument(doc)`, `setPixelArt(grid | null)` (undoable resample;
upscales are integer nearest-neighbour, centred), `setDocumentName(name)`,
`composite()` (cached straight surface), `serialize() → Promise<string>`
(.reskin JSON), `loadProject(json)` (any version; rejects with
`ProjectError`), `exportPngs(sizes = DEFAULT_ICO_SIZES)`, `dispose()`.

---

## Export (`toSizedPngs`, what `apply_icon` receives)

```ts
const images = await engine.exportPngs(settings.icoSizes); // SizedPng[] base64, straight alpha
await commands.applyIcon({ item, images, designName, mode, flourish, updatePins });
const [png] = await toSizedPngs(engine.doc, [256]);           // or exportPng(doc, size)
```

- Normal documents: composite at 512, halve (2×2 box) down to the nearest
  larger power-of-two step, one exact area resample to the size, light
  unsharp mask at ≤ 32 px (`sharpenSmall: false` to disable).
- Pixel-art documents: integer nearest-neighbour scaling (box reduction when
  the size is below the grid), centred with transparent padding when the
  size is not a multiple (32 px art → 40 px icon = 32 px + 4 px margin).
- `planExport(sourceSize, sizes, { pixelArt })` describes the plan;
  `renderSizes(doc, sizes)` returns surfaces (e.g. for the Previews block —
  draw with `surfaceToImageData`).
- `encodePng(rgba, w, h)`, `surfaceToPngBase64`, `surfaceToPngDataUrl` are
  a standalone PNG encoder (zlib via `CompressionStream`).

## Projects, autosave, import

- `serializeProject(doc)` / `deserializeProject(json)`: versioned JSON
  (`format: 'reskin', version: 1`), pixels as base64 zlib RGBA. Older files
  are upgraded by `migrateProject` (v0 → v1 is the reference migration).
  Everything is validated; errors name the field (`layers[2].opacity: …`).
  Loaded files must be 512 px (or the pixel-art grid) with at most
  `MAX_PROJECT_LAYERS` (256) layers, and pixel blobs are inflated with a hard
  output limit (`inflate(bytes, maxBytes)`), so hostile files cannot exhaust
  memory.
- `new Autosave({ produce: () => engine.serialize(), save: (d) =>
  commands.autosave(d), delayMs, maxWaitMs })` — call `schedule()` on
  `history`/`layers` events, `flush()` before closing, `dispose()`.
- `fitAndCenter(surface, { size, padding, fit, allowUpscale, resample,
  trim })`, `importLayer(doc, surface, name)`, `surfaceFromImageData`,
  `bestFrameIndex(frames)`; in the browser `decodeImage(bytes | Blob |
  base64 | dataURL, fallbackSize = 512, maxSize = 4096)` → `Surface` (PNG,
  JPEG, GIF, WebP, BMP, ICO, SVG; larger images are scaled down to `maxSize`
  while decoding). E.g.
  `engine.importImage(await decodeImage(frames[bestFrameIndex(frames)].png), item.name)`.

## Colour

`parseColor(text)` (hex with/without `#`, 3/4/6/8 digits, `rgb()/rgba()`,
`hsl()/hsla()`, `hsv()`, named colours, `transparent`), `toHex(c, 'auto' |
'always' | 'never')`, `toCssRgb`, `toCssHsl`, `toHsvString`,
`rgbToHsv`/`hsvToRgb`/`rgbToHsl`/`hslToRgb`/`hsvToHsl`/`hslToHsv` (exact
floats; round-trips are lossless after rounding), `roundRgba`, `mixColors`,
`contrastRatio`, `wcagLevel`, `readableTextColor`, `PALETTES` (Fluent,
Material, Pastel, Neon, Earth, Grayscale), `dominantColors(data, w, h, {
count })` (median cut), gradients: `GradientSpec { kind, stops, spread }`,
`createGradient`, `sampleGradient`, `gradientLut`, `reverseGradient`.

## Canvas view (`$engine/dom`)

`new CanvasView(engine, { theme?, onInvalidate? })`,
`view.render(ctx, viewport, { dpr, showGrid, showKeylines, showOverlay,
showSelection, compare: { image, split } | null, antsOffset })`,
`view.invalidate()`, `view.dispose()`. It draws the checkerboard, the
document (layers composited with canvas blend modes — identical formulas to
the reference compositor), the pixel grid from 8× (always in pixel-art at
≥ 4 px), Windows keylines (`keylines(size)`), marching ants, the tool
overlay and before/after (`split: null` shows the "before" image alone —
hold `\` — a number 0..1 splits the view). Layers below and above the
active one are cached, so painting costs one dirty-rect upload plus three
`drawImage`s per frame.

`Viewport`: `fit()`, `setZoom(z, ax, ay)`, `zoomBy`, `zoomStep(±1, ax, ay)`,
`actualSize()` (100 %), `panBy`, `setViewSize`, `screenToDoc`,
`docToScreen`, `visibleDocRect`, `gridVisible()`, `subscribe`. Zoom is
clamped to 0.25×–32× and is relative to the 512 master (a 32 px pixel-art
document at 100 % is shown 512 px wide).

## Layout of the source

```
engine.ts        Engine façade          index.ts / dom.ts   public barrels
doc/             model, layer ops (commands), effects, thumbnails
raster/          Surface, FloatImage, tiles, resampling, blur, distance, flood fill, unsharp, tone (luminance)
render/          blend modes, effects, reference compositor, overlay API, keylines, canvas-view (DOM)
history/         History stack, commands, PixelTransaction, layer previews
tools/           Tool interface, registry + metadata, every tool (dab-tool: base of spray/smudge/blur/dodge)
input/           pointer types, 1€ filter, stroke sampler, coalesced events
geometry/        affine maths, AA polygon rasterizer, shape outlines
selection/       masks, outline, refine (grow/shrink/border/alpha/wand);   symmetry/  mirror transforms
color/           conversions, contrast, palettes, median cut, gradients
export/          PNG encoder, CRC-32, size plan, toSizedPngs
io/              .reskin projects, autosave, import helpers, decode-dom (DOM)
text/            text layout contract, measure-canvas (DOM)
viewport/        zoom/pan maths
```
