import { describe, expect, it } from 'vitest';
import { desktopLabel, pickSize, vignetteOrigin, wallpaperLayout } from './desktop';

describe('wallpaper layout', () => {
  it('fills, fits, stretches, centres and tiles like Windows', () => {
    expect(wallpaperLayout('fill', 1000, 500, 1920, 1080)).toEqual({ kind: 'image', x: -120, y: 0, w: 2160, h: 1080 });
    expect(wallpaperLayout('fit', 1000, 500, 1920, 1080)).toEqual({ kind: 'image', x: 0, y: 60, w: 1920, h: 960 });
    expect(wallpaperLayout('stretch', 10, 10, 1920, 1080)).toEqual({ kind: 'image', x: 0, y: 0, w: 1920, h: 1080 });
    expect(wallpaperLayout('center', 800, 600, 1920, 1080)).toEqual({ kind: 'image', x: 560, y: 240, w: 800, h: 600 });
    expect(wallpaperLayout('tile', 64, 32, 1920, 1080)).toEqual({ kind: 'tile', w: 64, h: 32 });
    expect(wallpaperLayout('span', 1920, 1080, 1920, 1080)).toEqual({ kind: 'image', x: 0, y: 0, w: 1920, h: 1080 });
  });

  it('keeps the vignette on screen', () => {
    expect(vignetteOrigin(1920, 1080, 400, 200)).toEqual({ x: 376, y: 267 });
    expect(vignetteOrigin(1920, 1080, 400, 200, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(vignetteOrigin(300, 100, 400, 200)).toEqual({ x: 0, y: 0 });
  });
});

describe('icon sizes', () => {
  it('picks the exact, next larger or largest size', () => {
    const sizes = [16, 24, 32, 48, 256];
    expect(pickSize(sizes, 48)).toBe(48);
    expect(pickSize(sizes, 36)).toBe(48);
    expect(pickSize(sizes, 512)).toBe(256);
    expect(pickSize([], 16)).toBeNull();
  });
});

describe('desktop labels', () => {
  const measure = (s: string) => s.length * 7;

  it('wraps to two lines and ellipsises the rest', () => {
    expect(desktopLabel('Steam', 70, measure)).toEqual(['Steam']);
    expect(desktopLabel('Visual Studio Code', 91, measure)).toEqual(['Visual Studio', 'Code']);
    expect(desktopLabel('Visual Studio Code', 70, measure)).toEqual(['Visual', 'Studio Co…']);
    expect(desktopLabel('A very long shortcut name here', 70, measure)).toEqual(['A very', 'long shor…']);
    expect(desktopLabel('Supercalifragilistic', 70, measure)).toEqual(['Supercali…']);
    expect(desktopLabel('   ', 70, measure)).toEqual([]);
  });
});
