export type DialogButton = {
  label: string;
  role?: "primary" | "danger" | "default";
  value: string;
};

export type DialogOptions = {
  title: string;
  message: string;
  detail?: string;
  buttons: DialogButton[];
  defaultValue?: string;
};

/**
 * In-app modal dialog. Returns the clicked button value, or null if dismissed.
 */
export function showDialog(options: DialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h2 class="modal-title">${escapeHtml(options.title)}</h2>
        <p class="modal-message">${escapeHtml(options.message)}</p>
        ${options.detail ? `<p class="modal-detail">${escapeHtml(options.detail)}</p>` : ""}
        <div class="modal-actions"></div>
      </div>
    `;

    const actions = overlay.querySelector(".modal-actions")!;
    for (const btn of options.buttons) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = `modal-btn ${btn.role ?? "default"}`;
      el.textContent = btn.label;
      el.addEventListener("click", () => {
        cleanup();
        resolve(btn.value);
      });
      actions.appendChild(el);
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup();
        resolve(null);
      }
      if (e.key === "Enter" && options.defaultValue) {
        e.preventDefault();
        cleanup();
        resolve(options.defaultValue);
      }
    };

    const cleanup = () => {
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
    };

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve(null);
      }
    });

    window.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    (actions.querySelector(".modal-btn.primary, .modal-btn.danger, .modal-btn") as HTMLButtonElement)?.focus();
  });
}

export function showPrompt(options: {
  title: string;
  message: string;
  defaultValue?: string;
  placeholder?: string;
}): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h2 class="modal-title">${escapeHtml(options.title)}</h2>
        <p class="modal-message">${escapeHtml(options.message)}</p>
        <input class="modal-input" type="text" spellcheck="false" autocomplete="off"
          value="${escapeAttr(options.defaultValue ?? "")}"
          placeholder="${escapeAttr(options.placeholder ?? "")}" />
        <div class="modal-actions">
          <button type="button" class="modal-btn default" data-act="cancel">Cancel</button>
          <button type="button" class="modal-btn primary" data-act="ok">OK</button>
        </div>
      </div>
    `;

    const input = overlay.querySelector(".modal-input") as HTMLInputElement;

    const cleanup = () => {
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
    };

    const finish = (value: string | null) => {
      cleanup();
      resolve(value);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
      if (e.key === "Enter") {
        e.preventDefault();
        finish(input.value);
      }
    };

    overlay.querySelector('[data-act="cancel"]')?.addEventListener("click", () => finish(null));
    overlay.querySelector('[data-act="ok"]')?.addEventListener("click", () => finish(input.value));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) finish(null);
    });

    window.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
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
  });
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>");
}

function escapeAttr(s: string) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
