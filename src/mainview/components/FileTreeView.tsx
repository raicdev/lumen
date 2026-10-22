import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { HostFileDecoration } from "../../shared/extensions";
import type { FileEntry } from "../../shared/types";
import { api } from "../lib/rpc";
import { showContextMenu, type ContextMenuItem } from "../lib/context-menu";
import { extensionService, useExtensions } from "../lib/extensions";
import { isVirtualDocument } from "../lib/editor";
import { useStore } from "../features/store";
import { explorerRoots } from "../features/workspace-misc/roots";
import { FileIcon, FolderIcon } from "./FileIcon";
import { FILE_DRAG_TYPE } from "./EditorDropTarget";
import { themeColorReference } from "../lib/theme";
import { normalizeDocumentKey } from "../../shared/file-systems";

export type TreeContextAction = {
  action:
    | "open"
    | "open-to-side"
    | "new-file"
    | "new-folder"
    | "rename"
    | "delete"
    | "reveal"
    | "copy"
    | "cut"
    | "paste"
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
  /** Copy / move rows inside a provided file system (context menu paste, drag and drop). */
  onTransfer?: (paths: string[], targetDir: string, copy: boolean) => void;
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
  /** Changes when files of extension file systems changed (their folders re-list). */
  virtualKey: number;
  /** Rows of a read-only provider (its message explains why). */
  readOnly?: boolean;
  readOnlyMessage?: string;
  decorations: TreeDecorations;
  folderDecorations: { git: Set<string>; problems: Map<string, "error" | "warning">; extension: Map<string, HostFileDecoration> };
  onPaths: Props["onPaths"];
  onOpenFile: Props["onOpenFile"];
  onContextAction: Props["onContextAction"];
  onTransfer?: Props["onTransfer"];
};

/** Explorer copy / cut of rows of a provided file system (paste is a context menu item). */
let providerClipboard: { paths: string[]; copy: boolean } | null = null;

const pathScheme = (path: string) => /^(\w[\w+.-]+):/.exec(path)?.[1]?.toLowerCase();

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

type MenuOptions = { provider?: boolean; readOnly?: boolean; readOnlyMessage?: string; canPaste?: boolean };

async function contextMenuFor(entry: FileEntry, x: number, y: number, options: MenuOptions = {}): Promise<TreeContextAction["action"] | null> {
  const items: ContextMenuItem[] = [];
  const readOnly = !!(options.readOnly || entry.readOnly);
  if (!entry.isDirectory) items.push({ type: "item", label: "Open", action: "open" });
  if (options.readOnly) {
    // Provider file systems added with { value } say why they cannot be changed.
    const message = options.readOnlyMessage ? `Read-only: ${options.readOnlyMessage}` : "Read-only";
    items.push({ type: "item", label: message, action: "", disabled: true, run: () => {} });
    items.push({ type: "separator" });
  } else {
    items.push({ type: "item", label: "New File…", action: "new-file" });
    items.push({ type: "item", label: "New Folder…", action: "new-folder" });
    items.push({ type: "separator" });
  }
  if (options.provider) {
    items.push({ type: "item", label: "Copy", action: "copy" });
    items.push({ type: "item", label: "Cut", action: "cut", disabled: readOnly });
    if (entry.isDirectory) items.push({ type: "item", label: "Paste", action: "paste", disabled: !options.canPaste || readOnly });
    items.push({ type: "separator" });
  }
  if (entry.isDirectory && !options.provider) {
    items.push({ type: "item", label: "Find in Folder…", action: "find-in-folder" });
    items.push({ type: "item", label: "Open in Integrated Terminal", action: "open-in-terminal" });
    items.push({ type: "separator" });
  }
  items.push({ type: "item", label: "Copy Path", action: "copy-path" });
  items.push({ type: "item", label: "Copy Relative Path", action: "copy-relative-path" });
  if (!options.provider) items.push({ type: "item", label: "Reveal in File Explorer", action: "reveal" });
  items.push({ type: "separator" });
  items.push({ type: "item", label: "Rename…", action: "rename", disabled: readOnly });
  items.push({ type: "item", label: "Delete", action: "delete", danger: true, disabled: readOnly });
  const action = await showContextMenu(x, y, items);
  return action as TreeContextAction["action"] | null;
}

function TreeNode(props: NodeProps) {
  const { entry, depth, expanded, setExpanded, refreshKey, virtualKey } = props;
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isOpen = entry.isDirectory && expanded.has(key(entry.path));
  const provider = isVirtualDocument(entry.path);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    const load = async () => {
      if (!provider) return await api().request.readDir({ path: entry.path, depth: 1 });
      // Workspace folders of extension file systems list through the provider.
      const listing = await extensionService.call("providerReadDirectory", entry.path).catch((error) => ({
        entries: [] as FileEntry[],
        error: error instanceof Error ? error.message : String(error),
      }));
      return { entries: listing.entries, error: listing.error };
    };
    void load().then(({ entries, error: failure }) => {
      if (cancelled) return;
      setChildren(entries);
      setError(failure ?? null);
      props.onPaths(entries.map((child) => child.path));
    });
    return () => {
      cancelled = true;
    };
  }, [entry.path, isOpen, refreshKey, virtualKey, provider, props.onPaths]);

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
  /** Copy / move a row inside one provided file system (the App chooses provider.copy or rename). */
  const transfer = (source: string, target: string, copy: boolean) => {
    if (!props.onTransfer || !isVirtualDocument(source) || source === target || pathScheme(source) !== pathScheme(target)) return;
    props.onTransfer([source], target, copy);
  };

  return (
    <div className="tree-node">
      <div
        className={`tree-item${props.activePath === entry.path ? " active" : ""}${props.selected === entry.path ? " selected" : ""}`}
        data-path={entry.path}
        data-dir={entry.isDirectory ? "1" : undefined}
        draggable={!entry.isDirectory || provider}
        onDragStart={(e) => {
          e.dataTransfer.setData(FILE_DRAG_TYPE, entry.path);
          e.dataTransfer.effectAllowed = "copyMove";
        }}
        onDragOver={(e) => {
          if (!provider || !entry.isDirectory || !e.dataTransfer.types.includes(FILE_DRAG_TYPE)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = e.ctrlKey || e.metaKey ? "copy" : "move";
        }}
        onDrop={(e) => {
          if (!provider || !entry.isDirectory) return;
          const source = e.dataTransfer.getData(FILE_DRAG_TYPE);
          if (!source) return;
          e.preventDefault();
          e.stopPropagation();
          transfer(source, entry.path, e.ctrlKey || e.metaKey);
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
          void contextMenuFor(entry, e.clientX, e.clientY, { provider, readOnly: props.readOnly, readOnlyMessage: props.readOnlyMessage, canPaste: !!providerClipboard }).then((action) => {
            if (!action) return;
            if (action === "copy" || action === "cut") {
              providerClipboard = { paths: [entry.path], copy: action === "copy" };
              return;
            }
            if (action === "paste") {
              const clipboard = providerClipboard;
              if (!clipboard || !entry.isDirectory) return;
              for (const source of clipboard.paths) transfer(source, entry.path, clipboard.copy);
              if (!clipboard.copy) providerClipboard = null;
              return;
            }
            props.onContextAction({ action, path: entry.path, isDirectory: entry.isDirectory });
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
          {error && (
            <div className="tree-item" style={{ paddingLeft: 8 + (depth + 1) * 12, color: "var(--vscode-errorForeground, #f48771)" }} title={error}>
              {error}
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

  const { virtualSchemes, virtualReadOnly } = useExtensions();
  const roots = useStore(explorerRoots);
  const [virtualKey, setVirtualKey] = useState(0);

  /** Provider folders and extra local folders, next to the window's own root. */
  const extraRoots = useMemo(() => {
    const local = workspaceRoot?.toLowerCase();
    return roots.filter((root) => (root.scheme === "file" ? !local || root.path.toLowerCase() !== local : virtualSchemes.includes(root.scheme)));
  }, [roots, workspaceRoot, virtualSchemes]);

  /** Rows of a read-only provider cannot be renamed or deleted (the context menu says so). */
  const isReadOnly = (path: string) => {
    const scheme = /^(\w[\w+.-]+):/.exec(path)?.[1]?.toLowerCase();
    return !!scheme && !!virtualReadOnly[scheme];
  };

  // Watch the shown provider roots; the host disposes them when the provider unregisters.
  const watchKey = extraRoots
    .filter((root) => root.scheme !== "file")
    .map((root) => root.path)
    .join("\n");
  useEffect(() => {
    if (!watchKey) return;
    const paths = watchKey.split("\n");
    for (const path of paths) void extensionService.call("providerWatch", path, true).catch(() => false);
    return () => {
      for (const path of paths) void extensionService.call("providerUnwatch", path).catch(() => false);
    };
  }, [watchKey]);

  // onDidChangeFile: expanded provider folders list again (a superset of the affected ones).
  useEffect(() => {
    const onChanged = () => setVirtualKey((n) => n + 1);
    window.addEventListener("lumen:ext-virtual-changed", onChanged);
    return () => window.removeEventListener("lumen:ext-virtual-changed", onChanged);
  }, []);

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
  // A document of a provided file system reveals under its own (provider) root.
  useEffect(() => {
    if (!reveal) return;
    const target = reveal.path;
    const scheme = pathScheme(target);
    const virtual = !!scheme && virtualSchemes.includes(scheme);
    const roots = [...(workspaceRoot ? [workspaceRoot] : []), ...extraRoots.map((root) => root.path)];
    const root = roots
      .filter((candidate) => {
        if (!virtual) {
          const lower = target.toLowerCase();
          const base = candidate.toLowerCase().replace(/[\\/]+$/, "");
          return lower === base || lower.startsWith(`${base}\\`) || lower.startsWith(`${base}/`);
        }
        // A case-insensitive provider's explorer rows may only differ from the target in case.
        const targetKey = normalizeDocumentKey(target);
        const candidateKey = normalizeDocumentKey(candidate);
        return targetKey === candidateKey || targetKey.startsWith(candidateKey.endsWith("/") ? candidateKey : `${candidateKey}/`) || targetKey.startsWith(candidateKey);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!root) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const dir of parentDirs(root, target)) next.add(key(dir));
      return next;
    });
    setSelected(target);
    let frames = 0;
    const tick = () => {
      const targetKey = normalizeDocumentKey(target);
      const row = [...(containerRef.current?.querySelectorAll<HTMLElement>(".tree-item[data-path]") ?? [])].find(
        (el) => !!el.dataset.path && normalizeDocumentKey(el.dataset.path) === targetKey,
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
        if (current && !isReadOnly(current.dataset.path!)) props.onContextAction({ action: "rename", path: current.dataset.path!, isDirectory: isDir });
        break;
      case "Delete":
        e.preventDefault();
        if (current && !isReadOnly(current.dataset.path!)) props.onContextAction({ action: "delete", path: current.dataset.path!, isDirectory: isDir });
        break;
    }
  };

  if (!workspaceRoot && !extraRoots.length) {
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
  if (workspaceRoot && loading && !entries.length && !extraRoots.length) return <div className="tree-empty">Loading…</div>;
  if (workspaceRoot && error && !extraRoots.length) return <div className="tree-empty">{error}</div>;
  if (workspaceRoot && !entries.length && !extraRoots.length) return <div className="tree-empty">Empty folder</div>;

  return (
    <div
      className="file-tree"
      ref={containerRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => {
        if (e.target !== e.currentTarget || !workspaceRoot) return;
        e.preventDefault();
        void contextMenuFor({ name: "", path: workspaceRoot, isDirectory: true }, e.clientX, e.clientY).then((action) => {
          if (action) props.onContextAction({ action, path: workspaceRoot, isDirectory: true });
        });
      }}
    >
      {workspaceRoot &&
        entries.map((entry) => (
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
            virtualKey={virtualKey}
            decorations={props.decorations}
            folderDecorations={folderDecorations}
            onPaths={props.onPaths}
            onOpenFile={props.onOpenFile}
            onContextAction={props.onContextAction}
            onTransfer={props.onTransfer}
          />
        ))}
      {extraRoots.map((root) => {
        const readOnly = !!virtualReadOnly[root.scheme];
        const readOnlyMessage = typeof virtualReadOnly[root.scheme] === "string" ? (virtualReadOnly[root.scheme] as string) : undefined;
        return (
          <TreeNode
            key={root.uri}
            entry={{ name: root.name, path: root.path, isDirectory: true }}
            depth={0}
            activePath={props.activePath}
            selected={selected}
            setSelected={setSelected}
            expanded={expanded}
            setExpanded={setExpanded}
            refreshKey={refreshKey}
            virtualKey={virtualKey}
            readOnly={readOnly}
            readOnlyMessage={readOnlyMessage}
            decorations={props.decorations}
            folderDecorations={folderDecorations}
            onPaths={props.onPaths}
            onOpenFile={props.onOpenFile}
            onContextAction={props.onContextAction}
            onTransfer={props.onTransfer}
          />
        );
      })}
    </div>
  );
}
