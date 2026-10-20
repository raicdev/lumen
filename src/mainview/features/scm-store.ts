import { createStore } from "./store";
import type { ScmControlData, ScmSnapshot } from "../../shared/scm-protocol";

/** Source controls of extensions as the host last reported them (shared by the panel, status bar items and the quick diff gutter). */
export const scmStore = createStore<ScmSnapshot>({ controls: [], busy: 0 });

/** What the user typed per source control; adopted from the host only when the extension set the value itself. */
export const scmInputs = createStore<Record<number, string>>({});
const seenRev = new Map<number, number>();

export function applySnapshot(snapshot: ScmSnapshot): void {
  const live = new Set(snapshot.controls.map((control) => control.handle));
  for (const handle of [...seenRev.keys()]) if (!live.has(handle)) seenRev.delete(handle);
  scmInputs.set((previous) => {
    let next = previous;
    for (const control of snapshot.controls) {
      if (seenRev.get(control.handle) === control.inputBox.valueRev) continue;
      seenRev.set(control.handle, control.inputBox.valueRev);
      if (next[control.handle] !== control.inputBox.value) next = { ...next, [control.handle]: control.inputBox.value };
    }
    return next;
  });
  scmStore.set(snapshot);
}

export function resetSnapshot(): void {
  seenRev.clear();
  scmInputs.set({});
  scmStore.set({ controls: [], busy: 0 });
}

/** Status bar commands of all source controls, flattened (the status bar slots index into this). */
export function statusCommands(): { handle: number; index: number; control: ScmControlData; title: string; tooltip?: string }[] {
  return scmStore.get().controls.flatMap((control) => control.statusBarCommands.map((command, index) => ({ handle: control.handle, index, control, title: command.title, tooltip: command.tooltip })));
}
