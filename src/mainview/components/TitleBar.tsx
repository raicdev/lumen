import { Check, ChevronRight, Copy, Minus, Search, Sparkle, Square, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { APP_MENU, runMenuItem, type MenuItem } from "../lib/menu";
import type { Command } from "../lib/commands";
import { showContextMenu } from "../lib/context-menu";
import { contributedMenuItems } from "../features/menus-walkthroughs/menus";

type Props = {
  commands: Map<string, Command>;
  /** commandId → primary keybinding, for the shortcut column. */
  keys: Map<string, string>;
  /** Shown in the command center (workspace name). */
  centerLabel: string;
  onCommandCenter: () => void;
};

type ResolvedItem =
  | { kind: "separator" }
  | {
      kind: "item";
      item: MenuItem;
      label: string;
      accelerator?: string;
      checked: boolean;
      disabled: boolean;
      /** Entries of a submenu item. */
      children?: ResolvedItem[];
    };

/** The entries of a contributed submenu (menuBar/edit/copy). */
const contributedItems = (menu: string) => contributedMenuItems(menu, () => undefined, []);

function resolveItems(items: MenuItem[], commands: Map<string, Command>, keys: Map<string, string>): ResolvedItem[] {
  // Contributed submenus nobody contributes to are left out.
  const shown = items.filter((item) => item.type !== "contributed" || contributedItems(item.menu).length > 0);
  return shown.map((item): ResolvedItem => {
    if (item.type === "separator") return { kind: "separator" };
    if (item.type === "contributed") return { kind: "item", item, label: `${item.label} ›`, checked: false, disabled: false };
    if (item.type === "submenu") {
      const children = resolveItems(item.items, commands, keys);
      const disabled = !children.some((child) => child.kind === "item" && !child.disabled);
      return { kind: "item", item, label: item.label, checked: false, disabled, children };
    }
    if (item.type === "role") {
      return { kind: "item", item, label: item.label, accelerator: item.accelerator, checked: false, disabled: false };
    }
    const command = commands.get(item.command);
    return {
      kind: "item",
      item,
      label: item.label ?? command?.title ?? item.command,
      accelerator: keys.get(item.command),
      checked: command?.checked?.() ?? false,
      disabled: !command || command.enabled?.() === false,
    };
  });
}

/** Index of the next enabled item, walking in `step` direction. */
function nextItemIndex(items: ResolvedItem[], from: number, step: 1 | -1): number {
  for (let i = 1; i <= items.length; i++) {
    const index = (from + step * i + items.length * 2) % items.length;
    const item = items[index]!;
    if (item.kind === "item" && !item.disabled) return index;
  }
  return -1;
}

/** Keeps focus where it was (usually the editor) when clicking menu chrome. */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

function MenuBar({ commands, keys }: { commands: Map<string, Command>; keys: Map<string, string> }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [activeItem, setActiveItem] = useState(-1);
  /** Index (in `items`) of the submenu entry whose fly-out is open, and the highlighted fly-out entry. */
  const [subOpen, setSubOpen] = useState<number | null>(null);
  const [subActive, setSubActive] = useState(-1);
  const barRef = useRef<HTMLDivElement>(null);

  const items = openIndex === null ? [] : resolveItems(APP_MENU[openIndex]!.items, commands, keys);
  const subEntry = subOpen === null ? undefined : items[subOpen];
  const subItems = subEntry?.kind === "item" ? (subEntry.children ?? []) : [];

  const openSub = useCallback((index: number | null, highlightFirst = false, children: ResolvedItem[] = []) => {
    setSubOpen(index);
    setSubActive(highlightFirst ? nextItemIndex(children, -1, 1) : -1);
  }, []);

  const close = useCallback(() => {
    setOpenIndex(null);
    setActiveItem(-1);
    setSubOpen(null);
  }, []);

  const open = useCallback(
    (index: number, highlightFirst = false) => {
      setOpenIndex(index);
      setSubOpen(null);
      setActiveItem(highlightFirst ? nextItemIndex(resolveItems(APP_MENU[index]!.items, commands, keys), -1, 1) : -1);
    },
    [commands, keys],
  );

  const run = useCallback(
    (item: MenuItem, anchor?: Element | null) => {
      if (item.type === "submenu") return;
      close();
      // A contributed submenu opens next to its entry.
      if (item.type === "contributed") {
        const rect = anchor?.getBoundingClientRect();
        void showContextMenu(rect ? rect.right : 0, rect ? rect.top : 0, contributedItems(item.menu));
        return;
      }
      runMenuItem(item, commands);
    },
    [close, commands],
  );

  // Alt+<first letter> opens a menu, like the native Windows menu bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const letter = /^Key([A-Z])$/.exec(e.code)?.[1] ?? (e.key.length === 1 ? e.key.toUpperCase() : null);
      if (!letter) return;
      const index = APP_MENU.findIndex((group) => group.label[0]!.toUpperCase() === letter);
      if (index < 0) return;
      e.preventDefault();
      e.stopPropagation();
      open(index, true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // While a menu is open it owns the keyboard and closes on outside clicks.
  useEffect(() => {
    if (openIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      const handled = ["Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", " "];
      if (!handled.includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const inSub = subOpen !== null;
      const current = items[activeItem];
      const canOpenSub = current?.kind === "item" && !current.disabled && !!current.children;
      if (e.key === "Escape") {
        if (inSub) openSub(null);
        else close();
      } else if (e.key === "ArrowDown") {
        if (inSub) setSubActive((i) => nextItemIndex(subItems, i, 1));
        else setActiveItem((i) => nextItemIndex(items, i, 1));
      } else if (e.key === "ArrowUp") {
        if (inSub) setSubActive((i) => nextItemIndex(subItems, i < 0 ? subItems.length : i, -1));
        else setActiveItem((i) => nextItemIndex(items, i < 0 ? items.length : i, -1));
      } else if (e.key === "ArrowLeft") {
        if (inSub) openSub(null);
        else open((openIndex - 1 + APP_MENU.length) % APP_MENU.length, true);
      } else if (e.key === "ArrowRight") {
        if (!inSub && canOpenSub) openSub(activeItem, true, current.children);
        else open((openIndex + 1) % APP_MENU.length, true);
      } else if (inSub) {
        const item = subItems[subActive];
        if (item?.kind === "item" && !item.disabled) run(item.item, barRef.current?.querySelector(".menu-submenu .menu-item.active"));
      } else if (canOpenSub) {
        openSub(activeItem, true, current.children);
      } else if (current?.kind === "item" && !current.disabled) {
        run(current.item, barRef.current?.querySelector(".menu-item.active"));
      }
    };
    const onPointer = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onPointer, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
    // The items are resolved on every render (their checked / enabled state is live), so the keys follow them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openIndex, activeItem, items, subOpen, subActive, subItems, close, open, openSub, run]);

  const renderItem = (item: ResolvedItem, itemIndex: number, active: boolean, onHover: () => void, onClick: (el: Element) => void) =>
    item.kind === "separator" ? (
      <div key={`sep-${itemIndex}`} className="menu-sep" />
    ) : (
      <button
        key={`${item.label}-${itemIndex}`}
        type="button"
        role={item.checked ? "menuitemcheckbox" : "menuitem"}
        aria-checked={item.checked || undefined}
        aria-haspopup={item.children ? "menu" : undefined}
        aria-expanded={item.children ? subOpen === itemIndex : undefined}
        disabled={item.disabled}
        className={`menu-item${active ? " active" : ""}`}
        onMouseEnter={onHover}
        onClick={(e) => onClick(e.currentTarget)}
      >
        <span className="menu-check">{item.checked ? <Check size={14} /> : null}</span>
        <span className="menu-label">{item.label}</span>
        {item.children ? (
          <span className="menu-accel menu-submenu-arrow">
            <ChevronRight size={14} />
          </span>
        ) : (
          item.accelerator && <span className="menu-accel">{item.accelerator}</span>
        )}
      </button>
    );

  return (
    <div className="menubar" role="menubar" ref={barRef}>
      {APP_MENU.map((group, index) => (
        <div key={group.label} className="menubar-group">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openIndex === index}
            className={`menubar-btn${openIndex === index ? " open" : ""}`}
            onMouseDown={(e) => {
              keepFocus(e);
              if (e.button !== 0) return;
              if (openIndex === index) close();
              else open(index);
            }}
            onMouseEnter={() => {
              if (openIndex !== null && openIndex !== index) open(index);
            }}
          >
            {group.label}
          </button>
          {openIndex === index && (
            <div className="menu-dropdown" role="menu" data-lumen-no-drag onMouseDown={keepFocus}>
              {items.map((item, itemIndex) => {
                const hover = () => {
                  setActiveItem(itemIndex);
                  openSub(item.kind === "item" && item.children && !item.disabled ? itemIndex : null);
                };
                const button = renderItem(item, itemIndex, itemIndex === activeItem, hover, (el) => {
                  if (item.kind !== "item") return;
                  if (item.children) openSub(itemIndex, false, item.children);
                  else run(item.item, el);
                });
                if (item.kind === "separator" || !item.children) return button;
                return (
                  <div key={`${item.label}-${itemIndex}`} className="menu-submenu-anchor">
                    {button}
                    {subOpen === itemIndex && (
                      <div className="menu-dropdown menu-submenu" role="menu">
                        {item.children.map((child, childIndex) =>
                          renderItem(
                            child,
                            childIndex,
                            childIndex === subActive,
                            () => setSubActive(childIndex),
                            (el) => {
                              if (child.kind === "item") run(child.item, el);
                            },
                          ),
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(() => window.__lumen?.windowState === "maximized");

  useEffect(() => {
    const onState = (e: Event) => {
      setMaximized((e as CustomEvent<{ state: string }>).detail.state === "maximized");
    };
    window.addEventListener("lumen:window-state", onState);
    return () => window.removeEventListener("lumen:window-state", onState);
  }, []);

  const controls = window.__lumen?.window;
  return (
    <div className="window-controls">
      <button type="button" className="window-btn" title="Minimize" onMouseDown={keepFocus} onClick={() => controls?.minimize()}>
        <Minus size={16} strokeWidth={1.25} />
      </button>
      <button
        type="button"
        className="window-btn"
        // Registered with the OS as the real maximize button (snap layouts).
        data-lumen-maximize-button
        title={maximized ? "Restore" : "Maximize"}
        onMouseDown={keepFocus}
        onClick={() => controls?.toggleMaximize()}
      >
        {maximized ? <Copy size={14} strokeWidth={1.25} /> : <Square size={13} strokeWidth={1.25} />}
      </button>
      <button type="button" className="window-btn close" title="Close" onMouseDown={keepFocus} onClick={() => controls?.close()}>
        <X size={17} strokeWidth={1.25} />
      </button>
    </div>
  );
}

/**
 * Custom title bar: app mark, menu bar, command center and (for frameless
 * windows) the window buttons. Empty areas drag the window; double-click
 * toggles maximize — both handled by the Lumen Shell prelude.
 */
export function TitleBar({ commands, keys, centerLabel, onCommandCenter }: Props) {
  const frameless = window.__lumen?.frameless ?? false;
  const [focused, setFocused] = useState(() => document.hasFocus());

  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  return (
    <header className={`titlebar${frameless ? " frameless" : ""}${focused ? "" : " inactive"}`} data-lumen-drag-region>
      <div className="titlebar-left">
        <span className="titlebar-mark" aria-hidden="true">
          <Sparkle size={16} fill="currentColor" strokeWidth={1.5} />
        </span>
        <MenuBar commands={commands} keys={keys} />
      </div>
      <div className="titlebar-center">
        <button id="btn-command-palette" className="toolbar-search" type="button" title="Search files (Ctrl+P)" onClick={onCommandCenter}>
          <Search size={14} />
          <span>{centerLabel}</span>
        </button>
      </div>
      <div className="titlebar-right">{frameless && <WindowControls />}</div>
    </header>
  );
}
