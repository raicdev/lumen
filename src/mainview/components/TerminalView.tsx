import { CircleSlash, SquareSplitHorizontal, SquareTerminal, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { terminalService } from "../lib/terminals";
import { showContextMenu, type ContextMenuItem } from "../lib/context-menu";
import { WithCodicons } from "./Codicon";
import { contributedMenuItems, refArg, showContributedMenu } from "../features/menus-walkthroughs/menus";
import type { TerminalInfo } from "../lib/terminals";
import { t } from "../lib/i18n";

/** Drag payload types (also read by the dock overlay). */
export const TERMINAL_DRAG_TYPE = "application/x-lumen-terminal";

export function useTerminals() {
  return useSyncExternalStore(terminalService.subscribe, terminalService.getSnapshot);
}

/** The icon of a terminal tab: an extension's own icon / color, else the default one. */
function TerminalTabIcon({ info }: { info: TerminalInfo | undefined }) {
  if (info?.exited) return <CircleSlash size={14} />;
  const icon = info?.icon;
  const style = info?.color ? { color: info.color } : undefined;
  if (icon?.kind === "image") return <img className="terminal-ext-icon" src={icon.src} alt="" style={style} />;
  return (
    <span className="terminal-ext-icon-wrap" style={style}>
      {icon?.kind === "codicon" && (
        <span className="terminal-ext-icon">
          <WithCodicons text={`$(${icon.id})`} size={14} />
        </span>
      )}
      <SquareTerminal size={14} className="terminal-default-icon" />
    </span>
  );
}

/** Context keys of terminal/context and terminal/title/context. */
function terminalLookup(id: string): (key: string) => unknown {
  return (key) => {
    const snapshot = terminalService.getSnapshot();
    const info = snapshot.instances.find((instance) => instance.id === id);
    switch (key) {
      case "terminalFocus":
      case "terminalIsOpen":
      case "terminalHasBeenCreated":
      case "terminalProcessSupported":
        return true;
      case "terminalEditorFocus":
      case "terminalEditorActive":
        return info?.location === "editor";
      case "terminalCount":
        return snapshot.instances.length;
      case "terminalSplitPaneActive":
        return (snapshot.groups.find((group) => group.includes(id))?.length ?? 0) > 1;
      default:
        return undefined;
    }
  };
}

/** Contributed entries of a terminal menu; commands get the `Terminal` (revived by the host). */
function terminalMenu(menuId: "terminal/context" | "terminal/title/context", id: string): ContextMenuItem[] {
  return contributedMenuItems(menuId, terminalLookup(id), [refArg("terminal", { id })]);
}

/** Shows one terminal instance; refits whenever its box changes size. `editor`: shown as an editor tab (terminal/context on right click). */
export function TerminalHost({ id, active, onFocus, editor }: { id: string; active?: boolean; onFocus?: () => void; editor?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    terminalService.attach(id, container);
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => terminalService.fit(id));
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [id]);

  return (
    <div
      ref={ref}
      className={`terminal-host${active ? " active" : ""}`}
      onMouseDown={onFocus}
      onContextMenu={
        editor
          ? (e) =>
              showContributedMenu(
                e,
                "terminal/context",
                terminalLookup(id),
                [refArg("terminal", { id })],
                [
                  {
                    type: "item",
                    label: t("Copy"),
                    action: "copy",
                    disabled: !terminalService.hasSelection(id),
                    run: () => void terminalService.copySelection(id),
                  },
                  { type: "item", label: t("Paste"), action: "paste", run: () => void terminalService.paste(id) },
                ],
              )
          : undefined
      }
    />
  );
}

export type TerminalMenuAction = "rename" | "split" | "unsplit" | "move-to-editor" | "relaunch" | "kill";

type PanelProps = {
  visible: boolean;
  onAction: (action: TerminalMenuAction, id: string) => void;
};

/**
 * The panel's terminal area: the active group's terminals side by side, and
 * (with more than one terminal) the list of terminals on the right.
 */
export function TerminalPanelView({ visible, onAction }: PanelProps) {
  const snapshot = useTerminals();
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const group = snapshot.groups[snapshot.activeGroup] ?? [];
  const panelTerminals = snapshot.groups.flat();
  const titleOf = (id: string) => snapshot.instances.find((i) => i.id === id)?.title ?? "terminal";
  const exited = (id: string) => snapshot.instances.find((i) => i.id === id)?.exited ?? false;

  /** The terminal's own menu, then the extensions' terminal/context (body) or terminal/title/context (list entry). */
  const menu = (id: string, x: number, y: number, menuId: "terminal/context" | "terminal/title/context") => {
    const inGroup = (snapshot.groups.find((g) => g.includes(id))?.length ?? 0) > 1;
    const contributed = terminalMenu(menuId, id);
    void showContextMenu(x, y, [
      ...(menuId === "terminal/context"
        ? [
            { type: "item" as const, label: t("Copy"), action: "copy", disabled: !terminalService.hasSelection(id) },
            { type: "item" as const, label: t("Paste"), action: "paste" },
            { type: "separator" as const },
          ]
        : []),
      { type: "item", label: t("Split Terminal"), action: "split" },
      ...(inGroup ? [{ type: "item" as const, label: t("Unsplit Terminal"), action: "unsplit" }] : []),
      { type: "item", label: t("Move Terminal into Editor Area"), action: "move-to-editor" },
      { type: "separator" },
      { type: "item", label: t("Rename…"), action: "rename" },
      { type: "item", label: t("Relaunch Active Terminal"), action: "relaunch" },
      { type: "separator" },
      { type: "item", label: t("Kill Terminal"), action: "kill", danger: true },
      ...(contributed.length ? [{ type: "separator" as const }, ...contributed] : []),
    ]).then((action) => {
      if (action === "copy") terminalService.copySelection(id);
      else if (action === "paste") void terminalService.paste(id);
      else if (action) onAction(action as TerminalMenuAction, id);
    });
  };

  if (!panelTerminals.length) {
    return (
      <div className="terminal-empty">
        <button type="button" className="welcome-link" onClick={() => onAction("split", "")}>
          {t("Create a new terminal")}
        </button>
      </div>
    );
  }

  return (
    <div className="terminal-area">
      <div className="terminal-split">
        {visible &&
          group.map((id, index) => (
            <div key={id} className="terminal-pane-wrap" onContextMenu={(e) => (e.preventDefault(), menu(id, e.clientX, e.clientY, "terminal/context"))}>
              {index > 0 && <div className="terminal-pane-divider" />}
              <TerminalHost id={id} active={id === snapshot.activeId && group.length > 1} onFocus={() => terminalService.setActive(id)} />
            </div>
          ))}
      </div>
      {panelTerminals.length > 1 && (
        <div className="terminal-tabs" role="tablist" aria-label={t("Terminals")}>
          {snapshot.groups.map((g) =>
            g.map((id, index) => (
              <div
                key={id}
                role="tab"
                aria-selected={id === snapshot.activeId}
                className={`terminal-tab${id === snapshot.activeId ? " active" : ""}${dropTarget === id ? " drop-target" : ""}`}
                title={exited(id) ? t("{0} (exited)", titleOf(id)) : titleOf(id)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(TERMINAL_DRAG_TYPE, id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes(TERMINAL_DRAG_TYPE)) return;
                  e.preventDefault();
                  setDropTarget(id);
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropTarget(null);
                  const dragged = e.dataTransfer.getData(TERMINAL_DRAG_TYPE);
                  // Dropping one terminal on another splits them into one group.
                  if (dragged && dragged !== id) terminalService.joinGroup(dragged, id);
                }}
                onClick={() => {
                  terminalService.setActive(id);
                  terminalService.focus(id);
                }}
                onDoubleClick={() => onAction("rename", id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  menu(id, e.clientX, e.clientY, "terminal/title/context");
                }}
              >
                <span className="terminal-tab-tree">{g.length > 1 ? (index === 0 ? "┌" : index === g.length - 1 ? "└" : "├") : ""}</span>
                <span className="terminal-tab-icon">
                  <TerminalTabIcon info={snapshot.instances.find((i) => i.id === id)} />
                </span>
                <span className="terminal-tab-title">{titleOf(id)}</span>
                <span className="terminal-tab-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("Split Terminal")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAction("split", id);
                    }}
                  >
                    <SquareSplitHorizontal size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t("Kill Terminal")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAction("kill", id);
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </div>
            )),
          )}
        </div>
      )}
    </div>
  );
}
