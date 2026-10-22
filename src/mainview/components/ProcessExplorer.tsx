import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, CircleX, Pause, Play, Puzzle, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ProcessRow } from "../../shared/types";
import { showDialog } from "../lib/dialog";
import { api } from "../lib/rpc";

type Props = {
  open: boolean;
  onClose: () => void;
};

const REFRESH_MS = 1500;

/** Where a process's memory is counted in the summary. */
const CATEGORIES = [
  { id: "app", label: "Lumen" },
  { id: "webview", label: "WebView2" },
  { id: "extension", label: "Extensions" },
  { id: "terminal", label: "Terminals" },
  { id: "process", label: "Other processes" },
] as const;

type Category = (typeof CATEGORIES)[number]["id"];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatCpu(cpu: number | null): string {
  return cpu === null ? "—" : `${cpu.toFixed(1)}%`;
}

/** A row with the processes nested in it: thread rows are already part of their process, so they add nothing. */
type Usage = { memory: number; cpu: number | null };

type TreeEntry = { row: ProcessRow; depth: number; descendants: number; collapsed: boolean; total: Usage };

/**
 * Rows in tree order (children by memory with what is nested in them, largest
 * first), with their depth. The descendants of a collapsed row are left out.
 */
function treeOrder(rows: ProcessRow[], isCollapsed: (row: ProcessRow) => boolean): TreeEntry[] {
  const children = new Map<string | null, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.parent) ?? [];
    list.push(row);
    children.set(row.parent, list);
  }
  const totals = new Map<string, Usage>();
  const totalOf = (row: ProcessRow): Usage => {
    const known = totals.get(row.id);
    if (known) return known;
    const total: Usage = { memory: row.memory, cpu: row.cpu };
    for (const child of children.get(row.id) ?? []) {
      if (child.kind === "thread") continue;
      const nested = totalOf(child);
      total.memory += nested.memory;
      if (nested.cpu !== null) total.cpu = (total.cpu ?? 0) + nested.cpu;
    }
    totals.set(row.id, total);
    return total;
  };
  for (const list of children.values()) {
    // Threads first: they are part of the parent process, not children of it.
    list.sort((a, b) => Number(b.kind === "thread") - Number(a.kind === "thread") || totalOf(b).memory - totalOf(a).memory);
  }
  const countDescendants = (row: ProcessRow): number => (children.get(row.id) ?? []).reduce((sum, child) => sum + 1 + countDescendants(child), 0);
  const out: TreeEntry[] = [];
  const visit = (row: ProcessRow, depth: number) => {
    const descendants = countDescendants(row);
    const collapsed = descendants > 0 && isCollapsed(row);
    out.push({ row, depth, descendants, collapsed, total: totalOf(row) });
    if (collapsed) return;
    for (const child of children.get(row.id) ?? []) visit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  return out;
}

/** Terminals start collapsed: the shell's own process tree (node, compilers, ...) is deep and noisy. */
function collapsedByDefault(row: ProcessRow): boolean {
  return row.kind === "terminal";
}

/**
 * A process counts toward its nearest ancestor (or itself) that works for an
 * extension, is WebView2, or is a terminal; the rest are "other".
 */
function categoryOf(row: ProcessRow, byId: Map<string, ProcessRow>): Category {
  if (row.kind === "app") return "app";
  for (let current: ProcessRow | undefined = row; current; current = current.parent ? byId.get(current.parent) : undefined) {
    if (current.extension) return "extension";
    if (current.kind === "webview" || current.kind === "terminal") return current.kind;
  }
  return "process";
}

/** The extension a row works for, its own or an ancestor's (children of an extension's process). */
function extensionOf(row: ProcessRow, byId: Map<string, ProcessRow>): string | null {
  for (let current: ProcessRow | undefined = row; current && current.kind !== "app"; current = current.parent ? byId.get(current.parent) : undefined) {
    if (current.extension) return current.extension;
  }
  return null;
}

/** Process Explorer: what Lumen is running and how much memory / CPU each part uses. */
export function ProcessExplorer({ open, onClose }: Props) {
  const [rows, setRows] = useState<ProcessRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  /** Rows the user opened or closed; the others follow collapsedByDefault. */
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());

  useEffect(() => {
    if (!open) return;
    setRows([]);
    setError(null);
    setPaused(false);
    setToggled(new Map());
  }, [open]);

  useEffect(() => {
    if (!open || paused) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const result = await api().request.processList({});
        if (!cancelled) {
          setRows(result.rows);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, paused]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const ordered = useMemo(() => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const isCollapsed = (row: ProcessRow) => toggled.get(row.id) ?? collapsedByDefault(row);
    return treeOrder(rows, isCollapsed).map((entry) => ({ ...entry, category: categoryOf(entry.row, byId), extension: extensionOf(entry.row, byId) }));
  }, [rows, toggled]);

  const toggle = (entry: TreeEntry) => setToggled((map) => new Map(map).set(entry.row.id, !entry.collapsed));
  /** Open or close every row with children (the app row stays open, or nothing would be listed). */
  const setAll = (collapsed: boolean) => setToggled(new Map(rows.filter((row) => row.parent !== null).map((row) => [row.id, collapsed])));

  const summary = useMemo(() => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const totals = new Map<Category, number>(CATEGORIES.map((category) => [category.id, 0]));
    let memory = 0;
    let cpu = 0;
    let measured = false;
    for (const row of rows) {
      if (row.kind === "thread") continue;
      memory += row.memory;
      if (row.cpu !== null) {
        cpu += row.cpu;
        measured = true;
      }
      const category = categoryOf(row, byId);
      totals.set(category, (totals.get(category) ?? 0) + row.memory);
    }
    return { memory, cpu: measured ? cpu : null, totals };
  }, [rows]);

  const endProcess = async (row: ProcessRow) => {
    if (row.pid === null) return;
    const choice = await showDialog({
      title: "End Process",
      message: `End "${row.label}" (PID ${row.pid}) and the processes it started?`,
      detail:
        row.kind === "webview"
          ? "Lumen's window is drawn by WebView2: ending this process can leave the window blank until it is reloaded."
          : "Unsaved work in that process is lost.",
      buttons: [
        { label: "Cancel", value: "cancel" },
        { label: "End Process", value: "end", role: "danger" },
      ],
    });
    if (choice !== "end") return;
    const result = await api().request.processKill({ pid: row.pid });
    if (!result.ok) setError(result.error ?? "could not end the process");
  };

  if (!open) return null;

  return (
    <div className="modal-overlay settings-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-editor process-explorer" role="dialog" aria-label="Process Explorer">
        <div className="settings-header">
          <h2>Process Explorer</h2>
          <div className="process-summary">
            <span>
              Memory <strong>{formatBytes(summary.memory)}</strong>
            </span>
            <span>
              CPU <strong>{formatCpu(summary.cpu)}</strong>
            </span>
            {CATEGORIES.map((category) => (
              <span key={category.id} className={`process-chip process-kind-${category.id}`}>
                {category.label} {formatBytes(summary.totals.get(category.id) ?? 0)}
              </span>
            ))}
          </div>
          <button type="button" className="icon-btn" title="Expand All" onClick={() => setAll(false)}>
            <ChevronsUpDown size={16} />
          </button>
          <button type="button" className="icon-btn" title="Collapse All" onClick={() => setAll(true)}>
            <ChevronsDownUp size={16} />
          </button>
          <button type="button" className="icon-btn" title={paused ? "Resume Updates" : "Pause Updates"} onClick={() => setPaused((value) => !value)}>
            {paused ? <Play size={16} /> : <Pause size={16} />}
          </button>
          <button type="button" className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {error && <div className="process-error">{error}</div>}
        <div className="settings-body">
          <table className="shortcuts-table process-table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="num">PID</th>
                <th className="num">CPU</th>
                <th className="num">Memory</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ordered.map((entry) => {
                const { row, depth, descendants, collapsed, total, category, extension } = entry;
                // A parent shows itself with the processes nested in it; its own share is the muted value.
                const nested = row.kind !== "thread" && total.memory !== row.memory;
                return (
                  <tr key={row.id} className={`process-kind-${row.kind === "thread" ? "thread" : category}`} title={row.commandLine || undefined}>
                    <td>
                      <div className="process-name" style={{ paddingLeft: depth * 16 }}>
                        {descendants ? (
                          <button
                            type="button"
                            className="process-twisty"
                            aria-expanded={!collapsed}
                            title={collapsed ? "Expand" : "Collapse"}
                            onClick={() => toggle(entry)}
                          >
                            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                          </button>
                        ) : (
                          <span className="process-twisty" />
                        )}
                        <span className="process-dot" />
                        {row.label}
                        {collapsed && (
                          <span className="process-hidden-count" title={`${descendants} more process${descendants === 1 ? "" : "es"} inside`}>
                            +{descendants}
                          </span>
                        )}
                        {row.extension && (
                          <span className="process-extension" title={`Started for or rendered by the extension ${row.extension}`}>
                            <Puzzle size={11} />
                            {row.extension}
                          </span>
                        )}
                        {!row.extension && extension && <span className="process-extension-inherited">via {extension}</span>}
                      </div>
                    </td>
                    <td className="num muted">{row.pid ?? ""}</td>
                    <td className="num" title={nested ? `Own: ${formatCpu(row.cpu)}` : undefined}>
                      {row.kind === "thread" ? "" : formatCpu(total.cpu)}
                    </td>
                    <td
                      className="num"
                      title={
                        nested
                          ? `Own: ${formatBytes(row.memory)}
Nested processes: ${formatBytes(total.memory - row.memory)}`
                          : undefined
                      }
                    >
                      {formatBytes(total.memory)}
                      <span className="process-own">{nested ? formatBytes(row.memory) : ""}</span>
                    </td>
                    <td className="shortcut-actions">
                      {row.pid !== null && row.kind !== "app" && (
                        <button type="button" className="icon-btn" title="End Process" onClick={() => void endProcess(row)}>
                          <CircleX size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="process-note">
            Memory is each process's private working set on Windows, as in Task Manager (resident memory elsewhere). A row with processes nested in it shows
            them added in, with its own share after it. JS heap rows are parts of Lumen's own process (worker threads) and are not added to the total. Task
            Manager lists Lumen's WebView2 processes as a separate "WebView2 Manager" group; they are shown here under Lumen.
          </p>
        </div>
      </div>
    </div>
  );
}
