import { useEffect, useState } from "react";
import { Filter, RefreshCw } from "lucide-react";
import type { TimelineHostMessage, TimelineItemWire, TimelinePage, TimelineSourceWire, TimelineViewMessage } from "../../shared/timeline";
import { WithCodicons } from "../components/Codicon";
import { basename } from "../lib/paths";
import { MenuActions } from "./menus-walkthroughs/MenuActions";
import { refArg, showContributedMenu, uriArg } from "./menus-walkthroughs/menus";
import { createStore, useStore } from "./store";
import type { ViewFeature, ViewFeatureApi } from "./types";

/**
 * Window side of the "timeline" area: the Timeline section of the Explorer.
 * The history of the active file from every timeline source (extensions'
 * providers and Lumen's Git History), newest first, with "Load more", a
 * source filter and the timeline/title and timeline/item/context menus.
 */

const TRIGGER_INVOKE = 1;
const TRIGGER_AUTOMATIC = 2;
const HIDDEN_KEY = "lumen.timeline.hiddenSources";

type SourceState = { label: string; items: TimelineItemWire[]; cursor?: string; loading: boolean };
type TimelineState = { path: string | null; sources: Record<string, SourceState>; hidden: string[]; version: number };

function loadHidden(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

const store = createStore<TimelineState>({ path: null, sources: {}, hidden: loadHidden(), version: 0 });
let featureApi: ViewFeatureApi | null = null;
let loadToken = 0;

/** (Re)load the timeline of `path` (null: the workspace timeline) from all sources (or only `only`); `more` appends the next page. */
async function load(path: string | null, options: { only?: string; more?: boolean; trigger?: number } = {}): Promise<void> {
  const api = featureApi;
  if (!api) return;
  const token = options.only || options.more ? loadToken : ++loadToken;
  let sources: TimelineSourceWire[];
  try {
    sources = await api.requestHost<TimelineSourceWire[]>("sources", [path]);
  } catch {
    sources = [];
  }
  if (token !== loadToken) return;
  store.set((state) => {
    const next: Record<string, SourceState> = state.path === path ? { ...state.sources } : {};
    for (const source of sources) next[source.id] = { ...(next[source.id] ?? { items: [] }), label: source.label, loading: !options.only || options.only === source.id };
    for (const id of Object.keys(next)) if (!sources.some((source) => source.id === id)) delete next[id];
    return { ...state, path, sources: next };
  });
  await Promise.all(
    sources
      .filter((source) => !options.only || source.id === options.only)
      .map(async (source) => {
        const current = store.get().sources[source.id];
        const cursor = options.more ? current?.cursor : undefined;
        let page: TimelinePage;
        try {
          page = await api.requestHost<TimelinePage>("provide", [path, source.id, cursor, options.trigger ?? TRIGGER_AUTOMATIC]);
        } catch {
          page = { items: [] };
        }
        if (token !== loadToken || store.get().path !== path) return;
        store.set((state) => {
          const before = state.sources[source.id];
          const items = options.more ? [...(before?.items ?? []), ...page.items] : page.items;
          return { ...state, sources: { ...state.sources, [source.id]: { label: source.label, items, cursor: page.cursor, loading: false } } };
        });
      }),
  );
}

function relativeTime(timestamp: number): string {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "now";
  const steps: [number, string][] = [
    [60, "min"],
    [3600, "hr"],
    [86400, "day"],
    [604800, "wk"],
    [2629800, "mo"],
    [31557600, "yr"],
  ];
  let unit = steps[0]!;
  for (const step of steps) if (seconds >= step[0]) unit = step;
  const count = Math.floor(seconds / unit[0]);
  return `${count} ${unit[1]}${count === 1 ? "" : "s"}`;
}

function itemLookup(item: TimelineItemWire): (key: string) => unknown {
  return (key) => (key === "timelineItem" ? item.contextValue : key === "timeline" ? item.source : undefined);
}

function TimelineRow({ item, path }: { item: TimelineItemWire; path: string | null }) {
  const lookup = itemLookup(item);
  // VS Code's arguments: the TimelineItem, the file and the source.
  const args = [refArg("timeline", { item: item.handle }), path ? uriArg(path) : undefined, item.source];
  return (
    <div
      className={`timeline-row${item.hasCommand ? " clickable" : ""}`}
      title={item.tooltip ?? item.label}
      onClick={() => item.hasCommand && featureApi?.sendToHost({ kind: "run", handle: item.handle } satisfies TimelineViewMessage)}
      onContextMenu={(e) => showContributedMenu(e, "timeline/item/context", lookup, args)}
    >
      <span className="timeline-icon">
        {item.icon && "codicon" in item.icon ? <WithCodicons text={`$(${item.icon.codicon})`} size={14} /> : item.icon ? <img src={item.icon.url} alt="" /> : null}
      </span>
      <span className="timeline-label">{item.label}</span>
      {item.description && <span className="timeline-description">{item.description}</span>}
      <MenuActions menuId="timeline/item/context" lookup={lookup} args={args} inline={["inline"]} overflow={false} className="timeline-inline" />
      <span className="timeline-time">{relativeTime(item.timestamp)}</span>
    </div>
  );
}

function TimelineSection({ activePath }: { activePath: string | null }) {
  const state = useStore(store);
  useEffect(() => {
    void load(activePath);
  }, [activePath]);
  // Relative times move on.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const shown = Object.entries(state.sources).filter(([id]) => !state.hidden.includes(id));
  const items = shown.flatMap(([, source]) => source.items).sort((a, b) => b.timestamp - a.timestamp);
  const loading = shown.some(([, source]) => source.loading);
  const more = shown.filter(([, source]) => source.cursor);
  if (!items.length) {
    const text = loading ? "Loading timeline…" : activePath ? `No timeline information was provided for ${basename(activePath)}.` : "The active editor cannot provide timeline information.";
    return <div className="timeline-empty muted">{text}</div>;
  }
  return (
    <div className="timeline-list">
      {items.map((item) => (
        <TimelineRow key={item.handle} item={item} path={activePath} />
      ))}
      {more.length > 0 && (
        <button type="button" className="timeline-more" onClick={() => more.forEach(([id]) => void load(activePath, { only: id, more: true, trigger: TRIGGER_INVOKE }))}>
          Load more…
        </button>
      )}
    </div>
  );
}

async function filterSources(api: ViewFeatureApi): Promise<void> {
  const { sources, hidden } = store.get();
  const ids = Object.keys(sources);
  if (!ids.length) return;
  const picked = await api.showQuickPick(
    ids.map((id) => ({ label: sources[id]!.label, description: id, picked: !hidden.includes(id) })),
    { title: "Timeline Sources", placeholder: "Sources to show", canPickMany: true },
  );
  if (!picked) return;
  const next = ids.filter((_, index) => !picked.includes(index));
  store.set((state) => ({ ...state, hidden: next }));
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}

function TimelineActions({ activePath }: { activePath: string | null }) {
  return (
    <>
      <MenuActions menuId="timeline/title" lookup={() => undefined} args={activePath ? [uriArg(activePath)] : []} />
      <button type="button" className="icon-btn view-action" title="Refresh" onClick={() => void load(activePath, { trigger: TRIGGER_INVOKE })}>
        <RefreshCw size={13} />
      </button>
      <button type="button" className="icon-btn view-action" title="Filter Timeline" onClick={() => featureApi && void filterSources(featureApi)}>
        <Filter size={13} />
      </button>
    </>
  );
}

export const timelineView: ViewFeature = {
  area: "timeline",

  init: (api) => {
    featureApi = api;
  },

  onHostReady: (api) => {
    featureApi = api;
    void load(store.get().path);
  },

  onHostMessage: (payload) => {
    const message = payload as TimelineHostMessage;
    const path = store.get().path;
    if (message.kind === "sources") void load(path);
    else if (!message.path || message.path.toLowerCase() === path?.toLowerCase()) void load(path, { only: message.source });
  },

  commands: [{ id: "timeline.refresh", title: "Refresh", category: "Timeline", run: () => load(store.get().path, { trigger: TRIGGER_INVOKE }) }],

  explorerSections: [
    {
      id: "timeline",
      title: "Timeline",
      collapsed: true,
      render: ({ activePath }) => <TimelineSection activePath={activePath} />,
      actions: ({ activePath }) => <TimelineActions activePath={activePath} />,
    },
  ],
};
