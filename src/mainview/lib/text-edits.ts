import type { TextEdit } from "../../shared/types";

/** Offset of a 0-based line / character in `\n`-separated text (clamped). */
export function offsetOf(text: string, line: number, character: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) {
    const next = text.indexOf("\n", offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  const lineEnd = text.indexOf("\n", offset);
  return Math.min(offset + character, lineEnd < 0 ? text.length : lineEnd);
}

/** Apply edits (positions refer to the original text) and return the new text. */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  const resolved = edits
    .map((edit) => ({
      from: offsetOf(text, edit.startLine, edit.startCharacter),
      to: offsetOf(text, edit.endLine, edit.endCharacter),
      insert: edit.newText,
    }))
    .sort((a, b) => b.from - a.from);
  let result = text;
  for (const edit of resolved) result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
  return result;
}

/** Edits that trim trailing whitespace (and optionally add a final newline). */
export function saveParticipantEdits(text: string, trim: boolean, finalNewline: boolean): TextEdit[] {
  const edits: TextEdit[] = [];
  const lines = text.split("\n");
  if (trim) {
    lines.forEach((line, index) => {
      const trimmed = line.replace(/[ \t]+$/, "");
      if (trimmed.length !== line.length) {
        edits.push({
          startLine: index,
          startCharacter: trimmed.length,
          endLine: index,
          endCharacter: line.length,
          newText: "",
        });
      }
    });
  }
  if (finalNewline && text.length > 0 && !text.endsWith("\n")) {
    const last = lines.length - 1;
    edits.push({
      startLine: last,
      startCharacter: lines[last]!.length,
      endLine: last,
      endCharacter: lines[last]!.length,
      newText: "\n",
    });
  }
  return edits;
}
