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
commits a transform, Escape cancels, arrows nudge) and modifier changes
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
| `message` | `level, text` | Show a toast, e.g. "Layer 2 is locked". |

Events fire synchronously; batch UI work per animation frame.

### State

`doc`, `activeLayer`, `getLayer(id)`, `toolId` (effective, incl. override),
`selectedToolId`, `primary`, `secondary`, `symmetry`, `cursor`
(`{ css, radius }`), `isInteracting`, `hasPending`, `canUndo`, `canRedo`,
`historyEntries`, `historyIndex`, `textEditLayerId`, `viewport`,
`textMeasurer`, `history` (read it; mutate through the engine), `tools`.

### Input

`pointerDown(p)`, `pointerMove(p | p[])`, `pointerUp(p)`, `pointerCancel()`,
`pointerHover(p | null)`, `updateModifiers(mods)`, `keyDown(key, mods) →
handled`, `drawOverlay(painter)`. Build inputs with `toPointerInputs(event,
toDoc, button)` (coalesced samples) or `pointerInput({ x, y, ... })`. Mouse
pressure is normalised to 1.

### Tools

`setTool(id)` commits pending work; `setToolOverride('hand' | 'zoom' |
'eyedropper' | null)`; `getToolOptions(id)`, `setToolOptions(id, patch)`.

| id | Shortcut | Options (defaults) |
| --- | --- | --- |
| `move` | V | `handleTolerance` 7 (screen px). First drag moves; then handles scale (Shift keeps ratio, Alt from centre), outside corners rotate (Shift 15°). Enter/tool switch commits; Esc/undo cancels. Moves the selected pixels and the selection when there is one. |
| `selectRect` / `selectEllipse` | M / Shift+M | `mode` replace/add/subtract/intersect, `antialias`, `feather`. Shift/Alt at press = add/subtract (both = intersect); during drag Shift = square, Alt = from centre; click = deselect. |
| `brush` | B | `size` 24, `hardness` 0.8, `spacing` 0.15 (× diameter), `flow` 1, `opacity` 1, `pressureSize` true, `pressureOpacity` false, `minSize` 0.2, `smoothing` 0.3 (1€), `catchUp` true. Right button paints the secondary colour. |
| `pencil` | P | `size` 1, `pixelPerfect` true (removes L-corners), `opacity` 1. |
| `eraser` | E | Same as brush (hardness 0.9). |
| `fill` | G | `tolerance` 32 (0..255, max channel Δ on premultiplied RGBA), `contiguous` true, `sampleMerged` false, `opacity` 1. |
| `gradient` | Shift+G | `kind` linear/radial/conic, `spread` pad/repeat/reflect, `source` 'colors' (primary→secondary) or 'custom' (`stops`), `reverse`, `opacity`, `dither` true. Shift snaps 15°. |
| `shape` | U | `kind` rect/roundedRect/ellipse/line/arrow/polygon/star/heart/squircle, `fill`, `stroke`, `strokeWidth` 8, `cornerRadius` 64, `sides` 6, `innerRatio` 0.5, `opacity`. Fill = primary; stroke = secondary when both are on. Shift constrains, Alt from centre. |
| `text` | T | `fontFamily` 'Segoe UI', `fontSize` 64, `weight` 600, `italic`, `align` 'center'. Click empty space → new text layer + `textEdit`; click text → edit; drag text → move. |
| `eyedropper` | I | `sample` composite/layer, `size` 1/3/5. Right button/Alt → secondary. |
| `hand` | H | — (needs `screenX/screenY` on input and a viewport) |
| `zoom` | Z | `zoomOut` false. Click steps, horizontal drag scrubs. |

`TOOL_ORDER` is the rail order; each tool object has `label` and `shortcut`.

**Symmetry** (`setSymmetry({ mode: 'off'|'x'|'y'|'xy'|'radial', rays, mirror, cx, cy })`)
applies to brush, pencil and eraser; guides are drawn by `drawOverlay`.

### Layers (every change is one undo step)

`addLayer({ name?, index? }) → id`, `addTextLayer(props?) → id`,
`importImage(surface, name, fit?) → id` (fits and centres any image),
`deleteLayer(id?)`, `duplicateLayer(id?) → id`, `renameLayer(id, name)`,
`moveLayer(id, toIndex)` (bottom = 0), `mergeDown(id?)`, `flatten()`,
`rasterizeLayer(id?)`, `setLayerProps(id, { name, visible, locked, opacity,
blend, effects }, { merge?: key })` — pass `merge` for sliders so a drag is
one entry — `setActiveLayer(id)` (not an undo step), `clearPixels(id?)`
(Delete: clears the selection or the whole layer), `editLayerPixels(id,
label, fn(surface))` (any custom pixel edit as one undo step; only changed
tiles are stored), `layerThumbnail(id, size)`, `thumbnail(size)`.

Refused operations (locked layer, last layer, nothing below to merge…)
return `false`/`null` and emit a `message`.

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
history entries), `textLayout(layer)` (measured lines; use with `textQuad`
to place an inline editor). Text layers keep `text, fontFamily, fontSize,
weight, italic, align, color, x, y, rotation, lineHeight`; `(x, y)` is the top
of the first line at the left/centre/right edge per `align`, rotation is
about that anchor. They render through the `TextRasterizer`
(`createCanvasTextRasterizer()`; call `ensureFontLoaded(props)` for web
fonts). Without one (Node) text layers stay unrendered.

### Selection

`selectAll()`, `deselect()`, `invertSelection()`, `selectShape('rect' |
'ellipse', rect, op?)`, `featherSelection(radius)`, `setSelection(mask |
null, label)`. `doc.selection` is a `SelectionMask` (`Uint8Array`
coverage per pixel) or `null` (= everything). Painting tools, fill,
gradient and shapes are clipped to it. Build masks for future tools with
`polygonMask`, `combineMasks(current, shape, op)`, `transformMask`, …;
`selectionOutline(mask)` gives marching-ants segments.

### History

`undo()` (cancels a pending transform first), `redo()`, `jumpTo(n)` where
`n` = number of applied entries (0 = oldest reachable state; entry `i` in
`historyEntries` is "applied" when `i < historyIndex`), `clearHistory()`.
Entries: `{ id, label, bytes, time }`. Pixel edits store only changed 64×64
tiles; the stack drops its oldest entries past 256 MB
(`history.droppedCount` tells you it did).

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
- `new Autosave({ produce: () => engine.serialize(), save: (d) =>
  commands.autosave(d), delayMs, maxWaitMs })` — call `schedule()` on
  `history`/`layers` events, `flush()` before closing, `dispose()`.
- `fitAndCenter(surface, { size, padding, fit, allowUpscale, resample,
  trim })`, `importLayer(doc, surface, name)`, `surfaceFromImageData`,
  `bestFrameIndex(frames)`; in the browser `decodeImage(bytes | Blob |
  base64 | dataURL)` → `Surface` (PNG, JPEG, GIF, WebP, BMP, ICO, SVG). E.g.
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
raster/          Surface, FloatImage, tiles, resampling, blur, distance, flood fill, unsharp
render/          blend modes, effects, reference compositor, overlay API, keylines, canvas-view (DOM)
history/         History stack, commands, PixelTransaction
tools/           Tool interface + every tool
input/           pointer types, 1€ filter, stroke sampler, coalesced events
geometry/        affine maths, AA polygon rasterizer, shape outlines
selection/       masks, outline;   symmetry/  mirror transforms
color/           conversions, contrast, palettes, median cut, gradients
export/          PNG encoder, CRC-32, size plan, toSizedPngs
io/              .reskin projects, autosave, import helpers, decode-dom (DOM)
text/            text layout contract, measure-canvas (DOM)
viewport/        zoom/pan maths
```
