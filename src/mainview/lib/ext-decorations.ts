import { RangeSet, RangeSetBuilder, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { HostDecorationAttachment, HostDecorationRenderOptions, HostDecorationStyle, HostDecorationType } from "../../shared/extensions";
import { isDarkTheme } from "./theme";
import { extensionService } from "./extensions";
import {
  attachmentSide,
  gutterIconRules,
  gutterIconStyle,
  gutterIconUrl,
  overviewLaneStyle,
  overviewMarkRect,
  rangeInclusive,
  type GutterIcon,
} from "./ext-decoration-marks";

/**
 * Text decorations set by extensions (window.createTextEditorDecorationType +
 * editor.setDecorations): inline styles, whole-line backgrounds, before /
 * after text and icons, gutter icons and overview ruler marks. Ranges follow
 * edits until the extension sends new ones; light / dark options follow the
 * active color theme.
 */

/** An overview ruler mark: a document range, drawn against the whole document. */
type OverviewMark = { from: number; to: number; color: string; lane: number; inclusiveStart: boolean; inclusiveEnd: boolean };

export type ExtensionDecorationState = {
  decorations: DecorationSet;
  gutters: RangeSet<GutterMarker>;
  overview: OverviewMark[];
};

const EMPTY: ExtensionDecorationState = { decorations: Decoration.none, gutters: RangeSet.empty, overview: [] };

/** The editor may still send a plain DecorationSet (older call sites): accept both. */
export const setExtensionDecorations = StateEffect.define<ExtensionDecorationState | DecorationSet>();

function normalize(value: ExtensionDecorationState | DecorationSet): ExtensionDecorationState {
  return "decorations" in value ? value : { decorations: value, gutters: RangeSet.empty, overview: [] };
}

class IconMarker extends GutterMarker {
  readonly className: string;
  readonly width: string;
  readonly height: string;
  readonly backgroundSize: "contain" | "cover";
  constructor(className: string, size: { width: string; height: string; backgroundSize: "contain" | "cover" }) {
    super();
    this.className = className;
    this.width = size.width;
    this.height = size.height;
    this.backgroundSize = size.backgroundSize;
  }
  eq(other: IconMarker) {
    return other.className === this.className && other.width === this.width && other.height === this.height && other.backgroundSize === this.backgroundSize;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-ext-gutter-icon ${this.className}`;
    el.style.width = this.width;
    el.style.height = this.height;
    el.style.backgroundSize = this.backgroundSize;
    return el;
  }
}

let iconSheet: HTMLStyleElement | null = null;
const iconClasses = new Map<string, string>();

/** A class whose background image follows the theme (light / dark icon variants). */
function gutterIconClass(icon: GutterIcon): string {
  const key = `${icon.light ?? ""}\u0000${icon.dark ?? ""}`;
  let name = iconClasses.get(key);
  if (name) return name;
  name = `cm-ext-gutter-icon-${iconClasses.size}`;
  iconClasses.set(key, name);
  if (!iconSheet) {
    iconSheet = document.createElement("style");
    iconSheet.className = "cm-ext-gutter-icons";
    document.head.appendChild(iconSheet);
  }
  iconSheet.textContent += gutterIconRules(name, icon);
  return name;
}

/** The overview ruler: thin marks at the right of the editor, next to the scrollbar. */
function overviewRuler(field: StateField<ExtensionDecorationState>) {
  return ViewPlugin.fromClass(
    class {
      readonly dom: HTMLElement;
      readonly view: EditorView;
      constructor(view: EditorView) {
        this.view = view;
        this.dom = document.createElement("div");
        this.dom.className = "cm-ext-overview-ruler";
        this.dom.setAttribute("aria-hidden", "true");
        view.dom.appendChild(this.dom);
        this.render();
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.geometryChanged ||
          update.viewportChanged ||
          update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setExtensionDecorations)))
        )
          this.render();
      }
      destroy() {
        this.dom.remove();
      }
      render() {
        const { overview } = this.view.state.field(field);
        while (this.dom.firstChild) this.dom.removeChild(this.dom.firstChild);
        if (!overview.length) return;
        // The native scrollbar covers the right edge of the scroller: sit just left of it.
        const scrollbar = Math.max(0, this.view.scrollDOM.offsetWidth - this.view.scrollDOM.clientWidth);
        this.dom.style.right = `${scrollbar}px`;
        const height = this.dom.clientHeight || this.view.dom.clientHeight;
        if (!height) return;
        for (const mark of overview) {
          const rect = overviewMarkRect(this.view.lineBlockAt(mark.from).top, this.view.lineBlockAt(mark.to).bottom, height, this.view.contentHeight);
          const el = document.createElement("div");
          el.className = "cm-ext-overview-mark";
          el.style.top = `${rect.top}px`;
          el.style.height = `${rect.height}px`;
          el.style.backgroundColor = mark.color;
          const lane = overviewLaneStyle(mark.lane);
          if (lane.left) el.style.left = lane.left;
          if (lane.right) el.style.right = lane.right;
          el.style.width = lane.width;
          this.dom.appendChild(el);
        }
      }
    },
  );
}

const decorationTheme = EditorView.theme({
  ".cm-ext-gutter": { minWidth: "0", width: "auto", padding: "0" },
  ".cm-ext-gutter .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center", padding: "0 2px" },
  ".cm-ext-gutter-icon": { display: "block", backgroundRepeat: "no-repeat", backgroundPosition: "center" },
  ".cm-ext-decoration-icon": { display: "block", maxWidth: "100%", maxHeight: "100%", objectFit: "contain" },
  ".cm-ext-overview-ruler": { position: "absolute", top: "0", bottom: "0", width: "10px", pointerEvents: "none", zIndex: "3" },
  ".cm-ext-overview-mark": { position: "absolute", borderRadius: "1px", opacity: "0.9" },
});

export const extensionDecorationsField = StateField.define<ExtensionDecorationState>({
  create: () => EMPTY,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setExtensionDecorations)) return normalize(effect.value);
    if (!tr.docChanged) return value;
    return {
      decorations: value.decorations.map(tr.changes),
      gutters: value.gutters.map(tr.changes),
      overview: value.overview.map((mark) => ({
        ...mark,
        from: tr.changes.mapPos(mark.from, mark.inclusiveStart ? -1 : 1),
        to: tr.changes.mapPos(mark.to, mark.inclusiveEnd ? 1 : -1),
      })),
    };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    gutter({ class: "cm-ext-gutter", markers: (view) => view.state.field(field).gutters }),
    overviewRuler(field),
    decorationTheme,
  ],
});

/** A style or attachment: attachments add their image size to the box. */
type CssStyle = HostDecorationStyle & { width?: string; height?: string };

function css(style: CssStyle): string {
  const parts: string[] = [];
  const add = (name: string, value: string | undefined) => {
    // Values come from extensions: keep them to one declaration each.
    if (value && !/[;{}<>]/.test(value)) parts.push(`${name}: ${value}`);
  };
  add("background-color", style.backgroundColor);
  add("color", style.color);
  add("border", style.border);
  add("border-color", style.borderColor);
  add("border-style", style.borderStyle);
  add("border-width", style.borderWidth);
  add("border-spacing", style.borderSpacing);
  add("border-radius", style.borderRadius);
  add("outline", style.outline);
  add("outline-color", style.outlineColor);
  add("outline-style", style.outlineStyle);
  add("outline-width", style.outlineWidth);
  add("font-weight", style.fontWeight);
  add("font-style", style.fontStyle);
  add("text-decoration", style.textDecoration);
  add("opacity", style.opacity);
  add("cursor", style.cursor);
  add("letter-spacing", style.letterSpacing);
  add("width", style.width);
  add("height", style.height);
  return parts.join("; ");
}

class TextWidget extends WidgetType {
  readonly text: string;
  readonly icon: string | undefined;
  readonly style: string;
  constructor(text: string, icon: string | undefined, style: string) {
    super();
    this.text = text;
    this.icon = icon;
    this.style = style;
  }
  eq(other: TextWidget) {
    return other.text === this.text && other.icon === this.icon && other.style === this.style;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ext-decoration-text";
    if (this.icon) {
      const img = document.createElement("img");
      img.className = "cm-ext-decoration-icon";
      img.src = this.icon;
      img.alt = "";
      span.appendChild(img);
      span.style.display = "inline-flex";
      span.style.alignItems = "center";
    }
    if (this.text) span.appendChild(document.createTextNode(this.text));
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

/** The style of a decoration type for a theme kind (the host sent base + variant merged). */
function styleFor(type: HostDecorationType, dark: boolean): HostDecorationStyle {
  return (dark ? type.dark : type.light) ?? type;
}

/** A range's own attachments with its theme variant merged in. */
function rangeAttachments(renderOptions: HostDecorationRenderOptions | undefined, dark: boolean) {
  if (!renderOptions) return undefined;
  const variant = dark ? renderOptions.dark : renderOptions.light;
  if (!variant) return renderOptions;
  return {
    before: renderOptions.before || variant.before ? { ...renderOptions.before, ...variant.before } : undefined,
    after: renderOptions.after || variant.after ? { ...renderOptions.after, ...variant.after } : undefined,
  };
}

/** The before / after attachment of a range: the type's own, overridden by the range's. */
function attachmentOf(base: HostDecorationAttachment | undefined, own: HostDecorationAttachment | undefined): HostDecorationAttachment | undefined {
  return base || own ? { ...base, ...own } : undefined;
}

/** A before / after widget (text and / or icon) with the attachment's style. */
function attachmentWidget(attachment: HostDecorationAttachment, side: number, dark: boolean): Decoration | undefined {
  const text = attachment.contentText ?? "";
  const icon = gutterIconUrl(attachment.contentIcon, dark);
  if (!text && !icon) return undefined;
  return Decoration.widget({ widget: new TextWidget(text, icon, css(attachment)), side });
}

type Item = { from: number; to: number; decoration: Decoration; order: number };
type GutterItem = { pos: number; marker: GutterMarker; order: number };

/** All extension decorations for a document. */
export function buildExtensionDecorations(doc: Text, path: string): ExtensionDecorationState {
  const byType = extensionService.decorations.get(path.toLowerCase());
  if (!byType?.size) return EMPTY;
  const items: Item[] = [];
  const gutterItems: GutterItem[] = [];
  const overview: OverviewMark[] = [];
  const gutterLines = new Map<number, number>();
  const dark = isDarkTheme();
  let order = 0;
  for (const [typeId, ranges] of byType) {
    const type = extensionService.decorationTypes.get(typeId);
    if (!type) continue;
    const style = styleFor(type, dark);
    const styleText = css(style);
    const edges = rangeInclusive(type.rangeBehavior);
    const iconMarker =
      type.gutterIcon && (type.gutterIcon.light || type.gutterIcon.dark)
        ? new IconMarker(gutterIconClass(type.gutterIcon), gutterIconStyle(type.gutterIconSize))
        : undefined;
    for (const range of ranges) {
      const from = offset(doc, range.startLine, range.startCharacter);
      const to = Math.max(from, offset(doc, range.endLine, range.endCharacter));
      order++;
      const firstLine = doc.lineAt(from).number;
      const lastLine = doc.lineAt(to).number;
      if (type.isWholeLine && styleText) {
        for (let line = firstLine; line <= lastLine; line++) {
          items.push({ from: doc.line(line).from, to: doc.line(line).from, decoration: Decoration.line({ attributes: { style: styleText } }), order });
        }
      } else if (styleText && to > from) {
        const attributes: Record<string, string> = { style: styleText };
        if (range.hover) attributes.title = range.hover;
        items.push({ from, to, decoration: Decoration.mark({ attributes, inclusiveStart: edges.inclusiveStart, inclusiveEnd: edges.inclusiveEnd }), order });
      }
      if (iconMarker) {
        // One icon per line of the range, like VS Code (the first type on a line wins).
        for (let line = firstLine; line <= lastLine; line++) {
          if (gutterLines.has(line)) continue;
          gutterLines.set(line, order);
          gutterItems.push({ pos: doc.line(line).from, marker: iconMarker, order });
        }
      }
      if (style.overviewRulerColor) {
        overview.push({ from, to, color: style.overviewRulerColor, lane: type.overviewRulerLane ?? 2, ...edges });
      }
      const own = rangeAttachments(range.renderOptions, dark);
      const before = attachmentOf(style.before, own?.before);
      const after = attachmentOf(style.after, own?.after);
      const beforeWidget = before && attachmentWidget(before, attachmentSide("before", type.rangeBehavior), dark);
      const afterWidget = after && attachmentWidget(after, attachmentSide("after", type.rangeBehavior), dark);
      if (beforeWidget) items.push({ from, to: from, decoration: beforeWidget, order });
      if (afterWidget) items.push({ from: to, to, decoration: afterWidget, order });
    }
  }
  // RangeSetBuilder needs ranges sorted by position (and line decorations first at a position).
  items.sort((a, b) => a.from - b.from || a.decoration.startSide - b.decoration.startSide || a.order - b.order);
  const builder = new RangeSetBuilder<Decoration>();
  for (const item of items) builder.add(item.from, item.to, item.decoration);
  const gutterBuilder = new RangeSetBuilder<GutterMarker>();
  gutterItems.sort((a, b) => a.pos - b.pos || a.order - b.order);
  for (const item of gutterItems) gutterBuilder.add(item.pos, item.pos, item.marker);
  return { decorations: builder.finish(), gutters: gutterBuilder.finish(), overview };
}
