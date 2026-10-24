import {
  Annotation,
  EditorState,
  EditorSelection,
  Compartment,
  Transaction,
  type ChangeSet,
  RangeSet,
  StateEffect,
  StateField,
  Text,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightWhitespace,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  hoverTooltip,
  gutter,
  GutterMarker,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
  selectAll,
  toggleComment,
  toggleBlockComment,
  copyLineUp,
  copyLineDown,
  moveLineUp,
  moveLineDown,
  deleteLine,
  insertBlankLine,
  selectLine,
  cursorMatchingBracket,
  indentMore,
  indentLess,
  addCursorAbove,
  addCursorBelow,
} from "@codemirror/commands";
import {
  foldGutter,
  foldKeymap,
  foldAll,
  unfoldAll,
  foldCode,
  unfoldCode,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import {
  closeBrackets,
  closeBracketsKeymap,
  autocompletion,
  completionKeymap,
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches, openSearchPanel, selectNextOccurrence, selectSelectionMatches } from "@codemirror/search";
import { forceLinting, lintKeymap, linter, nextDiagnostic, previousDiagnostic, type Diagnostic as CMDiagnostic } from "@codemirror/lint";
import { Chunk, unifiedMergeView } from "@codemirror/merge";
import { showMinimap } from "@replit/codemirror-minimap";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { api } from "./rpc";
import { getSettings, onSettingsChange, type Settings } from "./settings";
import { indentationFor, rememberIndentation } from "./indentation";
import { isDarkTheme, onColorThemeChange, themeHighlighter } from "./theme";
import { applyTextEdits, offsetOf } from "./text-edits";
import { extensionService } from "./extensions";
import { featureEditorExtensions } from "../features/registry";
import { codeActionsExtension, runQuickFix } from "./ext-code-actions";
import { codeLensExtension } from "./ext-code-lens";
import { colorProviderExtension } from "./ext-colors";
import { buildExtensionDecorations, extensionDecorationsField, setExtensionDecorations } from "./ext-decorations";
import { foldingExtension } from "./ext-folding";
import { clearExtensionHighlights, extensionHighlightsField, showExtensionHighlights } from "./ext-highlights";
import { inlayHintsExtension } from "./ext-inlay-hints";
import { inlineCompletionExtension } from "./ext-inline-completion";
import { languageConfigExtensions } from "./ext-language-config";
import { linkedEditingExtension } from "./ext-linked-editing";
import { documentLinksExtension } from "./ext-links";
import { onTypeFormattingExtension } from "./ext-on-type-format";
import { expandSelection, shrinkSelection } from "./ext-selection";
import { blameAt, gitBlameExtension, setBlame, type BlameLine } from "./git-blame";
import { semanticTokensExtension } from "./ext-semantic-tokens";
import { closeSignatureHelp, requestSignatureHelp, signatureHelpExtension } from "./ext-signature-help";
import { renderMarkdown } from "./markdown";
import { snippetToTemplate, type SnippetVariables } from "./snippets";
import { refreshTextMateGrammars, textMateLanguage } from "./textmate";
import { debugEditorExtension, onDebugMarksChange, syncDebugMarks } from "./debug-editor";
import { t } from "./i18n";
import type { CompletionItem, Diagnostic, GitBlame, TextEdit, TextRange } from "../../shared/types";
import type { HostCompletionItem, HostDocumentHighlight, HostSelection } from "../../shared/extensions";

const SMART_LANGS = new Set(["typescript", "javascript", "json", "python", "css", "html", "shell", "yaml"]);

/** Languages CodeMirror packages handle themselves; extension grammars must not override them. */
const BUILT_IN_LANGUAGES = new Set(["typescript", "javascript", "json", "html", "vue", "svelte", "xml", "css", "markdown", "python", "rust"]);

const themeConf = new Compartment();

/** The editor's chrome in the active color theme's colors (CSS variables, see theme.ts). */
const chromeStyles = {
  "&": {
    backgroundColor: "var(--vscode-editor-background)",
    color: "var(--vscode-editor-foreground)",
    height: "100%",
  },
  ".cm-content": {
    caretColor: "var(--vscode-editorCursor-foreground)",
    padding: "6px 0",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--vscode-editorCursor-foreground)" },
  ".cm-git-gutter .cm-gutterElement": {
    width: "3px",
    padding: "0",
    marginLeft: "2px",
  },
  ".cm-git-added, .cm-git-modified": {
    height: "100%",
    width: "3px",
  },
  ".cm-git-added": { backgroundColor: "var(--vscode-editorGutter-addedBackground)" },
  ".cm-git-modified": { backgroundColor: "var(--vscode-editorGutter-modifiedBackground)" },
  ".cm-git-blame": {
    marginLeft: "3em",
    color: "var(--vscode-editorCodeLens-foreground)",
    fontStyle: "italic",
    whiteSpace: "pre",
  },
  ".cm-git-deleted": {
    width: "0",
    height: "0",
    marginTop: "-4px",
    borderTop: "4px solid transparent",
    borderBottom: "4px solid transparent",
    borderLeft: "5px solid var(--vscode-editorGutter-deletedBackground)",
  },
  ".cm-minimap-gutter": {
    borderLeft: "1px solid var(--vscode-editorOverviewRuler-border)",
    backgroundColor: "var(--vscode-minimap-background)",
  },
  ".cm-minimap-overlay": {
    backgroundColor: "var(--vscode-scrollbarSlider-background)",
  },
  ".cm-gutters": {
    backgroundColor: "var(--vscode-editorGutter-background)",
    color: "var(--vscode-editorLineNumber-foreground)",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 8px 0 4px",
    minWidth: "3ch",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--vscode-editor-selectionBackground) !important",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--vscode-editor-lineHighlightBackground)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--vscode-editor-lineHighlightBackground)",
    color: "var(--vscode-editorLineNumber-activeForeground)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "var(--vscode-editorBracketMatch-background)",
    outline: "1px solid var(--vscode-editorBracketMatch-border)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--vscode-editorHoverWidget-background)",
    border: "1px solid var(--vscode-editorHoverWidget-border)",
    borderRadius: "4px",
    color: "var(--vscode-editorHoverWidget-foreground)",
  },
  ".cm-tooltip.cm-tooltip-hover": {
    padding: "6px 8px",
    maxWidth: "480px",
    whiteSpace: "pre-wrap",
    fontFamily: "Consolas, monospace",
    fontSize: "12px",
    lineHeight: "1.4",
  },
  ".cm-tooltip-autocomplete": {
    backgroundColor: "var(--vscode-editorSuggestWidget-background)",
    borderColor: "var(--vscode-editorSuggestWidget-border)",
    color: "var(--vscode-editorSuggestWidget-foreground)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--vscode-editorSuggestWidget-selectedBackground)",
    color: "var(--vscode-list-activeSelectionForeground)",
  },
  ".cm-completionMatchedText": {
    color: "var(--vscode-editorSuggestWidget-highlightForeground)",
    textDecoration: "none",
    fontWeight: "bold",
  },
  ".cm-panels": {
    backgroundColor: "var(--vscode-editorWidget-background)",
    color: "var(--vscode-editorWidget-foreground)",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--vscode-editor-findMatchHighlightBackground)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--vscode-editor-findMatchBackground)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--vscode-editorWidget-background)",
    border: "none",
    color: "var(--vscode-descriptionForeground)",
  },
};

const chromeThemes = { dark: EditorView.theme(chromeStyles, { dark: true }), light: EditorView.theme(chromeStyles, { dark: false }) };

/** The theme part of an editor: chrome colors and the active theme's token colors. */
function themeExtensions(): Extension[] {
  return [chromeThemes[isDarkTheme() ? "dark" : "light"], syntaxHighlighting(themeHighlighter())];
}

/** A standalone editor view (the side-by-side diff): settings, theme, language and read-only. */
export function diffEditorExtensions(language: string, readOnly: boolean): Extension[] {
  return [
    settingsExtensions(getSettings()),
    ...themeExtensions(),
    languageExtension(language),
    languageConfigExtensions(extensionService.languageConfiguration(language)),
    ...readOnlyExtensions(readOnly),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
  ];
}

function languageExtension(language: string): Extension {
  switch (language) {
    case "typescript":
      return javascript({ typescript: true, jsx: true });
    case "javascript":
      return javascript({ jsx: true });
    case "json":
      return json();
    case "html":
    case "vue":
    case "svelte":
    case "xml":
      return html();
    case "css":
      return css();
    case "markdown":
      return markdown();
    case "python":
      return python();
    case "rust":
      return rust();
    // Closest highlighters for languages without dedicated packages
    case "go":
    case "java":
    case "c":
    case "cpp":
    case "csharp":
    case "php":
    case "ruby":
    case "kotlin":
    case "sql":
    case "shell":
    case "yaml":
    case "toml":
    case "dockerfile":
    case "dotenv":
      return javascript({ typescript: false });
    default:
      return [];
  }
}

export function isTsFamily(language: string) {
  return language === "typescript" || language === "javascript";
}

export function isSmart(language: string) {
  return SMART_LANGS.has(language);
}

export function lspStatusLabel(language: string): { text: string; active: boolean } {
  if (isTsFamily(language)) return { text: "TypeScript", active: true };
  if (language === "json") return { text: "JSON", active: true };
  if (language === "python") return { text: "Python", active: true };
  if (language === "css") return { text: "CSS", active: true };
  if (language === "html") return { text: "HTML", active: true };
  if (language === "shell") return { text: "Shell", active: true };
  if (language === "yaml") return { text: "YAML", active: true };
  return { text: t("No LSP"), active: false };
}

/** CodeMirror's own UI text (find / replace panel, folding, lint, completion) in the display language. */
const CODEMIRROR_PHRASES = [
  "Find",
  "Replace",
  "next",
  "previous",
  "all",
  "match case",
  "regexp",
  "by word",
  "replace",
  "replace all",
  "close",
  "current match",
  "on line",
  "replaced $ matches",
  "replaced match on line $",
  "Go to line",
  "go",
  "Completions",
  "Diagnostics",
  "No diagnostics",
  "Control character",
  "Selection deleted",
  "folded code",
  "unfold",
];
let codeMirrorPhrases: Record<string, string> | undefined;
function phrasesExtension(): Extension {
  codeMirrorPhrases ??= Object.fromEntries(CODEMIRROR_PHRASES.map((phrase) => [phrase, t(phrase)]));
  return EditorState.phrases.of(codeMirrorPhrases);
}

export function isUntitled(path: string) {
  return path.startsWith("untitled:");
}

/** A document of a file system an extension provides (`memfs:/notes.md`). */
export function isVirtualDocument(path: string | null | undefined): path is string {
  return !!path && /^\w[\w+.-]+:/.test(path) && !/^(untitled|terminal|webview):/.test(path);
}

/** Documents the language service never sees: untitled ones and those of extension file systems. */
export function noLanguageService(path: string) {
  return isUntitled(path) || isVirtualDocument(path);
}

/* ── settings-driven extensions ─────────────────────────────────────────── */

/** `path`: the document, whose own indentation (see indentation.ts) wins over the settings. */
function settingsExtensions(s: Settings, path?: string | null): Extension[] {
  const indentation = indentationFor(path, s);
  const tabSize = Math.max(1, Math.min(16, Math.round(indentation.tabSize)));
  return [
    EditorState.tabSize.of(tabSize),
    indentUnit.of(indentation.insertSpaces ? " ".repeat(tabSize) : "\t"),
    s["editor.wordWrap"] === "on" ? EditorView.lineWrapping : [],
    s["editor.lineNumbers"] === "off" ? [] : lineNumbers(),
    s["editor.renderWhitespace"] === "all" ? highlightWhitespace() : [],
    s["editor.renderLineHighlight"] ? [highlightActiveLine(), highlightActiveLineGutter()] : [],
    s["editor.autoClosingBrackets"] ? closeBrackets() : [],
    drawSelection({ cursorBlinkRate: s["editor.cursorBlinking"] ? 1200 : 0 }),
    s["editor.guides.indentation"]
      ? indentationMarkers({
          thickness: 1,
          colors: {
            dark: "var(--vscode-editorIndentGuide-background)",
            activeDark: "var(--vscode-editorIndentGuide-activeBackground)",
            light: "var(--vscode-editorIndentGuide-background)",
            activeLight: "var(--vscode-editorIndentGuide-activeBackground)",
          },
        })
      : [],
    s["editor.minimap.enabled"]
      ? showMinimap.compute(["doc"], () => ({
          create: () => ({ dom: document.createElement("div") }),
          displayText: "blocks" as const,
          showOverlay: "mouse-over" as const,
        }))
      : [],
    EditorView.theme({
      ".cm-content, .cm-gutters": {
        fontSize: `${s["editor.fontSize"]}px`,
        fontFamily: s["editor.fontFamily"],
      },
      ".cm-scroller": { fontFamily: s["editor.fontFamily"] },
    }),
  ];
}

/* ── read-only documents (extension content providers) ──────────────────── */

function readOnlyExtensions(readOnly: boolean): Extension[] {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

/* ── git change indicators (gutter) ─────────────────────────────────────── */

const setGitBase = StateEffect.define<Text | null>();

type GitGutterState = { base: Text | null; markers: RangeSet<GutterMarker> };

class GitMarker extends GutterMarker {
  readonly kind: "added" | "modified" | "deleted";
  constructor(kind: "added" | "modified" | "deleted") {
    super();
    this.kind = kind;
  }
  eq(other: GitMarker) {
    return other.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-git-${this.kind}`;
    return el;
  }
}

const gitMarkers = {
  added: new GitMarker("added"),
  modified: new GitMarker("modified"),
  deleted: new GitMarker("deleted"),
};

function computeGitMarkers(base: Text | null, doc: Text): RangeSet<GutterMarker> {
  if (!base || doc.lines > 20000) return RangeSet.empty;
  const ranges = [];
  for (const chunk of Chunk.build(base, doc)) {
    if (chunk.fromB === chunk.toB) {
      // Lines deleted: mark the line after the gap.
      const line = doc.lineAt(Math.min(chunk.fromB, doc.length));
      ranges.push(gitMarkers.deleted.range(line.from));
      continue;
    }
    const kind = chunk.fromA === chunk.toA ? gitMarkers.added : gitMarkers.modified;
    const first = doc.lineAt(chunk.fromB).number;
    const last = doc.lineAt(Math.max(chunk.fromB, Math.min(chunk.toB, doc.length) - 1)).number;
    for (let n = first; n <= last; n++) ranges.push(kind.range(doc.line(n).from));
  }
  return RangeSet.of(ranges, true);
}

const gitGutterField = StateField.define<GitGutterState>({
  create: () => ({ base: null, markers: RangeSet.empty }),
  update(value, tr) {
    let base = value.base;
    for (const effect of tr.effects) if (effect.is(setGitBase)) base = effect.value;
    if (base === value.base && !tr.docChanged) return value;
    return { base, markers: computeGitMarkers(base, tr.state.doc) };
  },
});

const gitGutter = [
  gitGutterField,
  gutter({
    class: "cm-git-gutter",
    markers: (view) => view.state.field(gitGutterField).markers,
  }),
];

/* ── controller ─────────────────────────────────────────────────────────── */

export type EditorDocument = {
  path: string;
  language: string;
  content: string;
  /** Last saved content (dirty = content !== savedContent). */
  savedContent: string;
  /** A virtual document an extension provides for reading only. */
  readOnly?: boolean;
};

export type CursorInfo = {
  line: number;
  column: number;
  selectedChars: number;
  selections: number;
  /** Git blame of the cursor's line, once the document was blamed. */
  blame: BlameLine | null;
};

export type EditorCommand =
  | "undo"
  | "redo"
  | "selectAll"
  | "toggleComment"
  | "toggleBlockComment"
  | "copyLineUp"
  | "copyLineDown"
  | "moveLineUp"
  | "moveLineDown"
  | "deleteLine"
  | "insertLineBelow"
  | "selectLine"
  | "expandSelection"
  | "shrinkSelection"
  | "jumpToBracket"
  | "indent"
  | "outdent"
  | "addCursorAbove"
  | "addCursorBelow"
  | "addNextOccurrence"
  | "selectAllOccurrences"
  | "foldAll"
  | "unfoldAll"
  | "fold"
  | "unfold"
  | "find"
  | "replace"
  | "nextProblem"
  | "previousProblem"
  | "upperCase"
  | "lowerCase"
  | "titleCase"
  | "sortLinesAscending"
  | "sortLinesDescending"
  | "joinLines"
  | "deleteDuplicateLines"
  | "trimTrailingWhitespace"
  | "duplicateSelection";

export type Location = { path: string; line: number; character: number };

/**
 * Marks changes that came from another editor group showing the same file
 * (or a reload): they are applied here but not mirrored back.
 */
const remoteChange = Annotation.define<boolean>();

type Cached = { state: EditorState; scroll: StateEffect<unknown> | null; settingsVersion: number };

const languageConf = new Compartment();
const languageConfigConf = new Compartment();
const completionConf = new Compartment();
const settingsConf = new Compartment();
const diffConf = new Compartment();
const readOnlyConf = new Compartment();

function selectionLines(state: EditorState): { from: number; to: number } {
  const range = state.selection.main;
  const first = state.doc.lineAt(range.from);
  let last = state.doc.lineAt(range.to);
  // A selection ending at column 0 does not include that line.
  if (range.to > range.from && last.from === range.to && last.number > first.number) {
    last = state.doc.line(last.number - 1);
  }
  // No selection: the whole document.
  if (range.empty) return { from: 0, to: state.doc.length };
  return { from: first.from, to: last.to };
}

/** Replace the selected lines (or the whole document) through `transform`. */
function transformLines(view: EditorView, transform: (lines: string[]) => string[]): boolean {
  const { from, to } = selectionLines(view.state);
  const text = view.state.sliceDoc(from, to);
  const next = transform(text.split("\n")).join("\n");
  if (next === text) return false;
  view.dispatch({ changes: { from, to, insert: next }, selection: { anchor: from, head: from + next.length } });
  return true;
}

function transformSelections(view: EditorView, transform: (text: string) => string): boolean {
  view.dispatch(
    view.state.changeByRange((range) => {
      const target = range.empty ? (view.state.wordAt(range.head) ?? range) : range;
      const insert = transform(view.state.sliceDoc(target.from, target.to));
      return {
        changes: { from: target.from, to: target.to, insert },
        range: EditorSelection.range(target.from, target.from + insert.length),
      };
    }),
  );
  return true;
}

export class EditorController {
  view: EditorView | null = null;
  private current: { path: string; language: string } | null = null;
  private cache = new Map<string, Cached>();
  private saved = new Map<string, string>();
  private dirty = new Map<string, boolean>();
  private gitBases = new Map<string, Text | null>();
  private settingsVersion = 0;
  private changeTimer: ReturnType<typeof setTimeout> | null = null;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private highlightTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped when a grammar request starts or extensions change, so stale loads do not apply. */
  private grammarGeneration = 0;

  private dirtyListeners: ((path: string, dirty: boolean) => void)[] = [];
  private openListeners: ((location: Location) => void)[] = [];
  private cursorListeners: ((info: CursorInfo) => void)[] = [];
  private visibleRangesListeners: ((path: string, ranges: TextRange[]) => void)[] = [];
  private contentListeners: ((path: string) => void)[] = [];
  private localChangeListeners: ((path: string, changes: ChangeSet) => void)[] = [];
  private unsubscribeSettings: () => void;
  private unsubscribeTheme: () => void;
  private diagnosticListeners: ((path: string, diagnostics: Diagnostic[]) => void)[] = [];
  private definitionHandler: (() => Promise<void>) | null = null;
  private typeDefinitionHandler: (() => Promise<void>) | null = null;
  private implementationHandler: (() => Promise<void>) | null = null;
  private declarationHandler: (() => Promise<void>) | null = null;

  constructor() {
    this.unsubscribeSettings = onSettingsChange(() => {
      this.settingsVersion++;
      if (!this.view) return;
      this.view.dispatch({ effects: settingsConf.reconfigure(settingsExtensions(getSettings(), this.current?.path)) });
    });
    this.unsubscribeTheme = onColorThemeChange(() => {
      this.view?.dispatch({ effects: themeConf.reconfigure(themeExtensions()) });
      // Light / dark decoration options (and themed before / after icons) are picked when building.
      this.refreshExtensionDecorations();
    });
    this.unsubscribeDecorations = extensionService.onDecorationsChange((path) => {
      if (!this.current || (path && path.toLowerCase() !== this.current.path.toLowerCase())) return;
      this.refreshExtensionDecorations();
    });
    this.unsubscribeLanguageConfig = extensionService.onLanguageConfigurationChange((languageId) => {
      if (!this.view || this.current?.language !== languageId) return;
      this.view.dispatch({ effects: languageConfigConf.reconfigure(languageConfigExtensions(extensionService.languageConfiguration(languageId))) });
    });
    window.addEventListener("lumen:ext-diagnostics", this.relint);
    window.addEventListener("lumen:ext-providers", this.onExtensionGrammarsChanged);
    window.addEventListener("lumen:ext-resync", this.onExtensionGrammarsChanged);
    this.unsubscribeDebug = onDebugMarksChange(() => this.syncDebug());
  }

  private unsubscribeDebug: () => void;

  /** Breakpoints and the debugger's current line of the shown document. */
  private syncDebug(force = false) {
    if (this.view) syncDebugMarks(this.view, this.current?.path ?? null, force);
  }

  private unsubscribeDecorations: () => void;
  private unsubscribeLanguageConfig: () => void;

  /** Extension diagnostics changed: show them in the editor. */
  private relint = () => {
    if (this.view && this.current) forceLinting(this.view);
  };

  /** Highlight the document with an extension grammar when CodeMirror has no built-in one. */
  private applyTextMateLanguage(language: string, path: string) {
    if (BUILT_IN_LANGUAGES.has(language)) return;
    const view = this.view;
    if (!view) return;
    const generation = ++this.grammarGeneration;
    void textMateLanguage(language).then((extension) => {
      if (!extension || generation !== this.grammarGeneration) return;
      if (this.view !== view || this.current?.path !== path || this.current.language !== language) return;
      view.dispatch({ effects: languageConf.reconfigure(extension) });
    });
  }

  /** Extensions were installed, enabled or disabled: reload their grammars. */
  private onExtensionGrammarsChanged = async () => {
    // Fired for every provider an extension registers: only act on real grammar changes.
    if (!(await refreshTextMateGrammars())) return;
    const view = this.view;
    const current = this.current;
    if (!view || !current || BUILT_IN_LANGUAGES.has(current.language)) return;
    const generation = ++this.grammarGeneration;
    const extension = await textMateLanguage(current.language);
    if (generation !== this.grammarGeneration || this.view !== view || this.current?.path !== current.path) return;
    // No grammar any more (extension disabled): back to Lumen's approximation.
    view.dispatch({ effects: languageConf.reconfigure(extension ?? languageExtension(current.language)) });
  };

  /** Re-read the decorations extensions set on the current document. */
  refreshExtensionDecorations() {
    if (!this.view || !this.current) return;
    this.view.dispatch({ effects: setExtensionDecorations.of(buildExtensionDecorations(this.view.state.doc, this.current.path)) });
  }

  /** Ask for document highlights once the cursor settles (250 ms), like VS Code. */
  scheduleExtensionHighlights() {
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => {
      this.highlightTimer = null;
      void this.requestExtensionHighlights();
    }, 250);
  }

  private async requestExtensionHighlights() {
    const view = this.view;
    const current = this.current;
    if (!view || !current) return;
    if (!extensionService.providersFor("documentHighlight", current.path, current.language).length) {
      clearExtensionHighlights(view);
      return;
    }
    const { line, character } = this.getCursor();
    let highlights: HostDocumentHighlight[];
    try {
      highlights = await extensionService.call("provideDocumentHighlights", current.path, line, character);
    } catch {
      return;
    }
    if (this.view !== view || this.current?.path !== current.path) return;
    showExtensionHighlights(view, highlights);
  }

  mount(parent: HTMLElement) {
    const state = EditorState.create({ doc: "", extensions: this.buildExtensions("plaintext") });
    this.view = new EditorView({ state, parent });
    this.view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
  }

  dispose() {
    this.unsubscribeSettings();
    this.unsubscribeTheme();
    this.unsubscribeDecorations();
    this.unsubscribeLanguageConfig();
    this.unsubscribeDebug();
    window.removeEventListener("lumen:ext-diagnostics", this.relint);
    window.removeEventListener("lumen:ext-providers", this.onExtensionGrammarsChanged);
    window.removeEventListener("lumen:ext-resync", this.onExtensionGrammarsChanged);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.view?.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.view?.destroy();
    this.view = null;
    this.current = null;
    this.cache.clear();
  }

  /** Scrolling is debounced before the view tells extensions about the visible ranges. */
  private onScroll = () => {
    if (this.scrollTimer) clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => this.emitVisibleRanges(), 100);
  };

  private emitVisibleRanges() {
    this.scrollTimer = null;
    const view = this.view;
    const current = this.current;
    if (!view || !current) return;
    const doc = view.state.doc;
    const ranges = view.visibleRanges.map((range) => {
      const start = doc.lineAt(range.from);
      const end = doc.lineAt(range.to);
      return {
        startLine: start.number - 1,
        startCharacter: range.from - start.from,
        endLine: end.number - 1,
        endCharacter: range.to - end.from,
      };
    });
    for (const cb of this.visibleRangesListeners) cb(current.path, ranges);
  }

  /** Whether this editor holds the document (shown or in a background tab). */
  hasDocument(path: string) {
    return this.current?.path === path || this.cache.has(path);
  }

  /** Edits made here, to mirror into other editor groups showing the same file. */
  onLocalChange(cb: (path: string, changes: ChangeSet) => void) {
    this.localChangeListeners.push(cb);
  }

  /** Apply edits made to the same document in another editor group. */
  applyRemoteChanges(path: string, changes: ChangeSet) {
    const annotations = [remoteChange.of(true), Transaction.addToHistory.of(false)];
    if (this.current?.path === path && this.view) {
      this.view.dispatch({ changes, annotations });
      return;
    }
    const cached = this.cache.get(path);
    if (!cached) return;
    cached.state = cached.state.update({ changes, annotations }).state;
    this.setDirty(path, cached.state.doc.toString() !== this.saved.get(path));
  }

  /** Re-send the cursor position (after this editor's group becomes active). */
  requestCursor() {
    this.emitCursor();
  }

  /* events */
  onDirty(cb: (path: string, dirty: boolean) => void) {
    this.dirtyListeners.push(cb);
  }
  onRequestOpen(cb: (location: Location) => void) {
    this.openListeners.push(cb);
  }
  onCursor(cb: (info: CursorInfo) => void) {
    this.cursorListeners.push(cb);
  }
  /** The visible ranges changed (the user scrolled); values are 0-based. */
  onVisibleRanges(cb: (path: string, ranges: TextRange[]) => void) {
    this.visibleRangesListeners.push(cb);
  }
  onContentChange(cb: (path: string) => void) {
    this.contentListeners.push(cb);
  }
  onDiagnostics(cb: (path: string, diagnostics: Diagnostic[]) => void) {
    this.diagnosticListeners.push(cb);
  }

  getCurrent(): { path: string; language: string; dirty: boolean } | null {
    if (!this.current) return null;
    return { ...this.current, dirty: this.dirty.get(this.current.path) ?? false };
  }

  getContent() {
    return this.view?.state.doc.toString() ?? "";
  }

  /** Content of any document the editor knows (current or cached). */
  getDocumentContent(path: string): string | null {
    if (this.current?.path === path) return this.getContent();
    return this.cache.get(path)?.state.doc.toString() ?? null;
  }

  isDirty(path: string) {
    return this.dirty.get(path) ?? false;
  }

  focus() {
    this.view?.focus();
  }

  hasFocus() {
    return this.view?.hasFocus ?? false;
  }

  getCursor(): { line: number; character: number } {
    if (!this.view) return { line: 0, character: 0 };
    const head = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(head);
    return { line: line.number - 1, character: head - line.from };
  }

  wordAtCursor(): string {
    if (!this.view) return "";
    const state = this.view.state;
    const range = state.selection.main;
    if (!range.empty) return state.sliceDoc(range.from, range.to);
    const word = state.wordAt(range.head);
    return word ? state.sliceDoc(word.from, word.to) : "";
  }

  selectedText(): string {
    if (!this.view) return "";
    const range = this.view.state.selection.main;
    return this.view.state.sliceDoc(range.from, range.to);
  }

  /** Jump to a 0-based position (optionally selecting up to an end position). */
  revealPosition(line: number, character = 0, end?: { line: number; character: number }) {
    if (!this.view) return;
    const doc = this.view.state.doc;
    const text = doc.toString();
    const anchor = offsetOf(text, Math.max(0, line), Math.max(0, character));
    const head = end ? offsetOf(text, end.line, end.character) : anchor;
    this.view.dispatch({
      selection: EditorSelection.single(anchor, head),
      effects: EditorView.scrollIntoView(anchor, { y: "center" }),
    });
    this.view.focus();
  }

  async openDocument(doc: EditorDocument) {
    if (!this.view) return;
    const previous = this.current;
    if (previous && previous.path !== doc.path) this.stash();

    this.current = { path: doc.path, language: doc.language };
    this.saved.set(doc.path, doc.savedContent);

    const cached = this.cache.get(doc.path);
    if (cached && cached.state.doc.toString() === doc.content) {
      this.view.setState(cached.state);
      const effects: StateEffect<unknown>[] = [];
      effects.push(languageConf.reconfigure(languageExtension(doc.language)));
      effects.push(languageConfigConf.reconfigure(languageConfigExtensions(extensionService.languageConfiguration(doc.language))));
      effects.push(readOnlyConf.reconfigure(readOnlyExtensions(!!doc.readOnly)));
      effects.push(themeConf.reconfigure(themeExtensions()));
      if (cached.settingsVersion !== this.settingsVersion) {
        effects.push(settingsConf.reconfigure(settingsExtensions(getSettings(), doc.path)));
      }
      if (cached.scroll) effects.push(cached.scroll);
      if (effects.length) this.view.dispatch({ effects });
    } else {
      rememberIndentation(doc.path, doc.content);
      this.view.setState(EditorState.create({ doc: doc.content, extensions: this.buildExtensions(doc.language, doc.path) }));
      const effects: StateEffect<unknown>[] = [readOnlyConf.reconfigure(readOnlyExtensions(!!doc.readOnly))];
      const base = this.gitBases.get(doc.path);
      if (base && getSettings()["editor.gitGutter"]) effects.push(setGitBase.of(base));
      this.view.dispatch({ effects });
    }
    this.applyTextMateLanguage(doc.language, doc.path);
    this.cache.delete(doc.path);
    this.syncDebug(true);
    this.setDirty(doc.path, doc.content !== doc.savedContent);
    this.emitCursor();
    this.refreshExtensionDecorations();
    this.scheduleExtensionHighlights();
    closeSignatureHelp(this.view);

    if (isSmart(doc.language) && !noLanguageService(doc.path)) {
      try {
        await api().request.lspOpen({ path: doc.path, content: doc.content, language: doc.language });
      } catch {
        /* the status bar shows the language service state */
      }
    }
  }

  /** Forget everything about a closed document. */
  closeDocument(path: string) {
    this.cache.delete(path);
    this.saved.delete(path);
    this.dirty.delete(path);
    this.gitBases.delete(path);
    if (this.current?.path === path) {
      this.current = null;
      this.view?.setState(EditorState.create({ doc: "", extensions: this.buildExtensions("plaintext") }));
    }
  }

  /** A document was saved under a new path (Save As / rename). */
  renameDocument(oldPath: string, newPath: string) {
    for (const map of [this.cache, this.saved, this.dirty, this.gitBases] as Map<string, unknown>[]) {
      if (map.has(oldPath)) {
        map.set(newPath, map.get(oldPath));
        map.delete(oldPath);
      }
    }
    if (this.current?.path === oldPath) this.current = { ...this.current, path: newPath };
  }

  /** The file changed on disk and has no local edits: take the new content (undoable). */
  reloadDocument(path: string, content: string) {
    this.saved.set(path, content);
    if (this.current?.path === path && this.view) {
      const doc = this.view.state.doc;
      // Every group reloads on its own: do not mirror this change.
      this.view.dispatch({ changes: { from: 0, to: doc.length, insert: content }, annotations: remoteChange.of(true) });
      this.setDirty(path, false);
    } else {
      this.cache.delete(path);
      this.setDirty(path, false);
    }
  }

  markSaved(path: string, content: string) {
    this.saved.set(path, content);
    const current = this.getDocumentContent(path);
    this.setDirty(path, current !== null && current !== content);
  }

  /** The active document's indentation changed (the status bar picker): edit with it from now on. */
  refreshIndentation(): void {
    this.view?.dispatch({ effects: settingsConf.reconfigure(settingsExtensions(getSettings(), this.current?.path)) });
  }

  setLanguage(language: string) {
    if (!this.view || !this.current) return;
    const previous = this.current.language;
    this.current = { ...this.current, language };
    this.view.dispatch({
      effects: [
        languageConf.reconfigure(languageExtension(language)),
        languageConfigConf.reconfigure(languageConfigExtensions(extensionService.languageConfiguration(language))),
        completionConf.reconfigure(this.completionExtension(language)),
      ],
    });
    const path = this.current.path;
    this.applyTextMateLanguage(language, path);
    if (noLanguageService(path)) return;
    if (isSmart(previous))
      void api()
        .request.lspClose({ path })
        .catch(() => {});
    if (isSmart(language)) {
      void api()
        .request.lspOpen({ path, content: this.getContent(), language })
        .catch(() => {});
    }
  }

  /** HEAD content of a file, for the gutter change indicators (`null` = untracked / no repo). */
  setGitBase(path: string, content: string | null) {
    const base = content === null ? null : Text.of(content.replace(/\r\n/g, "\n").split("\n"));
    this.gitBases.set(path, base);
    if (this.current?.path === path && this.view) {
      this.view.dispatch({ effects: setGitBase.of(getSettings()["editor.gitGutter"] ? base : null) });
    }
  }

  /** Git blame of a document (see git-blame.ts); `null` drops it. */
  setBlame(path: string, blame: GitBlame | null) {
    if (this.current?.path === path && this.view) {
      this.view.dispatch({ effects: setBlame.of(blame) });
      this.emitCursor();
      return;
    }
    const cached = this.cache.get(path);
    if (cached) cached.state = cached.state.update({ effects: setBlame.of(blame) }).state;
  }

  /** Inline diff against `original` (the HEAD version), or `null` to turn it off. */
  showInlineDiff(original: string | null) {
    if (!this.view) return;
    this.view.dispatch({
      effects: diffConf.reconfigure(
        original === null
          ? []
          : unifiedMergeView({
              original: original.replace(/\r\n/g, "\n"),
              mergeControls: false,
              highlightChanges: true,
              syntaxHighlightDeletions: true,
            }),
      ),
    });
  }

  isInlineDiffShown(): boolean {
    if (!this.view) return false;
    const value = diffConf.get(this.view.state);
    return Array.isArray(value) ? value.length > 0 : !!value;
  }

  /** Apply edits to the current document as one undoable change. */
  applyEdits(edits: TextEdit[]) {
    if (!this.view || !edits.length) return;
    const text = this.view.state.doc.toString();
    const changes = edits.map((edit) => ({
      from: offsetOf(text, edit.startLine, edit.startCharacter),
      to: offsetOf(text, edit.endLine, edit.endCharacter),
      insert: edit.newText,
    }));
    const changeSet = this.view.state.changes(changes);
    // A cursor where text is inserted ends up after it, like in VS Code.
    const selection = this.view.state.selection.ranges.every((range) => range.empty) ? this.view.state.selection.map(changeSet, 1) : undefined;
    this.view.dispatch({ changes: changeSet, selection, userEvent: "edit" });
  }

  /**
   * Apply edits to a document the editor holds (current or in a background
   * tab). Returns false when the document is not loaded in the editor.
   */
  applyEditsToDocument(path: string, edits: TextEdit[]): boolean {
    if (this.current?.path === path) {
      this.applyEdits(edits);
      return true;
    }
    const cached = this.cache.get(path);
    if (!cached) return false;
    const text = cached.state.doc.toString();
    const changes = edits.map((edit) => ({
      from: offsetOf(text, edit.startLine, edit.startCharacter),
      to: offsetOf(text, edit.endLine, edit.endCharacter),
      insert: edit.newText,
    }));
    const changeSet = cached.state.changes(changes);
    cached.state = cached.state.update({ changes: changeSet }).state;
    this.setDirty(path, cached.state.doc.toString() !== this.saved.get(path));
    for (const cb of this.localChangeListeners) cb(path, changeSet);
    return true;
  }

  /** Format Document: TS / JS through the language service, JSON natively. */
  async format(): Promise<boolean> {
    if (!this.view || !this.current) return false;
    const { language, path } = this.current;
    const { tabSize, insertSpaces } = indentationFor(path, getSettings());
    // An extension formatter (Prettier, …) wins over the built-in ones.
    if (this.hasExtensionFormatter()) {
      const edits = await extensionService.call("provideFormatting", path, { tabSize, insertSpaces }, null);
      if (edits && this.current?.path === path) {
        this.applyEdits(edits);
        return true;
      }
    }
    if (language === "json") {
      try {
        const text = this.getContent();
        const indent = insertSpaces ? tabSize : "\t";
        const formatted = JSON.stringify(JSON.parse(text), null, indent) + (text.endsWith("\n") ? "\n" : "");
        if (formatted !== text) {
          this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: formatted } });
        }
        return true;
      } catch {
        return false;
      }
    }
    if (!isTsFamily(language) || noLanguageService(path)) return false;
    await this.pushLspChange(this.getContent());
    const { edits } = await api().request.lspFormat({
      path,
      tabSize,
      insertSpaces,
    });
    this.applyEdits(edits);
    return true;
  }

  canFormat(): boolean {
    const language = this.current?.language ?? "";
    return language === "json" || (isTsFamily(language) && !noLanguageService(this.current?.path ?? "")) || this.hasExtensionFormatter();
  }

  private hasExtensionFormatter(): boolean {
    if (!this.current) return false;
    const { path, language } = this.current;
    return (
      extensionService.providersFor("formatting", path, language).length > 0 || extensionService.providersFor("rangeFormatting", path, language).length > 0
    );
  }

  goToDefinition() {
    void this.definitionHandler?.();
  }

  /** Signature help for the cursor: Ctrl+Shift+Space (editor.action.triggerParameterHints). */
  triggerParameterHints() {
    if (!this.view) return;
    void requestSignatureHelp(this.view, () => this.current, null);
  }

  /** Quick fix / code actions at the cursor: Ctrl+. (editor.action.quickFix). */
  quickFix() {
    if (!this.view) return;
    void runQuickFix(this.view, () => this.current);
  }

  goToTypeDefinition() {
    void this.typeDefinitionHandler?.();
  }

  goToImplementation() {
    void this.implementationHandler?.();
  }

  revealDeclaration() {
    void this.declarationHandler?.();
  }

  /** All selections (anchor / head as 0-based line and character). */
  getSelections(): HostSelection[] {
    if (!this.view) return [];
    const doc = this.view.state.doc;
    const at = (offset: number) => {
      const line = doc.lineAt(offset);
      return { line: line.number - 1, character: offset - line.from };
    };
    return this.view.state.selection.ranges.map((range) => {
      const anchor = at(range.anchor);
      const head = at(range.head);
      return { anchorLine: anchor.line, anchorCharacter: anchor.character, activeLine: head.line, activeCharacter: head.character };
    });
  }

  setSelections(selections: HostSelection[]) {
    if (!this.view || !selections.length) return;
    const text = this.view.state.doc.toString();
    const ranges = selections.map((s) =>
      EditorSelection.range(offsetOf(text, s.anchorLine, s.anchorCharacter), offsetOf(text, s.activeLine, s.activeCharacter)),
    );
    this.view.dispatch({ selection: EditorSelection.create(ranges), scrollIntoView: true });
  }

  /** Insert a VS Code snippet at the selections (or the given ranges). */
  insertSnippet(
    body: string,
    ranges: { startLine: number; startCharacter: number; endLine: number; endCharacter: number }[] | null,
    variables: SnippetVariables = {},
  ) {
    const view = this.view;
    if (!view) return false;
    const text = view.state.doc.toString();
    const target = ranges?.[0]
      ? { from: offsetOf(text, ranges[0].startLine, ranges[0].startCharacter), to: offsetOf(text, ranges[0].endLine, ranges[0].endCharacter) }
      : view.state.selection.main;
    const selected = view.state.sliceDoc(target.from, target.to);
    snippet(snippetToTemplate(body, { TM_SELECTED_TEXT: selected, ...this.snippetVariables(), ...variables }))(
      view,
      null as unknown as Completion,
      target.from,
      target.to,
    );
    return true;
  }

  /** TM_* variables for snippets. */
  private snippetVariables(): SnippetVariables {
    const path = this.current?.path ?? "";
    const name = path.split(/[/\\]/).pop() ?? "";
    const line = this.view ? this.view.state.doc.lineAt(this.view.state.selection.main.head) : null;
    return {
      TM_FILENAME: name,
      TM_FILENAME_BASE: name.replace(/\.[^.]+$/, ""),
      TM_DIRECTORY: path.replace(/[/\\][^/\\]*$/, ""),
      TM_FILEPATH: path,
      TM_CURRENT_LINE: line?.text ?? "",
      TM_LINE_INDEX: line ? String(line.number - 1) : "0",
      TM_LINE_NUMBER: line ? String(line.number) : "1",
      TM_CURRENT_WORD: this.wordAtCursor(),
      TM_SELECTED_TEXT: this.selectedText(),
      CLIPBOARD: "",
    };
  }

  run(command: EditorCommand): boolean {
    const view = this.view;
    if (!view) return false;
    switch (command) {
      case "undo":
        return undo(view);
      case "redo":
        return redo(view);
      case "selectAll":
        return selectAll(view);
      case "toggleComment":
        return toggleComment(view);
      case "toggleBlockComment":
        return toggleBlockComment(view);
      case "copyLineUp":
        return copyLineUp(view);
      case "copyLineDown":
        return copyLineDown(view);
      case "moveLineUp":
        return moveLineUp(view);
      case "moveLineDown":
        return moveLineDown(view);
      case "deleteLine":
        return deleteLine(view);
      case "insertLineBelow":
        return insertBlankLine(view);
      case "selectLine":
        return selectLine(view);
      case "expandSelection":
        void expandSelection(view, () => this.current);
        return true;
      case "shrinkSelection":
        shrinkSelection(view);
        return true;
      case "jumpToBracket":
        return cursorMatchingBracket(view);
      case "indent":
        return indentMore(view);
      case "outdent":
        return indentLess(view);
      case "addCursorAbove":
        return addCursorAbove(view);
      case "addCursorBelow":
        return addCursorBelow(view);
      case "addNextOccurrence":
        return selectNextOccurrence(view);
      case "selectAllOccurrences":
        return selectSelectionMatches(view);
      case "foldAll":
        return foldAll(view);
      case "unfoldAll":
        return unfoldAll(view);
      case "fold":
        return foldCode(view);
      case "unfold":
        return unfoldCode(view);
      case "find":
      case "replace":
        openSearchPanel(view);
        if (command === "replace") {
          // Move focus to the replace field of the search panel.
          requestAnimationFrame(() => view.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]")?.focus());
        }
        return true;
      case "nextProblem":
        return nextDiagnostic(view);
      case "previousProblem":
        return previousDiagnostic(view);
      case "upperCase":
        return transformSelections(view, (text) => text.toUpperCase());
      case "lowerCase":
        return transformSelections(view, (text) => text.toLowerCase());
      case "titleCase":
        return transformSelections(view, (text) => text.toLowerCase().replace(/(^|[\s_-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase()));
      case "sortLinesAscending":
        return transformLines(view, (lines) => [...lines].sort((a, b) => a.localeCompare(b)));
      case "sortLinesDescending":
        return transformLines(view, (lines) => [...lines].sort((a, b) => b.localeCompare(a)));
      case "deleteDuplicateLines":
        return transformLines(view, (lines) => [...new Set(lines)]);
      case "trimTrailingWhitespace":
        return transformLines(view, (lines) => lines.map((line) => line.replace(/[ \t]+$/, "")));
      case "joinLines": {
        const range = view.state.selection.main;
        const line = view.state.doc.lineAt(range.from);
        const last = view.state.doc.lineAt(range.to);
        const end = last.number > line.number ? last : view.state.doc.lines > line.number ? view.state.doc.line(line.number + 1) : null;
        if (!end) return false;
        const text = view.state.sliceDoc(line.from, end.to);
        const joined = text.replace(/\s*\n\s*/g, " ");
        view.dispatch({ changes: { from: line.from, to: end.to, insert: joined } });
        return true;
      }
      case "duplicateSelection": {
        const range = view.state.selection.main;
        if (range.empty) return copyLineDown(view);
        const text = view.state.sliceDoc(range.from, range.to);
        view.dispatch({
          changes: { from: range.to, insert: text },
          selection: EditorSelection.range(range.to, range.to + text.length),
        });
        return true;
      }
    }
  }

  /* ── internals ──────────────────────────────────────────────────────── */

  private stash() {
    if (!this.view || !this.current) return;
    this.cache.set(this.current.path, {
      state: this.view.state,
      scroll: this.view.scrollSnapshot(),
      settingsVersion: this.settingsVersion,
    });
  }

  private setDirty(path: string, dirty: boolean) {
    if ((this.dirty.get(path) ?? false) === dirty) {
      this.dirty.set(path, dirty);
      return;
    }
    this.dirty.set(path, dirty);
    for (const cb of this.dirtyListeners) cb(path, dirty);
  }

  private emitCursor() {
    if (!this.view) return;
    const state = this.view.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    let selectedChars = 0;
    for (const range of state.selection.ranges) selectedChars += range.to - range.from;
    const info: CursorInfo = {
      line: line.number,
      column: head - line.from + 1,
      selectedChars,
      selections: state.selection.ranges.length,
      blame: blameAt(state, line.number),
    };
    for (const cb of this.cursorListeners) cb(info);
  }

  private completionExtension(language: string): Extension {
    return [
      autocompletion({
        override: isTsFamily(language) ? [this.lspCompletion, this.extensionCompletion] : undefined,
        activateOnTyping: true,
        maxRenderedOptions: 40,
      }),
      // Other languages keep their own sources; extensions add theirs next to them.
      isTsFamily(language) ? [] : EditorState.languageData.of(() => [{ autocomplete: this.extensionCompletion }]),
      language === "json" ? EditorState.languageData.of(() => [{ autocomplete: this.jsonCompletion }]) : [],
    ];
  }

  /** JSON: completions from the document's schema (contributes.jsonValidation, `$schema`). */
  private jsonCompletion = async (context: CompletionContext): Promise<CompletionResult | null> => {
    const current = this.current;
    if (!current || current.language !== "json" || noLanguageService(current.path)) return null;
    const typed = context.matchBefore(/"?[\w$@./-]*/);
    if (!context.explicit && (!typed || typed.from === typed.to)) return null;
    const line = context.state.doc.lineAt(context.pos);
    let items: CompletionItem[];
    try {
      await this.syncLsp();
      ({ items } = await api().request.lspCompletions({ path: current.path, line: line.number - 1, character: context.pos - line.from }));
    } catch {
      return null;
    }
    if (!items.length || this.current?.path !== current.path) return null;
    const text = context.state.doc.toString();
    // The schema service says which text an item replaces (a property name with its quotes, …).
    const range = items.find((item) => item.range)?.range;
    const from = range ? Math.min(context.pos, offsetOf(text, range.startLine, range.startCharacter)) : (typed?.from ?? context.pos);
    const to = range ? Math.max(context.pos, offsetOf(text, range.endLine, range.endCharacter)) : context.pos;
    return {
      from,
      to,
      options: items.map((item): Completion => ({
        label: item.filterText ?? item.label,
        displayLabel: item.label,
        detail: item.detail,
        type: item.kind,
        apply: item.snippet ? (view, completion, start, end) => snippet(snippetToTemplate(item.insertText))(view, completion, start, end) : item.insertText,
        info: item.documentation
          ? () => {
              const dom = document.createElement("div");
              dom.className = "cm-ext-doc markdown-body";
              dom.innerHTML = renderMarkdown(item.documentation!);
              return dom;
            }
          : undefined,
      })),
    };
  };

  /** Completions from extensions (completion providers and contributed snippets). */
  private extensionCompletion = async (context: CompletionContext): Promise<CompletionResult | null> => {
    const current = this.current;
    if (!current) return null;
    const providers = extensionService.providersFor("completion", current.path, current.language);
    if (!providers.length && !extensionService.hasSnippets(current.language)) return null;
    const before = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos);
    const trigger = providers.some((provider) => provider.triggerCharacters?.includes(before)) ? before : null;
    const word = context.matchBefore(/[\w$-]*/);
    if (!word || (word.from === word.to && !context.explicit && !trigger)) return null;
    const line = context.state.doc.lineAt(context.pos);
    let items: HostCompletionItem[];
    try {
      items = await extensionService.call("provideCompletions", current.path, line.number - 1, context.pos - line.from, trigger);
    } catch {
      return null;
    }
    if (!items.length || this.current?.path !== current.path) return null;
    const variables = this.snippetVariables();
    const text = context.state.doc.toString();
    let from = word.from;
    // A provider's range (on the cursor line) says where the replaced text starts.
    const ranged = items.find((item) => item.range && item.range.startLine === line.number - 1);
    if (ranged?.range) from = Math.min(context.pos, offsetOf(text, ranged.range.startLine, ranged.range.startCharacter));
    return {
      from,
      options: items.map((item): Completion => {
        const apply = item.snippet
          ? (view: EditorView, completion: Completion, start: number, end: number) => {
              snippet(snippetToTemplate(item.insertText, variables))(view, completion, start, end);
              this.afterCompletion(item);
            }
          : item.command || item.additionalTextEdits?.length
            ? (view: EditorView, _completion: Completion, start: number, end: number) => {
                view.dispatch({ changes: { from: start, to: end, insert: item.insertText }, selection: { anchor: start + item.insertText.length } });
                this.afterCompletion(item);
              }
            : item.insertText;
        return {
          // CodeMirror filters on `label`; VS Code on filterText when given.
          label: item.filterText ?? item.label,
          displayLabel: item.label,
          detail: item.detail,
          type: item.kind,
          boost: item.preselect ? 50 : undefined,
          apply,
          info: item.documentation
            ? () => {
                const dom = document.createElement("div");
                dom.className = "cm-ext-doc markdown-body";
                dom.innerHTML = renderMarkdown(item.documentation!);
                return dom;
              }
            : undefined,
        };
      }),
      validFor: /^[\w$-]*$/,
    };
  };

  /** Extra edits and the follow-up command of an accepted completion. */
  private afterCompletion(item: HostCompletionItem) {
    if (item.additionalTextEdits?.length) this.applyEdits(item.additionalTextEdits);
    if (item.command) extensionService.executeCommand(item.command.command, item.command.arguments ?? []);
  }

  private lspCompletion = async (context: CompletionContext): Promise<CompletionResult | null> => {
    if (!this.current || !isTsFamily(this.current.language) || noLanguageService(this.current.path)) return null;
    // Complete the identifier being typed; after "obj." the member list starts empty.
    const word = context.matchBefore(/[\w$]*/);
    const afterDot = context.matchBefore(/\.[\w$]*/) !== null;
    if (!word || (word.from === word.to && !context.explicit && !afterDot)) return null;
    const pos = context.state.doc.lineAt(context.pos);
    try {
      // The language service must see what was just typed (changes are batched).
      await this.syncLsp();
      const { items } = await api().request.lspCompletions({
        path: this.current.path,
        line: pos.number - 1,
        character: context.pos - pos.from,
      });
      if (!items.length) return null;
      return {
        from: word.from,
        options: items.map((item) => ({
          label: item.label,
          detail: item.detail,
          type: item.kind,
          apply: item.insertText || item.label,
          info: item.documentation,
        })),
        validFor: /^[\w$]*$/,
      };
    } catch {
      return null;
    }
  };

  private buildExtensions(language: string, path?: string): Extension[] {
    const self = this;

    const hover = hoverTooltip(async (view, pos) => {
      const current = self.current;
      if (!current) return null;
      const line = view.state.doc.lineAt(pos);
      const position = { line: line.number - 1, character: pos - line.from };
      const builtIn =
        isTsFamily(current.language) && !noLanguageService(current.path)
          ? api()
              .request.lspHover({ path: current.path, ...position })
              .then((result) => result.hover?.contents ?? null)
              .catch(() => null)
          : Promise.resolve(null);
      // JSON hovers (schema descriptions) are Markdown.
      const fromSchema =
        current.language === "json" && !noLanguageService(current.path)
          ? self
              .syncLsp()
              .then(() => api().request.lspHover({ path: current.path, ...position }))
              .then((result) => (result.hover?.contents ? [result.hover.contents] : []))
              .catch(() => [] as string[])
          : Promise.resolve([] as string[]);
      const fromExtensions = extensionService.providersFor("hover", current.path, current.language).length
        ? extensionService
            .call("provideHover", current.path, position.line, position.character)
            .then((result) => result?.contents ?? [])
            .catch(() => [])
        : Promise.resolve([] as string[]);
      const [text, extensionMarkdown, schemaMarkdown] = await Promise.all([builtIn, fromExtensions, fromSchema]);
      const markdown = [...schemaMarkdown, ...extensionMarkdown];
      if (!text && !markdown.length) return null;
      return {
        pos,
        above: true,
        create() {
          const dom = document.createElement("div");
          if (text) {
            const plain = document.createElement("div");
            plain.textContent = text;
            dom.appendChild(plain);
          }
          for (const part of markdown) {
            const section = document.createElement("div");
            section.className = "cm-ext-hover markdown-body";
            section.innerHTML = renderMarkdown(part);
            dom.appendChild(section);
          }
          return { dom };
        },
      };
    });

    const goToDefinition = async () => {
      const current = self.current;
      if (!self.view || !current) return;
      const { line, character } = self.getCursor();
      if (isTsFamily(current.language) && !noLanguageService(current.path)) {
        try {
          await self.syncLsp();
          const { location } = await api().request.lspDefinition({ path: current.path, line, character });
          if (location) {
            for (const cb of self.openListeners) cb(location);
            return;
          }
        } catch {
          /* try the extensions */
        }
      }
      if (!extensionService.providersFor("definition", current.path, current.language).length) return;
      try {
        const [location] = await extensionService.call("provideDefinition", current.path, line, character);
        if (location)
          for (const cb of self.openListeners) cb({ path: extensionService.viewPath(location.path), line: location.line, character: location.character });
      } catch {
        /* ignore */
      }
    };
    this.definitionHandler = goToDefinition;

    /** Jump to the first location an extension provider of the kind returns. */
    const goToProviderLocation =
      (kind: "typeDefinition" | "implementation" | "declaration", method: "provideTypeDefinition" | "provideImplementation" | "provideDeclaration") =>
      async () => {
        const current = self.current;
        if (!self.view || !current) return;
        const { line, character } = self.getCursor();
        if (!extensionService.providersFor(kind, current.path, current.language).length) return;
        try {
          const [location] = await extensionService.call(method, current.path, line, character);
          if (location)
            for (const cb of self.openListeners) cb({ path: extensionService.viewPath(location.path), line: location.line, character: location.character });
        } catch {
          /* ignore */
        }
      };
    this.typeDefinitionHandler = goToProviderLocation("typeDefinition", "provideTypeDefinition");
    this.implementationHandler = goToProviderLocation("implementation", "provideImplementation");
    this.declarationHandler = goToProviderLocation("declaration", "provideDeclaration");

    /** Diagnostics extensions reported for the current document (shown next to the language service's). */
    const extensionDiagnostics = (view: EditorView, path: string) =>
      (extensionService.getSnapshot().diagnostics.get(extensionService.viewPath(path)) ?? []).map((d) => toCmDiagnostic(d, view));

    const diagLinter = linter(
      async (view) => {
        const current = self.current;
        if (!current || !isSmart(current.language) || noLanguageService(current.path)) {
          if (current) for (const cb of self.diagnosticListeners) cb(current.path, []);
          return current ? extensionDiagnostics(view, current.path) : [];
        }
        try {
          await api().request.lspChange({ path: current.path, content: view.state.doc.toString() });
          const { diagnostics } = await api().request.lspDiagnostics({ path: current.path });
          if (self.current?.path !== current.path) return [];
          for (const cb of self.diagnosticListeners) cb(current.path, diagnostics);
          return [...diagnostics.map((d) => toCmDiagnostic(d, view)), ...extensionDiagnostics(view, current.path)];
        } catch (e) {
          console.error("diagnostics failed", e);
          return extensionDiagnostics(view, current.path);
        }
      },
      { delay: 350 },
    );

    return [
      phrasesExtension(),
      // Before the line numbers: the breakpoint gutter sits at the far left.
      debugEditorExtension(() => self.current?.path ?? null),
      settingsConf.of(settingsExtensions(getSettings(), path)),
      gitGutter,
      gitBlameExtension,
      foldGutter(),
      foldingExtension(() => self.current),
      dropCursor(),
      history(),
      indentOnInput(),
      bracketMatching(),
      rectangularSelection(),
      crosshairCursor(),
      highlightSelectionMatches(),
      completionConf.of(this.completionExtension(language)),
      hover,
      codeLensExtension(() => self.current),
      codeActionsExtension(() => self.current),
      signatureHelpExtension(() => self.current),
      linkedEditingExtension(() => self.current),
      onTypeFormattingExtension(() => self.current),
      inlineCompletionExtension(() => self.current),
      documentLinksExtension(
        () => self.current,
        (target) => {
          for (const cb of self.openListeners) cb(target);
        },
      ),
      colorProviderExtension(() => self.current),
      languageConf.of(languageExtension(language)),
      languageConfigConf.of(languageConfigExtensions(extensionService.languageConfiguration(language))),
      themeConf.of(themeExtensions()),
      diffConf.of([]),
      readOnlyConf.of(readOnlyExtensions(false)),
      diagLinter,
      extensionDecorationsField,
      extensionHighlightsField,
      ...(path ? featureEditorExtensions(path, language) : []),
      inlayHintsExtension(() => self.current),
      semanticTokensExtension(() => self.current),
      EditorView.updateListener.of((update) => {
        const current = self.current;
        if (!current) return;
        if (update.docChanged) {
          const content = update.state.doc.toString();
          self.setDirty(current.path, content !== self.saved.get(current.path));
          if (!update.transactions.some((tr) => tr.annotation(remoteChange))) {
            for (const cb of self.localChangeListeners) cb(current.path, update.changes);
          }
          for (const cb of self.contentListeners) cb(current.path);
          if (self.changeTimer) clearTimeout(self.changeTimer);
          self.changeTimer = setTimeout(() => void self.pushLspChange(content), 200);
          // An edit invalidates the highlights before the cursor settles again.
          if (self.highlightTimer) clearTimeout(self.highlightTimer);
          self.highlightTimer = null;
        }
        if (update.selectionSet || update.docChanged) self.emitCursor();
        if (update.selectionSet && !update.docChanged) self.scheduleExtensionHighlights();
      }),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
        indentWithTab,
        { key: "Mod-h", run: (view) => (openSearchPanel(view), true) },
        { key: "F12", run: () => (void goToDefinition(), true) },
        { key: "Mod-.", run: (view) => (void runQuickFix(view, () => self.current), true) },
      ]),
    ];
  }

  /** Send the current document to the language service right away. */
  async syncLsp() {
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
      this.changeTimer = null;
    }
    await this.pushLspChange(this.getContent());
  }

  private async pushLspChange(content: string) {
    if (!this.current || !isSmart(this.current.language) || noLanguageService(this.current.path)) return;
    try {
      await api().request.lspChange({ path: this.current.path, content });
    } catch {
      /* ignore */
    }
  }
}

function toCmDiagnostic(d: Diagnostic, view: EditorView): CMDiagnostic {
  const doc = view.state.doc;
  const startLine = doc.line(Math.min(Math.max(1, d.startLine + 1), doc.lines));
  const endLine = doc.line(Math.min(Math.max(1, d.endLine + 1), doc.lines));
  const from = Math.min(startLine.from + Math.max(0, d.startCharacter), startLine.to);
  let to = Math.min(endLine.from + Math.max(0, d.endCharacter), endLine.to);
  if (to <= from) to = Math.min(from + 1, doc.length);
  return {
    from,
    to,
    severity: d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "info",
    message: d.message + (d.code != null ? ` (${d.source ?? "ts"} ${d.code})` : ""),
    source: d.source,
  };
}

export { applyTextEdits };
