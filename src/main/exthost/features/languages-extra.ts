import type { HierarchyDirection, HierarchyKind, WireTransferItem } from "../../../shared/languages-extra.ts";
import type { TextRange } from "../../../shared/types.ts";
import * as Compat from "../compat-types.ts";
import * as T from "../types.ts";
import {
  CallHierarchyItem,
  DataTransfer,
  DataTransferItem,
  DocumentDropEdit,
  DocumentDropOrPasteEditKind,
  DocumentPasteEdit,
  DocumentPasteTriggerKind,
  SnippetTextEdit,
  SyntaxTokenType,
  TypeHierarchyItem,
} from "./languages-extra/classes.ts";
import { languagesExtraOf } from "./languages-extra/core.ts";
import type { HostFeature } from "./contract.ts";
import { NOT_HANDLED } from "./contract.ts";

/**
 * Host side of the "languages-extra" area: type and call hierarchy, inline
 * values, evaluatable expressions and document drop / paste edit providers,
 * the classes they use, and the `vscode.prepare*Hierarchy` commands. The
 * window side (../../../mainview/features/languages-extra.tsx) shows the
 * hierarchy panel and drives the editor integrations through `onViewRequest`.
 */

const COMMANDS = [
  "vscode.prepareCallHierarchy",
  "vscode.provideIncomingCalls",
  "vscode.provideOutgoingCalls",
  "vscode.prepareTypeHierarchy",
  "vscode.provideSupertypes",
  "vscode.provideSubtypes",
] as const;

const position = (value: unknown): T.Position => {
  const { line, character } = value as { line: number; character: number };
  return new T.Position(line, character);
};

const session = (value: unknown) => value as { sessionId: string; frameId: number };

export const languagesExtraFeature: HostFeature = {
  area: "languages-extra",

  api: ({ host, extensionId }) => {
    const state = languagesExtraOf(host);
    const register =
      (kind: "callHierarchy" | "typeHierarchy" | "inlineValues" | "evaluatable" | "drop" | "paste") =>
      (selector: unknown, provider: object, metadata?: unknown) =>
        state.register(kind, selector, provider, extensionId, metadata);
    return {
      languages: {
        registerCallHierarchyProvider: register("callHierarchy"),
        registerTypeHierarchyProvider: register("typeHierarchy"),
        registerInlineValuesProvider: register("inlineValues"),
        registerEvaluatableExpressionProvider: register("evaluatable"),
        registerDocumentDropEditProvider: register("drop"),
        registerDocumentPasteEditProvider: register("paste"),
      },
    };
  },

  types: {
    CallHierarchyItem,
    TypeHierarchyItem,
    SnippetTextEdit,
    DataTransferItem,
    DataTransfer,
    DocumentDropEdit,
    DocumentPasteEdit,
    DocumentDropOrPasteEditKind,
    DocumentPasteTriggerKind,
    SyntaxTokenType,
  },

  commands: COMMANDS,

  async executeCommand(host, command, args) {
    const state = languagesExtraOf(host);
    switch (command) {
      case "vscode.prepareCallHierarchy":
      case "vscode.prepareTypeHierarchy": {
        const [uri, at] = args;
        const target = T.Uri.revive(uri as T.Uri);
        if (!target || !at) throw new Error(`${command}: expected (uri, position)`);
        const document = host.documentForUri(target) ?? (await host.openDocument(target));
        const kind: HierarchyKind = command === "vscode.prepareCallHierarchy" ? "call" : "type";
        return (await state.prepareItems(kind, document, position(at))).map(({ item }) => item);
      }
      case "vscode.provideIncomingCalls":
      case "vscode.provideOutgoingCalls": {
        const [item] = args;
        if (!item) throw new Error(`${command}: expected a call hierarchy item`);
        const direction: HierarchyDirection = command === "vscode.provideIncomingCalls" ? "incoming" : "outgoing";
        const calls = await state.childrenOf(direction, item as Compat.CallHierarchyItem);
        return calls.map(({ item: target, fromRanges }) =>
          direction === "incoming" ? new Compat.CallHierarchyIncomingCall(target, fromRanges) : new Compat.CallHierarchyOutgoingCall(target, fromRanges),
        );
      }
      case "vscode.provideSupertypes":
      case "vscode.provideSubtypes": {
        const [item] = args;
        if (!item) throw new Error(`${command}: expected a type hierarchy item`);
        return (await state.childrenOf(command === "vscode.provideSupertypes" ? "supertypes" : "subtypes", item as Compat.TypeHierarchyItem)).map(
          (entry) => entry.item,
        );
      }
    }
    return NOT_HANDLED;
  },

  async onViewRequest(host, method, args) {
    const state = languagesExtraOf(host);
    switch (method) {
      case "availability":
        return state.availability(args[0] as string, args[1] as string);
      case "prepare":
        return state.prepare(args[0] as HierarchyKind, args[1] as string, args[2] as number, args[3] as number);
      case "children":
        return state.children(args[0] as HierarchyDirection, args[1] as number);
      case "inlineValues":
        return state.inlineValues(
          args[0] as string,
          args[1] as { startLine: number; endLine: number },
          session(args[2]),
          args[3] as { line: number; character: number },
        );
      case "evaluatable":
        return state.evaluatable(args[0] as string, args[1] as number, args[2] as number, session(args[3]));
      case "dropEdits":
        return state.dropEdits(args[0] as string, args[1] as number, args[2] as number, args[3] as WireTransferItem[]);
      case "preparePaste":
        return state.preparePaste(args[0] as string, args[1] as TextRange[]);
      case "pasteEdits":
        return state.pasteEdits(
          args[0] as string,
          args[1] as TextRange[],
          args[2] as WireTransferItem[],
          (args[3] ?? {}) as { copyId?: number | null; triggerKind?: number; only?: string },
        );
      case "resolveEdit":
        return state.resolveEdit(args[0] as number);
      case "commitEdit":
        return state.commitEdit(args[0] as number);
    }
    throw new Error(`languages-extra: unknown request '${method}'`);
  },
};
