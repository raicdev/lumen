/**
 * The shell prelude. Injected into every page *before* any app code runs.
 *
 * It exposes `window.__lumen`, the only bridge the renderer needs:
 *   - `invoke(channel, data)`   → native binding call (returns a promise)
 *   - `receive(raw)`            → feed an inbound envelope to the RPC client
 *   - `onEnvelope(listener)`    → subscribe (with buffering) to envelopes
 *   - `installMenu(groups)`     → render the in-page menu bar (non-Windows)
 *   - `window.*`                → minimize / toggleMaximize / close / startDrag
 *   - `frameless`, `windowState` (+ `lumen:window-state` events)
 *
 * For frameless windows it also turns `[data-lumen-drag-region]` elements into
 * title bar drag areas (double-click maximizes), adds the top resize edge and
 * registers `[data-lumen-maximize-button]` with the OS (Windows 11 snap
 * layouts); that element gets `data-hover` / `data-pressed` attributes since
 * the OS, not the page, receives the mouse there.
 *
 * Kept as a plain string so it can be handed to `webview_init` verbatim.
 */
export const PRELUDE = `
(function () {
  // Only the window's own page: never iframes (e.g. extension webviews).
  if (window.__lumen || window.top !== window) return;

  var listeners = [];
  var pending = [];

  function nativeInvoke(channel, data) {
    if (typeof window.__lumen_invoke !== "function") {
      return Promise.reject(new Error("Lumen Shell bridge is not available"));
    }
    return window.__lumen_invoke(channel, data);
  }

  function signalReady() {
    nativeInvoke("__lumen:ready", "{}").catch(function () {});
  }

  // Tells the shell the page has painted, so the (still invisible) window can
  // be shown without a blank frame. The timeout covers throttled frames.
  function signalShow() {
    var sent = false;
    function send() {
      if (sent) return;
      sent = true;
      nativeInvoke("__lumen:show", "{}").catch(function () {});
    }
    requestAnimationFrame(function () { requestAnimationFrame(send); });
    setTimeout(send, 250);
  }

  function windowControl(action) {
    nativeInvoke("__lumen:window", action).catch(function () {});
  }

  var windowOptions = window.__lumenWindowOptions || {};
  var frameless = !!windowOptions.frameless;
  var lastMaximizeReport = "";
  var maximizeReportPending = false;

  window.__lumen = {
    version: 1,
    frameless: frameless,
    windowState: "normal",
    window: {
      minimize: function () { windowControl("minimize"); },
      toggleMaximize: function () { windowControl("toggle-maximize"); },
      close: function () { windowControl("close"); },
      startDrag: function () { windowControl("drag"); }
    },
    setWindowState: function (state) {
      window.__lumen.windowState = state;
      document.documentElement.classList.toggle("lumen-maximized", state === "maximized");
      window.dispatchEvent(new CustomEvent("lumen:window-state", { detail: { state: state } }));
      scheduleMaximizeButtonReport();
    },
    setMaximizeButtonState: function (hover, pressed) {
      var button = document.querySelector("[data-lumen-maximize-button]");
      if (!button) return;
      if (hover) button.setAttribute("data-hover", ""); else button.removeAttribute("data-hover");
      if (pressed) button.setAttribute("data-pressed", ""); else button.removeAttribute("data-pressed");
    },
    invoke: function (channel, data) {
      // The webview library drops messages holding a raw U+007F (DEL).
      return nativeInvoke(channel, typeof data === "string" ? data : JSON.stringify(data === undefined ? null : data).replace(/\\x7f/g, "\\\\u007f"));
    },
    receive: function (raw) {
      if (typeof raw !== "string") return;
      if (!listeners.length) { pending.push(raw); return; }
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](raw); } catch (error) { console.error("[lumen]", error); }
      }
    },
    onEnvelope: function (listener) {
      listeners.push(listener);
      if (!pending.length) return;
      var queue = pending;
      pending = [];
      for (var i = 0; i < queue.length; i++) {
        try { listener(queue[i]); } catch (error) { console.error("[lumen]", error); }
      }
    },
    installMenu: function (groups) { installMenu(groups); },
    menuAction: function (action) {
      if (typeof window.__lumen_invoke === "function") {
        nativeInvoke("__lumen:menu", action).catch(function () {});
        return;
      }
      window.dispatchEvent(new CustomEvent("lumen:menu", { detail: { action: action } }));
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", signalReady);
  else signalReady();

  if (document.readyState === "complete") signalShow();
  else window.addEventListener("load", signalShow);

  if (frameless) {
    if (document.documentElement) document.documentElement.classList.add("lumen-frameless");
    else document.addEventListener("DOMContentLoaded", function () { document.documentElement.classList.add("lumen-frameless"); });
    installWindowChrome();
  }

  /* ── frameless windows: drag regions + top resize edge ─────────────────── */

  var NO_DRAG = "button, a, input, textarea, select, [contenteditable], [data-lumen-no-drag]";

  function isDragTarget(target) {
    var element = target && target.nodeType === 1 ? target : target && target.parentElement;
    if (!element || !element.closest) return false;
    var region = element.closest("[data-lumen-drag-region]");
    if (!region) return false;
    var blocker = element.closest(NO_DRAG);
    return !blocker || !region.contains(blocker);
  }

  function installWindowChrome() {
    var pressed = null;

    // The OS move loop starts on the first mouse move, so a plain click or a
    // double-click on the title bar never swallows the button release.
    document.addEventListener("mousedown", function (event) {
      pressed = null;
      if (event.button !== 0 || !isDragTarget(event.target)) return;
      event.preventDefault();
      pressed = { x: event.screenX, y: event.screenY };
    });
    document.addEventListener("mousemove", function (event) {
      if (!pressed) return;
      if (!(event.buttons & 1)) { pressed = null; return; }
      if (Math.abs(event.screenX - pressed.x) + Math.abs(event.screenY - pressed.y) < 2) return;
      pressed = null;
      windowControl("drag");
    });
    document.addEventListener("mouseup", function () { pressed = null; });
    document.addEventListener("dblclick", function (event) {
      if (event.button === 0 && isDragTarget(event.target)) windowControl("toggle-maximize");
    });

    function addEdges() {
      var style = document.createElement("style");
      style.textContent =
        ".lumen-resize-edge{position:fixed;top:0;height:4px;z-index:2147483646}" +
        "#lumen-resize-top{left:8px;right:8px;cursor:ns-resize}" +
        "#lumen-resize-top-left{left:0;width:8px;cursor:nwse-resize}" +
        "#lumen-resize-top-right{right:0;width:8px;cursor:nesw-resize}" +
        "html.lumen-maximized .lumen-resize-edge{display:none}";
      document.head.appendChild(style);
      ["top", "top-left", "top-right"].forEach(function (edge) {
        var element = document.createElement("div");
        element.id = "lumen-resize-" + edge;
        element.className = "lumen-resize-edge";
        element.addEventListener("mousedown", function (event) {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          windowControl("resize:" + edge);
        });
        document.body.appendChild(element);
      });
    }

    if (document.body) addEdges();
    else document.addEventListener("DOMContentLoaded", addEdges);

    var observed = null;
    var resizeObserver = new ResizeObserver(scheduleMaximizeButtonReport);
    function watchMaximizeButton() {
      var button = document.querySelector("[data-lumen-maximize-button]");
      if (button !== observed) {
        if (observed) resizeObserver.unobserve(observed);
        if (button) resizeObserver.observe(button);
        observed = button;
        scheduleMaximizeButtonReport();
      }
    }
    function startWatching() {
      new MutationObserver(watchMaximizeButton).observe(document.body, { childList: true, subtree: true });
      watchMaximizeButton();
    }
    if (document.body) startWatching();
    else document.addEventListener("DOMContentLoaded", startWatching);
    window.addEventListener("resize", scheduleMaximizeButtonReport);
  }

  function scheduleMaximizeButtonReport() {
    if (!frameless || maximizeReportPending) return;
    maximizeReportPending = true;
    requestAnimationFrame(function () {
      maximizeReportPending = false;
      var button = document.querySelector("[data-lumen-maximize-button]");
      var rect = button ? button.getBoundingClientRect() : null;
      var report = rect && rect.width > 0 && rect.height > 0
        ? "snap:" + [rect.left, rect.top, rect.width, rect.height, window.innerWidth, window.innerHeight].join(",")
        : "snap:none";
      if (report === lastMaximizeReport) return;
      lastMaximizeReport = report;
      windowControl(report);
    });
  }

  /* ── in-page menu bar (macOS / Linux fallback for native menus) ───────── */

  var STYLE_ID = "lumen-menubar-style";

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "html.lumen-menubar body{padding-top:26px;box-sizing:border-box}" +
      "html.lumen-menubar #root{height:calc(100% - 26px)}" +
      "#lumen-menubar{position:fixed;top:0;left:0;right:0;height:26px;z-index:2147483000;display:flex;align-items:center;gap:2px;padding:0 6px;font:12px/1.6 system-ui,sans-serif;color:#d6d6d6;background:#1b1d22;border-bottom:1px solid #333}" +
      "#lumen-menubar button{all:unset;padding:2px 8px;border-radius:4px;cursor:default}" +
      "#lumen-menubar button:hover{background:rgba(255,255,255,.12)}" +
      ".lumen-menu{position:fixed;min-width:210px;padding:4px;background:#1b1d22;border:1px solid #3a3a3a;border-radius:6px;box-shadow:0 10px 26px rgba(0,0,0,.45);z-index:2147483001;font:12px/1.6 system-ui,sans-serif;color:#d6d6d6}" +
      ".lumen-menu .lumen-item{display:flex;justify-content:space-between;gap:18px;padding:4px 10px;border-radius:4px;cursor:default}" +
      ".lumen-menu .lumen-item:hover{background:rgba(255,255,255,.1)}" +
      ".lumen-menu .lumen-item.disabled{opacity:.4;pointer-events:none}" +
      ".lumen-menu .lumen-sep{height:1px;margin:4px 6px;background:#3a3a3a}" +
      ".lumen-menu .lumen-accel{opacity:.5}";
    document.head.appendChild(style);
    document.documentElement.classList.add("lumen-menubar");
  }

  function installMenu(groups) {
    if (!groups || !groups.length) return;
    ensureStyle();

    var existing = document.getElementById("lumen-menubar");
    if (existing) existing.remove();

    var bar = document.createElement("div");
    bar.id = "lumen-menubar";
    var openMenu = null;

    function closeMenu() {
      if (openMenu) { openMenu.remove(); openMenu = null; }
    }

    function runEntry(entry) {
      if (entry.enabled === false) return;
      if (entry.role) {
        try { document.execCommand(entry.role); } catch (error) { /* best effort */ }
        return;
      }
      if (entry.action) window.__lumen.menuAction(entry.action);
    }

    groups.forEach(function (group) {
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = group.label;
      button.addEventListener("click", function (event) {
        event.stopPropagation();
        var wasOpen = openMenu && openMenu.dataset.group === group.label;
        closeMenu();
        if (wasOpen) return;

        var menu = document.createElement("div");
        menu.className = "lumen-menu";
        menu.dataset.group = group.label;
        var rect = button.getBoundingClientRect();
        menu.style.left = Math.round(rect.left) + "px";
        menu.style.top = Math.round(rect.bottom + 2) + "px";

        (group.submenu || []).forEach(function (entry) {
          if (entry.type === "separator") {
            var separator = document.createElement("div");
            separator.className = "lumen-sep";
            menu.appendChild(separator);
            return;
          }
          var item = document.createElement("div");
          item.className = "lumen-item" + (entry.enabled === false ? " disabled" : "");
          var label = document.createElement("span");
          label.textContent = entry.label || "";
          item.appendChild(label);
          if (entry.accelerator) {
            var accel = document.createElement("span");
            accel.className = "lumen-accel";
            accel.textContent = entry.accelerator;
            item.appendChild(accel);
          }
          item.addEventListener("click", function () {
            closeMenu();
            runEntry(entry);
          });
          menu.appendChild(item);
        });

        document.body.appendChild(menu);
        openMenu = menu;
      });
      bar.appendChild(button);
    });

    document.body.appendChild(bar);
    document.addEventListener("click", closeMenu);
    window.addEventListener("blur", closeMenu);
  }
})();
`;
