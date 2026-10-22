import { cssVariable, resolveThemeColors } from "./color-theme.ts";

/**
 * The document of a webview: the extension's html with Lumen's bootstrap in
 * front (acquireVsCodeApi, theme, links, shortcuts). Built by the main process,
 * which serves it from the webview's own origin (see webview-server.ts).
 */

/** VS Code's theme variables in Lumen Dark (the window sends the active theme's when the page starts). */
export const THEME: Record<string, string> = {
  "--vscode-font-family": '"Segoe UI", system-ui, -apple-system, sans-serif',
  "--vscode-font-size": "13px",
  "--vscode-font-weight": "normal",
  "--vscode-editor-font-family": '"Cascadia Code", Consolas, ui-monospace, monospace',
  "--vscode-editor-font-size": "14px",
  "--vscode-editor-font-weight": "normal",
  ...Object.fromEntries(Object.entries(resolveThemeColors("dark", {})).map(([id, value]) => [cssVariable(id), value])),
};

/** The active theme as a webview gets it: body class, name and the color variables. */
export type WebviewTheme = { kind: string; name: string; id: string; variables: Record<string, string> };

/** VS Code's default webview styles. */
const DEFAULT_CSS = `
html { scrollbar-color: var(--vscode-scrollbarSlider-background) transparent; }
body { background-color: transparent; color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); font-weight: var(--vscode-font-weight); font-size: var(--vscode-font-size); margin: 0; padding: 0 20px; }
img, video { max-width: 100%; max-height: 100%; }
a, a code { color: var(--vscode-textLink-foreground); }
a:hover { color: var(--vscode-textLink-activeForeground); }
code { font-family: var(--vscode-editor-font-family); color: var(--vscode-textPreformat-foreground); }
blockquote { background: var(--vscode-textBlockQuote-background); border-color: var(--vscode-textBlockQuote-border); }
kbd { background-color: var(--vscode-keybindingLabel-background); color: var(--vscode-keybindingLabel-foreground); border-radius: 3px; padding: 1px 4px; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-corner { background-color: transparent; }
::-webkit-scrollbar-thumb { background-color: var(--vscode-scrollbarSlider-background); }
::-webkit-scrollbar-thumb:hover { background-color: var(--vscode-scrollbarSlider-hoverBackground); }
::highlight(lumen-find) { background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33)); }
::highlight(lumen-find-active) { background-color: var(--vscode-editor-findMatchBackground, #515c6a); }
`;

/** Styles of the find bar (in its own shadow root, so the page's styles do not reach it). */
const FIND_CSS = `
:host { all: initial; position: fixed; top: 0; right: 14px; z-index: 2147483647; }
.bar { display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 0 0 4px 4px; background: var(--vscode-editorWidget-background, #252526); color: var(--vscode-editorWidget-foreground, #cccccc); box-shadow: 0 0 8px 2px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36)); font: 13px var(--vscode-font-family, system-ui, sans-serif); }
input { width: 180px; padding: 3px 6px; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; outline: none; background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #cccccc); font: inherit; }
input:focus { border-color: var(--vscode-focusBorder, #007fd4); }
.count { min-width: 72px; padding: 0 6px; font-size: 12px; opacity: 0.8; white-space: nowrap; }
button { width: 22px; height: 22px; padding: 0; border: 0; border-radius: 3px; background: none; color: inherit; font: inherit; cursor: pointer; }
button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31)); }
`;

export type WebviewFindAction = "open" | "next" | "previous" | "close";

/** The find action a key forwarded by a webview stands for (Ctrl/Cmd+F, F3, Shift+F3), as in VS Code's webview find widget. */
export function webviewFindAction(event: { key?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }): WebviewFindAction | null {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key?.toLowerCase() === "f") return "open";
  if (event.key === "F3" && !event.ctrlKey && !event.metaKey && !event.altKey) return event.shiftKey ? "previous" : "next";
  return null;
}

/**
 * Runs first in every webview: acquireVsCodeApi() (also acquireLumenApi),
 * the theme, links and shortcuts handed to the window. It comes before the
 * page's own Content-Security-Policy <meta>, which only applies after it.
 */
const BOOTSTRAP = `(() => {
  const host = window.parent;
  const send = (type, data) => host.postMessage({ __lumenWebview: type, data }, "*");
  // The window hands the saved state and the theme over in the frame's name (the page comes from a server).
  let state;
  let theme = null;
  try {
    if (window.name.startsWith("lumen-webview:")) {
      const handoff = JSON.parse(window.name.slice(14));
      if ("state" in handoff) state = handoff.state;
      theme = handoff.theme || null;
    }
  } catch {}
  try { window.name = ""; } catch {}
  let acquired = false;
  const api = Object.freeze({
    postMessage: (message) => send("message", message),
    setState: (value) => { state = value; send("state", value); return value; },
    getState: () => state,
  });
  const acquire = () => {
    if (acquired) throw new Error("An instance of the VS Code API has already been acquired");
    acquired = true;
    return api;
  };
  Object.defineProperty(window, "acquireVsCodeApi", { value: acquire });
  Object.defineProperty(window, "acquireLumenApi", { value: acquire });
  const root = document.documentElement;
  const DEFAULTS = ${JSON.stringify(THEME)};
  const KINDS = ["vscode-light", "vscode-dark", "vscode-high-contrast", "vscode-high-contrast-light"];
  const themeBody = () => {
    const kind = theme ? theme.kind : "vscode-dark";
    document.body.classList.remove(...KINDS);
    document.body.classList.add(kind);
    if (kind === "vscode-high-contrast-light") document.body.classList.add("vscode-high-contrast");
    document.body.dataset.vscodeThemeKind = kind;
    document.body.dataset.vscodeThemeName = theme ? theme.name : "Lumen Dark";
    document.body.dataset.vscodeThemeId = theme ? theme.id : "lumen-dark";
  };
  const applyTheme = () => {
    const variables = Object.assign({}, DEFAULTS, theme ? theme.variables : {});
    for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
    const light = theme && (theme.kind === "vscode-light" || theme.kind === "vscode-high-contrast-light");
    root.style.setProperty("color-scheme", light ? "light" : "dark");
    if (document.body) themeBody();
  };
  applyTheme();
  // The window's theme changes: a message of its own, not seen by the page's listeners.
  window.addEventListener("message", (event) => {
    if (event.source !== host || !event.data || !event.data.__lumenTheme) return;
    event.stopImmediatePropagation();
    theme = event.data.__lumenTheme;
    applyTheme();
  }, true);
  if (!document.body) document.addEventListener("DOMContentLoaded", themeBody);
  document.addEventListener("click", (event) => {
    const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!link) return;
    const href = link.getAttribute("href") || "";
    if (/^(https?|mailto):/i.test(href)) { event.preventDefault(); send("link", href); }
    else if (/^command:/i.test(href)) { event.preventDefault(); send("command", href); }
  }, true);
  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey || event.altKey;
    if (!mod && !/^F\\d+$/.test(event.key)) return;
    // Editing shortcuts stay in the page.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && "acvxyz".includes(event.key.toLowerCase())) return;
    event.preventDefault();
    send("keydown", { key: event.key, code: event.code, ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey });
  }, true);
  window.addEventListener("focus", () => send("focus"));
  // Right click: the window shows the menu (webview/context), with the data-vscode-context of the element and its ancestors.
  document.addEventListener("contextmenu", (event) => {
    let context = {};
    for (let node = event.target; node && node.nodeType === 1; node = node.parentElement) {
      const raw = node.dataset ? node.dataset.vscodeContext : undefined;
      if (!raw) continue;
      try { context = Object.assign({}, JSON.parse(raw), context); } catch {}
    }
    event.preventDefault();
    const selection = String(window.getSelection ? window.getSelection() : "");
    const editable = !!(event.target && event.target.closest && event.target.closest("input, textarea, [contenteditable=''], [contenteditable='true']"));
    send("contextmenu", { x: event.clientX, y: event.clientY, context, selection: !!selection, editable });
  });
  // Cut / Copy / Paste chosen in that menu.
  window.addEventListener("message", (event) => {
    if (event.source !== host || !event.data || !event.data.__lumenEdit) return;
    event.stopImmediatePropagation();
    const edit = event.data.__lumenEdit;
    if (edit === "paste") document.execCommand("insertText", false, String(event.data.text || ""));
    else document.execCommand(edit);
  }, true);
  // The find widget (enableFindWidget; the window decides when to open it): a bar in a closed
  // shadow root. Matches are CSS highlights, so the page's DOM is never changed.
  const find = (() => {
    const highlights = typeof Highlight === "function" && window.CSS && CSS.highlights ? CSS.highlights : null;
    let bar = null;
    let input = null;
    let count = null;
    let ranges = [];
    let index = -1;
    const update = () => {
      count.textContent = ranges.length ? (index + 1) + " of " + ranges.length : input.value ? "No results" : "";
    };
    const clear = () => {
      if (highlights) { highlights.delete("lumen-find"); highlights.delete("lumen-find-active"); }
      ranges = [];
      index = -1;
    };
    const go = (step) => {
      if (!ranges.length) { index = -1; update(); return; }
      index = index < 0 ? 0 : (index + step + ranges.length) % ranges.length;
      const range = ranges[index];
      if (highlights) highlights.set("lumen-find-active", new Highlight(range));
      const target = range.startContainer.parentElement;
      if (target) target.scrollIntoView({ block: "center", inline: "nearest" });
      update();
    };
    const search = () => {
      clear();
      const query = input.value.toLowerCase();
      if (query && document.body) {
        const skip = "script, style, noscript, template, textarea";
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: (node) => (node.parentElement && !node.parentElement.closest(skip) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
        });
        for (let node = walker.nextNode(); node && ranges.length < 1000; node = walker.nextNode()) {
          const text = node.data.toLowerCase();
          for (let at = text.indexOf(query); at >= 0 && ranges.length < 1000; at = text.indexOf(query, at + query.length)) {
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + query.length);
            // Text that is not rendered (display: none, ...) is not a match.
            if (range.getClientRects().length) ranges.push(range);
          }
        }
      }
      if (highlights && ranges.length) highlights.set("lumen-find", new Highlight(...ranges));
      go(0);
    };
    const shown = () => !!bar && bar.isConnected;
    const close = () => {
      clear();
      if (bar) bar.remove();
    };
    const open = () => {
      if (!bar) {
        bar = document.createElement("lumen-find-widget");
        const shadow = bar.attachShadow({ mode: "closed" });
        shadow.innerHTML = "<style>" + ${JSON.stringify(FIND_CSS)} + "</style>" +
          "<div class='bar' role='search'><input type='text' placeholder='Find' aria-label='Find'><span class='count' aria-live='polite'></span>" +
          "<button type='button' data-step='-1' title='Previous Match (Shift+Enter)' aria-label='Previous Match'>&#8593;</button>" +
          "<button type='button' data-step='1' title='Next Match (Enter)' aria-label='Next Match'>&#8595;</button>" +
          "<button type='button' data-close='' title='Close (Escape)' aria-label='Close'>&#215;</button></div>";
        input = shadow.querySelector("input");
        count = shadow.querySelector(".count");
        input.addEventListener("input", search);
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") { event.preventDefault(); go(event.shiftKey ? -1 : 1); }
          else if (event.key === "Escape") { event.preventDefault(); close(); }
          event.stopPropagation();
        });
        shadow.addEventListener("click", (event) => {
          const button = event.target && event.target.closest ? event.target.closest("button") : null;
          if (!button) return;
          if (button.hasAttribute("data-close")) close();
          else go(Number(button.dataset.step));
        });
      }
      if (!bar.isConnected) document.documentElement.appendChild(bar);
      input.focus();
      input.select();
      if (input.value) search();
    };
    return { open, close, next: () => (shown() ? go(1) : open()), previous: () => (shown() ? go(-1) : open()) };
  })();
  window.addEventListener("message", (event) => {
    if (event.source !== host || !event.data || !event.data.__lumenFind) return;
    event.stopImmediatePropagation();
    const action = find[event.data.__lumenFind];
    if (typeof action === "function") action();
  }, true);
})();`;

/**
 * The extension's page with Lumen's bootstrap in front of everything else.
 * The default styles come first too, as in VS Code, so the page's own rules
 * override them (adopted style sheets would come after the page's in the cascade).
 */
export function documentFor(html: string): string {
  const head = `<style id="_defaultStyles">${DEFAULT_CSS}</style><script>${BOOTSTRAP}</script>`;
  const opening = /<head(\s[^>]*)?>/i.exec(html);
  if (opening) return html.slice(0, opening.index + opening[0].length) + head + html.slice(opening.index + opening[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return `${doctype[0]}<head>${head}</head>${html.slice(doctype[0].length)}`;
  return `<!DOCTYPE html><head>${head}</head>${html}`;
}


/**
 * Every extension's webviews get their own origin, `http://<label>.localhost:<port>`:
 * isolated from the window and from other extensions, with working
 * localStorage / IndexedDB that persist (the port is stable).
 */
export function webviewLabel(extensionId: string): string {
  let a = 2166136261;
  let b = 5381;
  const id = extensionId.toLowerCase();
  for (let i = 0; i < id.length; i++) {
    a = Math.imul(a ^ id.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ id.charCodeAt(i);
  }
  return `x${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

export function webviewOrigin(extensionId: string, port: number): string {
  return `http://${webviewLabel(extensionId)}.localhost:${port}`;
}
