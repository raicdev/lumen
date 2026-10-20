import { useEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { isDarkTheme, onColorThemeChange, themeHighlighter } from "../../lib/theme";

/** A CodeMirror editor for one notebook cell. */

const external = Annotation.define<boolean>();

function languageExtension(language: string): Extension {
  switch (language) {
    case "typescript":
      return javascript({ typescript: true, jsx: true });
    case "javascript":
      return javascript({ jsx: true });
    case "json":
    case "jsonc":
      return json();
    case "html":
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
    default:
      return [];
  }
}

const chrome = {
  "&": { backgroundColor: "transparent", color: "var(--vscode-editor-foreground)", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.5" },
  ".cm-content": { caretColor: "var(--vscode-editorCursor-foreground)", padding: "6px 0" },
  ".cm-cursor": { borderLeftColor: "var(--vscode-editorCursor-foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--vscode-editor-selectionBackground)" },
  ".cm-placeholder": { color: "var(--text-muted)" },
};
const chromeThemes = { dark: EditorView.theme(chrome, { dark: true }), light: EditorView.theme(chrome, { dark: false }) };
const themeExtensions = (): Extension[] => [chromeThemes[isDarkTheme() ? "dark" : "light"], syntaxHighlighting(themeHighlighter())];

type Props = {
  value: string;
  /** Changes when the host replaced the text (an extension edited the cell). */
  rev: number;
  languageId: string;
  placeholderText?: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  /** Shift+Enter (advance), Ctrl+Enter (stay) or Alt+Enter (insert below). */
  onRun: (mode: "advance" | "stay" | "insert") => void;
  onFocus: () => void;
  /** Escape. */
  onEscape: () => void;
  /** ArrowUp on the first line / ArrowDown on the last one: move to the neighbour cell. */
  onNavigate: (direction: -1 | 1) => void;
};

export function CellEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const language = useRef(new Compartment());
  const theme = useRef(new Compartment());
  const first = useRef(true);

  useEffect(() => {
    if (!host.current) return;
    const run = (mode: "advance" | "stay" | "insert") => () => {
      latest.current.onRun(mode);
      return true;
    };
    const navigate = (direction: -1 | 1) => (editor: EditorView) => {
      const { main } = editor.state.selection;
      const line = editor.state.doc.lineAt(main.head);
      const edge = direction < 0 ? line.number === 1 : line.number === editor.state.doc.lines;
      if (!main.empty || !edge) return false;
      latest.current.onNavigate(direction);
      return true;
    };
    const state = EditorState.create({
      doc: latest.current.value,
      extensions: [
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        EditorState.tabSize.of(4),
        EditorView.lineWrapping,
        placeholder(latest.current.placeholderText ?? ""),
        keymap.of([
          { key: "Shift-Enter", run: run("advance") },
          { key: "Ctrl-Enter", run: run("stay") },
          { key: "Alt-Enter", run: run("insert") },
          {
            key: "Escape",
            run: () => {
              latest.current.onEscape();
              return true;
            },
          },
          { key: "ArrowUp", run: navigate(-1) },
          { key: "ArrowDown", run: navigate(1) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        language.current.of(languageExtension(latest.current.languageId)),
        theme.current.of(themeExtensions()),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(external))) latest.current.onChange(update.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          focus: () => {
            latest.current.onFocus();
          },
        }),
      ],
    });
    const editor = new EditorView({ state, parent: host.current });
    view.current = editor;
    if (latest.current.autoFocus) editor.focus();
    const stopTheme = onColorThemeChange(() => editor.dispatch({ effects: theme.current.reconfigure(themeExtensions()) }));
    return () => {
      stopTheme();
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: language.current.reconfigure(languageExtension(props.languageId)) });
  }, [props.languageId]);

  // The host replaced the text.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== latest.current.value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: latest.current.value }, annotations: external.of(true) });
    }
  }, [props.rev]);

  return <div className="nb-cell-editor" ref={host} />;
}
