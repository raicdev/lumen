import { StateEffect, StateField, type Extension, type Range, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { HostDocumentLink } from "../../shared/extensions";
import { extensionService } from "./extensions";
import { api } from "./rpc";

/**
 * Links from extensions (languages.registerDocumentLinkProvider): holding Ctrl
 * underlines the link under the pointer and Ctrl+click opens its target — a
 * file in the editor (with a `#L` line fragment), a URL in the browser, or a
 * command. The links are fetched when a document opens, after edits
 * (debounced) and when a provider registers.
 */

/** The document the links are for (null when no editor document is shown). */
export type DocumentLinkSource = () => { path: string; language: string } | null;

/** Where a `file:` link opens in the editor (0-based line / character). */
export type DocumentLinkTarget = { path: string; line: number; character: number };

const setDocumentLinks = StateEffect.define<HostDocumentLink[]>();
const setCtrlHeld = StateEffect.define<boolean>();
const setPointer = StateEffect.define<number | null>();

const linksField = StateField.define<HostDocumentLink[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setDocumentLinks)) return effect.value;
    return value;
  },
});

/** Whether Ctrl (or Cmd) is held: links are only underlined then, like VS Code. */
const ctrlField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setCtrlHeld)) return effect.value;
    return value;
  },
});

/** The document offset under the pointer (null when it left the editor). */
const pointerField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setPointer)) return effect.value;
    return value;
  },
});

const linkMark = Decoration.mark({ class: "cm-ext-link" });

/** Underline the link the pointer is over, while Ctrl is held. */
const linkDecorations = EditorView.decorations.compute([linksField, ctrlField, pointerField], (state) => {
  const pointer = state.field(pointerField);
  if (!state.field(ctrlField) || pointer === null) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  for (const link of state.field(linksField)) {
    const from = linkOffset(state.doc, link.range.startLine, link.range.startCharacter);
    const to = linkOffset(state.doc, link.range.endLine, link.range.endCharacter);
    if (to <= from || pointer < from || pointer >= to) continue;
    const mark = link.tooltip ? Decoration.mark({ class: "cm-ext-link", attributes: { title: link.tooltip } }) : linkMark;
    ranges.push(mark.range(from, to));
  }
  return Decoration.set(ranges, true);
});

function linkOffset(doc: Text, line: number, character: number): number {
  const target = doc.line(Math.min(Math.max(1, line + 1), doc.lines));
  return Math.min(target.from + Math.max(0, character), target.to);
}

/** The link at an offset (the first one, like VS Code), or -1. */
function linkAt(links: HostDocumentLink[], doc: Text, pos: number): number {
  for (let index = 0; index < links.length; index++) {
    const link = links[index]!;
    const from = linkOffset(doc, link.range.startLine, link.range.startCharacter);
    const to = linkOffset(doc, link.range.endLine, link.range.endCharacter);
    if (to > from && pos >= from && pos < to) return index;
  }
  return -1;
}

const WINDOWS = navigator.platform.toLowerCase().startsWith("win");

/** The file path of a `file:` URI, with `//host/` kept as a UNC prefix on Windows. */
function filePathOf(url: URL): string {
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep the raw path */
  }
  if (url.host) {
    const unc = `//${url.host}${path}`;
    return WINDOWS ? unc.replace(/\//g, "\\") : unc;
  }
  if (WINDOWS) {
    if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
    return path.replace(/\//g, "\\");
  }
  return path;
}

/** A `file:` URI (with an optional `#L12` / `#L12,5` fragment) as a location. */
function parseFileUri(uri: string): DocumentLinkTarget | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  const path = filePathOf(url);
  if (!path) return null;
  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const match = /^L(\d+)(?:,(\d+))?$/i.exec(fragment);
  return {
    path,
    line: match ? Math.max(0, Number(match[1]) - 1) : 0,
    character: match?.[2] ? Number(match[2]) : 0,
  };
}

/** Run a `command:id?args` link (the args are URI-encoded JSON, like a webview). */
function runCommandUri(uri: string): void {
  const match = /^command:([^?]+)(?:\?(.*))?$/i.exec(uri);
  if (!match) return;
  let command = match[1]!;
  try {
    command = decodeURIComponent(command);
  } catch {
    /* keep the raw command */
  }
  let args: unknown[] = [];
  try {
    const parsed = match[2] ? JSON.parse(decodeURIComponent(match[2])) : [];
    args = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    /* no arguments */
  }
  extensionService.executeCommand(command, args);
}

/** Open a resolved target: files through the editor, commands through the host, everything else externally. */
function openTarget(uri: string, onOpen: (target: DocumentLinkTarget) => void): void {
  const scheme = (/^(\w[\w+.-]*):/i.exec(uri)?.[1] ?? "").toLowerCase();
  if (scheme === "command") {
    runCommandUri(uri);
    return;
  }
  if (scheme === "file") {
    const target = parseFileUri(uri);
    if (target) onOpen(target);
    return;
  }
  void api().request.openExternal({ url: uri });
}

/** Resolve the link at `index` when the provider left its target out, then open it. */
async function openLink(view: EditorView, source: DocumentLinkSource, index: number, onOpen: (target: DocumentLinkTarget) => void): Promise<void> {
  const current = source();
  const link = view.state.field(linksField)[index];
  if (!current || !link) return;
  let uri = link.target;
  if (!uri) {
    try {
      uri = (await extensionService.call("resolveDocumentLink", current.path, index))?.target;
    } catch {
      return;
    }
  }
  if (uri) openTarget(uri, onOpen);
}

/** Edits close together must not ask for the links again and again. */
const DEBOUNCE = 500;

class DocumentLinkPlugin {
  readonly view: EditorView;
  readonly #source: DocumentLinkSource;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #sequence = 0;
  #path: string | null = null;

  constructor(view: EditorView, source: DocumentLinkSource) {
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

  /** Fetch the links again right away. */
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
    if (!current || !extensionService.providersFor("documentLink", current.path, current.language).length) {
      view.dispatch({ effects: setDocumentLinks.of([]) });
      return;
    }
    let links: HostDocumentLink[];
    try {
      links = await extensionService.call("provideDocumentLinks", current.path);
    } catch {
      return;
    }
    if (this.#sequence !== sequence || !view.dom.isConnected) return;
    if (this.#source()?.path !== current.path) return;
    view.dispatch({ effects: setDocumentLinks.of(links) });
  }
}

/** Ctrl / Cmd held: underline the link under the pointer; Ctrl+click opens it. */
function linkEvents(source: DocumentLinkSource, onOpen: (target: DocumentLinkTarget) => void) {
  const setCtrl = (view: EditorView, held: boolean) => {
    if (view.state.field(ctrlField) !== held) view.dispatch({ effects: setCtrlHeld.of(held) });
  };
  const setPointerAt = (view: EditorView, event: MouseEvent) => {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos !== view.state.field(pointerField)) view.dispatch({ effects: setPointer.of(pos) });
  };
  const isModifier = (event: KeyboardEvent) => event.key === "Control" || event.key === "Meta";
  return EditorView.domEventHandlers({
    keydown(event, view) {
      if (isModifier(event)) setCtrl(view, true);
      return false;
    },
    keyup(event, view) {
      if (isModifier(event)) setCtrl(view, false);
      return false;
    },
    mousemove(event, view) {
      const held = event.ctrlKey || event.metaKey;
      setCtrl(view, held);
      // Ordinary movement must not dispatch: the pointer only matters while Ctrl is held.
      if (held || view.state.field(pointerField) !== null) setPointerAt(view, event);
      return false;
    },
    mouseleave(_event, view) {
      setCtrl(view, false);
      if (view.state.field(pointerField) !== null) view.dispatch({ effects: setPointer.of(null) });
      return false;
    },
    blur(_event, view) {
      setCtrl(view, false);
      return false;
    },
    mousedown(event, view) {
      if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      const index = linkAt(view.state.field(linksField), view.state.doc, pos);
      if (index < 0) return false;
      // The click follows the link instead of moving the cursor.
      event.preventDefault();
      void openLink(view, source, index, onOpen);
      return true;
    },
  });
}

export function documentLinksExtension(source: DocumentLinkSource, onOpen: (target: DocumentLinkTarget) => void): Extension {
  return [
    linksField,
    ctrlField,
    pointerField,
    linkDecorations,
    linkEvents(source, onOpen),
    ViewPlugin.define((view) => new DocumentLinkPlugin(view, source)),
  ];
}
