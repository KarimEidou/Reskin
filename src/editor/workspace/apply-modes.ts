// Human wording for the Save & Apply modes, which mode an item prefers and
// why applying is blocked (unit tested).

import type { ApplyMode, ItemInfo } from '$lib/ipc/types';

/** Menu order of the apply modes. */
export const MODE_ORDER: readonly ApplyMode[] = ['inPlace', 'newShortcut', 'personalCopy'];

export const MODE_INFO: Record<ApplyMode, { label: string; description: string; unavailable: string }> = {
  inPlace: {
    label: 'Change in place',
    description: 'Give this shortcut the new icon.',
    unavailable: 'Not possible for this item.',
  },
  newShortcut: {
    label: 'New desktop shortcut',
    description: 'Create a desktop shortcut with the new icon.',
    unavailable: 'Only for programs and other files.',
  },
  personalCopy: {
    label: 'Personal copy',
    description: 'Copy the shortcut to your desktop and change the copy.',
    unavailable: 'Only for shortcuts shared by all users.',
  },
};

type ModeInfo = Pick<ItemInfo, 'modes' | 'storeApp'>;

/**
 * The mode Save & Apply uses for an item: the first of its modes, except
 * for Store (AppsFolder) app shortcuts, whose icon Explorer ignores — a
 * classic shortcut with the icon is what actually shows.
 */
export function preferredMode(item: ModeInfo): ApplyMode | null {
  if (item.storeApp && item.modes.includes('newShortcut')) return 'newShortcut';
  return item.modes[0] ?? null;
}

/** An item's modes, the preferred one first. */
export function orderedModes(item: ModeInfo): ApplyMode[] {
  const first = preferredMode(item);
  return first ? [first, ...item.modes.filter((m) => m !== first)] : [];
}

/**
 * Why Save & Apply cannot run right now, or null when it can. `busy` is
 * the session's long-running action.
 */
export function applyBlockedReason(
  item: Pick<ItemInfo, 'name' | 'modes' | 'kind'> | null,
  busy: { label: string } | null,
): string | null {
  if (busy) return `${busy.label}…`;
  if (!item) return 'Drop a shortcut here to apply';
  if (item.modes.length === 0) {
    return item.kind === 'image' || item.kind === 'project'
      ? `${item.name} is a design source — drop a shortcut here to apply`
      : `${item.name} can't take a custom icon`;
  }
  return null;
}
