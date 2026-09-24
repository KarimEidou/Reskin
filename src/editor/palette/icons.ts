// Icons for palette rows (kept out of commands.ts so the registry stays
// importable in node unit tests).

import AppWindow from '@lucide/svelte/icons/app-window';
import Blend from '@lucide/svelte/icons/blend';
import Brush from '@lucide/svelte/icons/brush';
import CircleDashed from '@lucide/svelte/icons/circle-dashed';
import ClipboardCopy from '@lucide/svelte/icons/clipboard-copy';
import Columns2 from '@lucide/svelte/icons/columns-2';
import Command from '@lucide/svelte/icons/command';
import Eraser from '@lucide/svelte/icons/eraser';
import FileDown from '@lucide/svelte/icons/file-down';
import FilePlus from '@lucide/svelte/icons/file-plus';
import Grid3x3 from '@lucide/svelte/icons/grid-3x3';
import Hand from '@lucide/svelte/icons/hand';
import ImagePlus from '@lucide/svelte/icons/image-plus';
import Keyboard from '@lucide/svelte/icons/keyboard';
import Layers from '@lucide/svelte/icons/layers';
import Maximize from '@lucide/svelte/icons/maximize';
import Move from '@lucide/svelte/icons/move';
import PaintBucket from '@lucide/svelte/icons/paint-bucket';
import PanelsTopLeft from '@lucide/svelte/icons/panels-top-left';
import Pencil from '@lucide/svelte/icons/pencil';
import Pipette from '@lucide/svelte/icons/pipette';
import Redo2 from '@lucide/svelte/icons/redo-2';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
import Save from '@lucide/svelte/icons/save';
import Settings from '@lucide/svelte/icons/settings';
import Shapes from '@lucide/svelte/icons/shapes';
import SquareDashed from '@lucide/svelte/icons/square-dashed';
import Type from '@lucide/svelte/icons/type';
import Undo2 from '@lucide/svelte/icons/undo-2';
import Wand from '@lucide/svelte/icons/wand-sparkles';
import X from '@lucide/svelte/icons/x';
import ZoomIn from '@lucide/svelte/icons/zoom-in';
import ZoomOut from '@lucide/svelte/icons/zoom-out';
import ExternalLink from '@lucide/svelte/icons/external-link';
import SunMoon from '@lucide/svelte/icons/sun-moon';
import type { IconComponent } from '$lib/ui/types';
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
  'tool.move': Move,
  'tool.selectRect': SquareDashed,
  'tool.selectEllipse': CircleDashed,
  'tool.brush': Brush,
  'tool.pencil': Pencil,
  'tool.eraser': Eraser,
  'tool.fill': PaintBucket,
  'tool.gradient': Blend,
  'tool.shape': Shapes,
  'tool.text': Type,
  'tool.eyedropper': Pipette,
  'tool.hand': Hand,
  'tool.zoom': ZoomIn,
  'edit.undo': Undo2,
  'edit.redo': Redo2,
  'view.fit': Maximize,
  'view.actual': ZoomIn,
  'view.zoomIn': ZoomIn,
  'view.zoomOut': ZoomOut,
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
  Tools: Brush,
  Edit: Layers,
  Canvas: Maximize,
  Panels: PanelsTopLeft,
  'Go to': AppWindow,
  Settings: Settings,
  App: Command,
};

export function commandIcon(cmd: Cmd): IconComponent {
  if (cmd.group === 'Settings' && cmd.id.startsWith('settings.theme')) return SunMoon;
  return BY_ID[cmd.id] ?? BY_GROUP[cmd.group];
}
