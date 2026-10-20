/**
 * TextMate scopes → CodeMirror stream-language token names.
 *
 * A token's `scopes` array runs from the least specific (`source.ruby`) to the
 * most specific (`constant.numeric.integer.ruby`), so it is searched backwards.
 * The returned names are the tags/modifiers `StreamLanguage` understands, which
 * lets the editor's normal highlight styles color extension grammars.
 */

type ScopeRule = { scope: string; style: string };

const RULES: ScopeRule[] = [
  { scope: "keyword.operator", style: "operator" },
  { scope: "keyword", style: "keyword" },
  { scope: "storage", style: "keyword" },
  { scope: "constant.numeric", style: "number" },
  { scope: "constant.language", style: "atom" },
  { scope: "constant.character.escape", style: "escape" },
  { scope: "string", style: "string" },
  { scope: "comment", style: "comment" },
  { scope: "entity.name.function", style: "variableName.function" },
  { scope: "entity.name.class", style: "typeName" },
  { scope: "entity.name.type", style: "typeName" },
  { scope: "entity.name.tag", style: "tagName" },
  { scope: "entity.other.attribute-name", style: "attributeName" },
  { scope: "support.function", style: "variableName.function" },
  { scope: "support.type", style: "typeName" },
  { scope: "support.class", style: "typeName" },
  { scope: "variable.parameter", style: "variableName" },
  { scope: "variable", style: "variableName" },
  { scope: "punctuation", style: "punctuation" },
  { scope: "markup.heading", style: "heading" },
  { scope: "markup.bold", style: "strong" },
  { scope: "markup.italic", style: "emphasis" },
  { scope: "invalid", style: "invalid" },
];

/** `source.*` and `meta.*` are containers: they only style what is nested in them. */
const CONTAINER = /^(?:source|meta)(?:\.|$)/;

function matches(scope: string, prefix: string): boolean {
  return scope === prefix || scope.startsWith(`${prefix}.`);
}

/** The CodeMirror token name for a TextMate token, or null for no highlighting. */
export function textMateTokenStyle(scopes: readonly string[]): string | null {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i];
    for (const rule of RULES) {
      if (matches(scope, rule.scope)) return rule.style;
    }
    if (CONTAINER.test(scope)) return null;
  }
  return null;
}
