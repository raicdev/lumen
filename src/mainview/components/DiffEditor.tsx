import { useEffect, useRef, useState } from "react";
import type { ChangeSet } from "@codemirror/state";
import { EditorSelection } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { MergeView, goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { ChevronDown, ChevronUp } from "lucide-react";
import { diffEditorExtensions } from "../lib/editor";
import { offsetOf } from "../lib/text-edits";
import type { TextRange } from "../../shared/types";

export type DiffContent = { content: string; language: string; readOnly?: boolean } | { error: string };

type Props = {
  original: string;
  modified: string;
  /** The modified side's language and whether it may be edited. */
  language: string;
  readOnly: boolean;
  initialSelection?: TextRange;
  /** Read a document from disk or from an extension's content / file system provider. */
  load: (path: string) => Promise<DiffContent>;
  /** An edit of the modified side. */
  onEdit: (path: string, content: string, changes: ChangeSet) => void;
  onFocus?: () => void;
  autoFocus?: boolean;
};

/** A side-by-side diff: the original is read-only, the modified side can be edited and saved. */
export function DiffEditor({ original, modified, language, readOnly, initialSelection, load, onEdit, onFocus, autoFocus }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mergeRef = useRef<MergeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const callbacks = useRef({ onEdit, onFocus, load });
  callbacks.current = { onEdit, onFocus, load };

  useEffect(() => {
    let disposed = false;
    setError(null);
    void (async () => {
      const [left, right] = await Promise.all([callbacks.current.load(original), callbacks.current.load(modified)]);
      if (disposed || !hostRef.current) return;
      if ("error" in left) return setError(left.error);
      if ("error" in right) return setError(right.error);

      const merge = new MergeView({
        a: { doc: left.content.replace(/\r\n/g, "\n"), extensions: diffEditorExtensions(left.language, true) },
        b: {
          doc: right.content.replace(/\r\n/g, "\n"),
          extensions: [
            ...diffEditorExtensions(language || right.language, readOnly || !!right.readOnly),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) callbacks.current.onEdit(modified, update.state.doc.toString(), update.changes);
            }),
            EditorView.domEventHandlers({ focus: () => (callbacks.current.onFocus?.(), false) }),
            keymap.of([
              { key: "F7", run: goToNextChunk },
              { key: "Shift-F7", run: goToPreviousChunk },
              { key: "Alt-ArrowDown", run: goToNextChunk },
              { key: "Alt-ArrowUp", run: goToPreviousChunk },
            ]),
          ],
        },
        parent: hostRef.current,
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: { margin: 3, minSize: 4 },
      });
      merge.dom.style.height = "100%";
      merge.dom.style.overflow = "auto";
      mergeRef.current = merge;
      if (initialSelection) {
        const text = merge.b.state.doc.toString();
        const from = offsetOf(text, Math.max(0, initialSelection.startLine), Math.max(0, initialSelection.startCharacter));
        const to = offsetOf(text, Math.max(0, initialSelection.endLine), Math.max(0, initialSelection.endCharacter));
        merge.b.dispatch({ selection: EditorSelection.single(from, to), effects: EditorView.scrollIntoView(from, { y: "center" }) });
      }
      if (autoFocus) merge.b.focus();
    })();
    return () => {
      disposed = true;
      mergeRef.current?.destroy();
      mergeRef.current = null;
    };
  }, [original, modified, language, readOnly, initialSelection, autoFocus]);

  const go = (command: typeof goToNextChunk) => {
    const merge = mergeRef.current;
    if (!merge) return;
    command(merge.b);
    merge.b.focus();
  };

  return (
    <div className="editor-diff">
      <div className="editor-diff-toolbar">
        <span className="editor-diff-title" title={modified}>
          {readOnly ? "Read-only comparison" : "Editable comparison"}
        </span>
        <span className="editor-diff-spacer" />
        <button type="button" title="Previous change (Shift+F7)" onClick={() => go(goToPreviousChunk)}>
          <ChevronUp size={14} />
        </button>
        <button type="button" title="Next change (F7)" onClick={() => go(goToNextChunk)}>
          <ChevronDown size={14} />
        </button>
      </div>
      {error ? <div className="editor-diff-error">{error}</div> : <div ref={hostRef} className="editor-diff-views" />}
    </div>
  );
}
