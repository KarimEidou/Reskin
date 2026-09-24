// Promise-based confirmation dialog: `if (await confirm({...})) …`.
// <ConfirmDialog /> (mounted once by App) renders the pending request.

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Label of the confirming button (default "OK"). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive action: the confirm button is red. */
  danger?: boolean;
}

interface Pending {
  id: number;
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

let pending = $state.raw<Pending | null>(null);
let nextId = 1;

/** Asks the user; resolves true on confirm, false on cancel/dismiss. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  // A newer question replaces an unanswered one (which counts as "no").
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { id: nextId++, options, resolve };
  });
}

/** The question on screen, if any (reactive). */
export function pendingConfirm(): Pending | null {
  return pending;
}

/** Answers the current question. */
export function answerConfirm(ok: boolean): void {
  const p = pending;
  if (!p) return;
  pending = null;
  p.resolve(ok);
}
