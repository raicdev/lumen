import type { ViewFeature } from "./types";
import { languagesExtraEditorExtensions, pasteAs } from "./languages-extra/editor";
import { HIERARCHY_TAB, HierarchyPanel, clearHierarchy, showHierarchy } from "./languages-extra/hierarchy";
import { getLastEditor, inlineValuesChanged, providersChanged } from "./languages-extra/shared";
import { featureApi } from "./registry";

/**
 * Window side of the "languages-extra" area: the call / type hierarchy panel,
 * and (editor.ts) inline values, debug hover and document drop / paste edits.
 * Its styles go to feature-languages-extra.css (imported by index.css); the
 * host side is src/main/exthost/features/languages-extra.ts.
 */

const api = () => featureApi("languages-extra");

export const languagesExtraView: ViewFeature = {
  area: "languages-extra",

  onHostMessage(payload) {
    const message = payload as { type?: string };
    if (message.type === "changed") providersChanged();
    else if (message.type === "inlineValuesChanged") inlineValuesChanged();
  },

  onHostReady() {
    // A restarted host forgot its providers and handles.
    providersChanged();
    clearHierarchy(api());
  },

  commands: [
    { id: "references-view.showCallHierarchy", title: "Show Call Hierarchy", category: "References", run: (feature) => showHierarchy("call", feature) },
    { id: "references-view.showTypeHierarchy", title: "Show Type Hierarchy", category: "References", run: (feature) => showHierarchy("type", feature) },
    { id: "references-view.clearHierarchy", title: "Clear Hierarchy", category: "References", run: (feature) => clearHierarchy(feature) },
    {
      id: "editor.action.pasteAs",
      title: "Paste As…",
      category: "Edit",
      run: async (feature) => {
        const editor = getLastEditor();
        if (editor) await pasteAs(feature, editor.view, editor.path);
      },
    },
  ],

  panelTabs: [{ id: HIERARCHY_TAB, title: "Hierarchy", render: () => <HierarchyPanel api={api()} /> }],

  editorExtensions: (path, languageId, feature) => languagesExtraEditorExtensions(path, languageId, feature),
};
