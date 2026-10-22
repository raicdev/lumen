import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Code, Cpu, Eraser, Loader, Play, Plus, Save, Square, Trash2, Type } from "lucide-react";
import type { NbWireCell, NbWireDoc } from "../../../shared/notebooks";
import { WithCodicons } from "../../components/Codicon";
import { allLanguageLabels } from "../../lib/languages";
import { renderMarkdown } from "../../lib/markdown";
import { useStore } from "../store";
import type { ViewFeatureApi } from "../types";
import { CellEditor } from "./CellEditor";
import { CellOutputs } from "./Output";
import { InteractiveInput } from "./InteractiveInput";
import { MenuActions } from "../menus-walkthroughs/MenuActions";
import { contributedMenuItems, refArg } from "../menus-walkthroughs/menus";
import { showContextMenu } from "../../lib/context-menu";
import { activePath, call, docs, flushText, hostEpoch, loadDoc, pickController, queueText, runCells, selectCell, selection } from "./state";

/** The editor of a notebook: a toolbar and the cells (markdown rendered, code editable) with their outputs. */

const formatDuration = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;

function focusCellDom(root: HTMLElement | null, id: string): void {
  requestAnimationFrame(() => {
    const cell = root?.querySelector<HTMLElement>(`[data-cell-id="${id}"]`);
    const editor = cell?.querySelector<HTMLElement>(".cm-content");
    if (editor) editor.focus();
    else cell?.focus();
    cell?.scrollIntoView({ block: "nearest" });
  });
}

type CellProps = {
  path: string;
  cell: NbWireCell;
  index: number;
  count: number;
  selected: boolean;
  api: ViewFeatureApi;
  /** A cell that was just inserted by the user takes the focus. */
  autoFocus: boolean;
  onSelect: (id: string) => void;
  onNavigate: (index: number) => void;
  onInserted: (index: number) => void;
  /** For the context keys of the cell menus (notebookType, notebookKernel). */
  notebookType: string;
  kernel: string | undefined;
  /** An Interactive Window's cell: interactive/cell/title instead of notebook/cell/title. */
  interactive: boolean;
};

/** Context keys of notebook/toolbar, notebook/cell/title and notebook/cell/execute. */
function notebookLookup(notebookType: string, kernel: string | undefined, cell?: NbWireCell, index?: number): (key: string) => unknown {
  return (key) => {
    switch (key) {
      case "notebookType":
        return notebookType;
      case "notebookKernel":
        return kernel;
      case "notebookKernelSelected":
        return !!kernel;
      case "notebookEditorFocused":
        return true;
      case "notebookCellType":
        return cell ? (cell.kind === 2 ? "code" : "markup") : undefined;
      case "notebookCellExecutionState":
        return cell
          ? cell.state === "idle"
            ? cell.success === undefined
              ? "idle"
              : cell.success
                ? "succeeded"
                : "failed"
            : cell.state === "running"
              ? "executing"
              : "pending"
          : undefined;
      case "notebookCellHasOutputs":
        return cell ? cell.outputs.length > 0 : undefined;
      case "notebookCellExecuting":
        return cell ? cell.state !== "idle" : undefined;
      case "notebookCellIndex":
        return index;
      case "activeEditor":
        return notebookType === "interactive" ? "workbench.editor.interactive" : "workbench.editor.notebook";
      default:
        return undefined;
    }
  };
}

const Cell = memo(function Cell({
  path,
  cell,
  index,
  count,
  selected,
  api,
  autoFocus,
  onSelect,
  onNavigate,
  onInserted,
  notebookType,
  kernel,
  interactive,
}: CellProps) {
  const lookup = notebookLookup(notebookType, kernel, cell, index);
  // Cell menus' commands get the `NotebookCell` (revived by the host).
  const cellArgs = [refArg("notebooks", { path, cell: cell.id })];
  const isCode = cell.kind === 2;
  const [editing, setEditing] = useState(!isCode && !cell.value.trim());
  const running = cell.state === "running";
  const pending = cell.state === "pending";

  const run = (mode: "advance" | "stay" | "insert") => {
    if (!isCode) {
      setEditing(false);
      if (mode !== "stay") onNavigate(index + 1);
      return;
    }
    void runCells(api, path, [cell.id]);
    if (mode === "insert") {
      void call(api, path, "insert", index + 1, 2).then(() => onInserted(index + 1));
    } else if (mode === "advance") onNavigate(index + 1);
  };

  const chooseLanguage = async () => {
    const labels = Object.entries(allLanguageLabels()).sort((a, b) => a[1].localeCompare(b[1]));
    const picked = await api.showQuickPick(
      labels.map(([id, label]) => ({ label, description: id, picked: id === cell.languageId })),
      { title: "Select Cell Language", placeholder: "Language of the cell", matchOnDescription: true },
    );
    const language = picked?.[0] !== undefined ? labels[picked[0]]?.[0] : undefined;
    if (language) void call(api, path, "setLanguage", cell.id, language);
  };

  const label = running ? "*" : pending ? "…" : (cell.executionOrder ?? " ");
  const statusItems = cell.status;
  const durationLabel = cell.durationMs !== undefined && !running ? formatDuration(cell.durationMs) : "";

  return (
    <div
      className={`nb-cell nb-cell-${isCode ? "code" : "markup"}${selected ? " selected" : ""}${running ? " running" : ""}`}
      data-cell-id={cell.id}
      data-cell-index={index}
      tabIndex={-1}
      onMouseDown={() => onSelect(cell.id)}
      onFocus={() => onSelect(cell.id)}
    >
      <div className="nb-cell-gutter">
        {isCode ? (
          <>
            <button
              className="icon-btn nb-run"
              title={running || pending ? "Stop execution" : "Run cell (Ctrl+Enter)"}
              onClick={() => (running || pending ? void call(api, path, "interrupt") : void runCells(api, path, [cell.id]))}
            >
              {running ? <Square size={13} /> : pending ? <Loader size={13} className="nb-spin" /> : <Play size={13} />}
            </button>
            {contributedMenuItems("notebook/cell/execute", lookup, cellArgs).length > 0 && (
              <button
                className="icon-btn nb-run-more"
                title="More Run Actions…"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  void showContextMenu(rect.left, rect.bottom, contributedMenuItems("notebook/cell/execute", lookup, cellArgs));
                }}
              >
                ▾
              </button>
            )}
            <span className="nb-count" title={cell.success === false ? "The last run failed" : undefined}>
              [{label}]
            </span>
          </>
        ) : null}
      </div>
      <div className="nb-cell-main">
        <div className="nb-cell-actions">
          <MenuActions
            menuId={interactive ? "interactive/cell/title" : "notebook/cell/title"}
            lookup={lookup}
            args={cellArgs}
            inline={(group) => group === "inline" || group.startsWith("navigation")}
          />
          {isCode && cell.outputs.length ? (
            <button className="icon-btn" title="Clear outputs" onClick={() => void call(api, path, "clearOutputs", cell.id)}>
              <Eraser size={13} />
            </button>
          ) : null}
          {isCode ? (
            <button className="icon-btn nb-lang" title="Change cell language" onClick={() => void chooseLanguage()}>
              {cell.languageId}
            </button>
          ) : null}
          <button
            className="icon-btn"
            title={isCode ? "Change to markdown" : "Change to code"}
            onClick={() => void call(api, path, "setKind", cell.id, isCode ? 1 : 2)}
          >
            {isCode ? <Type size={13} /> : <Code size={13} />}
          </button>
          <button className="icon-btn" title="Move up" disabled={index === 0} onClick={() => void call(api, path, "move", cell.id, -1)}>
            <ArrowUp size={13} />
          </button>
          <button className="icon-btn" title="Move down" disabled={index === count - 1} onClick={() => void call(api, path, "move", cell.id, 1)}>
            <ArrowDown size={13} />
          </button>
          <button className="icon-btn" title="Delete cell" onClick={() => void call(api, path, "delete", cell.id)}>
            <Trash2 size={13} />
          </button>
        </div>
        {isCode || editing ? (
          <div className="nb-cell-input">
            <CellEditor
              value={cell.value}
              rev={cell.rev}
              languageId={isCode ? cell.languageId : "markdown"}
              placeholderText={isCode ? "" : "Empty markdown cell, double-click or press Enter to edit."}
              autoFocus={autoFocus || (!isCode && editing)}
              onChange={(value) => queueText(api, path, cell.id, value)}
              onRun={run}
              onFocus={() => onSelect(cell.id)}
              onEscape={() => (isCode ? (document.activeElement as HTMLElement | null)?.blur() : setEditing(false))}
              onNavigate={(direction) => onNavigate(index + direction)}
            />
          </div>
        ) : (
          <div
            className="nb-markdown markdown-body"
            tabIndex={0}
            title="Double-click to edit"
            onDoubleClick={() => setEditing(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                setEditing(true);
              }
            }}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(cell.value) }}
          />
        )}
        {isCode && (statusItems.length || durationLabel || cell.success !== undefined) ? (
          <div className="nb-cell-status">
            <span className={`nb-result${cell.success === false ? " failed" : cell.success ? " ok" : ""}`}>
              {cell.success === undefined ? "" : cell.success ? "✓" : "✗"} {durationLabel}
            </span>
            {statusItems
              .filter((item) => item.alignment === "left")
              .sort((a, b) => b.priority - a.priority)
              .map((item, i) => (
                <StatusItem key={`l${i}`} item={item} api={api} />
              ))}
            <span className="nb-status-spacer" />
            {statusItems
              .filter((item) => item.alignment === "right")
              .sort((a, b) => b.priority - a.priority)
              .map((item, i) => (
                <StatusItem key={`r${i}`} item={item} api={api} />
              ))}
          </div>
        ) : null}
        {isCode ? <CellOutputs outputs={cell.outputs} /> : null}
      </div>
    </div>
  );
});

function StatusItem({ item, api }: { item: NbWireCell["status"][number]; api: ViewFeatureApi }) {
  const body = <WithCodicons text={item.text} size={12} />;
  if (!item.command)
    return (
      <span className="nb-status-item" title={item.tooltip}>
        {body}
      </span>
    );
  const command = item.command;
  return (
    <button className="nb-status-item clickable" title={item.tooltip} onClick={() => api.executeCommand(command.command, ...(command.arguments ?? []))}>
      {body}
    </button>
  );
}

/** `interactive`: an Interactive Window (its own toolbar, no cell insertion, the input box at the bottom). */
export function NotebookEditor({ path, api, interactive = false }: { path: string; api: ViewFeatureApi; interactive?: boolean }) {
  const doc: NbWireDoc | undefined = useStore(docs)[path];
  const epoch = useStore(hostEpoch);
  const picked = useStore(selection)[path];
  const [ready, setReady] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    let shown = false;
    setReady(false);
    void loadDoc(api, path).then(() => {
      if (!alive) return;
      setReady(true);
      shown = true;
      api.sendToHost({ t: "visible", path, visible: true });
    });
    activePath.set(path);
    return () => {
      alive = false;
      flushText(path);
      if (shown) api.sendToHost({ t: "visible", path, visible: false });
      if (activePath.get() === path) activePath.set(null);
    };
  }, [path, epoch, api]);

  const cells = doc?.cells ?? [];
  const selectedId = picked?.cell && cells.some((cell) => cell.id === picked.cell) ? picked.cell : (cells[0]?.id ?? null);

  // Tell the host which cells are selected.
  const selectedIndex = cells.findIndex((cell) => cell.id === selectedId);
  useEffect(() => {
    if (ready && selectedIndex >= 0) api.sendToHost({ t: "selection", path, selections: [[selectedIndex, selectedIndex + 1]] });
  }, [ready, selectedIndex, path, api]);

  // NotebookEditor.revealRange
  useEffect(() => {
    if (picked?.reveal && selectedId) root.current?.querySelector(`[data-cell-id="${selectedId}"]`)?.scrollIntoView({ block: "center" });
  }, [picked?.reveal, selectedId]);

  // A cell the user inserted takes the selection once it arrives.
  useEffect(() => {
    if (focusIndex === null) return;
    const cell = cells[focusIndex];
    if (cell) {
      selectCell(path, cell.id);
      focusCellDom(root.current, cell.id);
      setFocusIndex(null);
    }
  }, [cells.length, focusIndex]);

  // NotebookEditor.visibleRanges
  const cellsKey = cells.map((cell) => cell.id).join();
  useEffect(() => {
    const container = root.current;
    if (!container || !ready) return;
    const visible = new Set<number>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.cellIndex);
          if (entry.isIntersecting) visible.add(index);
          else visible.delete(index);
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
          const ranges: [number, number][] = [];
          for (const index of [...visible].sort((a, b) => a - b)) {
            const last = ranges[ranges.length - 1];
            if (last && last[1] === index) last[1] = index + 1;
            else ranges.push([index, index + 1]);
          }
          api.sendToHost({ t: "ranges", path, ranges });
        }, 150);
      },
      { root: container },
    );
    container.querySelectorAll("[data-cell-id]").forEach((element) => observer.observe(element));
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [cellsKey, ready, path, api]);

  const onSelect = useMemo(() => (id: string) => selectCell(path, id), [path]);
  const onNavigate = (index: number) => {
    const target = cells[index];
    if (!target) return;
    selectCell(path, target.id);
    focusCellDom(root.current, target.id);
  };

  if (!doc || !ready) return <div className="notebook-editor nb-loading">Loading notebook…</div>;
  if (doc.error) {
    return (
      <div className="notebook-editor nb-error-view">
        <p>Cannot open this notebook</p>
        <pre>{doc.error}</pre>
        <button className="nb-button" onClick={() => void loadDoc(api, path)}>
          Retry
        </button>
      </div>
    );
  }

  const insertAt = (index: number, kind: 1 | 2) => void call(api, path, "insert", index, kind).then(() => setFocusIndex(index));
  const busy = cells.some((cell) => cell.state !== "idle");

  return (
    <div
      className="notebook-editor"
      ref={root}
      onMouseDownCapture={() => {
        activePath.set(path);
        api.sendToHost({ t: "focus", path });
      }}
      onFocusCapture={() => {
        activePath.set(path);
        api.sendToHost({ t: "focus", path });
      }}
    >
      {interactive ? (
        <div className="nb-toolbar">
          <button className="nb-button" title="Stop the execution" disabled={!busy} onClick={() => void call(api, path, "interrupt")}>
            <Square size={13} /> Interrupt
          </button>
          <button className="nb-button" title="Clear all outputs" onClick={() => void call(api, path, "clearOutputs")}>
            <Eraser size={13} /> Clear Outputs
          </button>
          <MenuActions
            menuId="interactive/toolbar"
            lookup={notebookLookup(doc.notebookType, doc.controller?.id)}
            args={[refArg("notebooks", { path })]}
            inline={(group) => group.startsWith("navigation") || group === "status"}
            className="nb-toolbar-contributed"
          />
          <span className="nb-toolbar-spacer" />
          <button className="nb-button" title="Select the kernel that runs this window" onClick={() => void pickController(api, path)}>
            <Cpu size={13} /> {doc.controller ? doc.controller.label : "Select Kernel"}
          </button>
        </div>
      ) : (
        <div className="nb-toolbar">
          <button className="nb-button" title="Run all cells" onClick={() => void runCells(api, path, "all")}>
            <Play size={13} /> Run All
          </button>
          <button className="nb-button" title="Stop the execution" disabled={!busy} onClick={() => void call(api, path, "interrupt")}>
            <Square size={13} /> Interrupt
          </button>
          <button className="nb-button" title="Clear all outputs" onClick={() => void call(api, path, "clearOutputs")}>
            <Eraser size={13} /> Clear Outputs
          </button>
          <button className="nb-button" title="Add a code cell at the end" onClick={() => insertAt(cells.length, 2)}>
            <Plus size={13} /> Code
          </button>
          <button className="nb-button" title="Add a markdown cell at the end" onClick={() => insertAt(cells.length, 1)}>
            <Plus size={13} /> Markdown
          </button>
          <MenuActions
            menuId="notebook/toolbar"
            lookup={notebookLookup(doc.notebookType, doc.controller?.id)}
            args={[refArg("notebooks", { path })]}
            inline={(group) => group.startsWith("navigation") || group === "status"}
            className="nb-toolbar-contributed"
          />
          <span className="nb-toolbar-spacer" />
          <button className="nb-button" title="Save (Ctrl+S)" disabled={!doc.dirty} onClick={() => void call(api, path, "save")}>
            <Save size={13} /> Save
          </button>
          <button className="nb-button" title="Select the kernel that runs this notebook" onClick={() => void pickController(api, path)}>
            <Cpu size={13} /> {doc.controller ? doc.controller.label : "Select Kernel"}
          </button>
        </div>
      )}
      <div className="nb-cells">
        {cells.length === 0 ? (
          <div className="nb-empty">{interactive ? "Type code below and press Shift+Enter to run it." : "This notebook has no cells."}</div>
        ) : null}
        {cells.map((cell, index) => (
          <div key={cell.id} className="nb-slot">
            {!interactive && (
              <div className="nb-insert">
                <button onClick={() => insertAt(index, 2)}>
                  <Plus size={11} /> Code
                </button>
                <button onClick={() => insertAt(index, 1)}>
                  <Plus size={11} /> Markdown
                </button>
              </div>
            )}
            <Cell
              path={path}
              cell={cell}
              index={index}
              count={cells.length}
              selected={cell.id === selectedId}
              api={api}
              autoFocus={focusIndex === index}
              onSelect={onSelect}
              onNavigate={onNavigate}
              onInserted={setFocusIndex}
              notebookType={doc.notebookType}
              kernel={doc.controller?.id}
              interactive={interactive}
            />
          </div>
        ))}
        {!interactive && (
          <div className="nb-insert nb-insert-end">
            <button onClick={() => insertAt(cells.length, 2)}>
              <Plus size={11} /> Code
            </button>
            <button onClick={() => insertAt(cells.length, 1)}>
              <Plus size={11} /> Markdown
            </button>
          </div>
        )}
      </div>
      {interactive && <InteractiveInput path={path} api={api} language={doc.cells.filter((cell) => cell.kind === 2).at(-1)?.languageId ?? "python"} />}
    </div>
  );
}
