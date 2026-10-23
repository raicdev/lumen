import { CircleX, Ellipsis, Eraser, Info, Maximize2, Minimize2, TriangleAlert, X, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useExtensionOutputs } from "../lib/extensions";
import type { Diagnostic, ReferenceLocation } from "../../shared/types";
import { FileIcon } from "./FileIcon";
import { showContextMenu, type ContextMenuItem } from "../lib/context-menu";
import { getSettings, updateSetting, useSettings } from "../lib/settings";
import { useFeaturePanelTabs } from "../features/components";
import { t } from "../lib/i18n";

export type PanelTab = "problems" | "terminal" | "references" | "output" | `view:${string}`;

/** A panel view container contributed by an extension. */
export type ExtraPanelTab = { id: `view:${string}`; label: string; badge?: number; content: ReactNode };
export type PanelPosition = "bottom" | "left" | "right";

/** Drag payload of the panel header (dock overlay reads it). */
export const PANEL_DRAG_TYPE = "application/x-lumen-panel";

export type ReferencesResult = { title: string; locations: ReferenceLocation[] };

type Props = {
  tab: PanelTab;
  position: PanelPosition;
  onMove: (position: PanelPosition) => void;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
  maximized: boolean;
  onToggleMaximize: () => void;
  diagnostics: Map<string, Diagnostic[]>;
  references: ReferencesResult | null;
  workspaceRoot: string | null;
  onOpenLocation: (path: string, line: number, character: number) => void;
  /** The terminal is rendered by the app (it must stay mounted). */
  terminal: ReactNode;
  terminalActions: ReactNode;
  onSelectOutput: (name: string) => void;
  onClearOutput: (name: string) => void;
  extraTabs: ExtraPanelTab[];
};

function basename(path: string) {
  return path.split(/[/\\]/).pop() ?? path;
}

function relativeDir(root: string | null, path: string) {
  let rel = path;
  if (root && path.toLowerCase().startsWith(root.toLowerCase())) rel = path.slice(root.length + 1);
  const parts = rel.replace(/\\/g, "/").split("/");
  parts.pop();
  return parts.join("/");
}

function SeverityIcon({ severity }: { severity: Diagnostic["severity"] }) {
  const Icon = severity === "error" ? CircleX : severity === "warning" ? TriangleAlert : Info;
  return <Icon className={`severity-icon ${severity}`} size={15} />;
}

function FileGroup({ path, root, count, children }: { path: string; root: string | null; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="panel-group">
      <button type="button" className="panel-group-header" onClick={() => setOpen((v) => !v)}>
        <span className={`chevron${open ? " open" : ""}`}>
          <ChevronRight size={14} />
        </span>
        <FileIcon name={basename(path)} />
        <span className="panel-group-name">{basename(path)}</span>
        <span className="panel-group-dir">{relativeDir(root, path)}</span>
        <span className="badge">{count}</span>
      </button>
      {open && children}
    </div>
  );
}

function ProblemsView({ diagnostics, root, onOpen }: { diagnostics: Map<string, Diagnostic[]>; root: string | null; onOpen: Props["onOpenLocation"] }) {
  const files = [...diagnostics].filter(([, list]) => list.some((d) => d.severity !== "hint"));
  if (!files.length) return <div className="panel-empty">{t("No problems have been detected in the workspace.")}</div>;
  return (
    <div className="panel-list">
      {files.map(([path, list]) => {
        const shown = list.filter((d) => d.severity !== "hint").sort((a, b) => a.startLine - b.startLine || a.startCharacter - b.startCharacter);
        return (
          <FileGroup key={path} path={path} root={root} count={shown.length}>
            {shown.map((d, index) => (
              <button key={index} type="button" className="panel-row" onClick={() => onOpen(path, d.startLine, d.startCharacter)}>
                <SeverityIcon severity={d.severity} />
                <span className="panel-row-text">{d.message.split("\n")[0]}</span>
                <span className="panel-row-meta">
                  {d.source ? `${d.source}${d.code != null ? `(${d.code})` : ""} ` : ""}[{t("Ln {0}, Col {1}", d.startLine + 1, d.startCharacter + 1)}]
                </span>
              </button>
            ))}
          </FileGroup>
        );
      })}
    </div>
  );
}

function ReferencesView({ references, root, onOpen }: { references: ReferencesResult | null; root: string | null; onOpen: Props["onOpenLocation"] }) {
  if (!references) return <div className="panel-empty">{t("Run “Go to References” (Shift+F12) on a symbol.")}</div>;
  if (!references.locations.length) return <div className="panel-empty">{t("No references found for “{0}”.", references.title)}</div>;
  const groups = new Map<string, ReferenceLocation[]>();
  for (const location of references.locations) {
    const list = groups.get(location.path) ?? [];
    list.push(location);
    groups.set(location.path, list);
  }
  // The symbol stays bold wherever the translation puts it.
  const [summaryBefore, summaryAfter = ""] = t("{0} references to {1} in {2} files", references.locations.length, "\u0000", groups.size).split("\u0000");
  return (
    <div className="panel-list">
      <div className="panel-summary">
        {summaryBefore}
        <strong>{references.title}</strong>
        {summaryAfter}
      </div>
      {[...groups].map(([path, list]) => (
        <FileGroup key={path} path={path} root={root} count={list.length}>
          {list.map((location, index) => {
            const text = location.preview;
            const lead = text.length - text.trimStart().length;
            const end = location.endLine === location.startLine ? location.endCharacter : text.length;
            return (
              <button key={index} type="button" className="panel-row" onClick={() => onOpen(path, location.startLine, location.startCharacter)}>
                <span className="panel-row-line">{location.startLine + 1}</span>
                <span className="panel-row-text code">
                  {text.slice(lead, location.startCharacter)}
                  <mark>{text.slice(location.startCharacter, end)}</mark>
                  {text.slice(end)}
                </span>
              </button>
            );
          })}
        </FileGroup>
      ))}
    </div>
  );
}

/** Output channels of extensions (and the extension host's log): subscribed here, so log lines only re-render the output. */
function useActiveOutput() {
  const { channels, active } = useExtensionOutputs();
  return { channels, channel: channels.find((channel) => channel.name === active) ?? channels[0] ?? null };
}

function OutputActions({ onSelect, onClear }: { onSelect: (name: string) => void; onClear: (name: string) => void }) {
  const { channels, channel: activeOutput } = useActiveOutput();
  if (!channels.length) return null;
  return (
    <>
      <select className="output-select" title={t("Output channel")} value={activeOutput?.name ?? ""} onChange={(e) => onSelect(e.target.value)}>
        {channels.map((channel) => (
          <option key={channel.name} value={channel.name}>
            {channel.name}
          </option>
        ))}
      </select>
      <button type="button" className="icon-btn" title={t("Clear Output")} onClick={() => activeOutput && onClear(activeOutput.name)}>
        <Eraser size={15} strokeWidth={1.75} />
      </button>
    </>
  );
}

function OutputView() {
  const { channels: outputs, channel: active } = useActiveOutput();
  const ref = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [active?.text, active?.name]);
  if (!outputs.length) return <div className="panel-empty">{t("Extensions write their output here (and the extension host its log).")}</div>;
  return (
    <pre
      ref={ref}
      className="output-view"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
      }}
    >
      {active?.text ?? ""}
    </pre>
  );
}

export function Panel(props: Props) {
  const problemCount = [...props.diagnostics.values()].reduce((sum, list) => sum + list.filter((d) => d.severity !== "hint").length, 0);
  // Panel tabs of feature plug-ins (src/mainview/features) sit with the extensions' ones.
  const extraTabs = [...props.extraTabs, ...useFeaturePanelTabs()];
  const tabs: { id: PanelTab; label: string; badge?: number }[] = [
    { id: "problems", label: t("Problems"), badge: problemCount },
    { id: "references", label: t("References") },
    { id: "output", label: t("Output") },
    { id: "terminal", label: t("Terminal") },
    ...extraTabs.map(({ id, label, badge }) => ({ id, label, badge })),
  ];
  // Tabs the user hid; the active one stays until another tab is opened.
  const hidden = new Set(useSettings()["workbench.panel.hidden"]);
  const shownTabs = tabs.filter((tab) => !hidden.has(tab.id) || tab.id === props.tab);
  const setTabHidden = (id: PanelTab, hide: boolean) => {
    const next = new Set(getSettings()["workbench.panel.hidden"]);
    if (hide) next.add(id);
    else next.delete(id);
    updateSetting("workbench.panel.hidden", [...next]);
    if (hide && id === props.tab) {
      const other = tabs.find((tab) => !next.has(tab.id));
      if (other) props.onTab(other.id);
    }
  };
  const tabItems = (tab?: (typeof tabs)[number]): ContextMenuItem[] => {
    const lastShown = tabs.filter((entry) => !hidden.has(entry.id)).length <= 1;
    return [
      ...(tab
        ? [
            {
              type: "item" as const,
              label: t("Hide '{0}'", tab.label),
              action: "hideTab",
              disabled: lastShown || hidden.has(tab.id),
              run: () => setTabHidden(tab.id, true),
            },
            { type: "separator" as const },
          ]
        : []),
      ...tabs.map((entry) => {
        const shown = !hidden.has(entry.id);
        return {
          type: "item" as const,
          label: entry.label,
          action: `tab:${entry.id}`,
          checked: shown,
          disabled: shown && lastShown,
          run: () => setTabHidden(entry.id, shown),
        };
      }),
      { type: "item", label: t("Reset Panel Tabs"), action: "resetTabs", disabled: !hidden.size, run: () => updateSetting("workbench.panel.hidden", []) },
      { type: "separator" },
    ];
  };
  const headerMenu = (x: number, y: number, tab?: (typeof tabs)[number]) =>
    void showContextMenu(x, y, [
      ...tabItems(tab),
      { type: "item", label: t("Move Panel Left"), action: "left", disabled: props.position === "left" },
      { type: "item", label: t("Move Panel Right"), action: "right", disabled: props.position === "right" },
      { type: "item", label: t("Move Panel to Bottom"), action: "bottom", disabled: props.position === "bottom" },
      { type: "separator" },
      { type: "item", label: props.maximized ? t("Restore Panel Size") : t("Maximize Panel Size"), action: "maximize" },
      { type: "item", label: t("Hide Panel"), action: "close" },
    ]).then((action) => {
      if (action === "maximize") props.onToggleMaximize();
      else if (action === "close") props.onClose();
      else if (action) props.onMove(action as PanelPosition);
    });

  const tabsRef = useRef<HTMLDivElement>(null);
  // Keep the active tab in view when the strip is scrolled
  useEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>(".panel-tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.tab, tabs.length]);
  return (
    <div className={`panel panel-${props.position}`}>
      <div
        className="panel-header"
        title={t("Drag to dock the panel on another side")}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(PANEL_DRAG_TYPE, "panel");
          e.dataTransfer.effectAllowed = "move";
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          headerMenu(e.clientX, e.clientY);
        }}
      >
        <div
          ref={tabsRef}
          className="panel-tabs"
          role="tablist"
          onWheel={(e) => {
            // A vertical wheel scrolls the tab strip sideways
            if (e.deltaY && !e.deltaX) e.currentTarget.scrollLeft += e.deltaY;
          }}
        >
          {shownTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={props.tab === tab.id}
              className={`panel-tab${props.tab === tab.id ? " active" : ""}`}
              onClick={() => props.onTab(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                headerMenu(e.clientX, e.clientY, tab);
              }}
            >
              {tab.label}
              {tab.badge ? <span className="badge">{tab.badge}</span> : null}
            </button>
          ))}
        </div>
        <div className="panel-actions">
          {props.tab === "terminal" && props.terminalActions}
          {props.tab === "output" && <OutputActions onSelect={props.onSelectOutput} onClear={props.onClearOutput} />}
          <button
            type="button"
            className="icon-btn"
            title={t("Move Panel… (or drag the panel header)")}
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              headerMenu(rect.left, rect.bottom + 2);
            }}
          >
            <Ellipsis size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title={props.maximized ? t("Restore Panel Size") : t("Maximize Panel Size")}
            onClick={props.onToggleMaximize}
          >
            {props.maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button type="button" className="icon-btn" title={t("Close Panel")} onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="panel-body">
        {props.tab === "problems" && <ProblemsView diagnostics={props.diagnostics} root={props.workspaceRoot} onOpen={props.onOpenLocation} />}
        {props.tab === "references" && <ReferencesView references={props.references} root={props.workspaceRoot} onOpen={props.onOpenLocation} />}
        {props.tab === "output" && <OutputView />}
        {extraTabs.map((tab) => (
          <div key={tab.id} className="panel-extension" hidden={props.tab !== tab.id}>
            {tab.content}
          </div>
        ))}
        <div className="panel-terminal" hidden={props.tab !== "terminal"}>
          {props.terminal}
        </div>
      </div>
    </div>
  );
}
