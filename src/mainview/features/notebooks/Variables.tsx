import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { NbVariableWire } from "../../../shared/notebooks";
import { basename } from "../../lib/paths";
import { refArg, showContributedMenu } from "../menus-walkthroughs/menus";
import { useStore } from "../store";
import type { ViewFeatureApi } from "../types";
import { activePath, call, docs, variablesVersion } from "./state";

/**
 * The Notebook Variables panel: the variables of the active notebook's kernel
 * (the controller's proposed `variableProvider`), expandable by name and by
 * index (in pages of 100), with the extensions' notebook/variables/context menu.
 */

const PAGE = 100;

type Node = { kind: "variable"; variable: NbVariableWire } | { kind: "range"; parent: string; start: number; end: number };

function variableLookup(path: string, variable: NbVariableWire): (key: string) => unknown {
  const doc = docs.get()[path];
  return (key) => {
    switch (key) {
      case "notebookKernel":
        return doc?.controller?.id;
      case "notebookType":
        return doc?.notebookType;
      case "notebookVariableLanguage":
        return variable.language;
      case "notebookVariableType":
        return variable.type;
      default:
        return undefined;
    }
  };
}

/** The children of a variable: its named ones, then its indexed ones (directly, or as ranges of 100). */
async function childrenOf(api: ViewFeatureApi, path: string, variable: NbVariableWire): Promise<Node[]> {
  const named = variable.hasNamedChildren ? await call<NbVariableWire[]>(api, path, "variables", variable.handle, 1, 0) : [];
  const nodes: Node[] = (named ?? []).map((child) => ({ kind: "variable", variable: child }));
  const count = variable.indexedChildrenCount;
  if (count > PAGE) {
    for (let start = 0; start < count; start += PAGE) nodes.push({ kind: "range", parent: variable.handle, start, end: Math.min(count, start + PAGE) - 1 });
  } else if (count > 0) {
    const indexed = await call<NbVariableWire[]>(api, path, "variables", variable.handle, 2, 0);
    nodes.push(...(indexed ?? []).map((child): Node => ({ kind: "variable", variable: child })));
  }
  return nodes;
}

function VariableRow({ api, path, node, depth, version }: { api: ViewFeatureApi; path: string; node: Node; depth: number; version: number }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<Node[] | null>(null);
  const expandable = node.kind === "range" || node.variable.hasNamedChildren || node.variable.indexedChildrenCount > 0;

  useEffect(() => {
    if (!open || !expandable) return;
    let cancelled = false;
    const load =
      node.kind === "range"
        ? call<NbVariableWire[]>(api, path, "variables", node.parent, 2, node.start).then((list) => (list ?? []).map((variable): Node => ({ kind: "variable", variable })))
        : childrenOf(api, path, node.variable);
    load.then(
      (nodes) => !cancelled && setChildren(nodes),
      () => !cancelled && setChildren([]),
    );
    return () => {
      cancelled = true;
    };
  }, [open, expandable, api, path, node, version]);

  const label = node.kind === "range" ? `[${node.start} … ${node.end}]` : node.variable.name;
  return (
    <>
      <div
        className="nbv-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        title={node.kind === "variable" ? [node.variable.type, node.variable.value].filter(Boolean).join(": ") : undefined}
        onClick={() => expandable && setOpen((value) => !value)}
        onContextMenu={(e) => {
          if (node.kind !== "variable") return;
          showContributedMenu(e, "notebook/variables/context", variableLookup(path, node.variable), [refArg("notebooks", { path, variable: node.variable.handle })]);
        }}
      >
        <ChevronRight size={14} className={`nbv-chevron${open ? " open" : ""}${expandable ? "" : " hidden"}`} />
        <span className="nbv-name">{label}</span>
        {node.kind === "variable" && <span className="nbv-value">{node.variable.value}</span>}
        {node.kind === "variable" && node.variable.type && <span className="nbv-type">{node.variable.type}</span>}
      </div>
      {open && children?.map((child, index) => <VariableRow key={child.kind === "variable" ? child.variable.handle : `r${child.start}`} api={api} path={path} node={child} depth={depth + 1} version={version} />)}
      {open && children?.length === 0 && <div className="nbv-row nbv-empty" style={{ paddingLeft: 22 + depth * 14 }}>No children</div>}
    </>
  );
}

export function NotebookVariablesPanel({ api }: { api: ViewFeatureApi }) {
  const path = useStore(activePath);
  const doc = useStore(docs)[path ?? ""];
  const version = useStore(variablesVersion)[path ?? ""] ?? 0;
  const [variables, setVariables] = useState<NbVariableWire[] | null>(null);
  const kernel = doc?.controller?.id;

  useEffect(() => {
    if (!path || !kernel) {
      setVariables(null);
      return;
    }
    let cancelled = false;
    call<NbVariableWire[]>(api, path, "variables", undefined, 1, 0).then(
      (list) => !cancelled && setVariables(list ?? []),
      () => !cancelled && setVariables([]),
    );
    return () => {
      cancelled = true;
    };
  }, [api, path, kernel, version]);

  if (!path || !doc) return <div className="nbv-panel nbv-placeholder">Open a notebook to see its variables.</div>;
  if (!kernel) return <div className="nbv-panel nbv-placeholder">Select a kernel for {basename(path)} to see its variables.</div>;
  if (!variables) return <div className="nbv-panel nbv-placeholder">Loading variables…</div>;
  if (!variables.length) return <div className="nbv-panel nbv-placeholder">No variables (the kernel {doc.controller?.label} reports none, or has no variable provider).</div>;
  return (
    <div className="nbv-panel">
      {variables.map((variable) => (
        <VariableRow key={variable.handle} api={api} path={path} node={{ kind: "variable", variable }} depth={0} version={version} />
      ))}
    </div>
  );
}
