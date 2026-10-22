export type DialogButton = {
  label: string;
  role?: "primary" | "danger" | "default";
  value: string;
};

/** Picks the icon and accent of the dialog. */
export type DialogKind = "info" | "warning" | "error" | "question" | "danger";

export type DialogOptions = {
  title: string;
  message: string;
  detail?: string;
  buttons: DialogButton[];
  defaultValue?: string;
  /**
   * Defaults to "danger" when the main action is destructive, "warning" when a destructive
   * button sits beside a primary one, otherwise "question" (or "info" with a single button).
   */
  kind?: DialogKind;
};

// Lucide icon paths (24×24, stroke).
const ICONS: Record<DialogKind | "edit" | "close", string> = {
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  question: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  error: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  danger:
    '<path d="M12 16h.01"/><path d="M12 8v4"/><path d="M15.31 2a2 2 0 0 1 1.42.59l4.68 4.68A2 2 0 0 1 22 8.69v6.62a2 2 0 0 1-.59 1.42l-4.68 4.68a2 2 0 0 1-1.42.59H8.69a2 2 0 0 1-1.42-.59l-4.68-4.68A2 2 0 0 1 2 15.31V8.69a2 2 0 0 1 .59-1.42l4.68-4.68A2 2 0 0 1 8.69 2z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.38 3.62a1 1 0 0 1 3 3L7.37 18.64a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

function icon(name: keyof typeof ICONS, size: number) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

let nextId = 0;

/**
 * Mounts a dialog shell (backdrop, icon, title, close button) and wires the
 * behavior every dialog shares: Escape / backdrop click dismiss, Tab stays
 * inside the dialog, focus returns to where it was, enter/exit animation.
 */
function openShell(options: {
  title: string;
  icon: DialogKind | "edit";
  body: string;
  footer: string;
  onKey?: (e: KeyboardEvent, finish: () => void) => void;
  onDismiss: () => void;
}) {
  const id = `lumen-dialog-${++nextId}`;
  const previousFocus = document.activeElement as HTMLElement | null;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay dialog-overlay";
  overlay.innerHTML = `
    <div class="modal dialog dialog-${options.icon}" role="dialog" aria-modal="true" aria-labelledby="${id}-title" aria-describedby="${id}-body">
      <button type="button" class="dialog-close" aria-label="Close" tabindex="-1">${icon("close", 14)}</button>
      <div class="dialog-header">
        <div class="dialog-icon">${icon(options.icon, 18)}</div>
        <h2 class="modal-title" id="${id}-title">${escapeHtml(options.title)}</h2>
      </div>
      <div class="dialog-body" id="${id}-body">${options.body}</div>
      <div class="modal-actions">${options.footer}</div>
    </div>
  `;
  const dialog = overlay.querySelector(".dialog") as HTMLElement;

  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener("keydown", onKey, true);
    overlay.classList.add("closing");
    const remove = () => overlay.remove();
    // The exit animation comes from modern.css; legacy style and reduced motion have none.
    if (getComputedStyle(overlay).animationName === "none") remove();
    else {
      overlay.addEventListener("animationend", remove, { once: true });
      setTimeout(remove, 200);
    }
    if (previousFocus?.isConnected) previousFocus.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish();
      options.onDismiss();
      return;
    }
    if (e.key === "Tab") {
      const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not([tabindex='-1']), input")];
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && index <= 0) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (index === -1 || index === focusable.length - 1)) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    options.onKey?.(e, finish);
  };

  overlay.addEventListener("mousedown", (e) => {
    if (e.target !== overlay) return;
    // A click on the backdrop shakes the dialog instead of dropping the answer silently.
    dialog.classList.remove("nudge");
    void dialog.offsetWidth;
    dialog.classList.add("nudge");
  });
  overlay.querySelector(".dialog-close")!.addEventListener("click", () => {
    finish();
    options.onDismiss();
  });

  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
  return { overlay, dialog, finish };
}

/**
 * In-app modal dialog. Returns the clicked button value, or null if dismissed.
 */
export function showDialog(options: DialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const destructive = options.buttons.some((b) => b.role === "danger");
    const kind =
      options.kind ??
      (destructive ? (options.buttons.some((b) => b.role === "primary") ? "warning" : "danger") : options.buttons.length === 1 ? "info" : "question");
    const body = `
      <p class="modal-message">${escapeHtml(options.message)}</p>
      ${options.detail ? `<p class="modal-detail">${escapeHtml(options.detail)}</p>` : ""}
    `;
    const { overlay, finish } = openShell({
      title: options.title,
      icon: kind,
      body,
      footer: "",
      onDismiss: () => resolve(null),
      onKey: (e, close) => {
        if (e.key === "Enter" && options.defaultValue && !(document.activeElement instanceof HTMLButtonElement)) {
          e.preventDefault();
          close();
          resolve(options.defaultValue);
        }
      },
    });

    const actions = overlay.querySelector(".modal-actions")!;
    for (const btn of options.buttons) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `modal-btn ${btn.role ?? "default"}`;
      el.textContent = btn.label;
      el.addEventListener("click", () => {
        finish();
        resolve(btn.value);
      });
      actions.appendChild(el);
    }

    const preferred =
      options.buttons.findIndex((b) => b.value === options.defaultValue) >= 0
        ? options.buttons.findIndex((b) => b.value === options.defaultValue)
        : options.buttons.findIndex((b) => b.role === "primary");
    // Destructive dialogs never focus the destructive button, so a stray Enter can't delete anything.
    const fallback = options.buttons.findIndex((b) => b.role !== "danger");
    const index = preferred >= 0 ? preferred : fallback >= 0 ? fallback : 0;
    (actions.children[index] as HTMLButtonElement | undefined)?.focus();
  });
}

export function showPrompt(options: { title: string; message: string; defaultValue?: string; placeholder?: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const body = `
      <p class="modal-message">${escapeHtml(options.message)}</p>
      <input class="modal-input" type="text" spellcheck="false" autocomplete="off"
        value="${escapeAttr(options.defaultValue ?? "")}"
        placeholder="${escapeAttr(options.placeholder ?? "")}" />
    `;
    const footer = `
      <span class="dialog-hint"><kbd>Enter</kbd> to confirm · <kbd>Esc</kbd> to cancel</span>
      <button type="button" class="modal-btn default" data-act="cancel">Cancel</button>
      <button type="button" class="modal-btn primary" data-act="ok">OK</button>
    `;
    const { overlay, finish } = openShell({
      title: options.title,
      icon: "edit",
      body,
      footer,
      onDismiss: () => resolve(null),
      onKey: (e, close) => {
        if (e.key === "Enter" && document.activeElement === input) {
          e.preventDefault();
          close();
          resolve(input.value);
        }
      },
    });

    const input = overlay.querySelector(".modal-input") as HTMLInputElement;
    overlay.querySelector('[data-act="cancel"]')?.addEventListener("click", () => {
      finish();
      resolve(null);
    });
    overlay.querySelector('[data-act="ok"]')?.addEventListener("click", () => {
      finish();
      resolve(input.value);
    });

    requestAnimationFrame(() => {
      input.focus();
      // Like a file rename: select the name without its extension.
      const dot = input.value.lastIndexOf(".");
      if (dot > 0) input.setSelectionRange(0, dot);
      else input.select();
    });
  });
}

export function showAbout(info: { name: string; version: string; platform: string }) {
  return showDialog({
    title: `${info.name} ${info.version}`,
    message: "A fast, luminous code editor.",
    detail: `Built with Lumen Shell · Node.js · TypeScript\nPlatform: ${info.platform}\n\nKeyboard: Ctrl+P palette · Ctrl+Shift+F search · Ctrl+S save`,
    buttons: [{ label: "Close", role: "primary", value: "ok" }],
    defaultValue: "ok",
    kind: "info",
  });
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "<br>");
}

function escapeAttr(s: string) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
