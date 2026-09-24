// Plausible `ItemInfo`s for the e2e fake backend: a path's extension picks
// the kind, its folder picks the location/access, and the icon is drawn at
// runtime. Ids are stable per path, like Rust's ItemId map.

import type {
  Access,
  ApplyMode,
  IconSource,
  ItemInfo,
  ItemKind,
  ItemLocation,
  SystemIconId,
} from '$lib/ipc/types';
import { iconDataUrl } from './fake-images';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff']);

/** Paths containing this marker are left out of `inspect_paths` results. */
export const UNREADABLE_MARKER = '::unreadable';

export function kindOf(path: string): ItemKind {
  if (/[\\/]$/.test(path)) return 'folder';
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (!ext) return 'folder';
  if (ext === 'lnk') return 'shortcut';
  if (ext === 'url') return 'internetShortcut';
  if (ext === 'exe') return 'executable';
  if (ext === 'reskin') return 'project';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'file';
}

export function locationOf(path: string): ItemLocation {
  if (/[\\/]Users[\\/]Public[\\/]Desktop[\\/]/i.test(path)) return 'publicDesktop';
  if (/[\\/]Desktop[\\/]/i.test(path)) return 'userDesktop';
  if (/[\\/]Quick Launch[\\/]User Pinned[\\/]TaskBar[\\/]/i.test(path)) return 'taskbarPin';
  if (/[\\/]Start Menu[\\/]/i.test(path)) return 'startMenu';
  return 'other';
}

/** File name without folder and extension ("Steam" for "C:\…\Steam.lnk"). */
export function displayName(path: string): string {
  const base = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
  const kind = kindOf(path);
  if (kind === 'folder' || kind === 'file' || kind === 'image') return base;
  return base.replace(/\.[^.]+$/, '');
}

const SOURCE: Record<ItemKind, IconSource> = {
  shortcut: 'resource',
  internetShortcut: 'shell',
  folder: 'shell',
  systemIcon: 'resource',
  executable: 'resource',
  image: 'image',
  file: 'shell',
  project: 'none',
};

function modesFor(kind: ItemKind, location: ItemLocation, storeApp: boolean): ApplyMode[] {
  switch (kind) {
    case 'shortcut':
      if (storeApp) return ['newShortcut'];
      return location === 'publicDesktop' ? ['inPlace', 'personalCopy'] : ['inPlace'];
    case 'internetShortcut':
    case 'folder':
      return location === 'publicDesktop' ? ['inPlace', 'personalCopy'] : ['inPlace'];
    case 'systemIcon':
      return ['inPlace'];
    case 'executable':
    case 'file':
      return ['newShortcut'];
    case 'image':
    case 'project':
      return [];
  }
}

function targetFor(kind: ItemKind, name: string): string | null {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';
  if (kind === 'shortcut') return `C:\\Program Files\\${name}\\${name}.exe`;
  if (kind === 'internetShortcut') {
    return /steam/i.test(name) ? 'steam://rungameid/570' : `https://www.example.com/${slug}`;
  }
  return null;
}

export interface MakeItemOptions {
  id: string;
  /** Reskin's journal has an applied change for this target. */
  reskinned?: boolean;
}

/** Builds the ItemInfo Rust would return for `path`. */
export async function makeItem(path: string, opts: MakeItemOptions): Promise<ItemInfo> {
  const kind = kindOf(path);
  const location = locationOf(path);
  const name = displayName(path);
  const storeApp = kind === 'shortcut' && /AppsFolder|Store App/i.test(path);
  const access: Access = location === 'publicDesktop' ? 'needsElevation' : 'writable';
  const notes: string[] = [];
  if (access === 'needsElevation') notes.push('Public desktop — changing it needs admin rights');
  if (storeApp) notes.push('Store app: Windows ignores custom icons on its shortcut; Reskin makes a classic one');
  return {
    id: opts.id,
    kind,
    name,
    path,
    target: targetFor(kind, name),
    location,
    access,
    modes: modesFor(kind, location, storeApp),
    icon: kind === 'project' ? null : await iconDataUrl({ kind, name }),
    iconSource: SOURCE[kind],
    customIcon: opts.reskinned ?? false,
    reskinned: opts.reskinned ?? false,
    storeApp,
    systemIcon: null,
    notes,
  };
}

export const SYSTEM_ICONS: Record<SystemIconId, { label: string; clsid: string }> = {
  thisPc: { label: 'This PC', clsid: '{20D04FE0-3AEA-1069-A2D8-08002B30309D}' },
  recycleBinEmpty: { label: 'Recycle Bin (empty)', clsid: '{645FF040-5081-101B-9F08-00AA002F954E}' },
  recycleBinFull: { label: 'Recycle Bin (full)', clsid: '{645FF040-5081-101B-9F08-00AA002F954E}' },
  userFiles: { label: 'User files', clsid: '{59031a47-3f72-44a7-89c5-5595fe6b30ee}' },
  network: { label: 'Network', clsid: '{F02C1A0D-BE21-4350-88B0-7367FC96EF3C}' },
  controlPanel: { label: 'Control Panel', clsid: '{5399E694-6CE5-4D6C-8FCE-1D8870FDCBA0}' },
};

export async function makeSystemItem(id: SystemIconId, itemId: string, reskinned: boolean): Promise<ItemInfo> {
  const sys = SYSTEM_ICONS[id];
  return {
    id: itemId,
    kind: 'systemIcon',
    name: sys.label,
    path: `::${sys.clsid}`,
    target: null,
    location: 'system',
    access: 'writable',
    modes: ['inPlace'],
    icon: await iconDataUrl({ kind: 'systemIcon', name: sys.label }),
    iconSource: 'resource',
    customIcon: reskinned,
    reskinned,
    storeApp: false,
    systemIcon: id,
    notes: [],
  };
}
