/** Messages between the comments feature of the extension host and its view (src/main/exthost/features/comments.ts, src/mainview/features/comments.tsx). */

export type CommentActionWire = { command: string; title: string };

export type CommentReactionWire = { label: string; count: number; authorHasReacted: boolean; icon?: string };

export type CommentWire = {
  index: number;
  author: string;
  avatar?: string;
  /** Markdown source (plain text bodies are escaped by the extension themselves). */
  body: string;
  mode: number;
  label?: string;
  timestamp?: string;
  contextValue?: string;
  reactions: CommentReactionWire[];
  /** `comments/comment/title` and `comments/comment/context` menu items. */
  actions: CommentActionWire[];
};

export type CommentThreadWire = {
  id: string;
  controllerId: string;
  controllerLabel: string;
  /** Document key (file system path). */
  path: string;
  /** Zero-based lines; the widget sits below `endLine`. */
  startLine: number;
  endLine: number;
  comments: CommentWire[];
  collapsed: boolean;
  canReply: boolean;
  label?: string;
  contextValue?: string;
  /** 0 unresolved, 1 resolved. */
  state: number;
  /** A thread started from the gutter that has no comment yet. */
  draft: boolean;
  placeHolder?: string;
  prompt?: string;
  /** `comments/commentThread/title` */
  titleActions: CommentActionWire[];
  /** `comments/commentThread/context` and `additionalActions`: the buttons of the reply box. */
  replyActions: CommentActionWire[];
};

export type CommentsHostMessage = { t: "upsert"; thread: CommentThreadWire } | { t: "remove"; id: string };

export type CommentRangeWire = { controllerId: string; startLine: number; endLine: number };

export type CommentActionRequest =
  | { threadId: string; kind: "thread"; command: string }
  | { threadId: string; kind: "reply"; command: string; text: string }
  | { threadId: string; kind: "comment"; command: string; commentIndex: number }
  | { threadId: string; kind: "reaction"; commentIndex: number; reactionIndex: number };

export type CommentsViewMessage = { t: "collapse"; id: string; collapsed: boolean };
