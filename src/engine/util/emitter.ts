// Minimal synchronous listener set. Listeners added or removed during an
// emit take effect from the next emit; a throwing listener does not stop the
// others (the first error is rethrown afterwards).

export type Listener<T> = (value: T) => void;

export class Emitter<T> {
  private listeners: Listener<T>[] = [];

  get size(): number {
    return this.listeners.length;
  }

  subscribe(listener: Listener<T>): () => void {
    this.listeners = [...this.listeners, listener];
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(value: T): void {
    let error: unknown = null;
    for (const l of this.listeners) {
      try {
        l(value);
      } catch (e) {
        error ??= e;
      }
    }
    if (error !== null) throw error;
  }

  clear(): void {
    this.listeners = [];
  }
}
