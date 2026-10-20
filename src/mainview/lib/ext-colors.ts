import { StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { HostColor, HostColorInformation, HostColorPresentation } from "../../shared/extensions";
import type { TextRange } from "../../shared/types";
import { extensionService } from "./extensions";
import { offsetOf } from "./text-edits";

/**
 * Colours from extensions (languages.registerColorProvider): a small swatch
 * before every colour range; clicking it opens a native colour picker and the
 * chosen colour is written back through the provider's first presentation. The
 * colours are fetched when a document opens, after edits (debounced) and when
 * a provider is registered.
 */

/** The document the colours are for (null when no editor document is shown). */
export type ColorSource = () => { path: string; language: string } | null;

export const setExtensionColors = StateEffect.define<DecorationSet>();

const extensionColorsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setExtensionColors)) return effect.value;
    // Ranges an edit changed keep their swatch until the provider answers again.
    return tr.docChanged ? value.map(tr.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function channel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value * 255)));
}

function hexOf(color: HostColor): string {
  return `#${[color.red, color.green, color.blue].map((value) => channel(value).toString(16).padStart(2, "0")).join("")}`;
}

function cssColor(color: HostColor): string {
  return `rgba(${channel(color.red)}, ${channel(color.green)}, ${channel(color.blue)}, ${color.alpha})`;
}

function rgbOfHex(value: string): { red: number; green: number; blue: number } {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  const int = parseInt(match?.[1] ?? "000000", 16);
  return { red: ((int >> 16) & 255) / 255, green: ((int >> 8) & 255) / 255, blue: (int & 255) / 255 };
}

function sameRange(a: TextRange, b: TextRange): boolean {
  return a.startLine === b.startLine && a.startCharacter === b.startCharacter && a.endLine === b.endLine && a.endCharacter === b.endCharacter;
}

function sameColor(a: HostColor, b: HostColor): boolean {
  return a.red === b.red && a.green === b.green && a.blue === b.blue && a.alpha === b.alpha;
}

/** Offset of a 0-based line / character in the document (clamped). */
function offset(doc: Text, line: number, character: number): number {
  const target = doc.line(Math.min(Math.max(1, line + 1), doc.lines));
  return Math.min(target.from + Math.max(0, character), target.to);
}

/** The swatch: its background is the colour, an invisible native input on top opens the picker. */
class ColorSwatchWidget extends WidgetType {
  readonly #info: HostColorInformation;
  readonly #source: ColorSource;
  constructor(info: HostColorInformation, source: ColorSource) {
    super();
    this.#info = info;
    this.#source = source;
  }
  eq(other: ColorSwatchWidget) {
    return sameRange(this.#info.range, other.#info.range) && sameColor(this.#info.color, other.#info.color);
  }
  toDOM(view: EditorView) {
    const dom = document.createElement("span");
    dom.className = "cm-ext-color-swatch";
    dom.style.backgroundColor = cssColor(this.#info.color);
    const input = document.createElement("input");
    input.type = "color";
    input.className = "cm-ext-color-input";
    input.value = hexOf(this.#info.color);
    input.tabIndex = -1;
    dom.appendChild(input);
    // The click must not move the cursor or start a selection.
    dom.addEventListener("mousedown", (event) => {
      event.stopPropagation();
    });
    input.addEventListener("input", () => {
      dom.style.backgroundColor = input.value;
    });
    input.addEventListener("change", () => {
      void applyColor(view, this.#source, this.#info, input.value);
    });
    return dom;
  }
  ignoreEvent() {
    return false;
  }
}

/** One swatch before each colour range. */
export function buildExtensionColors(doc: Text, colors: HostColorInformation[], source: ColorSource): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const info of colors) {
    const from = offset(doc, info.range.startLine, info.range.startCharacter);
    ranges.push(Decoration.widget({ widget: new ColorSwatchWidget(info, source), side: -1 }).range(from));
  }
  return Decoration.set(ranges, true);
}

/** Ask the extension how to write the picked colour, then apply the first presentation. */
async function applyColor(view: EditorView, source: ColorSource, info: HostColorInformation, value: string): Promise<void> {
  const current = source();
  if (!current) return;
  const rgb = rgbOfHex(value);
  const color: HostColor = { ...rgb, alpha: info.color.alpha };
  let presentations: HostColorPresentation[];
  try {
    presentations = await extensionService.call("provideColorPresentations", current.path, color, info.range);
  } catch {
    return;
  }
  if (source()?.path !== current.path) return;
  const first = presentations[0];
  if (first?.textEdit) {
    const text = view.state.doc.toString();
    const from = offsetOf(text, first.textEdit.startLine, first.textEdit.startCharacter);
    const to = offsetOf(text, first.textEdit.endLine, first.textEdit.endCharacter);
    view.dispatch({ changes: { from, to, insert: first.textEdit.newText } });
    return;
  }
  const label = first?.label ?? hexOf(color);
  const from = offset(view.state.doc, info.range.startLine, info.range.startCharacter);
  const to = offset(view.state.doc, info.range.endLine, info.range.endCharacter);
  view.dispatch({ changes: { from, to: Math.max(from, to), insert: label } });
}

/** Edits close together must not ask for the colours again and again. */
const DEBOUNCE = 500;

class ColorPlugin {
  readonly view: EditorView;
  readonly #source: ColorSource;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #sequence = 0;
  #path: string | null = null;

  constructor(view: EditorView, source: ColorSource) {
    this.view = view;
    this.#source = source;
    window.addEventListener("lumen:ext-providers", this.refresh);
    void this.#fetch();
  }

  update(update: ViewUpdate) {
    if (update.docChanged) this.#debounce();
    else if ((this.#source()?.path ?? null) !== this.#path) void this.#fetch();
  }

  destroy() {
    if (this.#timer) clearTimeout(this.#timer);
    window.removeEventListener("lumen:ext-providers", this.refresh);
  }

  /** Fetch the colours again right away. */
  readonly refresh = () => {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    void this.#fetch();
  };

  #debounce() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#fetch();
    }, DEBOUNCE);
  }

  async #fetch() {
    // Never dispatch while the constructor (or an update) is still running.
    await Promise.resolve();
    const view = this.view;
    const current = this.#source();
    const sequence = ++this.#sequence;
    this.#path = current?.path ?? null;
    if (!current || !extensionService.providersFor("color", current.path, current.language).length) {
      view.dispatch({ effects: setExtensionColors.of(Decoration.none) });
      return;
    }
    let colors: HostColorInformation[];
    try {
      colors = await extensionService.call("provideDocumentColors", current.path);
    } catch {
      return;
    }
    if (this.#sequence !== sequence || !view.dom.isConnected) return;
    if (this.#source()?.path !== current.path) return;
    view.dispatch({ effects: setExtensionColors.of(buildExtensionColors(view.state.doc, colors, this.#source)) });
  }
}

export function colorProviderExtension(source: ColorSource): Extension {
  return [extensionColorsField, ViewPlugin.define((view) => new ColorPlugin(view, source))];
}
