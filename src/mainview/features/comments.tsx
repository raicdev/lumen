import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { CommentActionRequest, CommentActionWire, CommentRangeWire, CommentThreadWire, CommentWire, CommentsHostMessage } from "../../shared/comments-wire";
import { api as rpc } from "../lib/rpc";
import type { ViewFeature, ViewFeatureApi } from "./types";
import { createStore } from "./store";

/**
 * Window side of vscode.comments: comment threads as block widgets below the
 * lines they are about, a "+" in the gutter of commenting ranges that starts a
 * new thread, and the reply box whose buttons run the commands contributed to
 * `comments/commentThread/context`.
 */

/* ── state ─────────────────────────────────────────────────────────────── */

const threads = createStore<ReadonlyMap<string, CommentThreadWire>>(new Map());
/** Bumped when the set of threads or controllers may have changed (commenting ranges are asked again). */
const epoch = createStore(0);
/** Unsent reply text per thread (widgets are rebuilt when a thread changes). */
const drafts = new Map<string, string>();
let focusAfterRender: string | null = null;

const keyOf = (path: string) => path.replace(/\\/g, "/").toLowerCase();

function setThread(thread: CommentThreadWire): void {
  threads.set((previous) => new Map(previous).set(thread.id, thread));
  epoch.set((value) => value + 1);
}

function removeThread(id: string): void {
  if (!threads.get().has(id)) return;
  threads.set((previous) => {
    const next = new Map(previous);
    next.delete(id);
    return next;
  });
  drafts.delete(id);
  epoch.set((value) => value + 1);
}

function threadsOf(path: string): CommentThreadWire[] {
  const key = keyOf(path);
  return [...threads.get().values()].filter((thread) => keyOf(thread.path) === key).sort((a, b) => a.endLine - b.endLine);
}

/* ── markdown ──────────────────────────────────────────────────────────── */

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function inline(parent: HTMLElement, text: string): void {
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>)]+)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) parent.append(text.slice(last, at));
    const token = match[0];
    if (match[1]) parent.append(element("code", undefined, token.slice(1, -1)));
    else if (match[2]) parent.append(element("strong", undefined, token.slice(2, -2)));
    else if (match[3]) parent.append(element("em", undefined, token.slice(1, -1)));
    else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      const label = link ? link[1]! : token;
      const url = link ? link[2]! : token;
      if (/^https?:\/\//i.test(url)) {
        const anchor = element("a", "cm-comment-link", label);
        anchor.href = url;
        anchor.title = url;
        anchor.addEventListener("click", (event) => {
          event.preventDefault();
          void rpc().request.openExternal({ url });
        });
        parent.append(anchor);
      } else parent.append(label);
    }
    last = at + token.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function renderMarkdown(source: string): HTMLElement {
  const root = element("div", "cm-comment-body");
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    const block = element("p");
    paragraph.forEach((line, index) => {
      if (index > 0) block.append(document.createElement("br"));
      inline(block, line);
    });
    root.append(block);
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```/.test(lines[index]!)) code.push(lines[index++]!);
      const pre = element("pre");
      pre.append(element("code", undefined, code.join("\n")));
      root.append(pre);
    } else if (line.trim() === "") flush();
    else paragraph.push(line);
  }
  flush();
  return root;
}

/* ── widget ────────────────────────────────────────────────────────────── */

function button(label: string, className: string, onClick: () => void, title?: string): HTMLButtonElement {
  const node = element("button", className, label);
  node.type = "button";
  if (title) node.title = title;
  node.addEventListener("click", (event) => {
    event.preventDefault();
    onClick();
  });
  return node;
}

function runAction(api: ViewFeatureApi, request: CommentActionRequest): Promise<void> {
  return api.requestHost("action", [request]).then(
    () => undefined,
    (error: unknown) => {
      void api.showMessage("error", error instanceof Error ? error.message : String(error));
    },
  );
}

function setCollapsed(api: ViewFeatureApi, thread: CommentThreadWire, collapsed: boolean): void {
  setThread({ ...thread, collapsed });
  api.sendToHost({ t: "collapse", id: thread.id, collapsed });
}

function renderComment(thread: CommentThreadWire, comment: CommentWire, api: ViewFeatureApi): HTMLElement {
  const root = element("div", "cm-comment");
  const header = element("div", "cm-comment-header");
  if (comment.avatar) {
    const avatar = element("img", "cm-comment-avatar");
    avatar.src = comment.avatar;
    avatar.alt = "";
    header.append(avatar);
  } else header.append(element("span", "cm-comment-avatar cm-comment-avatar-fallback", (comment.author[0] ?? "?").toUpperCase()));
  header.append(element("span", "cm-comment-author", comment.author));
  if (comment.label) header.append(element("span", "cm-comment-chip", comment.label));
  if (comment.timestamp) header.append(element("span", "cm-comment-time", new Date(comment.timestamp).toLocaleString()));
  const actions = element("span", "cm-comment-actions");
  for (const action of comment.actions) actions.append(button(action.title, "cm-comment-link-button", () => void runAction(api, { threadId: thread.id, kind: "comment", command: action.command, commentIndex: comment.index })));
  header.append(actions);
  root.append(header, renderMarkdown(comment.body));
  if (comment.reactions.length > 0) {
    const reactions = element("div", "cm-comment-reactions");
    comment.reactions.forEach((reaction, reactionIndex) => {
      const chip = button("", `cm-comment-reaction${reaction.authorHasReacted ? " reacted" : ""}`, () => void runAction(api, { threadId: thread.id, kind: "reaction", commentIndex: comment.index, reactionIndex }));
      if (reaction.icon) {
        const icon = element("img");
        icon.src = reaction.icon;
        icon.alt = "";
        chip.append(icon);
      }
      chip.append(`${reaction.label} ${reaction.count}`);
      reactions.append(chip);
    });
    root.append(reactions);
  }
  return root;
}

function renderReply(thread: CommentThreadWire, api: ViewFeatureApi, view: EditorView): HTMLElement {
  const root = element("div", "cm-comment-reply");
  const input = element("textarea", "cm-comment-input");
  input.rows = 1;
  input.placeholder = thread.placeHolder ?? (thread.comments.length === 0 ? "Start discussion" : "Reply…");
  input.value = drafts.get(thread.id) ?? "";
  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    view.requestMeasure();
  };
  const buttons = element("div", "cm-comment-buttons");
  const sync = () => {
    for (const node of buttons.querySelectorAll<HTMLButtonElement>("button[data-reply]")) node.disabled = input.value.trim() === "";
  };
  const submit = (action: CommentActionWire) => {
    const text = input.value;
    if (text.trim() === "") return;
    input.disabled = true;
    void runAction(api, { threadId: thread.id, kind: "reply", command: action.command, text }).then(() => {
      drafts.delete(thread.id);
      input.value = "";
      input.disabled = false;
      sync();
      grow();
    });
  };
  input.addEventListener("input", () => {
    drafts.set(thread.id, input.value);
    sync();
    grow();
  });
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && thread.replyActions[0]) {
      event.preventDefault();
      submit(thread.replyActions[0]);
    } else if (event.key === "Escape" && thread.draft) {
      event.preventDefault();
      void api.requestHost("discard", [thread.id]);
    }
  });
  thread.replyActions.forEach((action, index) => {
    const node = button(action.title, index === 0 ? "cm-comment-button primary" : "cm-comment-button", () => submit(action));
    node.dataset.reply = "1";
    buttons.append(node);
  });
  if (thread.draft) buttons.append(button("Cancel", "cm-comment-button", () => void api.requestHost("discard", [thread.id])));
  root.append(input, buttons);
  if (thread.replyActions.length === 0) root.append(element("div", "cm-comment-hint", "This extension contributes no reply command (comments/commentThread/context)."));
  queueMicrotask(() => {
    sync();
    grow();
  });
  return root;
}

class ThreadWidget extends WidgetType {
  readonly thread: CommentThreadWire;
  readonly api: ViewFeatureApi;
  constructor(thread: CommentThreadWire, api: ViewFeatureApi) {
    super();
    this.thread = thread;
    this.api = api;
  }

  eq(other: ThreadWidget): boolean {
    return other.thread === this.thread;
  }

  get estimatedHeight(): number {
    return this.thread.collapsed ? 28 : 120;
  }

  ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const { thread, api } = this;
    const root = element("div", `cm-comment-thread${thread.state === 1 ? " resolved" : ""}`);
    const header = element("div", "cm-comment-thread-header");
    header.append(button(thread.collapsed ? "▸" : "▾", "cm-comment-toggle", () => setCollapsed(api, thread, !thread.collapsed), thread.collapsed ? "Expand" : "Collapse"));
    header.append(element("span", "cm-comment-thread-title", thread.label ?? thread.controllerLabel));
    if (thread.comments.length > 0) header.append(element("span", "cm-comment-count", `${thread.comments.length} comment${thread.comments.length === 1 ? "" : "s"}`));
    if (thread.state === 1) header.append(element("span", "cm-comment-chip", "Resolved"));
    const titleActions = element("span", "cm-comment-actions");
    for (const action of thread.titleActions) titleActions.append(button(action.title, "cm-comment-link-button", () => void runAction(api, { threadId: thread.id, kind: "thread", command: action.command })));
    header.append(titleActions);
    if (thread.draft) header.append(button("×", "cm-comment-toggle", () => void api.requestHost("discard", [thread.id]), "Discard"));
    root.append(header);
    if (!thread.collapsed) {
      const body = element("div", "cm-comment-thread-body");
      for (const comment of thread.comments) body.append(renderComment(thread, comment, api));
      if (thread.canReply) body.append(renderReply(thread, api, view));
      root.append(body);
    }
    if (focusAfterRender === thread.id) {
      focusAfterRender = null;
      setTimeout(() => root.querySelector<HTMLTextAreaElement>("textarea")?.focus(), 0);
    }
    return root;
  }
}

/* ── editor extension ──────────────────────────────────────────────────── */

const setThreadList = StateEffect.define<CommentThreadWire[]>();
const setRanges = StateEffect.define<CommentRangeWire[]>();

function threadField(api: ViewFeatureApi) {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, transaction) {
      value = value.map(transaction.changes);
      for (const effect of transaction.effects) {
        if (!effect.is(setThreadList)) continue;
        const builder = new RangeSetBuilder<Decoration>();
        const doc = transaction.state.doc;
        for (const thread of effect.value) {
          const line = doc.line(Math.max(1, Math.min(thread.endLine + 1, doc.lines)));
          builder.add(line.to, line.to, Decoration.widget({ widget: new ThreadWidget(thread, api), block: true, side: 1 }));
        }
        value = builder.finish();
      }
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

class AddMarker extends GutterMarker {
  readonly controllerId: string;
  constructor(controllerId: string) {
    super();
    this.controllerId = controllerId;
  }
  eq(other: AddMarker): boolean {
    return other.controllerId === this.controllerId;
  }
  toDOM(): Node {
    const node = element("span", "cm-comment-add", "+");
    node.title = "Add Comment";
    return node;
  }
}

const rangesField = StateField.define<CommentRangeWire[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setRanges)) value = effect.value;
    return value;
  },
});

function rangeAt(ranges: CommentRangeWire[], line: number): CommentRangeWire | undefined {
  return ranges.find((range) => line >= range.startLine && line <= range.endLine);
}

function commentsExtension(path: string, api: ViewFeatureApi): Extension[] {
  const field = threadField(api);
  const plugin = ViewPlugin.fromClass(
    class {
      listed: CommentThreadWire[] = [];
      unsubscribe: Array<() => void> = [];
      timer: ReturnType<typeof setTimeout> | null = null;
      lateTimer: ReturnType<typeof setTimeout> | null = null;
      destroyed = false;
      readonly view: EditorView;
      constructor(view: EditorView) {
        this.view = view;
        this.unsubscribe.push(threads.subscribe(() => this.syncThreads()));
        this.unsubscribe.push(epoch.subscribe(() => this.scheduleRanges(50)));
        queueMicrotask(() => this.syncThreads());
        // Controllers are registered when their extension activates, which can be after the editor opened.
        this.scheduleRanges(0);
        this.lateTimer = setTimeout(() => this.scheduleRanges(0), 2000);
      }
      syncThreads() {
        const next = threadsOf(path);
        if (next.length === this.listed.length && next.every((thread, index) => thread === this.listed[index])) return;
        this.listed = next;
        if (!this.destroyed) this.view.dispatch({ effects: setThreadList.of(next) });
      }
      scheduleRanges(delay: number) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.loadRanges(), delay);
      }
      async loadRanges() {
        this.timer = null;
        try {
          const ranges = await api.requestHost<CommentRangeWire[]>("ranges", [path]);
          if (this.destroyed) return;
          const previous = this.view.state.field(rangesField);
          if (JSON.stringify(previous) !== JSON.stringify(ranges)) this.view.dispatch({ effects: setRanges.of(ranges) });
        } catch {
          /* the host is not running, or no extension is a comment controller */
        }
      }
      update(update: ViewUpdate) {
        if (update.docChanged && this.view.state.field(rangesField).length > 0) this.scheduleRanges(700);
      }
      destroy() {
        this.destroyed = true;
        if (this.timer) clearTimeout(this.timer);
        if (this.lateTimer) clearTimeout(this.lateTimer);
        for (const dispose of this.unsubscribe) dispose();
      }
    },
  );
  const addGutter = gutter({
    class: "cm-comment-gutter",
    lineMarker(view, line) {
      const ranges = view.state.field(rangesField);
      if (ranges.length === 0) return null;
      const range = rangeAt(ranges, view.state.doc.lineAt(line.from).number - 1);
      return range ? new AddMarker(range.controllerId) : null;
    },
    lineMarkerChange: (update) => update.transactions.some((transaction) => transaction.effects.some((effect) => effect.is(setRanges))) || update.docChanged,
    domEventHandlers: {
      mousedown(view, line) {
        const lineNumber = view.state.doc.lineAt(line.from).number - 1;
        const range = rangeAt(view.state.field(rangesField), lineNumber);
        if (!range) return false;
        const existing = threadsOf(path).find((thread) => thread.draft && thread.endLine === lineNumber);
        if (existing) {
          focusAfterRender = existing.id;
          setThread({ ...existing });
          return true;
        }
        void api.requestHost<string>("createDraft", [range.controllerId, path, lineNumber]).then(
          (id) => {
            focusAfterRender = id;
            // The thread usually arrived before this answer: render it again so the box gets the focus.
            const created = threads.get().get(id);
            if (created) setThread({ ...created });
          },
          (error: unknown) => void api.showMessage("error", error instanceof Error ? error.message : String(error)),
        );
        return true;
      },
    },
  });
  return [rangesField, field, plugin, addGutter];
}

/* ── feature ───────────────────────────────────────────────────────────── */

export const commentsView: ViewFeature = {
  area: "comments",
  onHostReady: (api) => {
    // The host (re)started: its threads are gone; ask for the ones it already has.
    threads.set(new Map());
    epoch.set((value) => value + 1);
    void api.requestHost<CommentThreadWire[]>("snapshot").then(
      (list) => {
        for (const thread of list) setThread(thread);
      },
      () => undefined,
    );
  },
  onHostMessage: (payload) => {
    const message = payload as CommentsHostMessage;
    if (message?.t === "upsert") setThread(message.thread);
    else if (message?.t === "remove") removeThread(message.id);
  },
  editorExtensions: (path, _languageId, api) => commentsExtension(path, api),
};
