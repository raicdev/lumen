import type { HostFeature } from "./contract.ts";
import type { ExtensionHost } from "../host.ts";
import * as T from "../types.ts";
import { CancellationTokenSource } from "../types.ts";
import { keyOfUri, uriOfKey } from "../documents.ts";
import { markdownOf, toWire } from "../wire.ts";
import type {
  CommentActionRequest,
  CommentActionWire,
  CommentRangeWire,
  CommentThreadWire,
  CommentWire,
  CommentsViewMessage,
} from "../../../shared/comments-wire.ts";

/**
 * vscode.comments: comment controllers, threads and the commenting ranges of
 * documents. The view (mainview/features/comments.tsx) renders the threads as
 * block widgets in the text editors; replies and buttons come back here as
 * `comments/commentThread/*` and `comments/comment/*` menu commands.
 */

function reverseEnum<V extends Record<string, number>>(values: V): Readonly<V> & Readonly<Record<number, string>> {
  const result: Record<string | number, string | number> = { ...values };
  for (const [key, value] of Object.entries(values)) result[value] = key;
  return Object.freeze(result) as Readonly<V> & Readonly<Record<number, string>>;
}

const CommentMode = reverseEnum({ Editing: 0, Preview: 1 });
const CommentState = reverseEnum({ Published: 0, Draft: 1 });
const CommentThreadCollapsibleState = reverseEnum({ Collapsed: 0, Expanded: 1 });
const CommentThreadState = reverseEnum({ Unresolved: 0, Resolved: 1 });
const CommentThreadApplicability = reverseEnum({ Current: 0, Outdated: 1 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

type Controller = {
  id: string;
  label: string;
  extensionId: string;
  api: AnyRecord;
  threads: Set<Thread>;
  disposed: boolean;
};

type Thread = {
  id: string;
  controller: Controller;
  api: AnyRecord;
  /** Started from the gutter and still without comments. */
  draft: boolean;
  scheduled: boolean;
  disposed: boolean;
  fields: {
    range: T.Range | undefined;
    comments: AnyRecord[];
    collapsibleState: number;
    canReply: unknown;
    state: number;
    label?: string;
    contextValue?: string;
    applicability?: number;
  };
};

type State = { controllers: Map<string, Controller>; threads: Map<string, Thread>; seq: number };

const states = new WeakMap<ExtensionHost, State>();

function stateOf(host: ExtensionHost): State {
  let state = states.get(host);
  if (!state) {
    state = { controllers: new Map(), threads: new Map(), seq: 0 };
    states.set(host, state);
  }
  return state;
}

/* ── menus ─────────────────────────────────────────────────────────────── */

type MenuEntry = { command: string; when?: string; group?: string };

function arrayOf<V>(value: V | V[] | undefined): V[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function titleOf(value: unknown, fallback: string): string {
  const text =
    typeof value === "string" ? value : value && typeof value === "object" && typeof (value as AnyRecord).value === "string" ? (value as AnyRecord).value : "";
  if (!text || /^%.*%$/.test(text)) return fallback;
  return text;
}

function balanced(text: string): boolean {
  let depth = 0;
  for (const char of text) {
    if (char === "(") depth++;
    else if (char === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

function splitTop(text: string, operator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0 && text.startsWith(operator, at)) {
      parts.push(text.slice(from, at));
      from = at + operator.length;
      at += operator.length - 1;
    }
  }
  parts.push(text.slice(from));
  return parts;
}

/** Evaluate a `when` clause over plain context keys: `&&`, `||`, `!`, `==`, `!=`, `=~`, parentheses around a whole term. */
export function evaluateWhen(expression: string | undefined, context: Record<string, unknown>): boolean {
  if (!expression || !expression.trim()) return true;
  const unquote = (text: string) => text.trim().replace(/^(['"])(.*)\1$/, "$2");
  const lookup = (key: string): unknown => (key in context ? context[key] : undefined);
  const term = (source: string): boolean => {
    const text = source.trim();
    if (!text) return true;
    if (text.startsWith("(") && text.endsWith(")") && balanced(text.slice(1, -1))) return evaluateWhen(text.slice(1, -1), context);
    if (text.startsWith("!")) return !term(text.slice(1));
    const match = /^([\w.-]+)\s*(==|!=|=~)\s*(.+)$/.exec(text);
    if (match) {
      const left = lookup(match[1]!);
      const right = match[3]!.trim();
      if (match[2] === "=~") {
        const regex = /^\/(.*)\/([a-z]*)$/.exec(right);
        if (!regex) return false;
        try {
          return new RegExp(regex[1]!, regex[2]).test(String(left ?? ""));
        } catch {
          return false;
        }
      }
      const same = String(left ?? "") === unquote(right);
      return match[2] === "==" ? same : !same;
    }
    if (text === "true") return true;
    if (text === "false") return false;
    return !!lookup(text);
  };
  return splitTop(expression, "||").some((disjunct) => splitTop(disjunct, "&&").every(term));
}

function menuActions(host: ExtensionHost, menu: string[], context: Record<string, unknown>): CommentActionWire[] {
  const out: { action: CommentActionWire; group: string; order: number }[] = [];
  for (const runtime of host.runtimes.values()) {
    const contributes = (runtime.description.manifest.contributes ?? {}) as AnyRecord;
    const commands = arrayOf<AnyRecord>(contributes.commands);
    for (const id of menu) {
      for (const entry of arrayOf<MenuEntry>(contributes.menus?.[id])) {
        if (!entry?.command || !evaluateWhen(entry.when, context)) continue;
        const contributed = commands.find((command) => command.command === entry.command);
        const [group, order] = (entry.group ?? "").split("@");
        out.push({
          action: { command: entry.command, title: titleOf(contributed?.shortTitle ?? contributed?.title, entry.command) },
          group: group ?? "",
          order: Number(order) || 0,
        });
      }
    }
  }
  out.sort((a, b) => (a.group === b.group ? a.order - b.order : a.group < b.group ? -1 : 1));
  return out.map((item) => item.action);
}

/* ── wire ──────────────────────────────────────────────────────────────── */

function iconOf(value: unknown): string | undefined {
  const pick = (candidate: unknown): string | undefined => {
    if (typeof candidate === "string") return /^(https?:|data:)/.test(candidate) ? candidate : undefined;
    if (T.Uri.isUri(candidate)) return /^(https?|data)$/.test(candidate.scheme) ? candidate.toString() : undefined;
    return undefined;
  };
  if (value && typeof value === "object" && !T.Uri.isUri(value)) return pick((value as AnyRecord).dark) ?? pick((value as AnyRecord).light);
  return pick(value);
}

function threadContext(thread: Thread, comment?: AnyRecord): Record<string, unknown> {
  return {
    commentController: thread.controller.id,
    commentThread: thread.fields.contextValue,
    comment: comment?.contextValue,
    commentThreadIsEmpty: thread.fields.comments.length === 0,
    commentIsEmpty: !comment,
    commentThreadState: thread.fields.state === 1 ? "resolved" : "unresolved",
  };
}

function wireThread(host: ExtensionHost, thread: Thread): CommentThreadWire {
  const { fields } = thread;
  const range = fields.range;
  const options = (thread.controller.api.options ?? {}) as AnyRecord;
  const comments: CommentWire[] = fields.comments.map((comment, index) => {
    const author = (comment.author ?? {}) as AnyRecord;
    const timestamp = comment.timestamp instanceof Date && !Number.isNaN(comment.timestamp.getTime()) ? comment.timestamp.toISOString() : undefined;
    return {
      index,
      author: String(author.name ?? ""),
      avatar: iconOf(author.iconPath),
      body: markdownOf(comment.body),
      mode: typeof comment.mode === "number" ? comment.mode : 0,
      label: typeof comment.label === "string" ? comment.label : undefined,
      timestamp,
      contextValue: typeof comment.contextValue === "string" ? comment.contextValue : undefined,
      reactions: arrayOf<AnyRecord>(comment.reactions).map((reaction) => ({
        label: String(reaction.label ?? ""),
        count: Number(reaction.count) || 0,
        authorHasReacted: !!reaction.authorHasReacted,
        icon: iconOf(reaction.iconPath),
      })),
      actions: menuActions(host, ["comments/comment/title", "comments/comment/context"], threadContext(thread, comment)),
    };
  });
  return {
    id: thread.id,
    controllerId: thread.controller.id,
    controllerLabel: thread.controller.label,
    path: keyOfUri(thread.api.uri as T.Uri),
    startLine: range ? range.start.line : 0,
    endLine: range ? range.end.line : 0,
    comments,
    collapsed: fields.collapsibleState === 0,
    canReply: fields.canReply !== false,
    label: fields.label,
    contextValue: fields.contextValue,
    state: fields.state,
    draft: thread.draft && comments.length === 0,
    placeHolder: typeof options.placeHolder === "string" ? options.placeHolder : undefined,
    prompt: typeof options.prompt === "string" ? options.prompt : undefined,
    titleActions: menuActions(host, ["comments/commentThread/title"], threadContext(thread)),
    replyActions: menuActions(host, ["comments/commentThread/context", "comments/commentThread/additionalActions"], threadContext(thread)),
  };
}

function scheduleFlush(host: ExtensionHost, thread: Thread): void {
  if (thread.scheduled) return;
  thread.scheduled = true;
  queueMicrotask(() => {
    thread.scheduled = false;
    if (thread.disposed) return;
    host.postFeature("comments", { t: "upsert", thread: wireThread(host, thread) });
  });
}

function removeThread(host: ExtensionHost, thread: Thread): void {
  if (thread.disposed) return;
  thread.disposed = true;
  thread.controller.threads.delete(thread);
  stateOf(host).threads.delete(thread.id);
  host.postFeature("comments", { t: "remove", id: thread.id });
}

/* ── api objects ───────────────────────────────────────────────────────── */

function createThread(host: ExtensionHost, controller: Controller, uri: T.Uri, range: T.Range | undefined, comments: AnyRecord[], draft: boolean): Thread {
  const state = stateOf(host);
  const thread: Thread = {
    id: `${controller.id}:${++state.seq}`,
    controller,
    api: {},
    draft,
    scheduled: false,
    disposed: false,
    fields: { range, comments: [...comments], collapsibleState: 0, canReply: true, state: 0 },
  };
  const touch = () => scheduleFlush(host, thread);
  const { fields } = thread;
  const api: AnyRecord = {
    uri,
    get range() {
      return fields.range;
    },
    set range(value: T.Range | undefined) {
      fields.range = value;
      touch();
    },
    get comments() {
      return [...fields.comments];
    },
    set comments(value: AnyRecord[]) {
      fields.comments = [...(value ?? [])];
      if (fields.comments.length > 0) thread.draft = false;
      touch();
    },
    get collapsibleState() {
      return fields.collapsibleState;
    },
    set collapsibleState(value: number) {
      fields.collapsibleState = value;
      touch();
    },
    get canReply() {
      return fields.canReply;
    },
    set canReply(value: unknown) {
      fields.canReply = value;
      touch();
    },
    get state() {
      return fields.state;
    },
    set state(value: number) {
      fields.state = value;
      touch();
    },
    get label() {
      return fields.label;
    },
    set label(value: string | undefined) {
      fields.label = value;
      touch();
    },
    get contextValue() {
      return fields.contextValue;
    },
    set contextValue(value: string | undefined) {
      fields.contextValue = value;
      touch();
    },
    get applicability() {
      return fields.applicability ?? 0;
    },
    set applicability(value: number) {
      fields.applicability = value;
      touch();
    },
    dispose: () => removeThread(host, thread),
  };
  thread.api = api;
  controller.threads.add(thread);
  state.threads.set(thread.id, thread);
  touch();
  return thread;
}

function createController(host: ExtensionHost, extensionId: string, id: string, label: string): AnyRecord {
  const state = stateOf(host);
  state.controllers.get(id)?.api.dispose();
  const controller: Controller = { id, label, extensionId, api: {}, threads: new Set(), disposed: false };
  const api: AnyRecord = {
    id,
    get label() {
      return controller.label;
    },
    set label(value: string) {
      controller.label = value;
      for (const thread of controller.threads) scheduleFlush(host, thread);
    },
    options: undefined,
    commentingRangeProvider: undefined,
    reactionHandler: undefined,
    createCommentThread: (uri: T.Uri, range: T.Range | undefined, comments: AnyRecord[]) => {
      if (controller.disposed) throw new Error(`comment controller '${id}' is disposed`);
      return createThread(host, controller, T.Uri.revive(uri) ?? uri, range, comments ?? [], false).api;
    },
    dispose: () => {
      if (controller.disposed) return;
      controller.disposed = true;
      for (const thread of [...controller.threads]) removeThread(host, thread);
      if (state.controllers.get(id) === controller) state.controllers.delete(id);
    },
  };
  controller.api = api;
  state.controllers.set(id, controller);
  return api;
}

/* ── view requests ─────────────────────────────────────────────────────── */

async function commentingRanges(host: ExtensionHost, path: string): Promise<CommentRangeWire[]> {
  const out: CommentRangeWire[] = [];
  const controllers = [...stateOf(host).controllers.values()].filter((controller) => controller.api.commentingRangeProvider);
  if (controllers.length === 0) return out;
  const document = await host.openDocument(uriOfKey(path));
  for (const controller of controllers) {
    const provider = controller.api.commentingRangeProvider as AnyRecord;
    const source = new CancellationTokenSource();
    try {
      const result = await provider.provideCommentingRanges?.(document.toApi(), source.token);
      const ranges = Array.isArray(result) ? result : Array.isArray(result?.ranges) ? result.ranges : [];
      for (const range of ranges as T.Range[]) out.push({ controllerId: controller.id, startLine: range.start.line, endLine: range.end.line });
    } catch (error) {
      host.log("error", `comment controller '${controller.id}': ${error instanceof Error ? error.message : String(error)}`, controller.extensionId);
    } finally {
      source.dispose();
    }
  }
  return out;
}

function createDraft(host: ExtensionHost, controllerId: string, path: string, line: number): string {
  const controller = stateOf(host).controllers.get(controllerId);
  if (!controller) throw new Error(`unknown comment controller '${controllerId}'`);
  const thread = createThread(host, controller, uriOfKey(path), new T.Range(line, 0, line, 0), [], true);
  thread.fields.collapsibleState = 1;
  return thread.id;
}

async function runAction(host: ExtensionHost, request: CommentActionRequest): Promise<void> {
  const thread = stateOf(host).threads.get(request.threadId);
  if (!thread) return;
  if (request.kind === "thread") {
    await host.executeCommand(request.command, [thread.api]);
  } else if (request.kind === "reply") {
    await host.executeCommand(request.command, [{ thread: thread.api, text: request.text }]);
    // A draft that the command did not turn into a thread with comments is gone.
    if (thread.fields.comments.length === 0 && thread.draft) removeThread(host, thread);
    else thread.draft = false;
  } else {
    const comment = thread.fields.comments[request.commentIndex];
    if (!comment) return;
    if (request.kind === "comment") {
      await host.executeCommand(request.command, [Object.create(comment, { parent: { value: thread.api, enumerable: false } })]);
    } else {
      const reaction = arrayOf<AnyRecord>(comment.reactions)[request.reactionIndex];
      const handler = thread.controller.api.reactionHandler as ((comment: AnyRecord, reaction: AnyRecord) => unknown) | undefined;
      if (reaction && handler) await handler(comment, reaction);
    }
  }
  if (!thread.disposed) scheduleFlush(host, thread);
}

export const commentsFeature: HostFeature = {
  area: "comments",
  api: ({ host, extensionId }) => ({
    comments: {
      createCommentController: (id: string, label: string) => createController(host, extensionId, String(id), String(label ?? id)),
    },
  }),
  types: { CommentMode, CommentState, CommentThreadCollapsibleState, CommentThreadState, CommentThreadApplicability },
  onViewMessage: (host, payload) => {
    const message = payload as CommentsViewMessage;
    if (message?.t !== "collapse") return;
    const thread = stateOf(host).threads.get(message.id);
    if (thread) thread.fields.collapsibleState = message.collapsed ? 0 : 1;
  },
  onViewRequest: async (host, method, args) => {
    switch (method) {
      case "ranges":
        return commentingRanges(host, String(args[0]));
      case "createDraft":
        return createDraft(host, String(args[0]), String(args[1]), Number(args[2]) || 0);
      case "discard": {
        const thread = stateOf(host).threads.get(String(args[0]));
        if (thread && thread.draft && thread.fields.comments.length === 0) removeThread(host, thread);
        return null;
      }
      case "action":
        await runAction(host, args[0] as CommentActionRequest);
        return null;
      case "snapshot":
        return toWire([...stateOf(host).threads.values()].map((thread) => wireThread(host, thread)));
      default:
        throw new Error(`comments: unknown request ${method}`);
    }
  },
};
