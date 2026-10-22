import { EXTENSION_PROFILE_PREFIX, terminalService, type TerminalEvent, type TerminalIcon } from "../lib/terminals";
import { showContextMenu } from "../lib/context-menu";
import type { ViewFeature, ViewFeatureApi } from "./types";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  ResolvedProfileWire,
  TerminalHostMessage,
  TerminalIconWire,
  TerminalLinkWire,
  TerminalViewMessage,
} from "../../shared/terminal-protocol";
import type { TerminalSpawnSpec } from "../../shared/terminal-spawn";

/**
 * Window side of the "terminal" area. The terminals themselves live in
 * lib/terminals.ts; this connects them to the extension host: every terminal
 * gets a `Terminal` object there, pseudo-terminal output / input, shell
 * integration events, link providers and extension terminal profiles.
 */

let wired = false;
let hostReady = false;
/** Terminals the host knows about, with the title it last heard. */
const announced = new Map<string, string>();
/** True while `create` runs: the terminal it makes is reported by the host's own request, not as "opened". */
let creating = false;

/** A fix an extension's terminal quick fix provider returned (terminal/quickfix.ts). */
type TerminalQuickFixWire = { fixId: string; label: string; kind: "default" | "explain" };
/** `host.postFeature` message of the "terminal" area: the fixes to show for a terminal. */
type TerminalQuickFixMessage = { kind: "quickFixes"; id: string; fixes: TerminalQuickFixWire[] };

/** Fixes waiting in a terminal, until a new command starts or one is picked. */
const quickFixes = new Map<string, TerminalQuickFixWire[]>();
let lightbulb: HTMLButtonElement | null = null;
let lightbulbTerminal: string | null = null;

function removeLightbulb() {
  lightbulb?.remove();
  lightbulb = null;
  lightbulbTerminal = null;
}

/** The terminal whose fixes to show: the active one, else the first with fixes. */
function terminalWithFixes(): string | undefined {
  const snapshot = terminalService.getSnapshot();
  const withFixes = snapshot.instances.filter((instance) => !instance.hidden && quickFixes.get(instance.id)?.length);
  return (withFixes.find((instance) => instance.id === snapshot.activeId) ?? withFixes[0])?.id;
}

/** The lightbulb lives in the terminal's own host element (the terminal can move between panel and editor). */
function updateLightbulb(api: ViewFeatureApi) {
  const terminalId = terminalWithFixes();
  if (!terminalId) {
    removeLightbulb();
    return;
  }
  const terminalElement = [...document.querySelectorAll<HTMLElement>(".terminal-instance")].find((element) => element.dataset.terminalId === terminalId);
  const host = terminalElement?.parentElement;
  if (!host) {
    removeLightbulb();
    return;
  }
  if (!lightbulb) {
    lightbulb = document.createElement("button");
    lightbulb.type = "button";
    lightbulb.className = "terminal-quickfix-lightbulb";
    lightbulb.title = "Show Quick Fixes";
    lightbulb.textContent = "💡";
    lightbulb.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (lightbulbTerminal) showQuickFixMenu(api, lightbulbTerminal);
    });
  }
  lightbulbTerminal = terminalId;
  if (lightbulb.parentElement !== host) host.appendChild(lightbulb);
}

function showQuickFixMenu(api: ViewFeatureApi, terminalId: string) {
  const fixes = quickFixes.get(terminalId) ?? [];
  if (!fixes.length) return;
  const rect = lightbulb?.getBoundingClientRect();
  const x = rect ? Math.min(rect.right, window.innerWidth - 8) : window.innerWidth / 2;
  const y = rect ? Math.min(rect.bottom + 4, window.innerHeight - 8) : window.innerHeight / 2;
  void showContextMenu(
    x,
    y,
    fixes.map((fix) => ({ type: "item" as const, label: fix.label, action: fix.fixId })),
  ).then((fixId) => {
    if (!fixId) return;
    // The host runs the fix; the menu is gone until the next command matches.
    quickFixes.delete(terminalId);
    updateLightbulb(api);
    void api.requestHost("quickFix", [terminalId, fixId]).catch((error) => console.error("terminal quick fix failed", error));
  });
}

function toIcon(wire: TerminalIconWire | undefined): TerminalIcon | undefined {
  return wire;
}

/** A theme color id (`terminal.ansiRed`) or a CSS color. */
function cssColor(api: ViewFeatureApi, color: string | undefined): string | undefined {
  if (!color) return undefined;
  if (/^(#|rgb|hsl|var\()/i.test(color)) return color;
  return api.theme.color(color);
}

/** The extension profiles the installed extensions contribute (`contributes.terminal.profiles`). */
function contributedProfiles(api: ViewFeatureApi): { id: string; name: string }[] {
  const profiles: { id: string; name: string }[] = [];
  for (const extension of api.getExtensions()) {
    const contributed = (extension.manifest.contributes as { terminal?: { profiles?: { id?: string; title?: string }[] } } | undefined)?.terminal?.profiles;
    if (!Array.isArray(contributed)) continue;
    for (const profile of contributed) {
      if (typeof profile?.id === "string" && profile.id)
        profiles.push({ id: `${EXTENSION_PROFILE_PREFIX}${profile.id}`, name: String(profile.title ?? profile.id) });
    }
  }
  return profiles;
}

function send(api: ViewFeatureApi, message: TerminalViewMessage) {
  if (hostReady) api.sendToHost(message);
}

function forward(api: ViewFeatureApi, event: TerminalEvent) {
  switch (event.type) {
    case "input":
      send(api, { kind: "input", id: event.id, data: event.data });
      return;
    case "interacted":
      send(api, { kind: "interacted", id: event.id });
      return;
    case "resized":
      send(api, { kind: "resized", id: event.id, cols: event.cols, rows: event.rows });
      return;
    case "shell":
      send(api, { kind: "shell", id: event.id, event: event.event });
      return;
    case "started":
      quickFixes.delete(event.id);
      updateLightbulb(api);
      send(api, { kind: "started", id: event.id, pid: event.pid, shell: event.shell });
      return;
    case "exited":
      send(api, { kind: "exited", id: event.id, code: event.code });
      return;
    case "closed":
      announced.delete(event.id);
      quickFixes.delete(event.id);
      updateLightbulb(api);
      send(api, { kind: "closed", id: event.id, code: event.code });
      return;
  }
}

/** Tell the host about terminals it does not know yet and about renames. */
function sync(api: ViewFeatureApi) {
  if (!hostReady || creating) return;
  const instances = terminalService.getSnapshot().instances;
  for (const instance of instances) {
    const known = announced.get(instance.id);
    if (known === undefined) {
      announced.set(instance.id, instance.title);
      send(api, { kind: "opened", id: instance.id, name: instance.title, location: instance.location });
    } else if (known !== instance.title) {
      announced.set(instance.id, instance.title);
      send(api, { kind: "name", id: instance.id, name: instance.title });
    }
  }
}

function wire(api: ViewFeatureApi) {
  if (wired) return;
  wired = true;
  terminalService.onEvent((event) => forward(api, event));
  terminalService.subscribe(() => sync(api));
  terminalService.subscribe(() => updateLightbulb(api));
  terminalService.setProfileResolver(async (profileId, terminalId) => {
    const resolved = await api.requestHost<ResolvedProfileWire | null>("resolveProfile", [profileId, terminalId, terminalService.size(terminalId)]);
    if (!resolved) return null;
    return { ...resolved, icon: toIcon(resolved.icon), color: cssColor(api, resolved.color) };
  });
  const refreshProfiles = () => terminalService.setExtensionProfiles(contributedProfiles(api));
  refreshProfiles();
  api.onSettingsChange(refreshProfiles);
}

/** What `create` needs from the settings: the default profile applies to extension terminals too. */
function defaultSpawn(api: ViewFeatureApi, spawn: TerminalSpawnSpec | undefined): { spawn?: TerminalSpawnSpec; profileId?: string } {
  const profileId = (api.getSettings()["terminal.integrated.defaultProfile"] as string | undefined) || undefined;
  if (spawn?.shellPath) return { spawn };
  if (!spawn) return { profileId };
  return { spawn: { ...spawn, profileId: spawn.profileId ?? profileId } };
}

function create(request: CreateTerminalRequest, api: ViewFeatureApi): CreateTerminalResponse {
  creating = true;
  let id: string;
  try {
    const profile = request.pty ? {} : defaultSpawn(api, request.spawn);
    id = terminalService.create({
      title: request.name,
      cwd: request.cwd,
      location: request.location,
      splitWith: request.splitWith,
      pty: request.pty,
      hidden: request.hidden,
      transient: request.transient,
      message: request.message,
      icon: toIcon(request.icon),
      color: cssColor(api, request.color),
      placement: request.location === "editor" ? { viewColumn: request.viewColumn, preserveFocus: request.preserveFocus } : undefined,
      ...profile,
    });
  } finally {
    creating = false;
  }
  announced.set(id, terminalService.info(id)?.title ?? request.name ?? "terminal");
  const size = terminalService.size(id) ?? { cols: 80, rows: 24 };
  return { id, ...size };
}

export const terminalView: ViewFeature = {
  area: "terminal",

  init(api) {
    wire(api);
  },

  onHostReady(api) {
    wire(api);
    // A (re)started host knows no terminals and no link providers.
    hostReady = true;
    announced.clear();
    quickFixes.clear();
    removeLightbulb();
    terminalService.setLinkProvider(null);
    terminalService.setExtensionProfiles(contributedProfiles(api));
    sync(api);
  },

  onHostMessage(payload, api) {
    const message = payload as TerminalHostMessage | TerminalQuickFixMessage;
    switch (message.kind) {
      case "write":
        terminalService.writeData(message.id, message.data);
        return;
      case "dimensions":
        terminalService.overrideDimensions(message.id, message.cols && message.rows ? { cols: message.cols, rows: message.rows } : null);
        return;
      case "title":
        terminalService.setTitle(message.id, message.title);
        return;
      case "linkProviders":
        terminalService.setLinkProvider(
          message.count > 0
            ? {
                provide: (terminalId, line) => api.requestHost<TerminalLinkWire[]>("links", [terminalId, line]),
                activate: (terminalId, linkId) => api.sendToHost({ kind: "linkActivated", id: terminalId, linkId } satisfies TerminalViewMessage),
              }
            : null,
        );
        return;
      case "quickFixes":
        if (message.fixes.length) quickFixes.set(message.id, message.fixes);
        else quickFixes.delete(message.id);
        updateLightbulb(api);
        return;
    }
  },

  onHostRequest(method, args, api) {
    switch (method) {
      case "create":
        return create(args[0] as CreateTerminalRequest, api);
      case "reveal":
        terminalService.reveal(String(args[0]));
        return true;
      default:
        throw new Error(`terminal: unknown request '${method}'`);
    }
  },

  commands: [
    {
      id: "workbench.action.terminal.newWithExtensionProfile",
      title: "Create New Terminal (With Extension Profile)",
      category: "Terminal",
      enabled: () => terminalService.extensionProfiles().length > 0,
      async run(api) {
        const profiles = terminalService.extensionProfiles();
        const picked = await api.showQuickPick(
          profiles.map((profile) => ({ label: profile.name, description: profile.id.slice(EXTENSION_PROFILE_PREFIX.length) })),
          { title: "Select a terminal profile", placeholder: "Select a terminal profile" },
        );
        const profile = picked?.[0] !== undefined ? profiles[picked[0]] : undefined;
        if (!profile) return;
        const id = terminalService.create({ profileId: profile.id });
        // The host asks the workbench to show the panel with this terminal (its terminalShow request).
        await api.requestHost("show", [id]).catch(() => {});
      },
    },
    {
      id: "workbench.action.terminal.showQuickFixes",
      title: "Show Terminal Quick Fixes",
      category: "Terminal",
      enabled: () => terminalWithFixes() !== undefined,
      run(api) {
        const terminalId = terminalWithFixes();
        if (terminalId) showQuickFixMenu(api, terminalId);
      },
    },
  ],
};
