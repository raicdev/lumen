import { Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { ModalEditorTitleActions } from "../features/menus-walkthroughs/MenuActions";
import { useEffect, useMemo, useRef, useState } from "react";
import { commandLabel, DEFAULT_KEYBINDINGS, type Command, type Keybinding } from "../lib/commands";
import { keyFromEvent } from "../lib/keybindings";

type Props = {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  bindings: Keybinding[];
  overrides: Record<string, string>;
  onChangeOverrides: (overrides: Record<string, string>) => void;
};

/** Keyboard Shortcuts editor: search, record a new key, reset to default. */
export function ShortcutsEditor({ open, onClose, commands, bindings, overrides, onChangeOverrides }: Props) {
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setRecording(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Escape closes (unless a key is being recorded); recording captures keys.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (recording) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
          setRecording(null);
          setPending([]);
          return;
        }
        if (e.key === "Enter" && pending.length) {
          onChangeOverrides({ ...overrides, [recording]: pending.join(" ") });
          setRecording(null);
          setPending([]);
          return;
        }
        const key = keyFromEvent(e);
        if (key) setPending((prev) => (prev.length >= 2 ? [key] : [...prev, key]));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, recording, pending, overrides, onChangeOverrides, onClose]);

  const rows = useMemo(() => {
    const keysFor = new Map<string, string[]>();
    for (const binding of bindings) {
      const list = keysFor.get(binding.command) ?? [];
      list.push(binding.key);
      keysFor.set(binding.command, list);
    }
    const q = query.trim().toLowerCase();
    return commands
      .map((command) => ({ command, label: commandLabel(command), keys: keysFor.get(command.id) ?? [] }))
      .filter(({ command, label, keys }) => {
        if (!q) return true;
        const haystack = `${label} ${command.id} ${keys.join(" ")}`.toLowerCase();
        return q.split(/\s+/).every((word) => haystack.includes(word));
      })
      .sort((a, b) => Number(b.keys.length > 0) - Number(a.keys.length > 0) || a.label.localeCompare(b.label));
  }, [commands, bindings, query]);

  if (!open) return null;

  return (
    <div className="modal-overlay settings-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-editor shortcuts-editor" role="dialog" aria-label="Keyboard Shortcuts">
        <div className="settings-header">
          <h2>Keyboard Shortcuts</h2>
          <input
            ref={inputRef}
            className="settings-search"
            type="text"
            placeholder="Type to search in keybindings"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ModalEditorTitleActions activeEditor="workbench.editor.keybindings" />
          <button type="button" className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {recording && (
          <div className="shortcut-recorder">
            Press desired key combination{pending.length < 2 ? " (a second key makes a chord)" : ""}, then Enter. Esc cancels.
            <kbd>{pending.join(" ") || "…"}</kbd>
          </div>
        )}
        <div className="settings-body">
          <table className="shortcuts-table">
            <thead>
              <tr>
                <th>Command</th>
                <th>Keybinding</th>
                <th>Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(({ command, label, keys }) => {
                const custom = command.id in overrides;
                const isDefault = DEFAULT_KEYBINDINGS.some((binding) => binding.command === command.id);
                return (
                  <tr key={command.id} onDoubleClick={() => setRecording(command.id)}>
                    <td>
                      <div>{label}</div>
                      <div className="setting-key">{command.id}</div>
                    </td>
                    <td>{keys.length ? keys.map((key) => <kbd key={key}>{key}</kbd>) : <span className="muted">—</span>}</td>
                    <td className="muted">{custom ? "User" : isDefault ? "Default" : ""}</td>
                    <td className="shortcut-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="Change Keybinding"
                        onClick={() => {
                          setPending([]);
                          setRecording(command.id);
                        }}
                      >
                        <Pencil size={14} />
                      </button>
                      {custom && (
                        <button
                          type="button"
                          className="icon-btn"
                          title="Reset Keybinding"
                          onClick={() => {
                            const next = { ...overrides };
                            delete next[command.id];
                            onChangeOverrides(next);
                          }}
                        >
                          <RotateCcw size={14} />
                        </button>
                      )}
                      {keys.length > 0 && (
                        <button
                          type="button"
                          className="icon-btn"
                          title="Remove Keybinding"
                          onClick={() => onChangeOverrides({ ...overrides, [command.id]: "" })}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
