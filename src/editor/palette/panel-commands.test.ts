import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILTER_LIST } from '$engine/filters';
import { Engine } from '$engine/index';
import { PRESETS } from '$engine/presets';
import { defaultSettings } from '$lib/settings/defaults';
import { HELPERS } from '../panels/adjust/helper-defs';
import { panelRequests } from '../panels/requests.svelte';
import type { EditorSession } from '../state/session.svelte';
import { availableCommands, type CommandContext } from './commands';
import { fuzzyFilter } from './fuzzy';
import { panelCommands } from './panel-commands';

interface FakeSession {
  engine: Engine;
  view: string;
  hasDesign: boolean;
  sidebarTab: string;
  navigate: ReturnType<typeof vi.fn>;
}

let session: FakeSession;
let ctx: CommandContext;
const commands = panelCommands();
const byId = (id: string) => commands.find((c) => c.id === id)!;

beforeEach(() => {
  const s: FakeSession = {
    engine: new Engine(),
    view: 'library',
    hasDesign: true,
    sidebarTab: 'layers',
    navigate: vi.fn((v: string) => {
      s.view = v;
    }),
  };
  session = s;
  ctx = { session: session as unknown as EditorSession, settings: defaultSettings } as unknown as CommandContext;
});

afterEach(() => {
  panelRequests.adjust = null;
  panelRequests.style = null;
});

describe('panel commands', () => {
  it('cover every filter, icon helper and style preset', () => {
    expect(commands.filter((c) => c.group === 'Adjust').map((c) => c.id)).toEqual([
      ...FILTER_LIST.map((f) => `filter.${f.id}`),
      ...HELPERS.map((h) => `helper.${h.id}`),
    ]);
    expect(commands.filter((c) => c.group === 'Styles').map((c) => c.id)).toEqual(PRESETS.map((p) => `preset.${p.id}`));
    // No shortcuts of their own: the key dispatcher never sees them.
    expect(commands.every((c) => c.keys === undefined && c.altKeys === undefined)).toBe(true);
  });

  it('are found by the palette search', () => {
    const top = (q: string) => fuzzyFilter(availableCommands(commands, ctx), q, (c) => c.label, (c) => [...(c.keywords ?? []), c.group])[0]?.item.id;
    expect(top('sepia')).toBe('filter.sepia');
    expect(top('emboss')).toBe('filter.emboss');
    expect(top('glass')).toBe('preset.glass');
    expect(top('clay')).toBe('preset.clay');
    expect(top('remove background')).toBe('helper.removeBackground');
  });

  it('open the adjustment in the Adjust panel of the Edit view', () => {
    byId('filter.sepia').run(ctx);
    expect(session.view).toBe('edit');
    expect(session.sidebarTab).toBe('adjust');
    expect(panelRequests.adjust).toEqual({ kind: 'filter', id: 'sepia' });
    byId('helper.roundCorners').run(ctx);
    expect(panelRequests.adjust).toEqual({ kind: 'helper', id: 'roundCorners' });
  });

  it('apply the preset in the Styles panel', () => {
    byId('preset.clay').run(ctx);
    expect(session.view).toBe('edit');
    expect(session.sidebarTab).toBe('styles');
    expect(panelRequests.style).toBe('clay');
  });

  it('offer adjustments only for an image layer that can change', () => {
    const e = session.engine;
    const layer = e.activeLayer!;
    expect(byId('filter.blur').when!(ctx)).toBe(true);
    e.setLayerProps(layer.id, { locked: true });
    expect(byId('filter.blur').when!(ctx)).toBe(false);
    expect(byId('helper.autoTrim').when!(ctx)).toBe(false);
    // Styles rebuild the whole design: always there with a design.
    expect(byId('preset.neon').when!(ctx)).toBe(true);
    session.hasDesign = false;
    expect(availableCommands(commands, ctx)).toEqual([]);
  });
});
