import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { WithCodicons } from "../components/Codicon";
import type { ExtraPanelTab } from "../components/Panel";
import { basename } from "../lib/paths";
import { editorOpenerById, featureApi, featureExplorerSections, featurePanelTabs, featureSidebarViews, featureStatusItems, featureViewId, parseFeatureEditorTab } from "./registry";
import { useFeaturesVersion } from "./store";
import type { FeatureIcon } from "./types";

/** React pieces the shell mounts for what features add. */

export function FeatureIconView({ icon, size = 22 }: { icon: FeatureIcon; size?: number }): ReactNode {
  if (typeof icon === "string") return <WithCodicons text={`$(${icon})`} size={size} />;
  const Icon = icon;
  return <Icon size={size} strokeWidth={1.5} />;
}

/** Badge of an activity bar button (re-evaluated on `refresh()`; no App render needed). */
export function FeatureActivityBadge({ id }: { id: string }) {
  useFeaturesVersion();
  const view = featureSidebarViews().find((candidate) => candidate.id === id);
  const count = view?.badge?.() ?? 0;
  return count ? <span className="activity-badge">{count > 99 ? "99+" : count}</span> : null;
}

/** The side bar panels of the features' views; `sideView` is the App's current one. */
export function FeatureSidebarPanels({ sideView }: { sideView: string }) {
  return (
    <>
      {featureSidebarViews().map((view) => (
        <div key={view.id} className="sidebar-panel" hidden={sideView !== featureViewId(view.id)}>
          {view.render()}
        </div>
      ))}
    </>
  );
}

const EXPLORER_SECTIONS_KEY = "lumen.explorerSections.open";

function openSections(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(EXPLORER_SECTIONS_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** The features' sections at the bottom of the Explorer (Timeline), each collapsible (remembered). */
export function FeatureExplorerSections({ activePath }: { activePath: string | null }) {
  useFeaturesVersion();
  const [open, setOpen] = useState(openSections);
  const sections = featureExplorerSections();
  if (!sections.length) return null;
  const toggle = (id: string, value: boolean) => {
    const next = { ...open, [id]: value };
    setOpen(next);
    try {
      localStorage.setItem(EXPLORER_SECTIONS_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <div className="feature-explorer-sections">
      {sections.map((section) => {
        const expanded = open[section.id] ?? !section.collapsed;
        return (
          <section key={section.id} className={`feature-explorer-section${expanded ? " open" : ""}`}>
            <div className="scm-section-header view-section-header" role="button" aria-expanded={expanded} onClick={() => toggle(section.id, !expanded)}>
              <span className={`chevron${expanded ? " open" : ""}`}>
                <ChevronRight size={14} />
              </span>
              <span className="scm-section-title">{section.title}</span>
              {expanded && section.actions && (
                <span className="view-title-actions" onClick={(e) => e.stopPropagation()}>
                  {section.actions({ activePath })}
                </span>
              )}
            </div>
            {expanded && <div className="feature-explorer-section-body">{section.render({ activePath })}</div>}
          </section>
        );
      })}
    </div>
  );
}

/** The panel tabs of the features, in the shape of the Panel's extension tabs (a hook: they follow `refresh()`). */
export function useFeaturePanelTabs(): ExtraPanelTab[] {
  useFeaturesVersion();
  return featurePanelTabs().map((tab) => ({
    id: featureViewId(tab.id),
    label: tab.title,
    badge: tab.badge?.() || undefined,
    content: tab.render(),
  }));
}

/** Status bar items of the features on one side. */
export function FeatureStatusItems({ side }: { side: "left" | "right" }) {
  useFeaturesVersion();
  const items = featureStatusItems()
    .filter((item) => item.side === side)
    .map((item) => ({ item, text: item.text() }))
    .filter(({ text }) => !!text)
    .sort((a, b) => (b.item.priority ?? 0) - (a.item.priority ?? 0));
  return (
    <>
      {items.map(({ item, text }) => {
        const style = { color: item.color?.() };
        const title = item.tooltip?.();
        return item.command ? (
          <button key={item.id} type="button" className="status-btn status-ext" title={title} style={style} onClick={() => featureApi(item.area).executeCommand(item.command!)}>
            <WithCodicons text={text} />
          </button>
        ) : (
          <span key={item.id} className="status-item status-ext" title={title} style={style}>
            <WithCodicons text={text} />
          </span>
        );
      })}
    </>
  );
}

/** The whole editor of a feature editor tab (`feature-editor:<opener>:<file>`). */
export function FeatureEditorView({ tabPath }: { tabPath: string }) {
  const parsed = parseFeatureEditorTab(tabPath);
  const opener = parsed ? editorOpenerById(parsed.openerId) : null;
  if (!parsed || !opener) return <div className="editor-feature-missing">{parsed ? `No editor for ${basename(parsed.path)}` : ""}</div>;
  return <>{opener.render(parsed.path, featureApi(opener.area))}</>;
}
