/**
 * Icon helpers: remove background, auto-trim & fit, clip to a shape, round
 * corners, add a badge — plus the resampling / cropping they are built on.
 * All pure; inputs are never mutated.
 */
export { detectBackground, removeBackground, type BackgroundDetection, type RemoveBackgroundOptions } from './background';
export { alphaBounds, autoTrim, computeFit, fitAndCenter, type Alignment, type FitOptions, type FitPlacement, type TrimOptions, type TrimResult } from './trim';
export { blitPixels, cropPixels, resizePixels, type Resampling } from './resample';
export { fitToShape, roundCorners, type CornerStyle, type RoundCornersOptions, type ShapeClip } from './shape';
export { addBadge, badgeLayout, type BadgeLayout, type BadgeOptions, type BadgePosition } from './badge';
export { BITMAP_FONT_CHARS, bitmapTextRasterizer, type TextRaster, type TextRasterizer, type TextStyle } from './text';
export { createCanvasTextRasterizer, DEFAULT_FONT_FAMILY } from './canvas-text';
export { distanceTransform } from './distance';
