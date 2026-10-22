import { Ellipsis } from "lucide-react";
import type { MouseEvent } from "react";
import type { ResolvedMenuItem } from "../../../shared/menus-walkthroughs";
import { WithCodicons } from "../../components/Codicon";
import { showContextMenu } from "../../lib/context-menu";
import { useExtensions } from "../../lib/extensions";
import { resolveContributedMenu, runMenuCommand, toContextItems, uriArg, type MenuArgs } from "./menus";
import { resourceLookup } from "./editor";

/**
 * The action bar of a contributed menu (scm/title, debug/toolBar,
 * notebook/cell/title, …): entries of the `inline` groups are icon buttons,
 * the rest sits behind a "…" button. Renders nothing when no entry applies.
 */

type CommandItem = Extract<ResolvedMenuItem, { type: "command" }>;

export function MenuActionButton({ item, onRun, className }: { item: CommandItem; onRun: () => void; className?: string }) {
  const icon = item.icon?.startsWith("$(") ? (
    <WithCodicons text={item.icon} size={14} />
  ) : item.icon ? (
    <img src={item.icon} alt="" className="view-action-image" />
  ) : null;
  return (
    <button
      type="button"
      className={`icon-btn view-action${icon ? "" : " text"}${className ? ` ${className}` : ""}`}
      title={item.title}
      onClick={(e) => {
        e.stopPropagation();
        onRun();
      }}
    >
      {icon ?? item.title}
    </button>
  );
}

export function MenuActions({
  menuId,
  lookup,
  args,
  inline = ["navigation", "inline"],
  overflow = true,
  className,
}: {
  menuId: string;
  lookup: (key: string) => unknown;
  args: MenuArgs;
  /** Groups shown as buttons (VS Code: "navigation" in title bars, "inline" in list rows), or a test of the group. */
  inline?: string[] | ((group: string) => boolean);
  /** Show the other groups behind "…" (false: inline entries only). */
  overflow?: boolean;
  className?: string;
}) {
  // Re-render when extensions or context keys change: both can flip when clauses.
  useExtensions();
  const items = resolveContributedMenu(menuId, lookup);
  const isInline = typeof inline === "function" ? inline : (group: string) => inline.includes(group);
  const buttons = items.filter((item): item is CommandItem => item.type === "command" && isInline(item.group));
  const rest = overflow ? items.filter((item) => !buttons.includes(item as CommandItem)) : [];
  if (!buttons.length && !rest.length) return null;
  const run = (command: string) => runMenuCommand(command, typeof args === "function" ? args() : args);
  const more = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    void showContextMenu(rect.left, rect.bottom + 2, toContextItems(rest, run));
  };
  return (
    <span className={`menu-actions${className ? ` ${className}` : ""}`} onClick={(e) => e.stopPropagation()}>
      {buttons.map((item) => (
        <MenuActionButton key={item.command} item={item} onRun={() => run(item.command)} />
      ))}
      {rest.length > 0 && (
        <button type="button" className="icon-btn view-action" title="More Actions…" onClick={more}>
          <Ellipsis size={14} />
        </button>
      )}
    </span>
  );
}

/**
 * modalEditor/editorTitle: the actions of the editor shown in a modal (the
 * modal editor part, Settings, Keyboard Shortcuts, extension details).
 * `path` is the file of a text / feature editor; `activeEditor` names the others.
 */
export function ModalEditorTitleActions({ path, activeEditor, maximized = false }: { path?: string | null; activeEditor?: string; maximized?: boolean }) {
  const resource = path && !path.startsWith("terminal:") && !path.startsWith("webview:") ? resourceLookup(path) : () => undefined;
  const lookup = (key: string): unknown => {
    switch (key) {
      case "editorPartModal":
        return true;
      case "editorPartModalMaximized":
        return maximized;
      case "activeEditor":
        return activeEditor ?? (path ? "workbench.editors.files.textFileEditor" : undefined);
      default:
        return resource(key);
    }
  };
  return (
    <MenuActions
      menuId="modalEditor/editorTitle"
      lookup={lookup}
      args={path && !path.startsWith("terminal:") ? [uriArg(path)] : []}
      className="modal-editor-actions"
    />
  );
}
