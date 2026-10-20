import { RangeSetBuilder, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import type { HostDecoration, HostDecorationStyle, HostDecorationType } from "../../shared/extensions";
import { extensionService } from "./extensions";

/**
 * Text decorations set by extensions (window.createTextEditorDecorationType +
 * editor.setDecorations): inline styles, whole-line backgrounds and
 * before / after text. Ranges follow edits until the extension sends new ones.
 */

export const setExtensionDecorations = StateEffect.define<DecorationSet>();

export const extensionDecorationsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setExtensionDecorations)) return effect.value;
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function css(style: HostDecorationStyle): string {
  const parts: string[] = [];
  const add = (name: string, value: string | undefined) => {
    // Values come from extensions: keep them to one declaration each.
    if (value && !/[;{}<>]/.test(value)) parts.push(`${name}: ${value}`);
  };
  add("background-color", style.backgroundColor);
  add("color", style.color);
  add("border", style.border);
  add("border-radius", style.borderRadius);
  add("outline", style.outline);
  add("font-weight", style.fontWeight);
  add("font-style", style.fontStyle);
  add("text-decoration", style.textDecoration);
  add("opacity", style.opacity);
  add("cursor", style.cursor);
  return parts.join("; ");
}

class TextWidget extends WidgetType {
  readonly text: string;
  readonly style: string;
  constructor(text: string, style: string) {
    super();
    this.text = text;
    this.style = style;
  }
  eq(other: TextWidget) {
    return other.text === this.text && other.style === this.style;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ext-decoration-text";
    span.textContent = this.text;
    if (this.style) span.setAttribute("style", this.style);
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

function offset(doc: Text, line: number, character: number): number {
  const target = doc.line(Math.min(Math.max(1, line + 1), doc.lines));
  return Math.min(target.from + Math.max(0, character), target.to);
}

type Item = { from: number; to: number; decoration: Decoration; order: number };

/** All extension decorations for a document. */
export function buildExtensionDecorations(doc: Text, path: string): DecorationSet {
  const byType = extensionService.decorations.get(path.toLowerCase());
  if (!byType?.size) return Decoration.none;
  const items: Item[] = [];
  let order = 0;
  for (const [typeId, ranges] of byType) {
    const type: HostDecorationType | undefined = extensionService.decorationTypes.get(typeId);
    if (!type) continue;
    const style = css(type);
    const partStyle = (part: HostDecorationType["before"]) =>
      part ? css({ color: part.color, backgroundColor: part.backgroundColor, fontStyle: part.fontStyle, fontWeight: part.fontWeight }) + (part.margin && !/[;{}<>]/.test(part.margin) ? `; margin: ${part.margin}` : "") : "";
    for (const range of ranges as HostDecoration[]) {
      const from = offset(doc, range.startLine, range.startCharacter);
      const to = Math.max(from, offset(doc, range.endLine, range.endCharacter));
      order++;
      if (type.isWholeLine && style) {
        for (let line = doc.lineAt(from).number; line <= doc.lineAt(to).number; line++) {
          items.push({ from: doc.line(line).from, to: doc.line(line).from, decoration: Decoration.line({ attributes: { style } }), order });
        }
      } else if (style && to > from) {
        const attributes: Record<string, string> = { style };
        if (range.hover) attributes.title = range.hover;
        items.push({ from, to, decoration: Decoration.mark({ attributes }), order });
      }
      const before = range.before ?? type.before?.contentText;
      const after = range.after ?? type.after?.contentText;
      if (before) items.push({ from, to: from, decoration: Decoration.widget({ widget: new TextWidget(before, partStyle(type.before)), side: -1 }), order });
      if (after) items.push({ from: to, to, decoration: Decoration.widget({ widget: new TextWidget(after, partStyle(type.after)), side: 1 }), order });
    }
  }
  // RangeSetBuilder needs ranges sorted by position (and line decorations first at a position).
  items.sort((a, b) => a.from - b.from || a.decoration.startSide - b.decoration.startSide || a.order - b.order);
  const builder = new RangeSetBuilder<Decoration>();
  for (const item of items) builder.add(item.from, item.to, item.decoration);
  return builder.finish();
}
