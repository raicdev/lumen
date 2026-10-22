import { spawnSync } from "child_process";
import { processTree, type ProcessInfo, type WebviewProcessFrames } from "@lumen/shell/main";
import { getHeapStatistics } from "v8";
import type { ProcessRow } from "../shared/types.ts";
import { webviewLabel as extensionWebviewLabel } from "../shared/webview-document.ts";

/**
 * Process Explorer: the app's process tree with a purpose for each process.
 * Task Manager shows the WebView2 processes as a separate "WebView2 Manager"
 * group (WebView2Feedback#5628), so this is where they are tied back to Lumen.
 */

export type ThreadSource = { label: string; heapUsed: () => Promise<number | null> };

const WEBVIEW_TYPES: Record<string, string> = {
  "gpu-process": "GPU",
  renderer: "Renderer",
  "crashpad-handler": "Crash reporter",
};

const UTILITY_TYPES: Record<string, string> = {
  "network.mojom.NetworkService": "Network service",
  "storage.mojom.StorageService": "Storage service",
  "audio.mojom.AudioService": "Audio service",
  "video_capture.mojom.VideoCaptureService": "Video capture service",
  "data_decoder.mojom.DataDecoderService": "Data decoder",
};

/** Pids listed by the last call: only those may be ended. */
let known = new Set<number>();

function webviewLabel(commandLine: string): string {
  const type = /--type=([\w-]+)/.exec(commandLine)?.[1];
  if (!type) return "WebView2: Browser";
  if (type === "utility") {
    const subType = /--utility-sub-type=([\w.]+)/.exec(commandLine)?.[1] ?? "";
    return `WebView2: ${UTILITY_TYPES[subType] ?? "Utility"}`;
  }
  return `WebView2: ${WEBVIEW_TYPES[type] ?? type}`;
}

type Context = {
  terminals: Map<number, string>;
  /** pid → extension that started it. */
  extensionProcesses: Map<number, string>;
  /** Renderer pid → what its frames show: an extension, or Lumen's own window. */
  renderers: Map<number, string[]>;
};

const APP_WINDOW = "\0window";

function describe(info: ProcessInfo, context: Context): Pick<ProcessRow, "label" | "kind" | "extension"> {
  if (info.parentPid === null) return { label: "Lumen", kind: "app", extension: null };
  const terminal = context.terminals.get(info.pid);
  if (terminal) return { label: `Terminal: ${terminal}`, kind: "terminal", extension: null };
  const name = info.name.toLowerCase();
  if (name === "msedgewebview2.exe") {
    const shows = context.renderers.get(info.pid) ?? [];
    const extensions = shows.filter((entry) => entry !== APP_WINDOW);
    const label = webviewLabel(info.commandLine);
    if (extensions.length) return { label: `${label} (extension webview)`, kind: "webview", extension: extensions.join(", ") };
    return { label: shows.includes(APP_WINDOW) ? `${label} (Lumen window)` : label, kind: "webview", extension: null };
  }
  const extension = context.extensionProcesses.get(info.pid) ?? null;
  if (name === "openconsole.exe" || name === "conhost.exe") return { label: "Console host", kind: "process", extension };
  return { label: info.name.replace(/\.exe$/i, ""), kind: "process", extension };
}

/** How long before its shell a terminal's console host may start (they are spawned back to back). */
const CONSOLE_HOST_LEAD_MS = 5000;

/**
 * node-pty starts a terminal's pseudoconsole host (OpenConsole.exe) and then
 * its shell, both as children of the app, with nothing linking the two. Put
 * each console host under the shell started right after it, so a terminal
 * reads as one entry.
 */
function attachConsoleHosts(rows: ProcessRow[], tree: ProcessInfo[]): void {
  const info = new Map(tree.map((entry) => [String(entry.pid), entry]));
  const isConsoleHost = (row: ProcessRow) => /^(openconsole|conhost)\.exe$/i.test(info.get(row.id)?.name ?? "");
  const free = new Set(rows.filter(isConsoleHost));
  for (const terminal of rows.filter((row) => row.kind === "terminal")) {
    const shellStart = info.get(terminal.id)?.startTime ?? 0;
    let best: ProcessRow | null = null;
    let bestLead = CONSOLE_HOST_LEAD_MS;
    for (const host of free) {
      if (host.parent !== terminal.parent) continue;
      const lead = shellStart - (info.get(host.id)?.startTime ?? 0);
      if (lead >= 0 && lead < bestLead) {
        best = host;
        bestLead = lead;
      }
    }
    if (!best) continue;
    free.delete(best);
    best.parent = terminal.id;
    best.kind = "terminal";
  }
}

/** What each WebView2 renderer shows: the extensions whose webview origin its frames load, or the window itself. */
function rendererOwners(frames: WebviewProcessFrames[] | null, extensions: { id: string; name: string }[]): Map<number, string[]> {
  const byLabel = new Map(extensions.map((extension) => [extensionWebviewLabel(extension.id), extension.name]));
  const owners = new Map<number, string[]>();
  for (const entry of frames ?? []) {
    const shows = new Set<string>();
    for (const frame of entry.frames) {
      let host = "";
      try {
        host = new URL(frame.source).hostname;
      } catch {
        continue;
      }
      const name = host.endsWith(".localhost") ? byLabel.get(host.slice(0, -".localhost".length)) : undefined;
      if (name) shows.add(name);
      else if (host === "127.0.0.1" || host === "localhost") shows.add(APP_WINDOW);
    }
    if (shows.size) owners.set(entry.pid, [...shows]);
  }
  return owners;
}

export async function listProcesses(options: {
  threads: ThreadSource[];
  terminals: { pid: number; label: string }[];
  /** Installed extensions (ids and display names). */
  extensions: { id: string; name: string }[];
  /** pid → id of the extension that started it, for the processes still alive. */
  extensionProcesses: (alive: Set<number>) => Map<number, string>;
  /** WebView2 processes and the frames each one renders (null where unsupported). */
  webviewFrames: () => Promise<WebviewProcessFrames[] | null>;
}): Promise<ProcessRow[]> {
  const [tree, heaps, frames] = await Promise.all([
    processTree(),
    Promise.all(options.threads.map((thread) => thread.heapUsed().catch(() => null))),
    options.webviewFrames().catch(() => null),
  ]);
  known = new Set(tree.filter((info) => info.parentPid !== null).map((info) => info.pid));
  const names = new Map(options.extensions.map((extension) => [extension.id.toLowerCase(), extension.name]));
  const context: Context = {
    terminals: new Map(options.terminals.map((terminal) => [terminal.pid, terminal.label])),
    extensionProcesses: new Map(
      [...options.extensionProcesses(known)].map(([pid, id]) => [pid, names.get(id.toLowerCase()) ?? id]),
    ),
    renderers: rendererOwners(frames, options.extensions),
  };

  const rows: ProcessRow[] = tree.map((info) => ({
    id: String(info.pid),
    parent: info.parentPid === null ? null : String(info.parentPid),
    pid: info.pid,
    ...describe(info, context),
    commandLine: info.commandLine,
    memory: info.memory,
    cpu: info.cpu,
  }));
  attachConsoleHosts(rows, tree);

  // Worker threads share the app's process: their JS heaps show what it is made of.
  const app = String(process.pid);
  const threads = [{ label: "Main thread", heap: getHeapStatistics().used_heap_size }].concat(
    options.threads.map((thread, index) => ({ label: thread.label, heap: heaps[index] ?? -1 })),
  );
  for (const thread of threads) {
    if (thread.heap < 0) continue;
    rows.push({
      id: `thread:${thread.label}`,
      parent: app,
      pid: null,
      label: `${thread.label} (JS heap)`,
      kind: "thread",
      extension: null,
      commandLine: "",
      memory: thread.heap,
      cpu: null,
    });
  }
  return rows;
}

/** End a process listed by the last `listProcesses()` together with its children. */
export function killProcess(pid: number): { ok: boolean; error?: string } {
  if (!known.has(pid)) return { ok: false, error: "not a process of this app" };
  try {
    if (process.platform === "win32") {
      const result = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
      if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout).trim() || "taskkill failed" };
    } else {
      process.kill(pid);
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
