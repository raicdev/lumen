import { useState } from "react";
import { Play } from "lucide-react";
import { useStore } from "../store";
import type { ViewFeatureApi } from "../types";
import { CellEditor } from "./CellEditor";
import { call, interactiveInputs } from "./state";

/**
 * The input box of an Interactive Window: Shift+Enter / Ctrl+Enter runs the
 * code as a new cell (`interactive.execute`), ArrowUp / ArrowDown at the
 * edges walk the history of what was run.
 */

const history = new Map<string, string[]>();

/** Run what is in the input box of `path` (also the `interactive.execute` command); false when it is empty. */
export async function executeInteractiveInput(api: ViewFeatureApi, path: string): Promise<boolean> {
  const code = interactiveInputs.get()[path]?.value ?? "";
  if (!code.trim()) return false;
  const past = history.get(path) ?? [];
  history.set(path, [...past.filter((entry) => entry !== code), code].slice(-100));
  interactiveInputs.set((all) => ({ ...all, [path]: { value: "", rev: (all[path]?.rev ?? 0) + 1, cursor: -1 } }));
  return (await call<boolean>(api, path, "interactiveExecute", code)) === true;
}

export function InteractiveInput({ path, api, language }: { path: string; api: ViewFeatureApi; language: string }) {
  const input = useStore(interactiveInputs)[path] ?? { value: "", rev: 0, cursor: -1 };
  const [focused, setFocused] = useState(false);

  const recall = (direction: -1 | 1) => {
    const past = history.get(path) ?? [];
    if (!past.length) return;
    const from = input.cursor < 0 ? past.length : input.cursor;
    const cursor = Math.max(0, Math.min(past.length, from + direction));
    const value = cursor === past.length ? "" : past[cursor]!;
    interactiveInputs.set((all) => ({ ...all, [path]: { value, rev: input.rev + 1, cursor: cursor === past.length ? -1 : cursor } }));
  };

  return (
    <div className={`nb-interactive-input${focused ? " focused" : ""}`}>
      <button className="icon-btn nb-run" title="Execute (Shift+Enter)" onClick={() => void executeInteractiveInput(api, path)}>
        <Play size={13} />
      </button>
      <div className="nb-interactive-editor">
        <CellEditor
          value={input.value}
          rev={input.rev}
          languageId={language}
          placeholderText="Type code here and press Shift+Enter to run"
          onChange={(value) => interactiveInputs.set((all) => ({ ...all, [path]: { value, rev: all[path]?.rev ?? 0, cursor: all[path]?.cursor ?? -1 } }))}
          onRun={() => void executeInteractiveInput(api, path)}
          onFocus={() => setFocused(true)}
          onEscape={() => setFocused(false)}
          onNavigate={recall}
        />
      </div>
    </div>
  );
}
