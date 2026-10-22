import { RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { HostSemanticToken } from "../../shared/extensions";
import { compileTokenRules, matchTokenStyle, type ColorThemeData } from "../../shared/color-theme";
import { semanticLanguageClass, semanticSelectorCss, semanticTypeChain, type SemanticContributions } from "../../shared/theming-contribs";
import { extensionService } from "./extensions";
import { activeColorTheme, onColorThemeChange } from "./theme";

/**
 * Semantic tokens from extensions (languages.registerDocumentSemanticTokensProvider
 * and …RangeSemanticTokensProvider): marks with a class per token type and
 * modifier, colored by the active color theme (see theme.ts). They are
 * refreshed after edits (debounced), overwriting the syntactic highlighting.
 *
 * Extensions can add token types (with a super type whose style they inherit)
 * and modifiers, and map selectors to TextMate scopes (contributes.semanticToken*,
 * set by features/theming-contribs.tsx).
 */

let contributions: SemanticContributions = { types: [], modifiers: [], scopes: [] };
let typeParents = new Map<string, string | undefined>();

function styleBody(style: { foreground?: string; fontStyle?: string }): string {
  const parts: string[] = [];
  if (style.foreground) parts.push(`color: ${style.foreground} !important`);
  if (style.fontStyle !== undefined) {
    const words = style.fontStyle.split(/\s+/);
    parts.push(`font-style: ${words.includes("italic") ? "italic" : "normal"} !important`);
    parts.push(`font-weight: ${words.includes("bold") ? "bold" : "normal"} !important`);
    const lines = [words.includes("underline") ? "underline" : "", words.includes("strikethrough") ? "line-through" : ""].filter(Boolean);
    parts.push(`text-decoration: ${lines.length ? lines.join(" ") : "none"} !important`);
  }
  return parts.join("; ");
}

/** CSS of semanticTokenScopes: the style of the first scope the theme has a rule for (the theme's own semanticTokenColors win). */
export function semanticScopesCss(
  scopes: SemanticContributions["scopes"],
  theme: Pick<ColorThemeData, "tokenColors" | "semanticHighlighting" | "semanticTokenColors">,
): string {
  if (theme.semanticHighlighting === false) return "";
  const rules = compileTokenRules(theme.tokenColors);
  const own = theme.semanticTokenColors ?? {};
  const css: string[] = [];
  for (const entry of scopes) {
    if (entry.selector.split(":")[0]! in own || entry.selector in own) continue;
    const selector = semanticSelectorCss(entry.selector, entry.language);
    if (!selector) continue;
    for (const scope of entry.scopes) {
      const style = matchTokenStyle(rules, [scope]);
      if (!style.foreground && style.fontStyle === undefined) continue;
      const body = styleBody(style);
      if (body) css.push(`${selector} { ${body} }`);
      break;
    }
  }
  return css.join("\n");
}

function styleSheet(): HTMLStyleElement {
  let element = document.getElementById("lumen-semantic-contributions") as HTMLStyleElement | null;
  if (!element) {
    element = document.createElement("style");
    element.id = "lumen-semantic-contributions";
    document.head.appendChild(element);
  }
  return element;
}

function applyContributionCss() {
  try {
    const theme = activeColorTheme();
    styleSheet().textContent = semanticScopesCss(contributions.scopes, theme);
  } catch {
    /* no theme yet: applied on the first theme change */
  }
}

/** The semantic token contributions of the enabled extensions. */
export function setSemanticTokenContributions(next: SemanticContributions): void {
  contributions = next;
  typeParents = new Map(next.types.map((type) => [type.id, type.superType]));
  applyContributionCss();
  window.dispatchEvent(new Event("lumen:ext-providers"));
}

onColorThemeChange(applyContributionCss);

export const setExtensionSemanticTokens = StateEffect.define<DecorationSet>();

export const extensionSemanticTokensField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setExtensionSemanticTokens)) return effect.value;
    // Tokens carry positions: keep them next to their text across edits.
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const semanticTokensModifiers = EditorView.theme({
  // readonly stays upright, deprecated is struck through.
  ".cm-sem-mod-readonly": { fontStyle: "normal !important" },
  ".cm-sem-mod-deprecated": { textDecoration: "line-through !important" },
});

function offset(doc: Text, line: number, character: number): number {
  const target = doc.line(Math.min(Math.max(1, line + 1), doc.lines));
  return Math.min(target.from + Math.max(0, character), target.to);
}

/** Tokens as marks: `cm-sem-<type>` plus `cm-sem-mod-<modifier>` for each modifier. */
export function buildSemanticTokens(doc: Text, tokens: HostSemanticToken[], language?: string): DecorationSet {
  const items: { from: number; to: number; decoration: Decoration; order: number }[] = [];
  let order = 0;
  for (const token of tokens) {
    const from = offset(doc, token.line, token.character);
    const to = Math.min(from + Math.max(0, token.length), doc.lineAt(from).to);
    if (to <= from) continue;
    // A contributed type also carries the classes of its super types, so it inherits their colors.
    const classes = [
      ...semanticTypeChain(token.type, typeParents).map((type) => `cm-sem-${type}`),
      ...token.modifiers.map((modifier) => `cm-sem-mod-${modifier}`),
      ...(language ? [semanticLanguageClass(language)] : []),
    ].join(" ");
    items.push({ from, to, decoration: Decoration.mark({ class: classes }), order: order++ });
  }
  // RangeSetBuilder needs ranges sorted by position.
  items.sort((a, b) => a.from - b.from || a.decoration.startSide - b.decoration.startSide || a.to - b.to || a.order - b.order);
  const builder = new RangeSetBuilder<Decoration>();
  for (const item of items) builder.add(item.from, item.to, item.decoration);
  return builder.finish();
}

/** The document semantic tokens are asked for (null when no editor document is shown). */
export type SemanticTokensSource = () => { path: string; language: string } | null;

export function semanticTokensExtension(source: SemanticTokensSource): Extension {
  return [
    extensionSemanticTokensField,
    semanticTokensModifiers,
    ViewPlugin.fromClass(
      class {
        readonly view: EditorView;
        private timer: ReturnType<typeof setTimeout> | null = null;
        private destroyed = false;
        private readonly onChanged = () => this.schedule();

        constructor(view: EditorView) {
          this.view = view;
          window.addEventListener("lumen:ext-providers", this.onChanged);
          this.schedule();
        }

        update(update: ViewUpdate) {
          if (update.docChanged) this.schedule();
        }

        destroy() {
          this.destroyed = true;
          window.removeEventListener("lumen:ext-providers", this.onChanged);
          if (this.timer) clearTimeout(this.timer);
        }

        private schedule() {
          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            this.timer = null;
            void this.refresh();
          }, 500);
        }

        private clear() {
          if (this.view.state.field(extensionSemanticTokensField, false)?.size) {
            this.view.dispatch({ effects: setExtensionSemanticTokens.of(Decoration.none) });
          }
        }

        private hasProvider(path: string, language: string): boolean {
          return (
            extensionService.providersFor("semanticTokens", path, language).length > 0 ||
            extensionService.providersFor("rangeSemanticTokens", path, language).length > 0
          );
        }

        private async refresh() {
          const target = source();
          if (!target || !this.hasProvider(target.path, target.language)) {
            this.clear();
            return;
          }
          const view = this.view;
          let tokens: HostSemanticToken[];
          try {
            tokens = await extensionService.call("provideSemanticTokens", target.path);
          } catch {
            return;
          }
          if (this.destroyed || this.view !== view || !view.dom.isConnected) return;
          const current = source();
          if (!current || current.path !== target.path) return;
          view.dispatch({ effects: setExtensionSemanticTokens.of(buildSemanticTokens(view.state.doc, tokens, target.language)) });
        }
      },
    ),
  ];
}
