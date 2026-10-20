export type ContextMenuItem =
  | {
      type: "item";
      label: string;
      action: string;
      danger?: boolean;
      disabled?: boolean;
      /** Shows a check mark (toggle items); undefined leaves no check column. */
      checked?: boolean;
      /** Runs when the item is chosen (the menu then resolves with null instead of `action`). */
      run?: () => void;
    }
  /** A fly-out with more items (contributed submenus). */
  | { type: "submenu"; label: string; items: ContextMenuItem[]; disabled?: boolean }
  | { type: "separator" };

/**
 * Adds items to menus other components open (explorer/context of extensions):
 * called with the items about to be shown and the element that was right-clicked.
 * Returns the extra items (shown after a separator), or null.
 */
export type MenuAugmenter = (items: ContextMenuItem[], target: Element | null) => ContextMenuItem[] | null;

const augmenters = new Set<MenuAugmenter>();

export function registerMenuAugmenter(augmenter: MenuAugmenter): () => void {
  augmenters.add(augmenter);
  return () => void augmenters.delete(augmenter);
}

/** The element of the latest right click: menus opened right after it belong to it. */
let lastContext: { target: Element | null; time: number } = { target: null, time: 0 };
if (typeof window !== "undefined") {
  window.addEventListener(
    "contextmenu",
    (event) => {
      lastContext = { target: event.target instanceof Element ? event.target : null, time: Date.now() };
    },
    true,
  );
}

function augment(items: ContextMenuItem[]): ContextMenuItem[] {
  if (!augmenters.size) return items;
  const target = Date.now() - lastContext.time < 500 ? lastContext.target : null;
  if (!target) return items;
  const extra: ContextMenuItem[] = [];
  for (const augmenter of augmenters) {
    try {
      const added = augmenter(items, target);
      if (added?.length) extra.push(...added);
    } catch (error) {
      console.warn("[context-menu] augmenter failed", error);
    }
  }
  if (!extra.length) return items;
  const last = items[items.length - 1];
  return [...items, ...(last && last.type !== "separator" ? [{ type: "separator" } as const] : []), ...extra];
}

/**
 * Lightweight in-app context menu. Resolves with the chosen action, or null
 * when the menu is dismissed.
 */
export function showContextMenu(
  x: number,
  y: number,
  items: ContextMenuItem[],
): Promise<string | null> {
  return new Promise((resolve) => {
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.setAttribute("role", "menu");

    const cleanup = (value: string | null) => {
      window.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
      menu.remove();
      resolve(value);
    };

    const onOutside = (event: MouseEvent) => {
      if (!menu.contains(event.target as Node)) cleanup(null);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cleanup(null);
      }
    };

    const onBlur = () => cleanup(null);

    const fill = (container: HTMLElement, entries: ContextMenuItem[]) => {
      for (const item of entries) {
        if (item.type === "separator") {
          const separator = document.createElement("div");
          separator.className = "ctx-sep";
          container.appendChild(separator);
          continue;
        }

        if (item.type === "submenu") {
          const host = document.createElement("div");
          host.className = "ctx-submenu-host";
          const button = document.createElement("button");
          button.type = "button";
          button.className = "ctx-item ctx-item-submenu";
          button.textContent = item.label;
          button.disabled = item.disabled ?? false;
          const arrow = document.createElement("span");
          arrow.className = "ctx-submenu-arrow";
          arrow.textContent = "›";
          button.appendChild(arrow);
          const nested = document.createElement("div");
          nested.className = "ctx-menu ctx-submenu";
          nested.setAttribute("role", "menu");
          fill(nested, item.items);
          host.append(button, nested);
          // Open towards the free side of the window.
          host.addEventListener("mouseenter", () => {
            nested.style.left = "";
            nested.style.right = "";
            nested.style.top = "";
            const rect = nested.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
              nested.style.left = "auto";
              nested.style.right = "100%";
            }
            if (rect.bottom > window.innerHeight) nested.style.top = `${-Math.round(rect.bottom - window.innerHeight) - 8}px`;
          });
          container.appendChild(host);
          continue;
        }

        const button = document.createElement("button");
        button.type = "button";
        button.className = `ctx-item${item.danger ? " danger" : ""}`;
        button.textContent = item.label;
        if (item.checked !== undefined) {
          button.setAttribute("role", "menuitemcheckbox");
          button.setAttribute("aria-checked", String(item.checked));
          const check = document.createElement("span");
          check.className = "ctx-check";
          check.textContent = item.checked ? "✓" : "";
          button.prepend(check);
        }
        button.disabled = item.disabled ?? false;
        button.addEventListener("click", () => {
          if (item.run) {
            cleanup(null);
            item.run();
          } else cleanup(item.action);
        });
        container.appendChild(button);
      }
    };

    fill(menu, augment(items));

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    document.body.appendChild(menu);

    // Keep the menu inside the viewport.
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${Math.max(4, window.innerWidth - rect.width - 6)}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(4, window.innerHeight - rect.height - 6)}px`;
    }

    window.addEventListener("mousedown", onOutside, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
  });
}
