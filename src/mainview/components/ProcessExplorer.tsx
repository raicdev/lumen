import { CircleX, Pause, Play, X } from "lucide-react";
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

/** Rows in tree order (children by memory, largest first), with their depth. */
function treeOrder(rows: ProcessRow[]): { row: ProcessRow; depth: number }[] {
  const children = new Map<string | null, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.parent) ?? [];
    list.push(row);
    children.set(row.parent, list);
  }
  for (const list of children.values()) {
    // Threads first: they are part of the parent process, not children of it.
    list.sort((a, b) => Number(b.kind === "thread") - Number(a.kind === "thread") || b.memory - a.memory);
  }
  const out: { row: ProcessRow; depth: number }[] = [];
  const visit = (row: ProcessRow, depth: number) => {
    out.push({ row, depth });
    for (const child of children.get(row.id) ?? []) visit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  return out;
}

/** A process counts toward its nearest WebView2 or terminal ancestor; the rest are "other". */
function categoryOf(row: ProcessRow, byId: Map<string, ProcessRow>): Category {
  if (row.kind === "app") return "app";
  for (let current: ProcessRow | undefined = row; current; current = current.parent ? byId.get(current.parent) : undefined) {
    if (current.kind === "webview" || current.kind === "terminal") return current.kind;
  }
  return "process";
}

/** Process Explorer: what Lumen is running and how much memory / CPU each part uses. */
export function ProcessExplorer({ open, onClose }: Props) {
  const [rows, setRows] = useState<ProcessRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows([]);
    setError(null);
    setPaused(false);
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

  const ordered = useMemo(() => treeOrder(rows), [rows]);

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
          <button
            type="button"
            className="icon-btn"
            title={paused ? "Resume Updates" : "Pause Updates"}
            onClick={() => setPaused((value) => !value)}
          >
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
              {ordered.map(({ row, depth }) => (
                <tr key={row.id} className={`process-kind-${row.kind}`} title={row.commandLine || undefined}>
                  <td>
                    <div className="process-name" style={{ paddingLeft: depth * 18 }}>
                      <span className="process-dot" />
                      {row.label}
                    </div>
                  </td>
                  <td className="num muted">{row.pid ?? ""}</td>
                  <td className="num">{row.kind === "thread" ? "" : formatCpu(row.cpu)}</td>
                  <td className="num">{formatBytes(row.memory)}</td>
                  <td className="shortcut-actions">
                    {row.pid !== null && row.kind !== "app" && (
                      <button type="button" className="icon-btn" title="End Process" onClick={() => void endProcess(row)}>
                        <CircleX size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="process-note">
            Memory is each process's private working set on Windows, as in Task Manager (resident memory elsewhere). JS heap rows
            are parts of Lumen's own process (worker threads) and are not added to the total. Task Manager lists Lumen's WebView2
            processes as a separate "WebView2 Manager" group; they are shown here under Lumen.
          </p>
        </div>
      </div>
    </div>
  );
}
