/**
 * Fuzzy matching for Quick Open / the command palette: every query character
 * must appear in order; contiguous runs, word starts and file-name matches
 * score higher. Returns the matched indices for highlighting.
 */

export type FuzzyMatch = { score: number; indices: number[] };

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1]!;
  const char = text[index]!;
  return /[\s/\\_\-.:]/.test(prev) || (prev === prev.toLowerCase() && char !== char.toLowerCase());
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.replace(/\s+/g, "").toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const lower = text.toLowerCase();

  // Fast path: a plain substring match is always the best explanation.
  const direct = lower.indexOf(q);
  if (direct >= 0) {
    const indices = Array.from({ length: q.length }, (_, i) => direct + i);
    return { score: 100 + q.length * 10 + (isBoundary(text, direct) ? 30 : 0) - direct * 0.1, indices };
  }

  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const char of q) {
    let found = -1;
    // Prefer the next word boundary that matches, then any occurrence.
    for (let i = from; i < lower.length; i++) {
      if (lower[i] === char && isBoundary(text, i)) {
        found = i;
        break;
      }
    }
    const plain = lower.indexOf(char, from);
    if (found < 0 || (plain >= 0 && plain === previous + 1)) found = plain;
    if (found < 0) return null;
    score += found === previous + 1 ? 8 : isBoundary(text, found) ? 6 : 1;
    indices.push(found);
    previous = found;
    from = found + 1;
  }
  return { score: score - text.length * 0.01, indices };
}

/** Match a path, preferring hits in the file name over the folder part. */
export function fuzzyMatchPath(query: string, path: string): FuzzyMatch | null {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = path.slice(slash + 1);
  const inName = fuzzyMatch(query, name);
  if (inName) {
    return { score: inName.score + 50, indices: inName.indices.map((i) => i + slash + 1) };
  }
  return fuzzyMatch(query, path);
}
