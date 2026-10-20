/** Line diff for the quick diff gutter: which lines of `modified` are added / modified, and where lines were removed. */

export type ScmLineChange = { kind: "added" | "modified" | "deleted"; /** 1-based line of `modified`; for "deleted" the line after which lines were removed (0 = top). */ line: number; /** Lines covered (modified / added). */ count: number };

function splitLines(text: string): string[] {
  return text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n");
}

/** Hunks as [origStart, origLen, modStart, modLen] (0-based) from an LCS table over the lines between common prefix and suffix. */
export function diffHunks(original: string[], modified: string[]): [number, number, number, number][] {
  let start = 0;
  while (start < original.length && start < modified.length && original[start] === modified[start]) start++;
  let endO = original.length;
  let endM = modified.length;
  while (endO > start && endM > start && original[endO - 1] === modified[endM - 1]) {
    endO--;
    endM--;
  }
  const a = original.slice(start, endO);
  const b = modified.slice(start, endM);
  if (!a.length && !b.length) return [];
  // Too large for the quadratic table: treat the middle as one replaced block.
  if (a.length * b.length > 4_000_000) return [[start, a.length, start, b.length]];
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const hunks: [number, number, number, number][] = [];
  let i = 0;
  let j = 0;
  let open: [number, number, number, number] | null = null;
  const close = () => {
    if (open) hunks.push(open);
    open = null;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      i++;
      j++;
      continue;
    }
    open ??= [start + i, 0, start + j, 0];
    if (j < b.length && (i === a.length || table[i * width + j + 1]! >= table[(i + 1) * width + j]!)) {
      open[3]++;
      j++;
    } else {
      open[1]++;
      i++;
    }
  }
  close();
  return hunks;
}

export function computeLineChanges(originalText: string, modifiedText: string): ScmLineChange[] {
  const changes: ScmLineChange[] = [];
  for (const [origStart, origLen, modStart, modLen] of diffHunks(splitLines(originalText), splitLines(modifiedText))) {
    if (modLen === 0) changes.push({ kind: "deleted", line: modStart, count: origLen });
    else changes.push({ kind: origLen === 0 ? "added" : "modified", line: modStart + 1, count: modLen });
    void origStart;
  }
  return changes;
}

/** VS Code's `LineChange` (1-based; an empty side has end 0 and start = the line before it), as scm/change/title commands get them. */
export type VsLineChange = { originalStartLineNumber: number; originalEndLineNumber: number; modifiedStartLineNumber: number; modifiedEndLineNumber: number };

export function vscodeLineChanges(originalText: string, modifiedText: string): VsLineChange[] {
  return diffHunks(splitLines(originalText), splitLines(modifiedText)).map(([origStart, origLen, modStart, modLen]) => ({
    originalStartLineNumber: origLen ? origStart + 1 : origStart,
    originalEndLineNumber: origLen ? origStart + origLen : 0,
    modifiedStartLineNumber: modLen ? modStart + 1 : modStart,
    modifiedEndLineNumber: modLen ? modStart + modLen : 0,
  }));
}
