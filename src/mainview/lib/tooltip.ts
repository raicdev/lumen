import { COMMAND_LINK_HOST, parseCommandLink, replaceCommandLinks } from "../../shared/menus-walkthroughs";
import { renderMarkdown } from "./markdown";
import { api } from "./rpc";

/**
 * Tooltips of the whole window in the workbench's own look instead of the
 * browser's: a `title` attribute moves to `data-tooltip` the moment the pointer
 * reaches it (or it changes), so the native tooltip never shows. Elements with
 * `data-tooltip-markdown` get a Markdown tooltip the pointer can move into, with
 * links and `command:` links (status bar items of extensions).
 */

const DELAY = 500;
/** Moving from one tooltip to the next within this time shows the next one at once. */
const WARM_WINDOW = 300;
const WARM_DELAY = 40;
/** A Markdown tooltip stays this long after the pointer leaves, so it can be reached. */
const HIDE_GRACE = 160;
const GAP = 6;
const MARGIN = 6;

const ANCHOR_SELECTOR = "[data-tooltip], [data-tooltip-markdown], [title]";

let tooltip: HTMLDivElement | null = null;
let anchor: Element | null = null;
let shown = false;
let showTimer: number | null = null;
let hideTimer: number | null = null;
let lastHidden = 0;
/** A click on an anchor keeps its tooltip away until the pointer reaches another one. */
let suppressed: Element | null = null;
let pointer = { x: 0, y: 0 };
/** After a click no tooltip comes up until the pointer moves (the page under it may change). */
let quiet: { x: number; y: number } | null = null;
let commandLinks: string[] = [];
let commandHandler: ((command: string, args: unknown[]) => void) | null = null;

/** Runs the commands of `command:` links in Markdown tooltips. */
export function setTooltipCommandHandler(handler: (command: string, args: unknown[]) => void): void {
  commandHandler = handler;
}

const removeAttribute = Element.prototype.removeAttribute;

/** Takes over the `title` of an element (the attribute goes, its text stays for screen readers). */
function adopt(element: Element): void {
  if (element.tagName === "IFRAME") return;
  const title = element.getAttribute("title");
  if (title === null) return;
  removeAttribute.call(element, "title");
  if (title) element.setAttribute("data-tooltip", title);
  else removeAttribute.call(element, "data-tooltip");
  // The title named icon-only controls; for the others it described them.
  const ownLabel = element.hasAttribute("aria-label") && !element.hasAttribute("data-tooltip-aria");
  if (ownLabel) return;
  removeAttribute.call(element, "aria-label");
  removeAttribute.call(element, "aria-description");
  if (!title) return removeAttribute.call(element, "data-tooltip-aria");
  element.setAttribute(element.textContent?.trim() ? "aria-description" : "aria-label", title);
  element.setAttribute("data-tooltip-aria", "");
}

// React removes a `title` it no longer renders with removeAttribute, which leaves no
// mutation record when the attribute already moved: the adopted text goes with it.
Element.prototype.removeAttribute = function (this: Element, name: string) {
  if (name.toLowerCase() === "title" && this.hasAttribute("data-tooltip")) {
    removeAttribute.call(this, "data-tooltip");
    if (this.hasAttribute("data-tooltip-aria")) {
      removeAttribute.call(this, "aria-label");
      removeAttribute.call(this, "aria-description");
      removeAttribute.call(this, "data-tooltip-aria");
    }
    if (this === anchor) hide();
  }
  return removeAttribute.call(this, name);
};

function anchorOf(target: EventTarget | null): Element | null {
  if (!(target instanceof Element)) return null;
  const found = target.closest(ANCHOR_SELECTOR);
  if (!found || found.tagName === "IFRAME") return null;
  adopt(found);
  return found.hasAttribute("data-tooltip") || found.hasAttribute("data-tooltip-markdown") ? found : null;
}

function clearTimers(): void {
  if (showTimer !== null) clearTimeout(showTimer);
  if (hideTimer !== null) clearTimeout(hideTimer);
  showTimer = hideTimer = null;
}

function hide(): void {
  clearTimers();
  if (shown) lastHidden = performance.now();
  shown = false;
  anchor = null;
  commandLinks = [];
  tooltip?.remove();
}

function tooltipNode(): HTMLDivElement {
  if (tooltip) return tooltip;
  tooltip = document.createElement("div");
  tooltip.setAttribute("role", "tooltip");
  tooltip.addEventListener("pointerenter", () => {
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = null;
  });
  tooltip.addEventListener("pointerleave", (event) => {
    if (anchor?.contains(event.relatedTarget as Node | null)) return;
    scheduleHide();
  });
  tooltip.addEventListener("click", onLinkClick);
  return tooltip;
}

function onLinkClick(event: MouseEvent): void {
  const link = (event.target as Element).closest<HTMLElement>("a[data-href]");
  if (!link) return;
  event.preventDefault();
  const href = link.dataset.href ?? "";
  if (href.startsWith(COMMAND_LINK_HOST)) {
    const parsed = parseCommandLink(commandLinks[Number(href.slice(COMMAND_LINK_HOST.length))] ?? "");
    if (parsed) commandHandler?.(parsed.command, parsed.args);
  } else {
    void api().request.openExternal({ url: href });
  }
  hideUntilMove(event);
}

function hideUntilMove(event: MouseEvent): void {
  hide();
  lastHidden = 0;
  quiet = { x: event.clientX, y: event.clientY };
}

/** Fills the tooltip for the anchor; false when it has nothing to show. */
function render(target: Element): boolean {
  const node = tooltipNode();
  const markdown = target.getAttribute("data-tooltip-markdown");
  if (markdown) {
    const replaced = replaceCommandLinks(markdown);
    commandLinks = replaced.links;
    node.className = "lumen-tooltip lumen-tooltip-markdown markdown-body";
    node.innerHTML = renderMarkdown(replaced.markdown);
    return true;
  }
  const text = target.getAttribute("data-tooltip");
  if (!text) return false;
  commandLinks = [];
  node.className = "lumen-tooltip";
  node.textContent = text;
  return true;
}

/** Below the anchor (above when there is no room); large anchors place it by the pointer. */
function place(target: Element): void {
  const node = tooltipNode();
  const rect = target.getBoundingClientRect();
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  const large = rect.height > 48;
  const centerX = rect.width > 320 || large ? pointer.x : rect.left + rect.width / 2;
  const below = large ? pointer.y + 18 : rect.bottom + GAP;
  const above = (large ? pointer.y - 8 : rect.top - GAP) - height;
  const top = below + height + MARGIN <= window.innerHeight || above < MARGIN ? below : above;
  const left = Math.max(MARGIN, Math.min(centerX - width / 2, window.innerWidth - width - MARGIN));
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN)))}px`;
  node.dataset.side = top === below ? "below" : "above";
}

function show(target: Element): void {
  showTimer = null;
  if (!target.isConnected || target !== anchor || !render(target)) return hide();
  const node = tooltipNode();
  node.classList.remove("visible");
  if (!node.isConnected) document.body.appendChild(node);
  place(target);
  // The next frame starts the fade in from where it was placed.
  requestAnimationFrame(() => node.classList.add("visible"));
  shown = true;
}

function scheduleHide(): void {
  if (hideTimer !== null) return;
  const markdown = shown && tooltip?.classList.contains("lumen-tooltip-markdown");
  if (!markdown) return hide();
  hideTimer = window.setTimeout(hide, HIDE_GRACE);
}

function onPointerOver(event: PointerEvent): void {
  if (event.pointerType === "touch") return;
  pointer = { x: event.clientX, y: event.clientY };
  if (quiet && Math.abs(quiet.x - event.clientX) < 2 && Math.abs(quiet.y - event.clientY) < 2) return;
  quiet = null;
  if (tooltip?.contains(event.target as Node)) return;
  const next = event.buttons ? null : anchorOf(event.target);
  if (next === anchor) {
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = null;
    return;
  }
  if (next !== suppressed) suppressed = null;
  if (!next || next === suppressed) {
    if (anchor) scheduleHide();
    return;
  }
  const warm = shown || performance.now() - lastHidden < WARM_WINDOW;
  if (shown) {
    lastHidden = performance.now();
    shown = false;
    tooltip?.remove();
  }
  clearTimers();
  anchor = next;
  showTimer = window.setTimeout(() => show(next), warm ? WARM_DELAY : DELAY);
}

function onPointerDown(event: PointerEvent): void {
  if (tooltip?.contains(event.target as Node)) return;
  if (anchor) suppressed = anchor;
  hideUntilMove(event);
}

function onScroll(event: Event): void {
  if (tooltip?.contains(event.target as Node)) return;
  if (anchor) hide();
}

function startTooltips(): void {
  document.addEventListener("pointerover", onPointerOver, true);
  document.addEventListener("pointermove", (event) => (pointer = { x: event.clientX, y: event.clientY }), { capture: true, passive: true });
  document.addEventListener("pointerdown", onPointerDown, true);
  // Leaving the window (or entering a webview frame).
  document.addEventListener("pointerout", (event) => !event.relatedTarget && anchor && hide(), true);
  document.addEventListener("keydown", () => anchor && hide(), true);
  document.addEventListener("wheel", onScroll, { capture: true, passive: true });
  document.addEventListener("scroll", onScroll, true);
  window.addEventListener("blur", () => anchor && hide());
  window.addEventListener("resize", () => anchor && hide());

  // A title set while the element is on screen moves over at once (and updates a shown tooltip).
  new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target as Element;
      if (record.attributeName === "title") adopt(target);
      if (target !== anchor || !shown) continue;
      if (render(target)) place(target);
      else hide();
    }
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["title", "data-tooltip-markdown"] });
}

startTooltips();
