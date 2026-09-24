// Typed wrappers for every Tauri command. This file is the single source of
// truth for command names and argument shapes on the web side; the Rust
// handlers live in src-tauri/src/commands/*.rs and the e2e fake backend in
// src/testing/tauri-mock.ts. Tauri maps camelCase arg keys to snake_case
// Rust parameters.

import { invoke } from '@tauri-apps/api/core';
import type {
  AckStage,
  ApplyOutcome,
  ApplyRequest,
  BootInfo,
  CloseReason,
  DragResult,
  EditorView,
  Envelope,
  ExportRequest,
  HistoryEntry,
  IconFrame,
  ItemId,
  ItemInfo,
  LibraryEntry,
  LibrarySave,
  PickPurpose,
  RefreshLevel,
  RestoreReport,
  RestoreTarget,
  Settings,
  SmokeReport,
  SystemIconId,
  WallpaperInfo,
} from './types';

export type ExternalLink = 'releases' | 'repo' | 'license';

export const commands = {
  // --- boot -------------------------------------------------------------
  appBoot: () => invoke<BootInfo>('app_boot'),

  // --- box --------------------------------------------------------------
  /** Starts the native move loop; resolves when the button is released. */
  boxDrag: () => invoke<DragResult>('box_drag'),
  /** Pops the native context menu at box-window CSS coords. */
  boxMenu: (x: number, y: number) => invoke<void>('box_menu', { x, y }),
  /** Opens the editor out of the box with the given items / view. */
  openEditor: (items: ItemId[], view: EditorView) =>
    invoke<void>('open_editor', { items, view }),
  /** The picture of box session `session` (`box:handoff` / `box:collapse`) is on screen. */
  boxPainted: (session: number) => invoke<void>('box_painted', { session }),

  // --- morph mailbox (editor) --------------------------------------------
  /** Long-polls for commands with seq > after (25 s heartbeat). */
  editorNext: (after: number) => invoke<Envelope[]>('editor_next', { after }),
  editorAck: (session: number, stage: AckStage) =>
    invoke<void>('editor_ack', { session, stage }),
  /** Asks Rust to run the collapse handoff. */
  editorClose: (reason: CloseReason) => invoke<void>('editor_close', { reason }),

  // --- items ------------------------------------------------------------
  inspectPaths: (paths: string[]) => invoke<ItemInfo[]>('inspect_paths', { paths }),
  inspectSystemIcon: (id: SystemIconId) =>
    invoke<ItemInfo>('inspect_system_icon', { id }),
  /** All frames of the item's current icon (or the image itself). */
  itemFrames: (item: ItemId) => invoke<IconFrame[]>('item_frames', { item }),
  /** Native open dialog; picked files are inspected like dropped ones. */
  pickFiles: (purpose: PickPurpose) => invoke<ItemInfo[]>('pick_files', { purpose }),
  /** Reads a picked/dropped .reskin project. */
  readProject: (item: ItemId) => invoke<string>('read_project', { item }),

  // --- apply / restore --------------------------------------------------
  applyIcon: (req: ApplyRequest) => invoke<ApplyOutcome>('apply_icon', { req }),
  applyIconElevated: (ticket: string) =>
    invoke<ApplyOutcome>('apply_icon_elevated', { ticket }),
  restore: (target: RestoreTarget) => invoke<RestoreReport>('restore', { target }),
  historyList: () => invoke<HistoryEntry[]>('history_list'),
  refreshIcons: (level: RefreshLevel) => invoke<void>('refresh_icons', { level }),
  /** Native save dialog + write. Resolves to the saved path or null. */
  exportFile: (req: ExportRequest) => invoke<string | null>('export_file', { req }),

  // --- library ----------------------------------------------------------
  libraryList: () => invoke<LibraryEntry[]>('library_list'),
  librarySave: (entry: LibrarySave) => invoke<LibraryEntry>('library_save', { entry }),
  libraryLoad: (id: string) => invoke<string>('library_load', { id }),
  libraryDelete: (id: string) => invoke<void>('library_delete', { id }),
  /** Writes (or with null clears) the crash-recovery autosave. */
  autosave: (data: string | null) => invoke<void>('autosave', { data }),
  autosaveLoad: () => invoke<string | null>('autosave_load'),

  // --- system -----------------------------------------------------------
  /** Raw bytes of the current wallpaper image (jpg/png/bmp). */
  wallpaper: () => invoke<ArrayBuffer>('wallpaper'),
  wallpaperInfo: () => invoke<WallpaperInfo>('wallpaper_info'),
  systemFonts: () => invoke<string[]>('system_fonts'),
  accentColor: () => invoke<string | null>('accent_color'),
  settingsGet: () => invoke<Settings>('settings_get'),
  /** Saves settings; Rust applies hotkey / autostart / context menu. */
  settingsSet: (settings: Settings) => invoke<Settings>('settings_set', { settings }),
  openExternal: (link: ExternalLink) => invoke<void>('open_external', { link }),
  /** Shows/hides the floating box (tray "Hide box" equivalent). */
  setBoxVisible: (visible: boolean) => invoke<void>('set_box_visible', { visible }),
  quitApp: () => invoke<void>('quit_app'),
  /** Smoke test: the page rendered and its IPC works. */
  smokeReady: (report: SmokeReport) => invoke<void>('smoke_ready', { report }),
} as const;

export type Commands = typeof commands;

/** Every command name the backend must implement (used by the mock + tests). */
export const COMMAND_NAMES = [
  'app_boot',
  'box_drag',
  'box_menu',
  'open_editor',
  'box_painted',
  'editor_next',
  'editor_ack',
  'editor_close',
  'inspect_paths',
  'inspect_system_icon',
  'item_frames',
  'pick_files',
  'read_project',
  'apply_icon',
  'apply_icon_elevated',
  'restore',
  'history_list',
  'refresh_icons',
  'export_file',
  'library_list',
  'library_save',
  'library_load',
  'library_delete',
  'autosave',
  'autosave_load',
  'wallpaper',
  'wallpaper_info',
  'system_fonts',
  'accent_color',
  'settings_get',
  'settings_set',
  'open_external',
  'set_box_visible',
  'quit_app',
  'smoke_ready',
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];
