// e2e-only fake Tauri backend (M1 minimal version; M2 replaces it with the
// full stateful fake).
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';

export function install(kind: 'box' | 'editor'): void {
  mockWindows(kind, kind === 'box' ? 'editor' : 'box');
  mockIPC((cmd) => {
    if (cmd === 'app_boot') {
      return {
        window: kind,
        version: '0.0.0-e2e',
        settings: {},
        systemReducedMotion: false,
        accent: null,
        build: 'e2e',
        smoke: false,
        firstRun: false,
        boxMetrics: { window: 148, visual: 120, margin: 14, radius: 30 },
        windows11: true,
      };
    }
    return null;
  });
}
