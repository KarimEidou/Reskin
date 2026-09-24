// App-wide toasts. Render <ToastHost /> once; call `toast()` from anywhere:
//
//   toast('Copied to clipboard');
//   toast({ message: 'Icon applied', kind: 'success',
//           action: { label: 'Undo', run: () => commands.restore(…) } });
//   toast({ id: 'save', message: 'Saving…', timeout: 0 });   // later: same id replaces it
//
// Queue rules live in ./toast-queue.ts (unit tested).

import { ToastQueue, type Toast, type ToastOptions } from './toast-queue';

export type { Toast, ToastAction, ToastKind, ToastOptions } from './toast-queue';

let list = $state.raw<readonly Toast[]>([]);
const queue = new ToastQueue({ onChange: (toasts) => (list = toasts) });

/** Shows a toast; returns its id. A string is shorthand for an info toast. */
export function toast(opts: ToastOptions | string): string {
  return queue.show(typeof opts === 'string' ? { message: opts } : opts);
}

export function dismissToast(id: string): void {
  queue.dismiss(id);
}

export function clearToasts(): void {
  queue.clear();
}

/** Runs a toast's action (then dismisses it); a failing action shows an error toast. */
export async function runToastAction(id: string): Promise<void> {
  try {
    await queue.runAction(id);
  } catch (error) {
    toast({ message: error instanceof Error ? error.message : String(error), kind: 'error' });
  }
}

/** Pause/resume auto-dismissal (while the user hovers or focuses the stack). */
export function pauseToasts(): void {
  queue.pause();
}

export function resumeToasts(): void {
  queue.resume();
}

/** Current toasts, oldest first (reactive). */
export function toasts(): readonly Toast[] {
  return list;
}
