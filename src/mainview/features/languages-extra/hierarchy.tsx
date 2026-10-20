import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import type { HierarchyDirection, HierarchyKind, WireHierarchyItem, WireHierarchyNode } from "../../../shared/languages-extra";
import type { TextRange } from "../../../shared/types";
import { basename } from "../../lib/paths";
import { createStore, useStore } from "../store";
import type { ViewFeatureApi } from "../types";
import { getLastEditor } from "./shared";

/** The call / type hierarchy panel of the "languages-extra" area. */

export const HIERARCHY_TAB = "languages-extra.hierarchy";

type Node = {
  key: string;
  item: WireHierarchyItem;
  /** Where the parent calls this item (call hierarchy). */
  fromRanges: TextRange[];
  children: Node[] | null;
  expanded: boolean;
  loading: boolean;
  error?: string;
};

type State = { kind: HierarchyKind; direction: HierarchyDirection; roots: Node[]; message: string };

const DIRECTIONS: Record<HierarchyKind, { first: HierarchyDirection; second: HierarchyDirection }> = {
  call: { first: "incoming", second: "outgoing" },
  type: { first: "supertypes", second: "subtypes" },
};

const DIRECTION_LABEL: Record<HierarchyDirection, string> = { incoming: "Callers", outgoing: "Callees", supertypes: "Supertypes", subtypes: "Subtypes" };

/** The symbol kinds of vscode.SymbolKind, as a short label. */
const KIND_LABEL = ["F", "M", "N", "P", "C", "m", "p", "f", "c", "E", "I", "ƒ", "v", "K", "s", "n", "b", "[]", "{}", "e", "ev", "o", "T"];

let seq = 0;
const store = createStore<State>({ kind: "call", direction: "incoming", roots: [], message: "No hierarchy to show. Run Show Call Hierarchy or Show Type Hierarchy in an editor." });

const makeNode = (item: WireHierarchyItem, fromRanges: TextRange[] = []): Node => ({ key: `n${++seq}`, item, fromRanges, children: null, expanded: false, loading: false });

/** Replace a node anywhere in the tree (immutably). */
function update(nodes: Node[], key: string, change: (node: Node) => Node): Node[] {
  return nodes.map((node) => (node.key === key ? change(node) : node.children ? { ...node, children: update(node.children, key, change) } : node));
}

async function load(api: ViewFeatureApi, node: Node): Promise<void> {
  const { direction } = store.get();
  store.set((state) => ({ ...state, roots: update(state.roots, node.key, (n) => ({ ...n, loading: true, expanded: true, error: undefined })) }));
  try {
    const children = await api.requestHost<WireHierarchyNode[]>("children", [direction, node.item.handle]);
    store.set((state) => ({
      ...state,
      // The user switched direction while loading: drop the answer.
      roots: state.direction === direction ? update(state.roots, node.key, (n) => ({ ...n, loading: false, children: children.map((child) => makeNode(child.item, child.fromRanges)) })) : state.roots,
    }));
  } catch (error) {
    store.set((state) => ({ ...state, roots: update(state.roots, node.key, (n) => ({ ...n, loading: false, children: [], error: error instanceof Error ? error.message : String(error) })) }));
  }
}

function setRoots(kind: HierarchyKind, direction: HierarchyDirection, items: WireHierarchyItem[], api: ViewFeatureApi): void {
  const roots = items.map((item) => makeNode(item));
  store.set({ kind, direction, roots, message: "" });
  api.revealPanelTab(HIERARCHY_TAB);
  api.refresh();
  // The root of the hierarchy is open from the start.
  for (const root of roots) void load(api, root);
}

/** Show Call Hierarchy / Show Type Hierarchy for the symbol at the cursor of the last editor. */
export async function showHierarchy(kind: HierarchyKind, api: ViewFeatureApi): Promise<void> {
  const editor = getLastEditor();
  if (!editor) return void api.showMessage("info", "Open a file and place the cursor on a symbol first.");
  const head = editor.view.state.selection.main.head;
  const line = editor.view.state.doc.lineAt(head);
  const label = kind === "call" ? "call hierarchy" : "type hierarchy";
  let items: WireHierarchyItem[];
  try {
    items = await api.requestHost<WireHierarchyItem[]>("prepare", [kind, editor.path, line.number - 1, head - line.from]);
  } catch (error) {
    return void api.showMessage("error", `Cannot show the ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!items.length) {
    store.set({ kind, direction: DIRECTIONS[kind].first, roots: [], message: `No ${label} is available for the symbol at the cursor.` });
    api.revealPanelTab(HIERARCHY_TAB);
    return void api.showMessage("info", `No ${label} is available for the symbol at the cursor.`);
  }
  let chosen = items;
  if (items.length > 1) {
    const picked = await api.showQuickPick(items.map((item) => ({ label: item.name, description: item.detail, detail: basename(item.path) })), { title: `Show ${kind === "call" ? "Call" : "Type"} Hierarchy`, placeholder: "Select a symbol" });
    if (!picked?.length) return;
    chosen = picked.map((index) => items[index]!);
  }
  setRoots(kind, DIRECTIONS[kind].first, chosen, api);
}

export function clearHierarchy(api: ViewFeatureApi): void {
  store.set((state) => ({ ...state, roots: [], message: "No hierarchy to show. Run Show Call Hierarchy or Show Type Hierarchy in an editor." }));
  api.refresh();
}

/** The same roots, asked in the other direction (callers / callees, supertypes / subtypes). */
function switchDirection(api: ViewFeatureApi, direction: HierarchyDirection): void {
  const state = store.get();
  if (direction === state.direction) return;
  const roots = state.roots.map((node) => makeNode(node.item));
  store.set({ ...state, direction, roots });
  for (const root of roots) void load(api, root);
}

function open(api: ViewFeatureApi, node: Node, parent: Node | null): void {
  // Calls open where the parent calls the item; everything else at the symbol.
  const target = store.get().kind === "call" && parent && node.fromRanges[0] ? { path: parent.item.path, range: node.fromRanges[0] } : { path: node.item.path, range: node.item.selectionRange };
  void api.openFile(target.path, { line: target.range.startLine, character: target.range.startCharacter, preview: true, focus: true });
}

function Row({ node, parent, depth, api }: { node: Node; parent: Node | null; depth: number; api: ViewFeatureApi }): ReactNode {
  const hasChildren = node.children === null || node.children.length > 0;
  const toggle = () => {
    if (node.children === null) void load(api, node);
    else store.set((state) => ({ ...state, roots: update(state.roots, node.key, (n) => ({ ...n, expanded: !n.expanded })) }));
  };
  return (
    <>
      <div className="lx-row" style={{ paddingLeft: 8 + depth * 14 }} role="treeitem" aria-expanded={hasChildren ? node.expanded : undefined} onDoubleClick={toggle}>
        <button type="button" className="lx-twisty" onClick={toggle} disabled={!hasChildren} aria-label={node.expanded ? "Collapse" : "Expand"}>
          {hasChildren ? node.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
        </button>
        <button type="button" className="lx-label" onClick={() => open(api, node, parent)} title={`${node.item.path}:${node.item.selectionRange.startLine + 1}`}>
          <span className="lx-kind" aria-hidden>
            {KIND_LABEL[node.item.kind] ?? "?"}
          </span>
          <span className={`lx-name${node.item.tags?.includes(1) ? " lx-deprecated" : ""}`}>{node.item.name}</span>
          {node.item.detail ? <span className="lx-detail">{node.item.detail}</span> : null}
          <span className="lx-file">{basename(node.item.path)}</span>
        </button>
      </div>
      {node.expanded && node.loading ? (
        <div className="lx-note" style={{ paddingLeft: 30 + depth * 14 }}>
          Loading...
        </div>
      ) : null}
      {node.expanded && node.error ? (
        <div className="lx-note lx-error" style={{ paddingLeft: 30 + depth * 14 }}>
          {node.error}
        </div>
      ) : null}
      {node.expanded && node.children?.length === 0 && !node.loading && !node.error ? (
        <div className="lx-note" style={{ paddingLeft: 30 + depth * 14 }}>
          {store.get().kind === "call" ? "No calls found." : "No types found."}
        </div>
      ) : null}
      {node.expanded ? node.children?.map((child) => <Row key={child.key} node={child} parent={node} depth={depth + 1} api={api} />) : null}
    </>
  );
}

export function HierarchyPanel({ api }: { api: ViewFeatureApi }): ReactNode {
  const state = useStore(store);
  const { first, second } = DIRECTIONS[state.kind];
  return (
    <div className="lx-hierarchy">
      <div className="lx-toolbar">
        <span className="lx-title">{state.kind === "call" ? "Call Hierarchy" : "Type Hierarchy"}</span>
        {state.roots.length ? (
          <>
            {[first, second].map((direction) => (
              <button key={direction} type="button" className={`lx-toggle${state.direction === direction ? " active" : ""}`} onClick={() => switchDirection(api, direction)}>
                {DIRECTION_LABEL[direction]}
              </button>
            ))}
            <button type="button" className="lx-clear" onClick={() => clearHierarchy(api)} title="Clear" aria-label="Clear">
              <X size={14} />
            </button>
          </>
        ) : null}
      </div>
      {state.roots.length ? (
        <div className="lx-tree" role="tree">
          {state.roots.map((node) => (
            <Row key={node.key} node={node} parent={null} depth={0} api={api} />
          ))}
        </div>
      ) : (
        <div className="panel-empty">{state.message}</div>
      )}
    </div>
  );
}
