import { spawnSync } from "child_process";
import { processTree, type ProcessInfo } from "@lumen/shell/main";
import { getHeapStatistics } from "v8";
import type { ProcessRow } from "../shared/types.ts";

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

function describe(info: ProcessInfo, terminals: Map<number, string>): Pick<ProcessRow, "label" | "kind"> {
  if (info.parentPid === null) return { label: "Lumen", kind: "app" };
  const terminal = terminals.get(info.pid);
  if (terminal) return { label: `Terminal: ${terminal}`, kind: "terminal" };
  const name = info.name.toLowerCase();
  if (name === "msedgewebview2.exe") return { label: webviewLabel(info.commandLine), kind: "webview" };
  if (name === "openconsole.exe" || name === "conhost.exe") return { label: "Console host", kind: "process" };
  return { label: info.name.replace(/\.exe$/i, ""), kind: "process" };
}

export async function listProcesses(options: {
  threads: ThreadSource[];
  terminals: { pid: number; label: string }[];
}): Promise<ProcessRow[]> {
  const [tree, heaps] = await Promise.all([
    processTree(),
    Promise.all(options.threads.map((thread) => thread.heapUsed().catch(() => null))),
  ]);
  const terminals = new Map(options.terminals.map((terminal) => [terminal.pid, terminal.label]));
  known = new Set(tree.filter((info) => info.parentPid !== null).map((info) => info.pid));

  const rows: ProcessRow[] = tree.map((info) => ({
    id: String(info.pid),
    parent: info.parentPid === null ? null : String(info.parentPid),
    pid: info.pid,
    ...describe(info, terminals),
    commandLine: info.commandLine,
    memory: info.memory,
    cpu: info.cpu,
  }));

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
