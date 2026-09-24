/**
 * Stickers & emoji stamps for the editor's Stickers panel.
 *
 * ```ts
 * const px = renderSticker(getSticker('star')!, { size: 512, box: 220, outline: { color: '#fff', width: 10 } });
 * const emoji = renderEmoji('🚀', { size: 512, box: 220 }); // null in node
 * ```
 *
 * Vector stickers are path data in a 100 × 100 box, rasterized with the
 * engine's anti-aliased polygon rasterizer and stroker; they can be
 * recoloured (layers reference the main colour or its shade / tint) and get
 * an optional outline.
 */
export { STICKERS, getSticker, searchStickers, type StickerColorRef, type StickerDef, type StickerLayer, type StickerPart, type StickerPathPart, type StickerStrokePart } from './library';
export { STICKER_BOX, renderSticker, stickerSvgElements, stickerVariants, type StickerOutline, type StickerRenderOptions, type StickerSvgElement } from './render';
export { flattenPath, parsePath, polygonsToPath, PathSyntaxError, type FlattenOptions } from './path';
export { EMOJI, EMOJI_FONT, EMOJI_GROUPS, canRenderEmoji, renderEmoji, searchEmoji, type EmojiDef, type EmojiGroup, type EmojiRenderOptions } from './emoji';
