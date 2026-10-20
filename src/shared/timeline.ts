/** Wire types of the "timeline" area between the extension host and the Timeline section of the Explorer. */

export type TimelineSourceWire = { id: string; label: string };

export type TimelineItemWire = {
  /** Host handle of the item (its command, the menus' TimelineItem argument). */
  handle: string;
  source: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** Milliseconds since the epoch. */
  timestamp: number;
  icon?: { codicon: string } | { url: string };
  contextValue?: string;
  hasCommand: boolean;
};

export type TimelinePage = { items: TimelineItemWire[]; cursor?: string };

/** Host -> window: a source changed (`path` undefined: every file), or the list of sources changed. */
export type TimelineHostMessage = { kind: "changed"; source: string; path?: string; reset: boolean } | { kind: "sources" };

/** Window -> host. */
export type TimelineViewMessage = { kind: "run"; handle: string };
