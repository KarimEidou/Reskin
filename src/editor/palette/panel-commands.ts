// Palette commands for every adjustment, icon helper and style preset
// (docs/UI.md: the palette searches filters and presets too). They come from
// the engine's registries and the panels' definitions, which the editor loads
// only when they are used, so App loads this module together with the
// palette rather than with the page. Running one shows its panel and asks it
// to act (panels/requests.svelte.ts).

import { FILTER_CATEGORIES, FILTER_LIST } from '$engine/filters';
import { PRESETS } from '$engine/presets';
import { HELPERS } from '../panels/adjust/helper-defs';
import { panelRequests, type AdjustTarget } from '../panels/requests.svelte';
import { editableLayer, editing, toEdit, type Command, type CommandContext } from './commands';

function adjust(c: CommandContext, target: AdjustTarget): void {
  toEdit(c);
  c.session.sidebarTab = 'adjust';
  panelRequests.adjust = target;
}

export function panelCommands(): Command[] {
  const category = new Map(FILTER_CATEGORIES.map((c) => [c.id, c.label]));
  return [
    ...FILTER_LIST.map(
      (f): Command => ({
        id: `filter.${f.id}`,
        label: `${f.label}…`,
        group: 'Adjust',
        keywords: ['filter', 'adjustment', category.get(f.category) ?? f.category],
        when: editableLayer,
        run: (c) => adjust(c, { kind: 'filter', id: f.id }),
      }),
    ),
    ...HELPERS.map(
      (h): Command => ({
        id: `helper.${h.id}`,
        label: `${h.label}…`,
        group: 'Adjust',
        keywords: ['icon helper', 'adjustment'],
        when: editableLayer,
        run: (c) => adjust(c, { kind: 'helper', id: h.id }),
      }),
    ),
    ...PRESETS.map(
      (p): Command => ({
        id: `preset.${p.id}`,
        label: `${p.label} style`,
        group: 'Styles',
        keywords: ['preset', 'look', 'theme'],
        when: editing,
        run: (c) => {
          toEdit(c);
          c.session.sidebarTab = 'styles';
          panelRequests.style = p.id;
        },
      }),
    ),
  ];
}
