import { ChevronRight, ChevronsDownUp, Ellipsis, Folder, Loader } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import type { HostTreeIcon, HostTreeItem, HostTreeTooltip } from "../../shared/extensions";
import { showContextMenu, type ContextMenuItem } from "../lib/context-menu";
import { FILE_DRAG_TYPE } from "./EditorDropTarget";
import type { ContributedView } from "../lib/extensions";
import { renderMarkdown } from "../lib/markdown";
import { api } from "../lib/rpc";
import { treeService, useTree, useTreeViews, TREE_DRAG_TYPE, type TreeState, type ViewAction } from "../lib/trees";
import { WithCodicons } from "./Codicon";
import { FileIcon } from "./FileIcon";
import { themeColorReference } from "../lib/theme";

/**
 * A tree view of an extension (window.registerTreeDataProvider /
 * createTreeView): items come from the extension through the tree service,
 * with their inline actions and context menus (contributes.menus), and the
 * view's welcome content while it is empty.
 */

type Row = { item: HostTreeItem; depth: number };

const THEME_COLORS: Record<string, string> = {
  "charts.red": "#f14c4c",
  "charts.orange": "#d18616",
  "charts.yellow": "#cca700",
  "charts.green": "#89d185",
  "charts.blue": "#3794ff",
  "charts.purple": "#b180d7",
  errorForeground: "#f48771",
  "list.errorForeground": "#f48771",
  "list.warningForeground": "#cca700",
  "problemsErrorIcon.foreground": "#f14c4c",
  "problemsWarningIcon.foreground": "#cca700",
  "problemsInfoIcon.foreground": "#3794ff",
  "testing.iconPassed": "#73c991",
  "testing.iconFailed": "#f14c4c",
};

function rowsOf(state: TreeState): Row[] {
  const rows: Row[] = [];
  const walk = (parent: string, depth: number) => {
    for (const handle of state.children.get(parent) ?? []) {
      const item = state.items.get(handle);
      if (!item) continue;
      rows.push({ item, depth });
      if (item.collapsible !== "none" && state.expanded.has(handle)) walk(handle, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}

/** File paths of a drag over a tree: the explorer's, or a native `text/uri-list`. */
function dragFiles(dataTransfer: DataTransfer): string[] {
  const out = new Set<string>();
  const path = dataTransfer.getData(FILE_DRAG_TYPE);
  if (path) out.add(path);
  for (const line of dataTransfer.getData("text/uri-list").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^file:\/\/(.*)$/i.exec(line);
    if (match) out.add(decodeURIComponent(match[1]!.replace(/^\/([a-zA-Z]:)/, "$1")));
  }
  return [...out];
}

/** Whether a drag carries something a tree drop can use (a tree drag, or files). */
function draggable(dataTransfer: DataTransfer): boolean {
  const types = dataTransfer.types;
  return types.includes(TREE_DRAG_TYPE) || types.includes(FILE_DRAG_TYPE) || types.includes("text/uri-list");
}

export function TreeIcon({ icon }: { icon?: HostTreeIcon }) {
  if (!icon) return null;
  if ("codicon" in icon) {
    return (
      <span className="ext-tree-icon" style={icon.color ? { color: themeColorReference(icon.color, THEME_COLORS[icon.color]) } : undefined}>
        <WithCodicons text={`$(${icon.codicon})`} size={14} />
      </span>
    );
  }
  if ("url" in icon) return <img className="ext-tree-icon" src={icon.url} alt="" draggable={false} />;
  return <span className="ext-tree-icon">{icon.folder ? <Folder size={14} className="folder-icon" /> : <FileIcon name={icon.file} />}</span>;
}

/** A command's icon, or its title when it has none. */
export function ActionButton({ action, onRun }: { action: ViewAction; onRun: () => void }) {
  const icon = action.icon?.startsWith("$(") ? <WithCodicons text={action.icon} size={14} /> : action.icon ? <img src={action.icon} alt="" className="view-action-image" /> : null;
  return (
    <button
      type="button"
      className={`icon-btn view-action${icon ? "" : " text"}`}
      title={action.title}
      onClick={(e) => {
        e.stopPropagation();
        onRun();
      }}
    >
      {icon ?? action.title}
    </button>
  );
}

/** Groups of a menu as context menu items, separated like VS Code's; submenus become fly-outs. */
function showActionMenu(x: number, y: number, actions: ViewAction[], run: (action: ViewAction) => void): void {
  if (!actions.length) return;
  const toItems = (list: ViewAction[]): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];
    list.forEach((action, index) => {
      if (index && list[index - 1]!.group !== action.group) items.push({ type: "separator" });
      items.push(action.submenu ? { type: "submenu", label: action.title, items: toItems(action.submenu) } : { type: "item", label: action.title, action: action.command, run: () => run(action) });
    });
    return items;
  };
  void showContextMenu(x, y, toItems(actions));
}

/** `view/title` actions of a view (and Collapse All), for its header. */
export function ViewTitleActions({ view }: { view: ContributedView }) {
  const trees = useTreeViews();
  const tree = trees.get(view.id);
  const actions = treeService.menu("view/title", (key) => (key === "view" ? view.id : undefined));
  const inline = actions.filter((action) => !action.submenu && action.group === "navigation");
  const overflow = actions.filter((action) => action.submenu || action.group !== "navigation");
  if (!inline.length && !overflow.length && !tree?.showCollapseAll) return null;
  return (
    <span className="view-title-actions" onClick={(e) => e.stopPropagation()}>
      {inline.map((action) => (
        <ActionButton key={action.command} action={action} onRun={() => treeService.runCommand(action.command)} />
      ))}
      {tree?.showCollapseAll && (
        <button type="button" className="icon-btn view-action" title="Collapse All" onClick={() => treeService.collapseAll(view.id)}>
          <ChevronsDownUp size={14} />
        </button>
      )}
      {overflow.length > 0 && (
        <button
          type="button"
          className="icon-btn view-action"
          title="More Actions…"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            showActionMenu(rect.left, rect.bottom + 2, overflow, (action) => treeService.runCommand(action.command));
          }}
        >
          <Ellipsis size={14} />
        </button>
      )}
    </span>
  );
}

/** A label with highlighted ranges (TreeItemLabel.highlights). */
function Label({ text, highlights }: { text: string; highlights?: [number, number][] }) {
  if (!highlights?.length) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of [...highlights].sort((a, b) => a[0] - b[0])) {
    if (start < at) continue;
    parts.push(<Fragment key={`t${start}`}>{text.slice(at, start)}</Fragment>);
    parts.push(<mark key={`h${start}`}>{text.slice(start, end)}</mark>);
    at = end;
  }
  parts.push(<Fragment key="rest">{text.slice(at)}</Fragment>);
  return <>{parts}</>;
}

/** `command:` and web links of welcome content. */
function runLink(target: string) {
  if (/^https?:/i.test(target)) {
    void api().request.openExternal({ url: target });
    return;
  }
  const match = /^command:([^?]+)(?:\?(.*))?$/i.exec(target);
  if (!match) return;
  let args: unknown[] = [];
  try {
    const parsed = match[2] ? JSON.parse(decodeURIComponent(match[2])) : [];
    args = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    /* no arguments */
  }
  treeService.runCommand(match[1]!, args);
}

/** contributes.viewsWelcome: paragraphs with links; a line that is only a link is a button. */
function Welcome({ contents }: { contents: string[] }) {
  const lines = contents.flatMap((content) => content.split(/\r?\n/)).map((line) => line.trim()).filter(Boolean);
  return (
    <div className="ext-tree-welcome">
      {lines.map((line, index) => {
        const button = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(line);
        if (button) {
          return (
            <button key={index} type="button" className="primary-btn ext-tree-welcome-button" onClick={() => runLink(button[2]!)}>
              {button[1]}
            </button>
          );
        }
        const parts = line.split(/(\[[^\]]+\]\([^)]+\))/g);
        return (
          <p key={index}>
            {parts.map((part, at) => {
              const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
              if (!link) return <Fragment key={at}>{part}</Fragment>;
              return (
                <a
                  key={at}
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    runLink(link[2]!);
                  }}
                >
                  {link[1]}
                </a>
              );
            })}
          </p>
        );
      })}
    </div>
  );
}

export function ExtensionTreeView({ view }: { view: ContributedView }) {
  const viewId = view.id;
  const state = useTree(viewId);
  const trees = useTreeViews();
  const info = trees.get(viewId);
  const ref = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | null>(null);
  const rows = useMemo(() => rowsOf(state), [state, state.version]);
  const itemMenu = (item: HostTreeItem) =>
    treeService.menu("view/item/context", (key) => (key === "view" ? viewId : key === "viewItem" ? (item.contextValue ?? "") : key === "listMultiSelection" ? state.selection.length > 1 : undefined));

  // Shown while the element has a size: a hidden side bar or collapsed section does not count.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => treeService.setVisible(viewId, element.offsetWidth > 0 && element.offsetHeight > 0);
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => {
      observer.disconnect();
      treeService.setVisible(viewId, false);
    };
  }, [viewId]);

  // TreeView.reveal: scroll the item into view (and focus the tree when asked).
  useEffect(() => {
    if (!state.revealToken || !state.focused) return;
    const row = ref.current?.querySelector<HTMLElement>(`[data-handle="${CSS.escape(state.focused)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [state.revealToken, state.focused]);

  const select = (item: HostTreeItem, e: MouseEvent | KeyboardEvent | null) => {
    const handle = item.handle;
    if (info?.canSelectMany && e && (e.ctrlKey || e.metaKey)) {
      const selection = state.selection.includes(handle) ? state.selection.filter((other) => other !== handle) : [...state.selection, handle];
      treeService.select(viewId, selection, handle);
      anchor.current = handle;
      return;
    }
    if (info?.canSelectMany && e?.shiftKey && anchor.current) {
      const from = rows.findIndex((row) => row.item.handle === anchor.current);
      const to = rows.findIndex((row) => row.item.handle === handle);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        treeService.select(viewId, rows.slice(start, end + 1).map((row) => row.item.handle), handle);
        return;
      }
    }
    anchor.current = handle;
    treeService.select(viewId, [handle]);
  };

  const activate = (item: HostTreeItem) => {
    if (item.hasCommand) treeService.open(viewId, item.handle);
    else if (item.collapsible !== "none") treeService.toggle(viewId, item.handle);
  };

  const canDrag = (info?.dragMimeTypes?.length ?? 0) > 0;
  const canDrop = (info?.dropMimeTypes?.length ?? 0) > 0;
  const generation = treeService.generation;

  /* ── markdown tooltips (TreeItem.tooltip, TreeDataProvider.resolveTreeItem) ── */

  const [tooltip, setTooltip] = useState<{ handle: string; html: string; x: number; y: number } | null>(null);
  const [resolved, setResolved] = useState<Map<string, HostTreeTooltip | null>>(() => new Map());
  const [dropHandle, setDropHandle] = useState<string | null>(null);
  const tooltipTimer = useRef<number | null>(null);
  const hovered = useRef<string | null>(null);

  const clearTooltipTimer = () => {
    if (tooltipTimer.current !== null) {
      clearTimeout(tooltipTimer.current);
      tooltipTimer.current = null;
    }
  };

  // A new host: resolveTreeItem answers of the old one are dropped.
  useEffect(() => setResolved(new Map()), [generation]);
  useEffect(() => clearTooltipTimer, []);

  const showTooltip = (handle: string, element: HTMLElement, value: HostTreeTooltip) => {
    if (typeof value === "string") return;
    const rect = element.getBoundingClientRect();
    setTooltip({ handle, html: renderMarkdown(value.markdown), x: Math.max(4, Math.min(rect.left + 8, window.innerWidth - 340)), y: rect.bottom + 4 });
  };

  /** After half a second over a row, show its Markdown tooltip (resolved lazily when the item has none). */
  const onRowEnter = (item: HostTreeItem, element: HTMLElement) => {
    clearTooltipTimer();
    hovered.current = item.handle;
    tooltipTimer.current = window.setTimeout(() => {
      tooltipTimer.current = null;
      if (hovered.current !== item.handle) return;
      const key = `${generation}:${item.handle}`;
      if (item.tooltip) showTooltip(item.handle, element, item.tooltip);
      else if (resolved.has(key)) {
        const answer = resolved.get(key);
        if (answer) showTooltip(item.handle, element, answer);
      } else {
        void treeService.resolveTooltip(viewId, item.handle).then((answer) => {
          setResolved((prev) => new Map(prev).set(key, answer));
          if (answer && hovered.current === item.handle) showTooltip(item.handle, element, answer);
        });
      }
    }, 500);
  };

  const onRowLeave = (handle: string) => {
    clearTooltipTimer();
    if (hovered.current === handle) hovered.current = null;
    setTooltip((current) => (current?.handle === handle ? null : current));
  };

  /** The native title: a plain tooltip, or the resolved one; a Markdown tooltip is the hover popup instead. */
  const titleFor = (item: HostTreeItem): string | undefined => {
    if (item.tooltip) return typeof item.tooltip === "string" ? item.tooltip : undefined;
    const answer = resolved.get(`${generation}:${item.handle}`);
    if (answer) return typeof answer === "string" ? answer : undefined;
    return item.description ? `${item.label} ${item.description}` : item.label;
  };

  /* ── drag and drop ─────────────────────────────────────────────────── */

  const onDragStart = (item: HostTreeItem, e: DragEvent<HTMLDivElement>) => {
    if (!canDrag) {
      e.preventDefault();
      return;
    }
    const handles = state.selection.includes(item.handle) && state.selection.length > 1 ? state.selection : [item.handle];
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.setData(TREE_DRAG_TYPE, treeService.startTreeDrag(viewId, handles));
  };

  const onDrop = (handle: string | null, e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDropHandle(null);
    if (!canDrop) return;
    void treeService.drop(viewId, handle, e.dataTransfer.getData(TREE_DRAG_TYPE) || null, dragFiles(e.dataTransfer));
  };

  const onDragOver = (handle: string, e: DragEvent<HTMLDivElement>) => {
    if (!canDrop || !draggable(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropHandle(handle);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = rows.findIndex((row) => row.item.handle === state.focused);
    const current = rows[index]?.item;
    const move = (next: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
      if (row) select(row.item, e.shiftKey ? e : null);
    };
    switch (e.key) {
      case "ArrowDown":
        move(index + 1);
        break;
      case "ArrowUp":
        move(index < 0 ? rows.length - 1 : index - 1);
        break;
      case "Home":
        move(0);
        break;
      case "End":
        move(rows.length - 1);
        break;
      case "ArrowRight":
        if (!current || current.collapsible === "none") return;
        if (!state.expanded.has(current.handle)) treeService.toggle(viewId, current.handle, true);
        else move(index + 1);
        break;
      case "ArrowLeft": {
        if (!current) return;
        if (current.collapsible !== "none" && state.expanded.has(current.handle)) treeService.toggle(viewId, current.handle, false);
        else {
          const parent = state.parents.get(current.handle);
          const row = rows.find((candidate) => candidate.item.handle === parent);
          if (row) select(row.item, null);
        }
        break;
      }
      case "Enter":
        if (current) activate(current);
        break;
      case " ":
        if (current?.checkbox) treeService.setChecked(viewId, current.handle, current.checkbox !== "checked");
        else if (current) activate(current);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const lookup = (key: string) => (key === "view" ? viewId : undefined);
  const rootLoaded = state.children.has("");
  const empty = rootLoaded && !(state.children.get("")?.length ?? 0);
  const welcome = (empty || state.missing) && !state.loading.has("") ? treeService.welcome(viewId, lookup) : [];

  return (
    <div
      ref={ref}
      className="ext-tree"
      tabIndex={0}
      role="tree"
      aria-label={info?.title || view.name}
      aria-multiselectable={info?.canSelectMany || undefined}
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if (canDrop && draggable(e.dataTransfer)) e.preventDefault();
      }}
      onDrop={(e) => onDrop(null, e)}
      onMouseLeave={() => {
        clearTooltipTimer();
        hovered.current = null;
        setTooltip(null);
      }}
      onScroll={() => setTooltip(null)}
    >
      {info?.message && <div className="ext-tree-message">{info.message}</div>}
      {welcome.length > 0 ? (
        <Welcome contents={welcome} />
      ) : state.missing ? (
        <div className="ext-empty">There is no data provider registered that can provide view data.</div>
      ) : !rootLoaded ? (
        state.loading.has("") && (
          <div className="ext-empty">
            <Loader size={13} className="codicon spin" /> Loading…
          </div>
        )
      ) : null}
      {rows.map(({ item, depth }) => {
        const expanded = state.expanded.has(item.handle);
        const selected = state.selection.includes(item.handle);
        const inline = itemMenu(item).filter((action) => action.group.startsWith("inline"));
        return (
          <div
            key={item.handle}
            data-handle={item.handle}
            role="treeitem"
            aria-level={depth + 1}
            aria-expanded={item.collapsible === "none" ? undefined : expanded}
            aria-selected={selected}
            className={`ext-tree-row${selected ? " selected" : ""}${state.focused === item.handle ? " focused" : ""}${dropHandle === item.handle ? " drop-target" : ""}`}
            style={{ paddingLeft: 6 + depth * 12 }}
            title={titleFor(item)}
            draggable={canDrag}
            onDragStart={(e) => onDragStart(item, e)}
            onDragOver={(e) => onDragOver(item.handle, e)}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropHandle((current) => (current === item.handle ? null : current));
            }}
            onDrop={(e) => onDrop(item.handle, e)}
            onMouseEnter={(e) => onRowEnter(item, e.currentTarget)}
            onMouseLeave={() => onRowLeave(item.handle)}
            onClick={(e) => {
              select(item, e);
              if (!e.ctrlKey && !e.metaKey && !e.shiftKey) activate(item);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!selected) select(item, null);
              const actions = itemMenu(item).filter((action) => !action.group.startsWith("inline"));
              showActionMenu(e.clientX, e.clientY, actions, (action) => treeService.itemCommand(viewId, action.command, item.handle));
            }}
          >
            <span
              className={`chevron${expanded ? " open" : ""}`}
              onClick={(e) => {
                if (item.collapsible === "none") return;
                e.stopPropagation();
                select(item, null);
                treeService.toggle(viewId, item.handle);
              }}
            >
              {item.collapsible !== "none" && (state.loading.has(item.handle) ? <Loader size={12} className="codicon spin" /> : <ChevronRight size={14} />)}
            </span>
            {item.checkbox && (
              <input
                type="checkbox"
                className="ext-tree-checkbox"
                checked={item.checkbox === "checked"}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => treeService.setChecked(viewId, item.handle, e.target.checked)}
              />
            )}
            <TreeIcon icon={item.icon} />
            <span className="ext-tree-label">
              <Label text={item.label} highlights={item.highlights} />
            </span>
            {item.description && <span className="ext-tree-description">{item.description}</span>}
            {inline.length > 0 && (
              <span className="ext-tree-actions">
                {inline.map((action) => (
                  <ActionButton key={action.command} action={action} onRun={() => treeService.itemCommand(viewId, action.command, item.handle)} />
                ))}
              </span>
            )}
          </div>
        );
      })}
      {tooltip && (
        <div className="lumen-tooltip lumen-tooltip-markdown visible ext-tree-tooltip markdown-body" style={{ left: tooltip.x, top: tooltip.y }} dangerouslySetInnerHTML={{ __html: tooltip.html }} />
      )}
    </div>
  );
}

/** Lets other code know whether a contributed view is a tree (anything but a webview). */
export const isTreeView = (view: ContributedView) => view.type !== "webview";
