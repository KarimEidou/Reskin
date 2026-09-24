// Initial focus for the editor's dialogs.
//
// The shared Dialog focuses its first control when it opens, which for a
// dialog without controls in its body is the header's close (×) button.
// `{@attach autofocus}` on a footer button moves focus there instead, once
// the dialog is showing (after Dialog's own focus call).

import type { Attachment } from 'svelte/attachments';

export const autofocus: Attachment<HTMLElement> = (node) => {
  const dialog = node.closest('dialog');
  if (!dialog) return;
  const focus = () =>
    queueMicrotask(() => {
      if (dialog.open && node.isConnected) node.focus({ preventScroll: true });
    });
  if (dialog.open) {
    focus();
    return;
  }
  const observer = new MutationObserver(() => {
    if (!dialog.open) return;
    observer.disconnect();
    focus();
  });
  observer.observe(dialog, { attributes: true, attributeFilter: ['open'] });
  return () => observer.disconnect();
};
