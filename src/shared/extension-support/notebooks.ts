import type { AreaSupport } from "./types.ts";

/** Support table changes of the "notebooks" area. */
export const notebooksSupport: AreaSupport = {
  api: {
    "notebooks.*": null,
    "notebooks.createNotebookController": ["partial", "execution, interrupt, affinity, selection and the proposed variableProvider (Notebook Variables panel) work; rendererScripts are ignored (no renderer runs)"],
    "notebooks.createRendererMessaging": ["partial", "accepted; outputs are rendered natively, so no renderer ever receives or sends messages (postMessage resolves false)"],
    "notebooks.registerNotebookCellStatusBarItemProvider": "supported",
    "workspace.notebookDocuments": "supported",
    "workspace.openNotebookDocument": ["partial", "files open through their serializer; untitled notebooks live in memory (they cannot be shown, Save asks for a file)"],
    "workspace.registerNotebookSerializer": ["supported", "a built-in .ipynb serializer is the fallback for jupyter-notebook"],
    "workspace.onDidOpenNotebookDocument": "supported",
    "workspace.onDidCloseNotebookDocument": "supported",
    "workspace.onDidChangeNotebookDocument": "supported",
    "workspace.onWillSaveNotebookDocument": "supported",
    "workspace.onDidSaveNotebookDocument": "supported",
    "workspace.applyEdit": ["supported", "applied in order; notebook edits and cell text edits apply to the notebook (opened when needed)"],
    "window.activeNotebookEditor": "supported",
    "window.visibleNotebookEditors": "supported",
    "window.showNotebookDocument": ["partial", "opens the notebook editor in the given view column (or Beside) with preserveFocus; not for untitled notebooks"],
    "window.onDidChangeActiveNotebookEditor": "supported",
    "window.onDidChangeVisibleNotebookEditors": "supported",
    "window.onDidChangeNotebookEditorSelection": "supported",
    "window.onDidChangeNotebookEditorVisibleRanges": "supported",
  },
  types: ["NotebookCellKind", "NotebookControllerAffinity", "NotebookRange", "NotebookCellData", "NotebookData", "NotebookCellOutputItem", "NotebookCellOutput", "NotebookEdit", "TabInputNotebook", "NotebookEditorRevealType", "NotebookCellStatusBarAlignment", "NotebookCellStatusBarItem", "TabInputNotebookDiff", "TabInputInteractiveWindow", "NotebookVariablesRequestKind"],
  contributions: {
    notebooks: ["supported", "type and filenamePattern selector choose the serializer; priority \"option\" files open as text (Open in Notebook Editor switches)"],
    notebookRenderer: ["partial", "ignored; renderer scripts never run, outputs are rendered natively (text, HTML, Markdown, images, JSON, errors)"],
  },
};
