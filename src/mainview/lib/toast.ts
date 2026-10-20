export function toast(message: string, kind: "info" | "success" | "error" = "info") {
  const host = document.getElementById("toast-host");
  if (!host) return;

  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);

  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.2s ease";
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

/**
 * A notification with action buttons (extensions' showInformationMessage and
 * friends). Stays until an action or × is clicked when there are actions;
 * resolves with the index of the clicked action, or null.
 */
export function notify(kind: "info" | "warning" | "error", message: string, actions: string[] = [], source?: string): Promise<number | null> {
  return new Promise((resolve) => {
    const host = document.getElementById("toast-host");
    if (!host) {
      resolve(null);
      return;
    }
    const el = document.createElement("div");
    el.className = `toast notification ${kind}`;
    el.setAttribute("role", kind === "error" ? "alert" : "status");
    const body = document.createElement("div");
    body.className = "notification-body";
    const icon = document.createElement("span");
    icon.className = `notification-icon ${kind}`;
    icon.textContent = kind === "error" ? "⊗" : kind === "warning" ? "⚠" : "ⓘ";
    const text = document.createElement("div");
    text.className = "notification-message";
    text.textContent = message;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "notification-close";
    close.title = "Close";
    close.textContent = "×";
    body.append(icon, text, close);
    el.appendChild(body);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: number | null) => {
      if (timer) clearTimeout(timer);
      el.style.opacity = "0";
      el.style.transition = "opacity 0.15s ease";
      setTimeout(() => el.remove(), 160);
      resolve(value);
    };
    close.addEventListener("click", () => finish(null));

    if (source || actions.length) {
      const footer = document.createElement("div");
      footer.className = "notification-footer";
      const label = document.createElement("span");
      label.className = "notification-source";
      label.textContent = source ? `Source: ${source}` : "";
      footer.appendChild(label);
      actions.forEach((action, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `notification-action${index === 0 ? " primary" : ""}`;
        button.textContent = action;
        button.addEventListener("click", () => finish(index));
        footer.appendChild(button);
      });
      el.appendChild(footer);
    }
    host.appendChild(el);
    if (!actions.length) timer = setTimeout(() => finish(null), kind === "error" ? 9000 : 6000);
  });
}

const progressItems = new Map<number, HTMLDivElement>();

/** Notification-style progress (window.withProgress, location Notification). */
export function showProgress(id: number, update: { title?: string; message?: string; percent?: number; done?: boolean }) {
  const host = document.getElementById("toast-host");
  if (!host) return;
  let el = progressItems.get(id);
  if (update.done) {
    el?.remove();
    progressItems.delete(id);
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "toast notification progress";
    el.innerHTML = `<div class="notification-body"><span class="notification-spinner"></span><div class="notification-message"></div></div><div class="notification-bar"><div></div></div>`;
    host.appendChild(el);
    progressItems.set(id, el);
  }
  const title = update.title ?? el.dataset.title ?? "";
  if (update.title) el.dataset.title = update.title;
  el.querySelector(".notification-message")!.textContent = [title, update.message].filter(Boolean).join(": ");
  const bar = el.querySelector<HTMLDivElement>(".notification-bar > div")!;
  bar.style.width = update.percent === undefined ? "" : `${update.percent}%`;
  bar.parentElement!.classList.toggle("indeterminate", update.percent === undefined);
}
