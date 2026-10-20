import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ContributedView } from "../lib/extensions";
import { useTreeViews } from "../lib/trees";
import { webviewService, type WebviewInfo } from "../lib/webviews";
import { WithCodicons } from "./Codicon";
import { ExtensionTreeView, ViewTitleActions } from "./ExtensionTreeView";

/**
 * Where a webview is shown: the webview's iframe (in the webview layer) is
 * placed over this element while it is visible.
 */
export function WebviewSlot({ slotKey, placeholder }: { slotKey: string; placeholder?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    webviewService.attachSlot(slotKey, element);
    return () => webviewService.detachSlot(slotKey, element);
  }, [slotKey]);
  return (
    <div ref={ref} className="webview-slot">
      {placeholder && <span className="webview-slot-placeholder">{placeholder}</span>}
    </div>
  );
}

/** An extension's view container (activity bar or panel): its views stacked, each collapsible. */
export function ViewContainerView({ views, webviews, alwaysHeaders = false }: { views: ContributedView[]; webviews: WebviewInfo[]; alwaysHeaders?: boolean }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(views.filter((view) => view.visibility === "collapsed").map((view) => view.id)));
  const trees = useTreeViews();
  // A container with one view shows just the view (its title is the container's).
  const single = views.length === 1 && !alwaysHeaders;
  return (
    <div className="view-container">
      {views.map((view) => {
        const open = single || !collapsed.has(view.id);
        const webview = webviews.find((candidate) => candidate.kind === "view" && candidate.viewType === view.id);
        const info = view.type === "webview" ? webview : trees.get(view.id);
        const toggle = () =>
          setCollapsed((previous) => {
            const next = new Set(previous);
            if (next.has(view.id)) next.delete(view.id);
            else next.add(view.id);
            return next;
          });
        return (
          <section key={view.id} className={`view-section${open ? " open" : ""}`}>
            {!single && (
              <div
                role="button"
                tabIndex={0}
                aria-expanded={open}
                className="scm-section-header view-section-header"
                onClick={toggle}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                  e.preventDefault();
                  toggle();
                }}
              >
                <span className={`chevron${open ? " open" : ""}`}>
                  <ChevronRight size={14} />
                </span>
                <span className="scm-section-title">
                  <WithCodicons text={info?.title || view.name} />
                </span>
                {info?.description && <span className="view-section-description">{info.description}</span>}
                {info?.badge?.value ? <span className="badge" title={info.badge.tooltip}>{info.badge.value}</span> : null}
                {open && <ViewTitleActions view={view} />}
              </div>
            )}
            {open && single && (
              <div className="view-toolbar">
                <ViewTitleActions view={view} />
              </div>
            )}
            {open &&
              (view.type === "webview" ? (
                <WebviewSlot slotKey={`view:${view.id}`} placeholder={webview ? undefined : "Loading…"} />
              ) : (
                <ExtensionTreeView view={view} />
              ))}
          </section>
        );
      })}
    </div>
  );
}

/** The icon of a view container: an image file (as a mask, so it takes the theme color) or a codicon. */
export function ContainerIcon({ url, title }: { url?: string; title: string }) {
  if (url?.startsWith("$(")) return <WithCodicons text={url} size={22} />;
  if (url) return <span className="container-icon" style={{ WebkitMaskImage: `url("${url}")`, maskImage: `url("${url}")` }} aria-hidden="true" />;
  return (
    <span className="container-icon-letter" aria-hidden="true">
      {title.slice(0, 1).toUpperCase()}
    </span>
  );
}
