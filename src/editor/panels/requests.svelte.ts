// Asks from outside the sidebar (the command palette) for a panel to act
// once it shows: open an adjustment's settings, apply a style preset. The
// panel takes the ask when it is mounted — it may still be loading when the
// palette switches the tab — and clears it:
//
//   panelRequests.adjust = { kind: 'filter', id: 'sepia' };   // AdjustPanel opens Sepia
//   panelRequests.style = 'clay';                             // StylesPanel applies Clay

import type { FilterId } from '$engine/filters';
import type { PresetId } from '$engine/presets';
import type { HelperId } from './adjust/helper-defs';

/** An adjustment of the Adjust panel: a filter or an icon helper. */
export type AdjustTarget = { kind: 'filter'; id: FilterId } | { kind: 'helper'; id: HelperId };

class PanelRequests {
  /** The adjustment the Adjust panel should open. */
  adjust = $state.raw<AdjustTarget | null>(null);
  /** The preset the Styles panel should apply. */
  style = $state<PresetId | null>(null);
}

/** The editor page's panel requests (one per page). */
export const panelRequests = new PanelRequests();
