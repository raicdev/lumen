import { Terminal, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { api } from "./rpc";
import { onColorThemeChange, themeColor } from "./theme";
import { ShellIntegrationParser, type ShellIntegrationEvent } from "../../shared/terminal-integration";
import { encodeSpawnSpec, type TerminalSpawnSpec } from "../../shared/terminal-spawn";

/**
 * Integrated terminals (VS Code style): any number of PTY-backed instances,
 * grouped side by side ("split") in the panel, or living as editor tabs.
 *
 * Each instance owns one host element; views attach it to wherever the
 * terminal is shown, so moving a terminal between the panel and the editor
 * area keeps its session and scrollback.
 */

export type TerminalLocation = "panel" | "editor";

/** A terminal's icon as an extension gave it (TerminalOptions.iconPath). */
export type TerminalIcon = { kind: "codicon"; id: string } | { kind: "image"; src: string };

/** What the window tells whoever listens (the "terminal" feature forwards it to the extension host). */
export type TerminalEvent =
  | { type: "input"; id: string; data: string }
  /** The first time the user typed into the terminal. */
  | { type: "interacted"; id: string }
  | { type: "started"; id: string; pid: number | undefined; shell: string }
  | { type: "exited"; id: string; code: number | null }
  | { type: "closed"; id: string; code: number | null | undefined }
  | { type: "resized"; id: string; cols: number; rows: number }
  | { type: "shell"; id: string; event: ShellIntegrationEvent };

/** A link an extension's TerminalLinkProvider found in a line (offsets into the line's text). */
export type TerminalLinkMatch = { linkId: string; startIndex: number; length: number; tooltip?: string };

/** Asks for the links of a logical line of a terminal; activation goes back with the link's id. */
export type TerminalLinkProvider = {
  provide(terminalId: string, line: string): Promise<TerminalLinkMatch[]>;
  activate(terminalId: string, linkId: string): void;
};

/** Resolves an extension's terminal profile (`ext:<id>`) to the shell to start, or to a pseudo-terminal. */
export type TerminalProfileResolver = (
  profileId: string,
  terminalId: string,
) => Promise<{ spawn?: TerminalSpawnSpec; title?: string; cwd?: string; pty?: boolean; icon?: TerminalIcon; color?: string } | null>;

export const EXTENSION_PROFILE_PREFIX = "ext:";

/** Where an editor terminal's tab opens: a view column (1-based; -1 active, -2 beside) and whether it takes the focus. */
export type TerminalPlacement = { viewColumn?: number; preserveFocus?: boolean };

type Instance = {
  id: string;
  title: string;
  customTitle: boolean;
  profileId: string | undefined;
  cwd: string;
  sessionId: string | null;
  exited: boolean;
  location: TerminalLocation;
  el: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  /** Dimensions a Pseudoterminal asked for (onDidOverrideDimensions). */
  fixedSize: { cols: number; rows: number } | null;
  opened: boolean;
  starting: Promise<void> | null;
  /** Input sent before the shell started (extensions' Terminal.sendText). */
  queued: string;
  /** No shell: an extension's Pseudoterminal feeds the screen and receives the input. */
  pty: boolean;
  /** Not listed in the panel (TerminalOptions.hideFromUser) until revealed. */
  hidden: boolean;
  /** Not restored with the project (TerminalOptions.isTransient, pseudo-terminals). */
  transient: boolean;
  spawn: TerminalSpawnSpec | null;
  icon: TerminalIcon | null;
  color: string | null;
  /** Editor terminals an extension made: where their tab goes (taken once by the editor area). */
  placement: TerminalPlacement | null;
  interacted: boolean;
  exitCode: number | null | undefined;
  integration: ShellIntegrationParser;
};

export type TerminalInfo = {
  id: string;
  title: string;
  exited: boolean;
  location: TerminalLocation;
  hidden: boolean;
  pty: boolean;
  icon: TerminalIcon | null;
  color: string | null;
};

export type TerminalSnapshot = {
  instances: TerminalInfo[];
  /** Panel groups; each group shows its terminals side by side. */
  groups: string[][];
  activeGroup: number;
  activeId: string | null;
};

/** xterm's colors from the active color theme (terminal.* colors). */
function terminalTheme() {
  const color = (id: string) => themeColor(id);
  const ansi = (name: string) => color(`terminal.ansi${name}`);
  return {
    background: color("terminal.background"),
    foreground: color("terminal.foreground"),
    cursor: color("terminalCursor.foreground"),
    cursorAccent: color("terminalCursor.background") ?? color("terminal.background"),
    selectionBackground: color("terminal.selectionBackground"),
    black: ansi("Black"),
    red: ansi("Red"),
    green: ansi("Green"),
    yellow: ansi("Yellow"),
    blue: ansi("Blue"),
    magenta: ansi("Magenta"),
    cyan: ansi("Cyan"),
    white: ansi("White"),
    brightBlack: ansi("BrightBlack"),
    brightRed: ansi("BrightRed"),
    brightGreen: ansi("BrightGreen"),
    brightYellow: ansi("BrightYellow"),
    brightBlue: ansi("BrightBlue"),
    brightMagenta: ansi("BrightMagenta"),
    brightCyan: ansi("BrightCyan"),
    brightWhite: ansi("BrightWhite"),
  };
}

let tooltip: HTMLDivElement | null = null;

function showLinkTooltip(event: MouseEvent, text: string | undefined) {
  hideLinkTooltip();
  if (!text) return;
  tooltip = document.createElement("div");
  tooltip.className = "lumen-tooltip visible terminal-link-tooltip";
  tooltip.textContent = text;
  tooltip.style.left = `${event.clientX + 8}px`;
  tooltip.style.top = `${event.clientY + 14}px`;
  document.body.appendChild(tooltip);
}

function hideLinkTooltip() {
  tooltip?.remove();
  tooltip = null;
}

function basename(path: string) {
  return path.split(/[/\\]/).pop() ?? path;
}

class TerminalService {
  private instances = new Map<string, Instance>();
  private bySession = new Map<string, Instance>();
  private groups: string[][] = [];
  private activeGroup = 0;
  private activeId: string | null = null;
  private seq = 0;
  private defaultCwd = "";
  private fontSize = 13;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(event: TerminalEvent) => void>();
  private linkProvider: TerminalLinkProvider | null = null;
  private profileResolver: TerminalProfileResolver | null = null;
  private profileList: { id: string; name: string }[] = [];
  private snapshot: TerminalSnapshot = { instances: [], groups: [], activeGroup: 0, activeId: null };

  constructor() {
    // Shell sessions live in the main process: after a reload (or a restarted
    // renderer) the previous page's are orphans. Requests run in order, so
    // this ends them before this page starts any of its own.
    void api()
      .request.terminalReset({})
      .catch(() => {});
    window.addEventListener("lumen:terminal-data", (e) => {
      const { id, data } = (e as CustomEvent<{ id: string; data: string }>).detail;
      const instance = this.bySession.get(id);
      if (!instance) return;
      instance.term.write(data);
      for (const event of instance.integration.feed(data)) this.emitEvent({ type: "shell", id: instance.id, event });
    });
    window.addEventListener("lumen:terminal-exit", (e) => {
      const { id, code } = (e as CustomEvent<{ id: string; code: number | null }>).detail;
      const instance = this.bySession.get(id);
      if (!instance) return;
      this.bySession.delete(id);
      instance.sessionId = null;
      instance.exited = true;
      instance.exitCode = code;
      this.emitEvent({ type: "exited", id: instance.id, code });
      instance.term.writeln("");
      instance.term.writeln(`\x1b[90m[process exited with code ${code ?? "?"} — press Enter to restart]\x1b[0m`);
      this.emit();
    });
  }

  /* ── store (useSyncExternalStore) ─────────────────────────────────────── */

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private emit() {
    this.groups = this.groups.map((group) => group.filter((id) => this.instances.has(id))).filter((group) => group.length);
    this.activeGroup = Math.min(this.activeGroup, Math.max(0, this.groups.length - 1));
    if (this.activeId && !this.instances.has(this.activeId)) this.activeId = null;
    if (!this.activeId || this.instances.get(this.activeId)?.location !== "panel") {
      this.activeId = this.groups[this.activeGroup]?.[0] ?? null;
    }
    this.snapshot = {
      instances: [...this.instances.values()].map((i) => ({
        id: i.id,
        title: i.title,
        exited: i.exited,
        location: i.location,
        hidden: i.hidden,
        pty: i.pty,
        icon: i.icon,
        color: i.color,
      })),
      groups: this.groups.map((group) => [...group]),
      activeGroup: this.activeGroup,
      activeId: this.activeId,
    };
    for (const listener of this.listeners) listener();
  }

  private emitEvent(event: TerminalEvent) {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error("terminal listener failed", error);
      }
    }
  }

  /** Terminal events (input, shell integration, close, …); returns the unsubscribe function. */
  onEvent(listener: (event: TerminalEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => void this.eventListeners.delete(listener);
  }

  /** The provider of terminal links of extensions (null: none registered, nothing is asked). */
  setLinkProvider(provider: TerminalLinkProvider | null) {
    this.linkProvider = provider;
  }

  setProfileResolver(resolver: TerminalProfileResolver | null) {
    this.profileResolver = resolver;
  }

  /** Terminal profiles extensions contribute (`contributes.terminal.profiles`); ids start with `ext:`. */
  setExtensionProfiles(profiles: { id: string; name: string }[]) {
    this.profileList = profiles;
  }

  extensionProfiles(): { id: string; name: string }[] {
    return this.profileList;
  }

  /* ── configuration ────────────────────────────────────────────────────── */

  setDefaultCwd(cwd: string | null) {
    this.defaultCwd = cwd ?? "";
  }

  /** The color theme changed: repaint every terminal. */
  setTheme() {
    const theme = terminalTheme();
    for (const instance of this.instances.values()) instance.term.options.theme = theme;
  }

  setFontSize(size: number) {
    this.fontSize = size;
    for (const instance of this.instances.values()) {
      instance.term.options.fontSize = size;
      this.fit(instance.id);
    }
  }

  /* ── lifecycle ────────────────────────────────────────────────────────── */

  /** Create a terminal; `splitWith` puts it next to that terminal in its group. */
  create(
    options: {
      profileId?: string;
      cwd?: string;
      splitWith?: string;
      location?: TerminalLocation;
      /** A custom name (kept when the shell starts). */
      title?: string;
      /** Shown until the shell starts and reports its own name (restored terminals). */
      initialTitle?: string;
      /** Extension terminals: a Pseudoterminal instead of a shell. */
      pty?: boolean;
      hidden?: boolean;
      transient?: boolean;
      /** Written to the screen before the shell starts (TerminalOptions.message). */
      message?: string;
      /** TerminalOptions beyond a profile: shell path / args / env. */
      spawn?: TerminalSpawnSpec;
      icon?: TerminalIcon;
      color?: string;
      placement?: TerminalPlacement;
    } = {},
  ): string {
    const id = String(++this.seq);
    const el = document.createElement("div");
    el.className = "terminal-instance";
    el.dataset.terminalId = id;
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
      fontSize: this.fontSize,
      lineHeight: 1.2,
      theme: terminalTheme(),
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.attachCustomKeyEventHandler((event) => this.clipboardKey(id, event));
    const instance: Instance = {
      id,
      title: options.title ?? options.initialTitle ?? "terminal",
      customTitle: !!options.title,
      profileId: options.profileId,
      // Empty: resolved when the shell starts (the workspace may open in between).
      cwd: options.cwd ?? "",
      sessionId: null,
      exited: false,
      location: options.location ?? "panel",
      el,
      term,
      fit,
      fixedSize: null,
      opened: false,
      starting: null,
      queued: "",
      pty: !!options.pty,
      hidden: !!options.hidden,
      transient: !!(options.transient || options.pty),
      spawn: options.spawn ?? null,
      icon: options.icon ?? null,
      color: options.color ?? null,
      placement: options.placement ?? null,
      interacted: false,
      exitCode: undefined,
      integration: new ShellIntegrationParser(),
    };
    this.instances.set(id, instance);
    if (options.message) term.write(`${options.message.replace(/\r?\n/g, "\r\n")}\r\n`);

    term.onData((data) => {
      if (instance.exited) {
        if (data === "\r" && !instance.pty) void this.relaunch(id);
        return;
      }
      if (!instance.interacted) {
        instance.interacted = true;
        this.emitEvent({ type: "interacted", id });
      }
      if (instance.pty) this.emitEvent({ type: "input", id, data });
      else if (instance.sessionId) void api().request.terminalWrite({ id: instance.sessionId, data });
    });
    term.onResize(({ cols, rows }) => this.emitEvent({ type: "resized", id, cols, rows }));
    term.registerLinkProvider({
      provideLinks: (row, callback) => {
        const provider = this.linkProvider;
        if (!provider) return callback(undefined);
        void this.linksOfRow(instance, row, provider).then(callback, () => callback(undefined));
      },
    });
    el.addEventListener("focusin", () => {
      if (instance.location === "panel") this.setActive(id);
    });

    if (instance.location === "panel" && !instance.hidden) {
      const groupIndex = options.splitWith ? this.groups.findIndex((group) => group.includes(options.splitWith!)) : -1;
      if (groupIndex >= 0) {
        const group = this.groups[groupIndex]!;
        group.splice(group.indexOf(options.splitWith!) + 1, 0, id);
        this.activeGroup = groupIndex;
      } else {
        this.groups.push([id]);
        this.activeGroup = this.groups.length - 1;
      }
      this.activeId = id;
    }
    this.emit();
    // A terminal nobody lists has no view that would start its shell.
    if (instance.hidden) void this.ensureSession(instance);
    return id;
  }

  /** The links of the logical (wrapped) line that buffer row `row` (1-based) belongs to. */
  private async linksOfRow(instance: Instance, row: number, provider: TerminalLinkProvider): Promise<ILink[] | undefined> {
    const buffer = instance.term.buffer.active;
    let first = row - 1;
    while (first > 0 && buffer.getLine(first)?.isWrapped) first--;
    let last = row - 1;
    while (buffer.getLine(last + 1)?.isWrapped) last++;
    const cols = instance.term.cols;
    let text = "";
    for (let index = first; index <= last; index++) text += buffer.getLine(index)?.translateToString(index === last) ?? "";
    if (!text.trim()) return undefined;
    const matches = await provider.provide(instance.id, text);
    const position = (offset: number) => ({ x: (offset % cols) + 1, y: first + Math.floor(offset / cols) + 1 });
    const links: ILink[] = [];
    for (const match of matches) {
      if (match.length <= 0) continue;
      const start = position(match.startIndex);
      const end = position(match.startIndex + match.length - 1);
      if (row < start.y || row > end.y) continue;
      links.push({
        range: { start, end },
        text: text.slice(match.startIndex, match.startIndex + match.length),
        decorations: { underline: true, pointerCursor: true },
        activate: () => provider.activate(instance.id, match.linkId),
        hover: (event) => showLinkTooltip(event, match.tooltip),
        leave: hideLinkTooltip,
      });
    }
    return links;
  }

  /** Show a terminal inside `container` (starting its shell on first use). */
  attach(id: string, container: HTMLElement) {
    const instance = this.instances.get(id);
    if (!instance) return;
    if (instance.el.parentElement !== container) container.appendChild(instance.el);
    if (!instance.opened) {
      instance.term.open(instance.el);
      instance.opened = true;
    }
    this.fit(id);
    void this.ensureSession(instance);
  }

  fit(id: string) {
    const instance = this.instances.get(id);
    if (!instance?.opened || !instance.el.isConnected || instance.el.clientWidth === 0) return;
    // A pseudo-terminal that asked for fixed dimensions keeps them.
    if (instance.fixedSize) return;
    try {
      instance.fit.fit();
    } catch {
      return;
    }
    if (instance.sessionId) {
      void api().request.terminalResize({ id: instance.sessionId, cols: instance.term.cols, rows: instance.term.rows });
    }
  }

  private ensureSession(instance: Instance): Promise<void> {
    if (instance.sessionId || instance.exited || instance.pty) return Promise.resolve();
    if (instance.starting) return instance.starting;
    instance.starting = (async () => {
      try {
        let profile = instance.profileId;
        if (profile?.startsWith(EXTENSION_PROFILE_PREFIX)) {
          // A profile an extension contributes: its provider says what to start.
          const resolved = await this.profileResolver?.(profile, instance.id).catch((error) => {
            console.error("terminal profile provider failed", error);
            return null;
          });
          if (!this.instances.has(instance.id)) return;
          if (resolved?.title && !instance.customTitle) instance.title = resolved.title;
          if (resolved?.icon) instance.icon = resolved.icon;
          if (resolved?.color) instance.color = resolved.color;
          if (resolved?.cwd) instance.cwd = resolved.cwd;
          if (resolved?.pty) {
            instance.pty = true;
            instance.transient = true;
            this.emit();
            return;
          }
          instance.spawn = { ...resolved?.spawn };
          profile = instance.spawn.profileId;
        }
        const result = await api().request.terminalCreate({
          cwd: instance.cwd || this.defaultCwd || undefined,
          cols: instance.term.cols,
          rows: instance.term.rows,
          profile: instance.spawn ? encodeSpawnSpec({ ...instance.spawn, profileId: instance.spawn.profileId ?? profile }) : profile,
        });
        if (!this.instances.has(instance.id)) {
          void api().request.terminalKill({ id: result.id });
          return;
        }
        instance.sessionId = result.id;
        instance.cwd = result.cwd;
        this.bySession.set(result.id, instance);
        if (instance.queued) {
          void api().request.terminalWrite({ id: result.id, data: instance.queued });
          instance.queued = "";
        }
        if (!instance.customTitle) instance.title = result.profile || basename(result.shell).replace(/\.exe$/i, "");
        instance.integration = new ShellIntegrationParser(result.nonce);
        this.fit(instance.id);
        this.emit();
        this.emitEvent({ type: "started", id: instance.id, pid: (result as { pid?: number }).pid, shell: result.shell });
      } catch (error) {
        console.error("Failed to start terminal", error);
        instance.term.writeln("\x1b[31mFailed to start the shell.\x1b[0m");
      } finally {
        instance.starting = null;
      }
    })();
    return instance.starting;
  }

  /** Start a fresh shell in an exited (or running) terminal. */
  async relaunch(id: string) {
    const instance = this.instances.get(id);
    if (!instance || instance.pty) return;
    if (instance.sessionId) {
      this.bySession.delete(instance.sessionId);
      await api()
        .request.terminalKill({ id: instance.sessionId })
        .catch(() => {});
      instance.sessionId = null;
    }
    instance.exited = false;
    instance.term.reset();
    await this.ensureSession(instance);
    instance.term.focus();
    this.emit();
  }

  /** Type into a terminal; text sent before its shell starts is queued. */
  sendText(id: string, text: string) {
    const instance = this.instances.get(id);
    if (!instance) return;
    if (instance.pty) this.emitEvent({ type: "input", id, data: text });
    else if (instance.sessionId) void api().request.terminalWrite({ id: instance.sessionId, data: text });
    else instance.queued += text;
  }

  kill(id: string) {
    const instance = this.instances.get(id);
    if (!instance) return;
    this.emitEvent({ type: "closed", id, code: instance.exitCode });
    if (instance.sessionId) {
      this.bySession.delete(instance.sessionId);
      void api()
        .request.terminalKill({ id: instance.sessionId })
        .catch(() => {});
    }
    instance.term.dispose();
    instance.el.remove();
    this.instances.delete(id);
    this.emit();
  }

  clear(id: string | null) {
    const instance = id ? this.instances.get(id) : null;
    instance?.term.clear();
    instance?.term.focus();
  }

  focus(id: string | null) {
    const instance = id ? this.instances.get(id) : null;
    // The element may have just been attached: focus on the next frame.
    if (instance) requestAnimationFrame(() => instance.term.focus());
  }

  /* ── clipboard ────────────────────────────────────────────────────────── */

  hasSelection(id: string | null): boolean {
    return !!(id && this.instances.get(id)?.term.hasSelection());
  }

  /** Copy the selected text (and clear the selection, like VS Code). False when nothing is selected. */
  copySelection(id: string | null): boolean {
    const instance = id ? this.instances.get(id) : null;
    const text = instance?.term.getSelection();
    if (!instance || !text) return false;
    void navigator.clipboard.writeText(text).catch(() => {});
    instance.term.clearSelection();
    return true;
  }

  /** Paste the clipboard as input (bracketed when the shell asked for it). */
  async paste(id: string | null): Promise<void> {
    const instance = id ? this.instances.get(id) : null;
    if (!instance) return;
    const text = await navigator.clipboard.readText().catch(() => "");
    if (text) instance.term.paste(text);
    instance.term.focus();
  }

  /**
   * The terminal's clipboard keys, as in VS Code: Ctrl+C copies when text is selected
   * (and stays ^C otherwise), Ctrl+Shift+C / Ctrl+Insert copy, Ctrl+V / Ctrl+Shift+V /
   * Shift+Insert paste; Cmd+C / Cmd+V on macOS. False: xterm does not see the key.
   */
  private clipboardKey(id: string, event: KeyboardEvent): boolean {
    if (event.type !== "keydown" || event.altKey) return true;
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey !== event.metaKey && (event.ctrlKey || event.metaKey);
    const copy = (mod && key === "c") || (event.ctrlKey && !event.shiftKey && key === "insert");
    const paste = (mod && key === "v") || (event.shiftKey && !event.ctrlKey && !event.metaKey && key === "insert");
    if (copy) {
      // Ctrl+C without a selection is the interrupt; Ctrl+Shift+C without one does nothing.
      if (!this.hasSelection(id) && event.ctrlKey && !event.shiftKey && key === "c") return true;
      event.preventDefault();
      this.copySelection(id);
      return false;
    }
    if (paste) {
      event.preventDefault();
      void this.paste(id);
      return false;
    }
    return true;
  }

  rename(id: string, title: string) {
    const instance = this.instances.get(id);
    if (!instance || !title.trim()) return;
    instance.title = title.trim();
    instance.customTitle = true;
    this.emit();
  }

  /* ── extension terminals ──────────────────────────────────────────────── */

  /** Text written by an extension's Pseudoterminal. */
  writeData(id: string, data: string) {
    this.instances.get(id)?.term.write(data);
  }

  /** Pseudoterminal.onDidOverrideDimensions: show the terminal at exactly this size (null: fit to the view again). */
  overrideDimensions(id: string, size: { cols: number; rows: number } | null) {
    const instance = this.instances.get(id);
    if (!instance) return;
    instance.fixedSize = size;
    if (size) instance.term.resize(Math.max(2, size.cols), Math.max(1, size.rows));
    else this.fit(id);
  }

  size(id: string): { cols: number; rows: number } | null {
    const instance = this.instances.get(id);
    return instance ? { cols: instance.term.cols, rows: instance.term.rows } : null;
  }

  /** Let a hidden terminal (TerminalOptions.hideFromUser) show up in the panel. */
  reveal(id: string) {
    const instance = this.instances.get(id);
    if (!instance?.hidden) return;
    instance.hidden = false;
    if (instance.location === "panel") {
      this.groups.push([id]);
      this.activeGroup = this.groups.length - 1;
      this.activeId = id;
    }
    this.emit();
  }

  /** A name an extension gave (Pseudoterminal.onDidChangeName); the user's own name wins. */
  setTitle(id: string, title: string) {
    const instance = this.instances.get(id);
    if (!instance || instance.customTitle) return;
    instance.title = title;
    this.emit();
  }

  /** Has the terminal's shell reported itself through shell integration sequences? */
  integrationDetected(id: string): boolean {
    return !!this.instances.get(id)?.integration.detected;
  }

  setActive(id: string) {
    const groupIndex = this.groups.findIndex((group) => group.includes(id));
    if (groupIndex < 0) return;
    if (this.activeId === id && this.activeGroup === groupIndex) return;
    this.activeGroup = groupIndex;
    this.activeId = id;
    this.emit();
  }

  /** Focus the next / previous panel terminal (across groups). */
  cycle(step: 1 | -1) {
    const order = this.groups.flat();
    if (!order.length) return null;
    const index = this.activeId ? order.indexOf(this.activeId) : -1;
    const next = order[(index + step + order.length) % order.length]!;
    this.setActive(next);
    this.focus(next);
    return next;
  }

  /** Move a terminal out of its split group into a group of its own. */
  unsplit(id: string) {
    const groupIndex = this.groups.findIndex((group) => group.includes(id));
    if (groupIndex < 0 || this.groups[groupIndex]!.length < 2) return;
    this.groups[groupIndex] = this.groups[groupIndex]!.filter((entry) => entry !== id);
    this.groups.splice(groupIndex + 1, 0, [id]);
    this.activeGroup = groupIndex + 1;
    this.activeId = id;
    this.emit();
  }

  /** Join a terminal to another terminal's group (drag & drop in the list). */
  joinGroup(id: string, target: string) {
    if (id === target) return;
    const instance = this.instances.get(id);
    if (!instance) return;
    instance.location = "panel";
    this.groups = this.groups.map((group) => group.filter((entry) => entry !== id));
    const group = this.groups.find((entry) => entry.includes(target));
    if (!group) return;
    group.push(id);
    this.activeGroup = this.groups.indexOf(group);
    this.activeId = id;
    this.emit();
  }

  moveToEditor(id: string) {
    const instance = this.instances.get(id);
    if (!instance) return;
    instance.location = "editor";
    this.groups = this.groups.map((group) => group.filter((entry) => entry !== id));
    this.emit();
  }

  moveToPanel(id: string) {
    const instance = this.instances.get(id);
    if (!instance) return;
    instance.location = "panel";
    this.groups.push([id]);
    this.activeGroup = this.groups.length - 1;
    this.activeId = id;
    this.emit();
  }

  /** What is needed to recreate a terminal (per-project layout); null for one that cannot be recreated (extension pseudo-terminals). */
  describe(id: string): { profileId?: string; cwd?: string; title?: string; name?: string } | null {
    const instance = this.instances.get(id);
    if (!instance || instance.transient) return null;
    return {
      profileId: instance.profileId,
      cwd: instance.cwd || undefined,
      title: instance.customTitle ? instance.title : undefined,
      name: instance.title,
    };
  }

  /** Where the editor tab of a new terminal goes (once: later moves are the user's). */
  takePlacement(id: string): TerminalPlacement | null {
    const instance = this.instances.get(id);
    const placement = instance?.placement ?? null;
    if (instance) instance.placement = null;
    return placement;
  }

  info(id: string): TerminalInfo | null {
    return this.snapshot.instances.find((instance) => instance.id === id) ?? null;
  }

  disposeAll() {
    for (const id of [...this.instances.keys()]) this.kill(id);
  }
}

export const terminalService = new TerminalService();

export const TERMINAL_TAB_PREFIX = "terminal:";

export function isTerminalTab(path: string | null | undefined): path is string {
  return !!path && path.startsWith(TERMINAL_TAB_PREFIX);
}

export function terminalTabPath(id: string) {
  return `${TERMINAL_TAB_PREFIX}${id}`;
}

export function terminalIdOf(path: string) {
  return path.slice(TERMINAL_TAB_PREFIX.length);
}

onColorThemeChange(() => terminalService.setTheme());
