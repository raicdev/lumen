import { flattenMenu, resolveMenu, type ResolvedMenuItem } from "../../../shared/menus-walkthroughs";
import { showContextMenu, type ContextMenuItem } from "../../lib/context-menu";
import { extensionService } from "../../lib/extensions";
import { commandExecuted, getApi } from "./state";

/**
 * Contributed menus (contributes.menus + contributes.submenus) as context menu
 * items. Used by the editor (editor/context, editor/title), the explorer
 * (explorer/context) and, through `resolveContributedMenu`, by the views'
 * view/title and view/item/context menus.
 */

/** The entries of `menuId` whose when clause holds (`lookup` answers the keys the menu knows, e.g. `resourceLangId`). */
export function resolveContributedMenu(menuId: string, lookup: (key: string) => unknown): ResolvedMenuItem[] {
  const sources = extensionService
    .getSnapshot()
    .extensions.filter((extension) => extension.enabled)
    .map((extension) => ({ id: extension.id, manifest: extension.manifest, commandIcons: extension.commandIcons }));
  return resolveMenu(sources, menuId, (clause) => extensionService.when(clause, lookup));
}

/** Wire form of a resource argument: the host revives it into a `Uri` (`$uri`: a file path or URI components). */
export type UriArg = { $uri: string };

export const uriArg = (path: string): UriArg => ({ $uri: path });

/**
 * Wire form of an API object the host owns (a `SourceControlResourceState`, a
 * `TestItem`, a `NotebookCell`, a `Terminal`, …): the host feature of `area`
 * revives it (HostFeature.menuArg).
 */
export type RefArg = { $ref: { area: string; [key: string]: unknown } };

export const refArg = (area: string, fields: Record<string, unknown>): RefArg => ({ $ref: { ...fields, area } });

/** Resolves the arguments of a menu command when an entry is chosen (so they reflect the state at that time). */
export type MenuArgs = unknown[] | (() => unknown[]);

const argsOf = (args: MenuArgs): unknown[] => (typeof args === "function" ? args() : args);

/** Runs a menu command with the arguments VS Code passes (the resource); extension commands go through the host so the `Uri` is revived. */
export function runMenuCommand(command: string, args: unknown[]): void {
  const api = getApi();
  if (!api) return;
  const contributed = extensionService.contributedCommands().some((entry) => entry.command === command);
  if (contributed) api.sendToHost({ type: "run", command, args });
  else api.executeCommand(command, ...args.map((arg) => (arg && typeof arg === "object" && "$uri" in arg ? (arg as UriArg).$uri : arg)));
  commandExecuted(command);
}

/** The context menu items of a contributed menu (several menus are joined with separators); empty when nothing applies. */
export function contributedMenuItems(menuIds: string | string[], lookup: (key: string) => unknown, args: MenuArgs): ContextMenuItem[] {
  const out: ContextMenuItem[] = [];
  for (const menuId of Array.isArray(menuIds) ? menuIds : [menuIds]) {
    const items = resolveContributedMenu(menuId, lookup);
    if (!flattenMenu(items).length) continue;
    if (out.length) out.push({ type: "separator" });
    out.push(...toContextItems(items, (command) => runMenuCommand(command, argsOf(args))));
  }
  return out;
}

/**
 * Right click on something that has a contributed menu: shows it (after the
 * component's own `before` items) and returns true, or false when there is
 * nothing to show (the caller may then show its own menu or none).
 */
export function showContributedMenu(
  event: { clientX: number; clientY: number; preventDefault(): void; stopPropagation?(): void },
  menuIds: string | string[],
  lookup: (key: string) => unknown,
  args: MenuArgs,
  before: ContextMenuItem[] = [],
): boolean {
  const contributed = contributedMenuItems(menuIds, lookup, args);
  if (!contributed.length && !before.length) return false;
  event.preventDefault();
  event.stopPropagation?.();
  const items = before.length && contributed.length ? [...before, { type: "separator" } as const, ...contributed] : [...before, ...contributed];
  void showContextMenu(event.clientX, event.clientY, items);
  return true;
}

/** Items for `showContextMenu`: groups separated like VS Code's, submenus as fly-outs. */
export function toContextItems(items: ResolvedMenuItem[], run: (command: string) => void): ContextMenuItem[] {
  const out: ContextMenuItem[] = [];
  items.forEach((item, index) => {
    if (index && items[index - 1]!.group !== item.group) out.push({ type: "separator" });
    if (item.type === "submenu") out.push({ type: "submenu", label: item.title, items: toContextItems(item.items, run) });
    else out.push({ type: "item", label: item.title, action: item.command, run: () => run(item.command) });
  });
  return out;
}
