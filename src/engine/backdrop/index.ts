/**
 * Backdrop generator: resolution-independent icon backdrops (circle,
 * rounded, squircle, hexagon, shield, seeded blob) with solid / linear /
 * radial fills, gloss, border and drop shadow.
 *
 * ```ts
 * const px = renderBackdrop({ shape: 'hexagon', fill: { type: 'solid', color: '#222' } }, 512);
 * const px2 = renderBackdrop(backdropStyle('ocean'), 256);
 * ```
 */
export { renderBackdrop, backdropCoverage, backdropShapeMask, shapeBox } from './render';
export {
  BACKDROP_STYLES,
  DEFAULT_BACKDROP,
  DEFAULT_BLOB,
  DEFAULT_BORDER,
  DEFAULT_GLOSS,
  DEFAULT_SHADOW,
  DEFAULT_STOPS,
  backdropStyle,
  resolveBackdropSpec,
  type BackdropBorder,
  type BackdropFill,
  type BackdropFillType,
  type BackdropGloss,
  type BackdropShadow,
  type BackdropSpec,
  type BackdropSpecInput,
  type BackdropStyle,
  type BorderPosition,
} from './spec';
export {
  BACKDROP_SHAPES,
  SHIELD_ASPECT,
  blobControlPoints,
  blobPolygon,
  circleSdf,
  geometryCoverage,
  geometryInside,
  geometrySdf,
  hexagonPolygon,
  roundPolygon,
  roundedRectSdf,
  shapeGeometry,
  shieldPolygon,
  superellipseSdf,
  type BackdropShape,
  type BlobOptions,
  type Sdf,
  type ShapeBox,
  type ShapeGeometry,
  type ShapeOptions,
} from './shapes';
export { contourArea, insideMask, polygonSdf, rasterizePolygon, type Contour } from './raster';
