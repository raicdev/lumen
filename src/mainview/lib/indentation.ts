import type { Settings } from "./settings";

/**
 * Per-document indentation (VS Code's editor.detectIndentation): each file is
 * edited with the indentation it already uses, instead of the global
 * editor.tabSize / editor.insertSpaces. The status bar's indentation picker
 * changes it for the active file only.
 */

export type Indentation = { insertSpaces: boolean; tabSize: number };

const LINES_TO_SCAN = 10_000;

/** The indentation `text` uses; null when it has too few indented lines to tell. */
export function detectIndentation(text: string): Indentation | null {
  let tabLines = 0;
  let spaceLines = 0;
  // How often the indentation grows by n spaces from one indented line to the next.
  const steps = new Map<number, number>();
  let previous = 0;
  const lines = text.split("\n", LINES_TO_SCAN);
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = /^[\t ]*/.exec(line)![0];
    if (indent.startsWith("\t")) tabLines++;
    else if (indent.length) spaceLines++;
    // Block comment continuations (` * text`) are indented by one space: not a step.
    if (/^\s*\*/.test(line) && indent.length % 2 === 1) continue;
    const width = indent.includes("\t") ? -1 : indent.length;
    if (width >= 0 && width > previous) {
      const step = width - previous;
      if (step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1);
    }
    if (width >= 0) previous = width;
  }
  if (tabLines + spaceLines < 2) return null;
  if (tabLines > spaceLines) return { insertSpaces: false, tabSize: 4 };
  let best = 0;
  let bestCount = 0;
  for (const size of [2, 4, 8, 3, 6]) {
    const count = steps.get(size) ?? 0;
    if (count > bestCount) {
      best = size;
      bestCount = count;
    }
  }
  return best ? { insertSpaces: true, tabSize: best } : null;
}

const byPath = new Map<string, Indentation>();

/** Detect a document's indentation once, when it is first loaded into an editor. */
export function rememberIndentation(path: string, text: string): void {
  if (byPath.has(path)) return;
  const detected = detectIndentation(text);
  if (detected) byPath.set(path, detected);
}

/** The status bar picked another indentation for this file. */
export function setDocumentIndentation(path: string, indentation: Indentation): void {
  byPath.set(path, indentation);
}

/** The indentation to edit `path` with: detected (or picked) for the file, else the settings. */
export function indentationFor(path: string | null | undefined, settings: Settings): Indentation {
  const fallback = { insertSpaces: settings["editor.insertSpaces"], tabSize: settings["editor.tabSize"] };
  if (!path || !settings["editor.detectIndentation"]) return fallback;
  return byPath.get(path) ?? fallback;
}
