import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { HostFileDecoration } from "../../shared/extensions";
import type { FileEntry } from "../../shared/types";
import { api } from "../lib/rpc";
import { showContextMenu } from "../lib/context-menu";
import { FileIcon, FolderIcon } from "./FileIcon";
import { FILE_DRAG_TYPE } from "./EditorDropTarget";
import { themeColorReference } from "../lib/theme";

export type TreeContextAction = {
  action:
    | "open"
    | "open-to-side"
    | "new-file"
    | "new-folder"
    | "rename"
    | "delete"
    | "reveal"
    | "copy-path"
    | "copy-relative-path"
    | "find-in-folder"
    | "open-in-terminal";
  path: string;
  isDirectory: boolean;
};

/** Per-path decoration, keys are lower-cased absolute paths. */
export type TreeDecorations = {
  git: Map<string, { letter: string; className: string }>;
  problems: Map<string, "error" | "warning">;
  /** Extension file decorations (window.registerFileDecorationProvider). */
  fileDecorations: Map<string, HostFileDecoration>;
};

type Props = {
  workspaceRoot: string | null;
  activePath: string | null;
  refreshKey: number;
  /** Reveal (expand to + select) this path whenever the token changes. */
  reveal: { path: string; token: number } | null;
  collapseToken: number;
  decorations: TreeDecorations;
  /** The paths of the rows shown, so the host can decorate them. */
  onPaths: (paths: string[]) => void;
  onOpenFile: (path: string, options: { preview: boolean }) => void;
  onOpenFolder: () => void;
  onContextAction: (evt: TreeContextAction) => void;
};

type NodeProps = {
  entry: FileEntry;
  depth: number;
  activePath: string | null;
  selected: string | null;
  setSelected: (path: string) => void;
  expanded: Set<string>;
  setExpanded: Dispatch<SetStateAction<Set<string>>>;
  refreshKey: number;
  decorations: TreeDecorations;
  folderDecorations: { git: Set<string>; problems: Map<string, "error" | "warning">; extension: Map<string, HostFileDecoration> };
  onPaths: Props["onPaths"];
  onOpenFile: Props["onOpenFile"];
  onContextAction: Props["onContextAction"];
};

const key = (path: string) => path.toLowerCase();

/** Theme color ids extensions set on file decorations → colors Lumen knows. */
const DECORATION_COLORS: Record<string, string> = {
  "gitDecoration.addedResourceForeground": "#73c991",
  "gitDecoration.modifiedResourceForeground": "#e2c08d",
  "gitDecoration.deletedResourceForeground": "#c74e39",
  "gitDecoration.renamedResourceForeground": "#73c991",
  "gitDecoration.untrackedResourceForeground": "#73c991",
  "gitDecoration.ignoredResourceForeground": "#8c8c8c",
  "gitDecoration.conflictingResourceForeground": "#e4676b",
  "gitDecoration.submoduleResourceForeground": "#8db9e2",
  "errorForeground": "#f48771",
  "problemsErrorIcon.foreground": "#f14c4c",
  "problemsWarningIcon.foreground": "#cca700",
  "problemsInfoIcon.foreground": "#3794ff",
  "list.errorForeground": "#f88070",
  "list.warningForeground": "#cca700",
  "charts.red": "#f14c4c",
  "charts.blue": "#3794ff",
  "charts.yellow": "#cca700",
  "charts.orange": "#d18616",
  "charts.green": "#89d185",
  "charts.purple": "#b180d7",
};

function decorationColor(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return themeColorReference(id, DECORATION_COLORS[id]);
}

async function contextMenuFor(entry: FileEntry, x: number, y: number): Promise<TreeContextAction["action"] | null> {
  const action = await showContextMenu(x, y, [
    ...(!entry.isDirectory ? [{ type: "item" as const, label: "Open", action: "open" }] : []),
    { type: "item", label: "New File…", action: "new-file" },
    { type: "item", label: "New Folder…", action: "new-folder" },
    { type: "separator" },
    ...(entry.isDirectory
      ? [
          { type: "item" as const, label: "Find in Folder…", action: "find-in-folder" },
          { type: "item" as const, label: "Open in Integrated Terminal", action: "open-in-terminal" },
          { type: "separator" as const },
        ]
      : []),
    { type: "item", label: "Copy Path", action: "copy-path" },
    { type: "item", label: "Copy Relative Path", action: "copy-relative-path" },
    { type: "item", label: "Reveal in File Explorer", action: "reveal" },
    { type: "separator" },
    { type: "item", label: "Rename…", action: "rename" },
    { type: "item", label: "Delete", action: "delete", danger: true },
  ]);
  return action as TreeContextAction["action"] | null;
}

function TreeNode(props: NodeProps) {
  const { entry, depth, expanded, setExpanded, refreshKey } = props;
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const isOpen = entry.isDirectory && expanded.has(key(entry.path));

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void api()
      .request.readDir({ path: entry.path, depth: 1 })
      .then(({ entries }) => {
        if (cancelled) return;
        setChildren(entries);
        props.onPaths(entries.map((child) => child.path));
      });
    return () => {
      cancelled = true;
    };
  }, [entry.path, isOpen, refreshKey, props.onPaths]);

  const toggle = () =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key(entry.path))) next.delete(key(entry.path));
      else next.add(key(entry.path));
      return next;
    });

  const git = entry.isDirectory
    ? props.folderDecorations.git.has(key(entry.path))
      ? { letter: "•", className: "git-modified" }
      : undefined
    : props.decorations.git.get(key(entry.path));
  const problem = entry.isDirectory
    ? props.folderDecorations.problems.get(key(entry.path))
    : props.decorations.problems.get(key(entry.path));
  const extension = entry.isDirectory ? props.folderDecorations.extension.get(key(entry.path)) : props.decorations.fileDecorations.get(key(entry.path));
  const nameClass = problem ? `problem-${problem}` : (git?.className ?? "");
  const extensionColor = decorationColor(extension?.color);
  const nameStyle = extensionColor ? { color: extensionColor } : undefined;

  return (
    <div className="tree-node">
      <div
        className={`tree-item${props.activePath === entry.path ? " active" : ""}${props.selected === entry.path ? " selected" : ""}`}
        data-path={entry.path}
        data-dir={entry.isDirectory ? "1" : undefined}
        draggable={!entry.isDirectory}
        onDragStart={(e) => {
          e.dataTransfer.setData(FILE_DRAG_TYPE, entry.path);
          e.dataTransfer.effectAllowed = "copyMove";
        }}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => {
          props.setSelected(entry.path);
          if (entry.isDirectory) toggle();
          else props.onOpenFile(entry.path, { preview: true });
        }}
        onDoubleClick={() => {
          if (!entry.isDirectory) props.onOpenFile(entry.path, { preview: false });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          props.setSelected(entry.path);
          void contextMenuFor(entry, e.clientX, e.clientY).then((action) => {
            if (action) props.onContextAction({ action, path: entry.path, isDirectory: entry.isDirectory });
          });
        }}
      >
        <span className={`chevron${isOpen ? " open" : ""}`} style={entry.isDirectory ? undefined : { opacity: 0 }}>
          <ChevronRight size={14} />
        </span>
        {entry.isDirectory ? <FolderIcon open={isOpen} name={entry.name} /> : <FileIcon name={entry.name} />}
        <span className={`name ${nameClass}`} style={nameStyle} title={extension?.tooltip}>
          {entry.name}
        </span>
        {!entry.isDirectory && git && <span className={`tree-badge ${git.className}`}>{git.letter}</span>}
        {extension?.badge && (
          <span className="tree-badge extension-badge" style={nameStyle} title={extension.tooltip}>
            {extension.badge.slice(0, 2)}
          </span>
        )}
        {entry.isDirectory && (git || problem) && <span className={`tree-dot ${problem ? `problem-${problem}` : git!.className}`}>●</span>}
      </div>
      {isOpen && (
        <div className="tree-children open">
          {children === null && (
            <div className="tree-item" style={{ paddingLeft: 8 + (depth + 1) * 12, color: "var(--text-muted)" }}>
              Loading…
            </div>
          )}
          {children?.map((child) => (
            <TreeNode key={child.path} {...props} entry={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function parentDirs(root: string, path: string): string[] {
  const sep = path.includes("\\") ? "\\" : "/";
  const dirs: string[] = [];
  let current = path;
  while (true) {
    const index = current.lastIndexOf(sep);
    if (index <= 0) break;
    current = current.slice(0, index);
    if (current.length < root.length) break;
    dirs.push(current);
  }
  return dirs;
}

export function FileTreeView(props: Props) {
  const { workspaceRoot, refreshKey, reveal, collapseToken } = props;
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!workspaceRoot) {
      setEntries([]);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const { entries: list, error: err } = await api().request.readDir({ path: workspaceRoot, depth: 1 });
      setError(err ?? null);
      setEntries(list);
      props.onPaths(list.map((entry) => entry.path));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [workspaceRoot, props.onPaths]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    if (collapseToken > 0) setExpanded(new Set());
  }, [collapseToken]);

  // Reveal: expand every ancestor, select, then scroll once the row exists.
  useEffect(() => {
    if (!reveal || !workspaceRoot) return;
    const target = reveal.path;
    if (!target.toLowerCase().startsWith(workspaceRoot.toLowerCase())) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const dir of parentDirs(workspaceRoot, target)) next.add(key(dir));
      return next;
    });
    setSelected(target);
    let frames = 0;
    const tick = () => {
      const row = [...(containerRef.current?.querySelectorAll<HTMLElement>(".tree-item[data-path]") ?? [])].find(
        (el) => el.dataset.path === target,
      );
      if (row) row.scrollIntoView({ block: "nearest" });
      else if (frames++ < 60) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [reveal?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  const folderDecorations = useMemo(() => {
    const git = new Set<string>();
    const problems = new Map<string, "error" | "warning">();
    const extension = new Map<string, HostFileDecoration>();
    if (!workspaceRoot) return { git, problems, extension };
    for (const path of props.decorations.git.keys()) {
      for (const dir of parentDirs(workspaceRoot, path)) git.add(key(dir));
    }
    for (const [path, severity] of props.decorations.problems) {
      for (const dir of parentDirs(workspaceRoot, path)) {
        if (problems.get(key(dir)) !== "error") problems.set(key(dir), severity);
      }
    }
    // A propagating decoration applies to the file's folders too.
    for (const [path, decoration] of props.decorations.fileDecorations) {
      if (!decoration.propagate) continue;
      for (const dir of parentDirs(workspaceRoot, path)) {
        if (!extension.has(key(dir))) extension.set(key(dir), decoration);
      }
    }
    return { git, problems, extension };
  }, [props.decorations, workspaceRoot]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const rows = [...(containerRef.current?.querySelectorAll<HTMLElement>(".tree-item[data-path]") ?? [])];
    if (!rows.length) return;
    const index = rows.findIndex((row) => row.dataset.path === selected);
    const current = rows[index];
    const isDir = current?.dataset.dir === "1";
    const select = (row: HTMLElement | undefined) => {
      if (!row) return;
      setSelected(row.dataset.path!);
      row.scrollIntoView({ block: "nearest" });
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        select(rows[Math.min(rows.length - 1, index + 1)]);
        break;
      case "ArrowUp":
        e.preventDefault();
        select(rows[Math.max(0, index - 1)]);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (current && isDir) {
          if (!expanded.has(key(current.dataset.path!))) setExpanded((prev) => new Set(prev).add(key(current.dataset.path!)));
          else select(rows[index + 1]);
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (current && isDir && expanded.has(key(current.dataset.path!))) {
          setExpanded((prev) => {
            const next = new Set(prev);
            next.delete(key(current.dataset.path!));
            return next;
          });
        } else if (current) {
          const parent = current.parentElement?.closest(".tree-children")?.previousElementSibling as HTMLElement | null;
          select(parent ?? undefined);
        }
        break;
      case "Enter":
        e.preventDefault();
        if (!current) break;
        if (isDir) current.click();
        else props.onOpenFile(current.dataset.path!, { preview: false });
        break;
      case " ":
        e.preventDefault();
        if (current && !isDir) props.onOpenFile(current.dataset.path!, { preview: true });
        break;
      case "F2":
        e.preventDefault();
        if (current) props.onContextAction({ action: "rename", path: current.dataset.path!, isDirectory: isDir });
        break;
      case "Delete":
        e.preventDefault();
        if (current) props.onContextAction({ action: "delete", path: current.dataset.path!, isDirectory: isDir });
        break;
    }
  };

  if (!workspaceRoot) {
    return (
      <div className="tree-empty">
        You have not yet opened a folder.
        <br />
        <button type="button" onClick={props.onOpenFolder}>
          Open Folder
        </button>
      </div>
    );
  }
  if (loading && !entries.length) return <div className="tree-empty">Loading…</div>;
  if (error) return <div className="tree-empty">{error}</div>;
  if (!entries.length) return <div className="tree-empty">Empty folder</div>;

  return (
    <div
      className="file-tree"
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        if (e.target !== e.currentTarget) return;
        e.preventDefault();
        void contextMenuFor({ name: "", path: workspaceRoot, isDirectory: true }, e.clientX, e.clientY).then((action) => {
          if (action) props.onContextAction({ action, path: workspaceRoot, isDirectory: true });
        });
      }}
    >
      {entries.map((entry) => (
        <TreeNode
          key={entry.path}
          entry={entry}
          depth={0}
          activePath={props.activePath}
          selected={selected}
          setSelected={setSelected}
          expanded={expanded}
          setExpanded={setExpanded}
          refreshKey={refreshKey}
          decorations={props.decorations}
          folderDecorations={folderDecorations}
          onPaths={props.onPaths}
          onOpenFile={props.onOpenFile}
          onContextAction={props.onContextAction}
        />
      ))}
    </div>
  );
}
