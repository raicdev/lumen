import type { HostTab, HostTabGroup } from "../../shared/extensions.ts";
import type { ExtensionHost } from "./host.ts";
import { uriOfKey } from "./documents.ts";
import { TabInputCustom, TabInputTerminal, TabInputText, TabInputWebview } from "./compat-types.ts";
import * as T from "./types.ts";
import { hostFeatures } from "./features/registry.ts";

/**
 * window.tabGroups: the real editor groups and tabs. The view reports its
 * layout whenever tabs change; the host turns it into TabGroup / Tab objects,
 * fires onDidChangeTabGroups / onDidChangeTabs, and asks the view to close
 * tabs through tabGroups.close().
 */

export class Tab {
  readonly #path: string | null;
  readonly input: unknown;
  group: TabGroup;
  #label: string;
  #isActive: boolean;
  #isDirty: boolean;
  #isPinned: boolean;
  #isPreview: boolean;

  constructor(tab: HostTab, group: TabGroup) {
    this.#path = tab.path;
    this.#label = tab.label;
    this.#isActive = tab.isActive;
    this.#isDirty = tab.isDirty;
    this.#isPinned = tab.isPinned;
    this.#isPreview = tab.isPreview;
    this.input = inputOf(tab);
    this.group = group;
  }

  get label(): string {
    return this.#label;
  }

  get isActive(): boolean {
    return this.#isActive;
  }

  get isDirty(): boolean {
    return this.#isDirty;
  }

  get isPinned(): boolean {
    return this.#isPinned;
  }

  get isPreview(): boolean {
    return this.#isPreview;
  }

  /** The view's key for the tab (used to close it); not part of the public API. */
  viewPath(): string | null {
    return this.#path;
  }

  apply(tab: HostTab): void {
    this.#label = tab.label;
    this.#isActive = tab.isActive;
    this.#isDirty = tab.isDirty;
    this.#isPinned = tab.isPinned;
    this.#isPreview = tab.isPreview;
  }
}

export class TabGroup {
  readonly viewColumn: number;
  readonly tabs: Tab[] = [];
  #isActive: boolean;

  constructor(viewColumn: number, isActive: boolean) {
    this.viewColumn = viewColumn;
    this.#isActive = isActive;
  }

  get isActive(): boolean {
    return this.#isActive;
  }

  get activeTab(): Tab | undefined {
    return this.tabs.find((tab) => tab.isActive);
  }

  /** Not part of the public API: the view's layout, for change detection. */
  signature(): string {
    return `${this.#isActive ? 1 : 0}:${this.tabs.map((tab) => tab.viewPath() ?? tab.label).join("\u0000")}`;
  }
}

function inputOf(tab: HostTab): unknown {
  if (tab.kind === "custom" && tab.uri) return new TabInputCustom(uriOfKey(tab.uri), tab.viewType ?? "");
  if (tab.kind === "webview") return new TabInputWebview(tab.label);
  if (tab.kind === "terminal") return new TabInputTerminal();
  if (tab.kind === "feature" && tab.uri) {
    for (const feature of hostFeatures) {
      const input = feature.tabInput?.({ openerId: tab.viewType ?? "", uri: tab.uri, label: tab.label });
      if (input) return input;
    }
    return new TabInputText(uriOfKey(tab.uri));
  }
  if (tab.kind === "other" || !tab.path) return undefined;
  return new TabInputText(uriOfKey(tab.path));
}

const stateSignature = (tab: { label: string; isActive: boolean; isDirty: boolean; isPinned: boolean; isPreview: boolean }) =>
  `${tab.label}\u0000${tab.isActive ? 1 : 0}${tab.isDirty ? 1 : 0}${tab.isPinned ? 1 : 0}${tab.isPreview ? 1 : 0}`;

export class TabGroups {
  readonly #host: ExtensionHost;
  #groups: TabGroup[] = [];
  readonly onDidChangeTabGroups = new T.EventEmitter<{ opened: TabGroup[]; closed: TabGroup[]; changed: TabGroup[] }>();
  readonly onDidChangeTabs = new T.EventEmitter<{ opened: Tab[]; closed: Tab[]; changed: Tab[] }>();

  constructor(host: ExtensionHost) {
    this.#host = host;
  }

  get all(): TabGroup[] {
    return this.#groups;
  }

  get activeTabGroup(): TabGroup {
    return this.#groups.find((group) => group.isActive) ?? this.#groups[0] ?? new TabGroup(1, true);
  }

  /** The view reported its layout: rebuild the groups and fire what changed. */
  update(viewGroups: HostTabGroup[]): void {
    const previous = new Map<string, { tab: Tab; signature: string }>();
    for (const group of this.#groups) {
      for (const tab of group.tabs) previous.set(`${group.viewColumn}:${tab.viewPath() ?? tab.label}`, { tab, signature: stateSignature(tab) });
    }

    const next: TabGroup[] = [];
    const opened: Tab[] = [];
    const changed: Tab[] = [];
    const seen = new Set<string>();
    for (const viewGroup of viewGroups) {
      const group = new TabGroup(viewGroup.viewColumn, viewGroup.isActive);
      for (const viewTab of viewGroup.tabs) {
        const key = `${viewGroup.viewColumn}:${viewTab.path ?? viewTab.label}`;
        seen.add(key);
        const existing = previous.get(key);
        if (existing) {
          existing.tab.group = group;
          const before = existing.signature;
          existing.tab.apply(viewTab);
          if (before !== stateSignature(viewTab)) changed.push(existing.tab);
          group.tabs.push(existing.tab);
        } else {
          const tab = new Tab(viewTab, group);
          group.tabs.push(tab);
          opened.push(tab);
        }
      }
      next.push(group);
    }
    const closed = [...previous.entries()].filter(([key]) => !seen.has(key)).map(([, entry]) => entry.tab);

    const previousGroups = new Map(this.#groups.map((group) => [group.viewColumn, group]));
    const openedGroups: TabGroup[] = [];
    const changedGroups: TabGroup[] = [];
    for (const group of next) {
      const before = previousGroups.get(group.viewColumn);
      if (!before) openedGroups.push(group);
      else if (before.signature() !== group.signature()) changedGroups.push(group);
    }
    const closedGroups = this.#groups.filter((group) => !next.some((candidate) => candidate.viewColumn === group.viewColumn));

    this.#groups = next;
    if (opened.length || closed.length || changed.length) this.onDidChangeTabs.fire({ opened, closed, changed });
    if (openedGroups.length || closedGroups.length || changedGroups.length) {
      this.onDidChangeTabGroups.fire({ opened: openedGroups, closed: closedGroups, changed: changedGroups });
    }
  }

  /** tabGroups.close(tab | tabs | group): ask the view to close their tabs. */
  close(target: Tab | readonly Tab[] | TabGroup): Promise<boolean> {
    const tabs = target instanceof Tab ? [target] : target instanceof TabGroup ? target.tabs : Array.isArray(target) ? target : [];
    const paths = [...new Set(tabs.map((tab) => tab.viewPath()).filter((path): path is string => !!path))];
    if (!paths.length) return Promise.resolve(false);
    return this.#host.requestView("closeTabs", paths);
  }

  /** The `window.tabGroups` object handed to extensions. */
  api(): Record<string, unknown> {
    const model = this;
    return {
      get all() {
        return model.all;
      },
      get activeTabGroup() {
        return model.activeTabGroup;
      },
      onDidChangeTabGroups: this.onDidChangeTabGroups.event,
      onDidChangeTabs: this.onDidChangeTabs.event,
      close: (target: Tab | readonly Tab[] | TabGroup) => model.close(target),
    };
  }
}
