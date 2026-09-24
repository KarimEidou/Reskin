// Icons for palette rows (kept out of commands.ts so the registry stays
// importable in node unit tests).

import AppWindow from '@lucide/svelte/icons/app-window';
import ArrowLeftRight from '@lucide/svelte/icons/arrow-left-right';
import ClipboardCopy from '@lucide/svelte/icons/clipboard-copy';
import Columns2 from '@lucide/svelte/icons/columns-2';
import Command from '@lucide/svelte/icons/command';
import Expand from '@lucide/svelte/icons/expand';
import FileDown from '@lucide/svelte/icons/file-down';
import FilePlus from '@lucide/svelte/icons/file-plus';
import Frame from '@lucide/svelte/icons/frame';
import Grid2x2 from '@lucide/svelte/icons/grid-2x2';
import Grid3x3 from '@lucide/svelte/icons/grid-3x3';
import ImagePlus from '@lucide/svelte/icons/image-plus';
import Keyboard from '@lucide/svelte/icons/keyboard';
import Layers from '@lucide/svelte/icons/layers';
import Maximize from '@lucide/svelte/icons/maximize';
import Paintbrush from '@lucide/svelte/icons/paintbrush';
import PanelsTopLeft from '@lucide/svelte/icons/panels-top-left';
import Redo2 from '@lucide/svelte/icons/redo-2';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
import Save from '@lucide/svelte/icons/save';
import Scan from '@lucide/svelte/icons/scan';
import Settings from '@lucide/svelte/icons/settings';
import Shrink from '@lucide/svelte/icons/shrink';
import SquareDashed from '@lucide/svelte/icons/square-dashed';
import SquareDashedMousePointer from '@lucide/svelte/icons/square-dashed-mouse-pointer';
import Undo2 from '@lucide/svelte/icons/undo-2';
import Wand from '@lucide/svelte/icons/wand-sparkles';
import X from '@lucide/svelte/icons/x';
import ZoomIn from '@lucide/svelte/icons/zoom-in';
import ZoomOut from '@lucide/svelte/icons/zoom-out';
import ExternalLink from '@lucide/svelte/icons/external-link';
import SunMoon from '@lucide/svelte/icons/sun-moon';
import { isToolId } from '$engine/index';
import type { IconComponent } from '$lib/ui/types';
import { toolIconOf } from '../workspace/tool-icons';
import type { Command as Cmd, CommandGroup } from './commands';

const BY_ID: Record<string, IconComponent> = {
  apply: Wand,
  'apply.newShortcut': Wand,
  'apply.personalCopy': Wand,
  'apply.styleToAll': Wand,
  'library.save': Save,
  'export.ico': FileDown,
  'export.png': FileDown,
  'export.project': FileDown,
  'export.clipboard': ClipboardCopy,
  'edit.undo': Undo2,
  'edit.redo': Redo2,
  'edit.selectAll': SquareDashed,
  'edit.deselect': SquareDashed,
  'edit.invertSelection': SquareDashed,
  'edit.selectLayerPixels': SquareDashedMousePointer,
  'edit.featherSelection': SquareDashed,
  'edit.growSelection': Expand,
  'edit.shrinkSelection': Shrink,
  'edit.borderSelection': Frame,
  'color.swap': ArrowLeftRight,
  'color.reset': RotateCcw,
  'view.fit': Maximize,
  'view.actual': ZoomIn,
  'view.zoomIn': ZoomIn,
  'view.zoomOut': ZoomOut,
  'view.keylines': Scan,
  'view.grid': Grid2x2,
  'view.compare': Columns2,
  'view.pixelArt': Grid3x3,
  'app.palette': Command,
  'app.shortcuts': Keyboard,
  'app.openImage': ImagePlus,
  'app.newBlank': FilePlus,
  'app.restoreAll': RotateCcw,
  'app.refreshIcons': RefreshCw,
  'app.releases': ExternalLink,
  'app.close': X,
};

const BY_GROUP: Record<CommandGroup, IconComponent> = {
  'Apply & export': Wand,
  Tools: Paintbrush,
  Edit: Layers,
  Canvas: Maximize,
  Panels: PanelsTopLeft,
  'Go to': AppWindow,
  Settings: Settings,
  App: Command,
};

export function commandIcon(cmd: Cmd): IconComponent {
  if (cmd.group === 'Settings' && cmd.id.startsWith('settings.theme')) return SunMoon;
  const tool = cmd.id.startsWith('tool.') ? cmd.id.slice(5) : null;
  if (tool && isToolId(tool)) return toolIconOf(tool).icon;
  return BY_ID[cmd.id] ?? BY_GROUP[cmd.group];
}
