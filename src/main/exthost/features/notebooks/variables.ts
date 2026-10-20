import * as T from "../../types.ts";
import type { NotebookService } from "./model.ts";
import type { NbVariableWire } from "../../../../shared/notebooks.ts";

/**
 * The Notebook Variables panel: the proposed `NotebookController.variableProvider`
 * (`provideVariables` is an AsyncIterable), its children by name or by index,
 * and the `notebook/variables/context` menu argument of a variable.
 */

export const NotebookVariablesRequestKind = Object.freeze({ Named: 1, Indexed: 2, 1: "Named", 2: "Indexed" });

/** Variables asked for at once (an indexed parent is shown in pages of this size). */
export const VARIABLES_PAGE = 100;
const MAX_NAMED = 1000;
const MAX_KEPT = 5000;

type Variable = { name: string; value: string; expression?: string; type?: string; interfaces?: string[]; language?: string };
type Kept = { variable: Variable; parent: string | undefined; path: string; controllerId: string; extensionId: string; hasNamedChildren: boolean; indexedChildrenCount: number };

const kept = new WeakMap<NotebookService, { seq: number; variables: Map<string, Kept> }>();

function keptOf(service: NotebookService) {
  let entry = kept.get(service);
  if (!entry) kept.set(service, (entry = { seq: 0, variables: new Map() }));
  return entry;
}

/** One level of variables: the globals (`parent` undefined) or a variable's named / indexed children from `start`. */
export async function notebookVariables(service: NotebookService, path: string, parent: string | undefined, kind: number, start: number): Promise<NbVariableWire[]> {
  const doc = service.find(path);
  const controller = doc?.controllerId ? service.controllers.get(doc.controllerId) : undefined;
  const provider = controller?.variableProvider;
  if (!doc || !controller || !provider || typeof provider.provideVariables !== "function") return [];
  const store = keptOf(service);
  const parentVariable = parent ? store.variables.get(parent) : undefined;
  if (parent && !parentVariable) return [];
  const limit = kind === NotebookVariablesRequestKind.Indexed ? VARIABLES_PAGE : MAX_NAMED;
  const source = new T.CancellationTokenSource();
  const out: NbVariableWire[] = [];
  try {
    const results = provider.provideVariables(doc.facade, parentVariable?.variable, kind, start, source.token);
    for await (const result of results as AsyncIterable<{ variable?: Variable; hasNamedChildren?: boolean; indexedChildrenCount?: number }>) {
      const variable = result?.variable;
      if (!variable || typeof variable.name !== "string") continue;
      const handle = `v${++store.seq}`;
      const entry: Kept = {
        variable,
        parent,
        path,
        controllerId: controller.id,
        extensionId: controller.extensionId,
        hasNamedChildren: !!result.hasNamedChildren,
        indexedChildrenCount: Number(result.indexedChildrenCount) || 0,
      };
      store.variables.set(handle, entry);
      out.push({
        handle,
        name: variable.name,
        value: String(variable.value ?? ""),
        type: variable.type,
        expression: variable.expression,
        language: variable.language,
        hasNamedChildren: entry.hasNamedChildren,
        indexedChildrenCount: entry.indexedChildrenCount,
      });
      if (out.length >= limit) break;
    }
  } finally {
    source.cancel();
    source.dispose();
  }
  while (store.variables.size > MAX_KEPT) store.variables.delete(store.variables.keys().next().value!);
  return out;
}

/** VS Code's argument of notebook/variables/context commands (its INotebookVariableElement). */
export function variableMenuArg(service: NotebookService, handle: string): unknown {
  const entry = keptOf(service).variables.get(handle);
  if (!entry) return undefined;
  const doc = service.find(entry.path);
  return {
    id: handle,
    parentId: entry.parent,
    name: entry.variable.name,
    value: entry.variable.value,
    type: entry.variable.type,
    interfaces: entry.variable.interfaces,
    expression: entry.variable.expression,
    language: entry.variable.language,
    hasNamedChildren: entry.hasNamedChildren,
    indexedChildrenCount: entry.indexedChildrenCount,
    notebook: doc?.uri,
    extensionId: entry.extensionId,
    controllerId: entry.controllerId,
  };
}
