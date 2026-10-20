/** Tiny typed event emitter (no Node dependency, works in main and webview). */
type AnyListener = (...args: any[]) => void;

export class Emitter<Events extends Record<string, unknown[]>> {
  #listeners = new Map<keyof Events, Set<AnyListener>>();

  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener as AnyListener);
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): void {
    this.#listeners.get(event)?.delete(listener as AnyListener);
  }

  once<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): () => void {
    const dispose = this.on(event, ((...args: Events[K]) => {
      dispose();
      listener(...args);
    }) as (...args: Events[K]) => void);
    return dispose;
  }

  emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch (error) {
        console.error(`[lumen-shell] listener for "${String(event)}" threw:`, error);
      }
    }
  }
}
