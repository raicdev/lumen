import type { SearchOptions, TextEdit } from "./types.ts";

/** Build the line matcher shared by search and replace (always global). */
export function buildMatcher(query: string, options: SearchOptions): RegExp {
  let source = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (options.wholeWord) source = `\\b(?:${source})\\b`;
  return new RegExp(source, options.caseSensitive ? "g" : "gi");
}

/** What one match turns into: regex replacements expand $1, $& … the way String.prototype.replace does. */
function expand(matched: string, matcher: RegExp, replacement: string, regex: boolean): string {
  if (!regex) return replacement;
  return matched.replace(new RegExp(matcher.source, matcher.flags.replace("g", "")), replacement);
}

/** Replace every match in `text`, line by line (keeping each line ending) so ^ / $ behave as in search. */
export function replaceText(text: string, matcher: RegExp, replacement: string, regex: boolean): { text: string; count: number } {
  let count = 0;
  const next = text
    .split(/(\r?\n)/)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(matcher, (matched: string) => {
        if (!matched) return matched;
        count++;
        return expand(matched, matcher, replacement, regex);
      });
    })
    .join("");
  return { text: next, count };
}

/** The same replacements as edits of a `\n`-separated document (for open editors, so they can be undone). */
export function replacementEdits(text: string, matcher: RegExp, replacement: string, regex: boolean): TextEdit[] {
  const edits: TextEdit[] = [];
  text.split("\n").forEach((line, index) => {
    matcher.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(line))) {
      if (!match[0]) {
        matcher.lastIndex++;
        continue;
      }
      edits.push({
        startLine: index,
        startCharacter: match.index,
        endLine: index,
        endCharacter: match.index + match[0].length,
        newText: expand(match[0], matcher, replacement, regex),
      });
    }
  });
  return edits;
}
