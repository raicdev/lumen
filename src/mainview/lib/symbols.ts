import type { DocumentSymbol } from "../../shared/types";

/**
 * Document symbols for the outline, breadcrumbs and "Go to Symbol". TS / JS
 * symbols come from the language service; other languages use the light
 * pattern-based extraction below.
 */

type Rule = { pattern: RegExp; kind: string };

const RULES: Record<string, Rule[]> = {
  python: [
    { pattern: /^(\s*)class\s+([A-Za-z_]\w*)/, kind: "class" },
    { pattern: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
  ],
  rust: [
    { pattern: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:struct|union)\s+([A-Za-z_]\w*)/, kind: "class" },
    { pattern: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
    { pattern: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: "interface" },
    { pattern: /^(\s*)impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_][\w:<>]*)/, kind: "module" },
    { pattern: /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
  ],
  go: [
    { pattern: /^()type\s+([A-Za-z_]\w*)\s+struct/, kind: "class" },
    { pattern: /^()type\s+([A-Za-z_]\w*)\s+interface/, kind: "interface" },
    { pattern: /^()func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
  ],
  css: [{ pattern: /^(\s*)([^{}@\s][^{}]*?)\s*\{/, kind: "property" }],
  yaml: [{ pattern: /^()([A-Za-z_][\w-]*)\s*:/, kind: "property" }],
  shell: [{ pattern: /^(\s*)(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{/, kind: "function" }],
};

function markdownSymbols(lines: string[]): DocumentSymbol[] {
  const roots: DocumentSymbol[] = [];
  const stack: { level: number; symbol: DocumentSymbol }[] = [];
  let inFence = false;
  lines.forEach((text, line) => {
    if (/^\s*(```|~~~)/.test(text)) inFence = !inFence;
    const match = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
    if (!match) return;
    const level = match[1]!.length;
    const symbol: DocumentSymbol = {
      name: match[2]!,
      kind: "heading",
      line,
      character: 0,
      startLine: line,
      startCharacter: 0,
      endLine: lines.length - 1,
      endCharacter: 0,
    };
    while (stack.length && stack[stack.length - 1]!.level >= level) {
      stack.pop()!.symbol.endLine = Math.max(line - 1, 0);
    }
    const parent = stack[stack.length - 1]?.symbol;
    if (parent) (parent.children ??= []).push(symbol);
    else roots.push(symbol);
    stack.push({ level, symbol });
  });
  return roots;
}

/** Indentation-scoped extraction for languages without a language service. */
export function extractSymbols(language: string, text: string): DocumentSymbol[] {
  const lines = text.split("\n");
  if (language === "markdown") return markdownSymbols(lines);
  const rules = RULES[language];
  if (!rules) return [];

  const roots: DocumentSymbol[] = [];
  const stack: { indent: number; symbol: DocumentSymbol }[] = [];
  lines.forEach((lineText, line) => {
    for (const rule of rules) {
      const match = rule.pattern.exec(lineText);
      if (!match) continue;
      const indent = match[1]!.length;
      const name = match[2]!.trim();
      const symbol: DocumentSymbol = {
        name,
        kind: rule.kind,
        line,
        character: Math.max(0, lineText.indexOf(name)),
        startLine: line,
        startCharacter: 0,
        endLine: lines.length - 1,
        endCharacter: 0,
      };
      while (stack.length && stack[stack.length - 1]!.indent >= indent) {
        stack.pop()!.symbol.endLine = Math.max(line - 1, 0);
      }
      const parent = stack[stack.length - 1]?.symbol;
      if (parent) (parent.children ??= []).push(symbol);
      else roots.push(symbol);
      stack.push({ indent, symbol });
      break;
    }
  });
  return roots;
}

/** Depth-first list with the container name, for "Go to Symbol". */
export function flattenSymbols(
  symbols: DocumentSymbol[],
  container = "",
): { symbol: DocumentSymbol; container: string }[] {
  const out: { symbol: DocumentSymbol; container: string }[] = [];
  for (const symbol of symbols) {
    out.push({ symbol, container });
    if (symbol.children) out.push(...flattenSymbols(symbol.children, symbol.name));
  }
  return out;
}

/** The chain of symbols containing a position (outermost first), for breadcrumbs. */
export function symbolPathAt(symbols: DocumentSymbol[], line: number): DocumentSymbol[] {
  const path: DocumentSymbol[] = [];
  let level: DocumentSymbol[] | undefined = symbols;
  while (level) {
    const hit: DocumentSymbol | undefined = level.find((s) => s.startLine <= line && line <= s.endLine);
    if (!hit) break;
    path.push(hit);
    level = hit.children;
  }
  return path;
}
