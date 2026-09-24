// Window-level decisions that must come after everything else.
//
// Listeners on the same target run in the order they were added, and the
// editor's parts add theirs when they mount — the workspace, for one, long
// after the App. A decision such as "Escape closes the editor unless
// something used it" must therefore not be taken by a listener the App
// added at start-up: it would run before the canvas stage's own window
// listener and could never see its preventDefault.
//
// `afterAllListeners` adds, while each event is on its way (window capture,
// the very first stop), a one-off bubble listener to the window. It is the
// newest one, so it runs after every other listener of that event. Events
// whose propagation was stopped never get there.

/**
 * Calls `fn(e)` for each `type` event (that `when` accepts) once every
 * other listener has seen it. Returns the uninstaller.
 */
export function afterAllListeners<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  fn: (event: WindowEventMap[K]) => void,
  when: (event: WindowEventMap[K]) => boolean = () => true,
): () => void {
  const onCapture = (event: WindowEventMap[K]) => {
    if (!when(event)) return;
    const last = (e: Event) => {
      // A later event of the same type can reach it when this one stopped
      // on the way; it is only for this one.
      if (e !== event) return;
      target.removeEventListener(type, last);
      fn(event);
    };
    target.addEventListener(type, last);
    // Propagation stopped on the way: drop it once the dispatch is over.
    setTimeout(() => target.removeEventListener(type, last), 0);
  };
  target.addEventListener(type, onCapture, true);
  return () => target.removeEventListener(type, onCapture, true);
}
