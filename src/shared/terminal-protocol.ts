import type { ShellIntegrationEvent } from "./terminal-integration.ts";
import type { TerminalSpawnSpec } from "./terminal-spawn.ts";

/** Messages and requests between the extension host and the window for the "terminal" area. */

export const TERMINAL_AREA = "terminal";

/** An icon the host resolved for a terminal tab. */
export type TerminalIconWire = { kind: "codicon"; id: string } | { kind: "image"; src: string };

/** Host -> window request `create`. */
export type CreateTerminalRequest = {
  name?: string;
  cwd?: string;
  location: "panel" | "editor";
  /** Place the terminal next to this view terminal id. */
  splitWith?: string;
  spawn?: TerminalSpawnSpec;
  /** A Pseudoterminal instead of a shell. */
  pty?: boolean;
  message?: string;
  hidden?: boolean;
  transient?: boolean;
  icon?: TerminalIconWire;
  /** A theme color id (`terminal.ansiRed`) or a CSS color. */
  color?: string;
  /** Editor terminals: the group to open in (1-based; -1 the active group, -2 the one beside it). */
  viewColumn?: number;
  /** Editor terminals: open without taking the focus. */
  preserveFocus?: boolean;
};

export type CreateTerminalResponse = { id: string; cols: number; rows: number };

/** Window -> host messages. */
export type TerminalViewMessage =
  /** A terminal the window made (the user, a restored session): the host gives it a `Terminal` object. */
  | { kind: "opened"; id: string; name: string; location: "panel" | "editor" }
  | { kind: "started"; id: string; pid?: number; shell: string }
  | { kind: "exited"; id: string; code: number | null }
  | { kind: "closed"; id: string; code?: number | null }
  | { kind: "interacted"; id: string }
  | { kind: "input"; id: string; data: string }
  | { kind: "resized"; id: string; cols: number; rows: number }
  | { kind: "name"; id: string; name: string }
  | { kind: "shell"; id: string; event: ShellIntegrationEvent }
  | { kind: "linkActivated"; id: string; linkId: string };

/** Host -> window messages. */
export type TerminalHostMessage =
  | { kind: "write"; id: string; data: string }
  | { kind: "dimensions"; id: string; cols?: number; rows?: number }
  | { kind: "title"; id: string; title: string }
  /** Whether any extension registered a terminal link provider. */
  | { kind: "linkProviders"; count: number };

export type TerminalLinkWire = { linkId: string; startIndex: number; length: number; tooltip?: string };

export type ResolvedProfileWire = {
  spawn?: TerminalSpawnSpec;
  title?: string;
  cwd?: string;
  pty?: boolean;
  icon?: TerminalIconWire;
  color?: string;
};
