import { useEffect, useLayoutEffect, useRef } from "react";
import { EditorController, type EditorDocument } from "../lib/editor";

type Props = {
  /** Called once the editor is mounted. */
  onReady: (editor: EditorController) => void;
  /** Called when the editor goes away (its group was closed). */
  onDispose?: (editor: EditorController) => void;
  hidden?: boolean;
};

/** One CodeMirror view (an editor group's editor); created once per mount. */
export function CodeMirrorEditor({ onReady, onDispose, hidden }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onReady, onDispose });
  useLayoutEffect(() => {
    callbacks.current = { onReady, onDispose };
  });

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = new EditorController();
    editor.mount(hostRef.current);
    callbacks.current.onReady(editor);
    return () => {
      callbacks.current.onDispose?.(editor);
      editor.dispose();
    };
  }, []);

  return <div ref={hostRef} className="editor-root" hidden={hidden} />;
}

export type { EditorDocument };
