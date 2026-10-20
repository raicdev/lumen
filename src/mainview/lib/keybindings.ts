/**
 * Keyboard shortcut plumbing: event → "Ctrl+Shift+P" strings, chords
 * ("Ctrl+K Ctrl+S"), focus contexts and user overrides.
 */

const CODE_KEYS: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  IntlYen: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  NumpadAdd: "=",
  NumpadSubtract: "-",
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

/** Normalized key string for a keydown, or null for a lone modifier. */
export function keyFromEvent(e: KeyboardEvent): string | null {
  let key: string | undefined;
  const letter = /^Key([A-Z])$/.exec(e.code);
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  if (letter) key = letter[1];
  else if (digit) key = digit[1];
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else if (e.key && e.key.length === 1) key = e.key.toUpperCase();
  if (!key) return null;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(key);
  return parts.join("+");
}

/** Pretty label for menus / palette (identity today, kept for future mac glyphs). */
export function formatKeybinding(binding: string | undefined): string {
  return binding ?? "";
}

export type FocusContext = "editor" | "terminal" | "explorer" | "input" | "other";

export function focusContext(): FocusContext {
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return "other";
  if (active.closest(".cm-editor")) return "editor";
  if (active.closest(".terminal-instance")) return "terminal";
  if (active.closest(".file-tree")) return "explorer";
  if (active.matches("input, textarea, select, [contenteditable]")) return "input";
  return "other";
}

/* ── user overrides (Keyboard Shortcuts editor) ─────────────────────────── */

const OVERRIDES_KEY = "lumen.keybindings";

/** commandId → keybinding ("" removes the default binding). */
export function loadKeybindingOverrides(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(OVERRIDES_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function saveKeybindingOverrides(overrides: Record<string, string>): void {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {
    /* ignore */
  }
}

/* ── modifier tracking (Ctrl+Tab editor switcher) ───────────────────────── */

let ctrlHeld = false;
window.addEventListener("keydown", (e) => (ctrlHeld = e.ctrlKey), true);
window.addEventListener("keyup", (e) => (ctrlHeld = e.ctrlKey), true);
window.addEventListener("blur", () => (ctrlHeld = false));

/** Whether Ctrl is currently held down. */
export function isCtrlHeld(): boolean {
  return ctrlHeld;
}
