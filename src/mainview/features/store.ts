import { useSyncExternalStore } from "react";

/**
 * Tiny stores for view features: module-level state components subscribe to
 * (`useStore`). Surfaces that are plain functions of a feature (badges, status
 * bar items) re-evaluate when the feature calls `refreshFeatures()`.
 */

export type Store<T> = {
  get: () => T;
  /** Replace the value (or derive it from the previous one); listeners run when it changed (Object.is). */
  set: (next: T | ((previous: T) => T)) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === "function" ? (next as (previous: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Bumped by `refreshFeatures()`; the activity bar badges, panel tabs and status bar items follow it. */
const surfaces = createStore(0);
let scheduled = 0;

/** Ask the shell to re-evaluate badge(), statusBarItems() and the panel tab list (coalesced per frame). */
export function refreshFeatures(): void {
  scheduled ||= requestAnimationFrame(() => {
    scheduled = 0;
    surfaces.set((version) => version + 1);
  });
}

export function useFeaturesVersion(): number {
  return useStore(surfaces);
}
