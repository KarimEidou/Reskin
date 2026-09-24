// Human wording for the Save & Apply modes and why applying is blocked
// (unit tested).

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

/**
 * Why Save & Apply cannot run right now, or null when it can. `busy` is
 * the session's long-running action.
 */
export function applyBlockedReason(
  item: Pick<ItemInfo, 'name' | 'modes' | 'kind'> | null,
  busy: { label: string } | null,
): string | null {
  if (busy) return `${busy.label}…`;
  if (!item) return 'Drop a shortcut on the box to apply';
  if (item.modes.length === 0) {
    return item.kind === 'image' || item.kind === 'project'
      ? `${item.name} is a design source — drop a shortcut on the box to apply`
      : `${item.name} can't take a custom icon`;
  }
  return null;
}
