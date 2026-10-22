import { useMemo } from "react";
import type { ExtensionDescription } from "../../../shared/extensions";
import {
  completesOnSelect,
  findWalkthrough,
  formatResourceLabel,
  labelFormattersOf,
  orderWalkthroughs,
  parseCommandLink,
  parseCompletionEvent,
  parseResourceKey,
  parseWalkthroughs,
  setWalkthroughHidden as updateHiddenCategories,
  type ResourceLabelFormatter,
  type Walkthrough,
  type WalkthroughStep,
} from "../../../shared/menus-walkthroughs";
import { extensionService, useExtensions } from "../../lib/extensions";
import { getSettings, onSettingsChange, updateSetting, useSettings } from "../../lib/settings";
import { createStore, refreshFeatures, useStore } from "../store";
import type { ViewFeatureApi } from "../types";
import { labelOf } from "./labels";
import { isViewVisible, onViewVisibility } from "./views";

export { setVisibleViews, viewAliases } from "./views";

/** Window-side state of the "menus-walkthroughs" area: walkthrough progress, completion events and the label formatters. */

export const AREA = "menus-walkthroughs";
/** Editor tab "files" of walkthroughs (rendered by the feature's editor opener, never read from disk). */
export const WALKTHROUGH_PATH_PREFIX = "lumen-walkthrough:";

let featureApi: ViewFeatureApi | null = null;

export function setApi(api: ViewFeatureApi): void {
  featureApi = api;
}

export function getApi(): ViewFeatureApi | null {
  return featureApi;
}

/* ── context keys (extension-set and window state) ───────────────────────── */

/** Answers the window's own context keys (`sideBarVisible`, `resourceLangId`, …); extension keys come from extensionService. */
let windowContext: (key: string) => unknown = () => undefined;

/** Bumped when a window context key changes (the extension host's keys come through the snapshot). */
const contextVersion = createStore(0);

export function setContextLookup(lookup: (key: string) => unknown): void {
  windowContext = lookup;
  refreshContext();
}

/** A window context key changed: `when` clauses and onContext events see it now. */
export function refreshContext(): void {
  contextVersion.set((version) => version + 1);
  evaluateCompletion();
}

/** Whether a when clause holds, including the window's context keys. */
export function whenClause(clause: string | undefined): boolean {
  return extensionService.when(clause, windowContext);
}

/* ── progress (persisted in localStorage; everything works without it) ────── */

type Progress = { completed: Record<string, true>; selected: Record<string, string> };

const STORAGE_KEY = "lumen.walkthroughs.v1";

function loadProgress(): Progress {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Progress> | null;
    return { completed: parsed?.completed ?? {}, selected: parsed?.selected ?? {} };
  } catch {
    return { completed: {}, selected: {} };
  }
}

export const progressStore = createStore<Progress>(loadProgress());

progressStore.subscribe(() => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progressStore.get()));
  } catch {
    // storage unavailable: progress lives for this session only
  }
});

export const stepKey = (walkthrough: Walkthrough, step: WalkthroughStep) => `${walkthrough.key}#${step.id}`;

export function isStepDone(progress: Progress, walkthrough: Walkthrough, step: WalkthroughStep): boolean {
  return !!progress.completed[stepKey(walkthrough, step)];
}

export function setStepDone(walkthrough: Walkthrough, step: WalkthroughStep, done: boolean): void {
  progressStore.set((progress) => {
    const key = stepKey(walkthrough, step);
    if (!!progress.completed[key] === done) return progress;
    const completed = { ...progress.completed };
    if (done) completed[key] = true;
    else delete completed[key];
    return { ...progress, completed };
  });
}

/** "Developer: Reset Welcome Page Walkthrough Progress": every step unchecked. */
export function resetProgress(): void {
  progressStore.set(() => ({ completed: {}, selected: {} }));
  settingBaseline.clear();
}

/** The walkthrough and step of a full step key (`publisher.ext#walkthrough#step`). */
export function findStep(key: string): { walkthrough: Walkthrough; step: WalkthroughStep } | undefined {
  const lower = key.toLowerCase();
  for (const walkthrough of allWalkthroughs()) {
    for (const step of walkthrough.steps) {
      if (stepKey(walkthrough, step).toLowerCase() === lower) return { walkthrough, step };
    }
  }
  return undefined;
}

/** `welcome.markStepComplete` / `welcome.markStepIncomplete` (the step's full id). */
export function markStepDone(key: string, done: boolean): void {
  const found = findStep(key);
  if (found) setStepDone(found.walkthrough, found.step, done);
}

/** `walkthroughs.selectStep` (`<category>#<step>`): reveals the step, and completes it if it has no other event. */
export function selectStepByKey(key: string): void {
  const found = findStep(key);
  if (!found) return;
  selectStep(found.walkthrough, found.step);
  void openWalkthrough(found.walkthrough.key, found.step.id);
}

/** A step was selected: remembered, and completed when it has no completion events (or `onStepSelected`). */
export function selectStep(walkthrough: Walkthrough, step: WalkthroughStep): void {
  progressStore.set((progress) => (progress.selected[walkthrough.key] === step.id ? progress : { ...progress, selected: { ...progress.selected, [walkthrough.key]: step.id } }));
  if (!completesOnSelect(step)) return;
  const key = firedKey(walkthrough, step, "onStepSelected");
  if (!fired.has(key) && !isStepDone(progressStore.get(), walkthrough, step)) setStepDone(walkthrough, step, true);
  fired.add(key);
}

export function progressOf(progress: Progress, walkthrough: Walkthrough): { done: number; total: number } {
  return { done: walkthrough.steps.filter((step) => isStepDone(progress, walkthrough, step)).length, total: walkthrough.steps.length };
}

export function useWalkthroughProgress(): Progress {
  return useStore(progressStore);
}

/* ── hidden walkthroughs (workbench.welcomePage.hiddenCategories) ─────────── */

const HIDDEN_CATEGORIES_KEY = "workbench.welcomePage.hiddenCategories";

/** Lower-cased keys of the walkthroughs hidden from the Welcome page. */
export function hiddenWalkthroughs(settings = getSettings()): Set<string> {
  return new Set(settings[HIDDEN_CATEGORIES_KEY].map((key) => key.toLowerCase()));
}

/** The "Hide" (x) action of a walkthrough in the Welcome page. */
export function hideWalkthrough(walkthrough: Walkthrough): void {
  updateSetting(HIDDEN_CATEGORIES_KEY, updateHiddenCategories(getSettings()[HIDDEN_CATEGORIES_KEY], walkthrough.key, true));
}

/** Shows a hidden walkthrough in the Welcome page again. */
export function showWalkthrough(walkthrough: Walkthrough): void {
  updateSetting(HIDDEN_CATEGORIES_KEY, updateHiddenCategories(getSettings()[HIDDEN_CATEGORIES_KEY], walkthrough.key, false));
}

export function useHiddenWalkthroughs(): Set<string> {
  const settings = useSettings();
  return useMemo(() => hiddenWalkthroughs(settings), [settings]);
}

/* ── the walkthroughs of the enabled extensions ──────────────────────────── */

function sourcesOf(extensions: ExtensionDescription[]) {
  return extensions.filter((extension) => extension.enabled).map((extension) => ({ id: extension.id, manifest: extension.manifest, commandIcons: extension.commandIcons, iconUrl: extension.iconUrl }));
}

export function currentWalkthroughs(): Walkthrough[] {
  return parseWalkthroughs(sourcesOf(extensionService.getSnapshot().extensions), whenClause);
}

/** Every registered walkthrough, even ones hidden by a `when` / an invisible step (VS Code registers their steps too). */
function allWalkthroughs(): Walkthrough[] {
  return parseWalkthroughs(sourcesOf(extensionService.getSnapshot().extensions));
}

/** Keys of the walkthroughs whose `featuredFor` matches a file of the workspace (from the host). */
export const featuredStore = createStore<ReadonlySet<string>>(new Set());

let featuredSignature = "";
let featuredRequest = 0;

function walkthroughSignature(): string {
  return extensionService
    .getSnapshot()
    .extensions.map((extension) => `${extension.id}:${extension.enabled ? 1 : 0}:${JSON.stringify(extension.manifest.contributes?.walkthroughs ?? null)}`)
    .join("|");
}

/** Re-asks the host which walkthroughs are featured in the workspace (`force`: the workspace itself changed). */
export function refreshFeatured(force = false): void {
  const api = getApi();
  if (!api) return;
  const signature = walkthroughSignature();
  if (!force && signature === featuredSignature) return;
  featuredSignature = signature;
  const request = ++featuredRequest;
  void api
    .requestHost<string[]>("featured", [])
    .then((keys) => {
      if (request === featuredRequest) featuredStore.set(new Set((keys ?? []).map((key) => key.toLowerCase())));
    })
    .catch(() => {
      if (request === featuredRequest) featuredStore.set(new Set());
    });
}

export function useWalkthroughs(): Walkthrough[] {
  const snapshot = useExtensions();
  const featured = useStore(featuredStore);
  const version = useStore(contextVersion);
  return useMemo(
    () => orderWalkthroughs(parseWalkthroughs(sourcesOf(snapshot.extensions), whenClause), (walkthrough) => featured.has(walkthrough.key.toLowerCase())),
    // The snapshot covers extension context keys, `version` the window's own keys; `featured` the workspace files.
    [snapshot, featured, version],
  );
}

export function lookupWalkthrough(key: string): Walkthrough | undefined {
  return findWalkthrough(currentWalkthroughs(), key);
}

/* ── completion events ───────────────────────────────────────────────────── */

const settingBaseline = new Map<string, string>();

/**
 * Events already seen this session by a step (VS Code's `WalkthroughsService.sessionEvents`):
 * unchecking a step it completed stays unchecked until the window restarts.
 */
const fired = new Set<string>();
const firedKey = (walkthrough: Walkthrough, step: WalkthroughStep, event: string) => `${stepKey(walkthrough, step)}\0${event}`;

function settingValue(key: string): string {
  const own = (getSettings() as unknown as Record<string, unknown>)[key];
  return JSON.stringify(own !== undefined ? own : (featureApi?.getExtensionSetting(key) ?? null));
}

/** Re-checks the state-based events (context, setting changes, installed extensions, shown views) of all open steps. */
export function evaluateCompletion(): void {
  const progress = progressStore.get();
  const installed = new Set(extensionService.getSnapshot().extensions.map((extension) => extension.id.toLowerCase()));
  for (const walkthrough of allWalkthroughs()) {
    for (const step of walkthrough.steps) {
      const done = isStepDone(progress, walkthrough, step);
      for (const raw of step.completionEvents) {
        const event = parseCompletionEvent(raw);
        if (!event) continue;
        if (event.kind === "settingChanged") {
          // Completes when the setting changes after the window first saw it.
          const now = settingValue(event.arg);
          const before = settingBaseline.get(event.arg);
          if (before === undefined) settingBaseline.set(event.arg, now);
          else if (before !== now) {
            // Remember the new value even after completing, so unchecking the step sticks.
            settingBaseline.set(event.arg, now);
            const key = firedKey(walkthrough, step, raw);
            if (!fired.has(key) && !done) setStepDone(walkthrough, step, true);
            fired.add(key);
          }
        } else if (event.kind === "extensionInstalled" && installed.has(event.arg.toLowerCase())) {
          const key = firedKey(walkthrough, step, `extensionInstalled:${event.arg.toLowerCase()}`);
          if (!fired.has(key) && !done) setStepDone(walkthrough, step, true);
          fired.add(key);
        } else if (event.kind === "context" && extensionService.when(event.arg, windowContext)) {
          const key = firedKey(walkthrough, step, raw);
          if (!fired.has(key) && !done) setStepDone(walkthrough, step, true);
          fired.add(key);
        } else if (event.kind === "view" && isViewVisible(event.arg)) {
          const key = firedKey(walkthrough, step, raw);
          if (!fired.has(key) && !done) setStepDone(walkthrough, step, true);
          fired.add(key);
        }
      }
    }
  }
}

/** A view became visible (`onView:<id>`), for every kind of view the window reports. */
export function viewShown(id: string): void {
  for (const walkthrough of allWalkthroughs()) {
    for (const step of walkthrough.steps) {
      const waits = step.completionEvents.some((raw) => {
        const event = parseCompletionEvent(raw);
        return event?.kind === "view" && event.arg === id;
      });
      if (!waits) continue;
      const key = firedKey(walkthrough, step, `onView:${id}`);
      if (!fired.has(key) && !isStepDone(progressStore.get(), walkthrough, step)) setStepDone(walkthrough, step, true);
      fired.add(key);
    }
  }
}

/** A command ran (a link of a step, or the extension host reported it): completes the steps waiting for `onCommand:<id>`. */
export function commandExecuted(command: string): void {
  for (const walkthrough of allWalkthroughs()) {
    for (const step of walkthrough.steps) {
      const waits = step.completionEvents.some((raw) => {
        const event = parseCompletionEvent(raw);
        return event?.kind === "command" && event.arg === command;
      });
      if (!waits) continue;
      const key = firedKey(walkthrough, step, `onCommand:${command}`);
      if (!fired.has(key) && !isStepDone(progressStore.get(), walkthrough, step)) setStepDone(walkthrough, step, true);
      fired.add(key);
    }
  }
}

/** A link of a step description was followed (`onLink:<url>`). */
export function linkFollowed(walkthrough: Walkthrough, step: WalkthroughStep, url: string): void {
  const waits = step.completionEvents.some((raw) => {
    const event = parseCompletionEvent(raw);
    return event?.kind === "link" && event.arg === url;
  });
  if (!waits) return;
  const key = firedKey(walkthrough, step, `onLink:${url}`);
  if (!fired.has(key) && !isStepDone(progressStore.get(), walkthrough, step)) setStepDone(walkthrough, step, true);
  fired.add(key);
}

/** An external link opened from a step's media: every step waiting for `onLink:<url>` can complete. */
export function linkFollowedUrl(url: string): void {
  for (const walkthrough of allWalkthroughs()) {
    for (const step of walkthrough.steps) linkFollowed(walkthrough, step, url);
  }
}

/** Runs the command of a `command:` link in a step description (`command:toSide:` opens beside the editor). */
export function runCommandLink(href: string): void {
  const link = parseCommandLink(href);
  if (!link) return;
  if (link.toSide) {
    // Focus a side group first, like VS Code, so a command that opens an editor lands there.
    featureApi?.executeCommand("workbench.action.splitEditor");
    setTimeout(() => {
      featureApi?.executeCommand(link.command, ...link.args);
      commandExecuted(link.command);
    }, 0);
    return;
  }
  featureApi?.executeCommand(link.command, ...link.args);
  commandExecuted(link.command);
}

let watching = false;

/** Starts watching settings, views and extension changes (once). */
export function startCompletionWatch(): void {
  if (watching) return;
  watching = true;
  extensionService.subscribe(() => {
    evaluateCompletion();
    refreshFeatured();
  });
  onSettingsChange(evaluateCompletion);
  onViewVisibility((id, visible) => {
    if (visible) viewShown(id);
  });
  evaluateCompletion();
  refreshFeatured();
}

/* ── opening ─────────────────────────────────────────────────────────────── */

/** Opens a walkthrough in an editor tab (besides the editor when `toSide`); `step` selects one of its steps. */
export async function openWalkthrough(key: string, step?: string, toSide = false): Promise<boolean> {
  const walkthrough = lookupWalkthrough(key);
  if (!walkthrough) {
    void featureApi?.showMessage("error", `Walkthrough '${key}' not found.`);
    return false;
  }
  const target = step ? walkthrough.steps.find((candidate) => candidate.id === step) : undefined;
  if (target) selectStep(walkthrough, target);
  featureApi?.sendToHost({ type: "opened", key: walkthrough.key });
  return (await featureApi?.openFile(`${WALKTHROUGH_PATH_PREFIX}${walkthrough.key}`, { preview: false, focus: !toSide, beside: toSide })) ?? false;
}

/** The user opened a walkthrough on the Welcome page: its extension activates on `onWalkthrough:` (no editor tab). */
export function announceWalkthrough(key: string): void {
  const walkthrough = lookupWalkthrough(key);
  if (walkthrough) featureApi?.sendToHost({ type: "opened", key: walkthrough.key });
}

/** `workbench.action.openWalkthrough` without an argument: the Welcome page (VS Code opens Getting Started). */
export async function openWelcomePage(): Promise<void> {
  await featureApi?.executeCommand("workbench.action.openWelcome");
}

/** Asks which walkthrough to open (Welcome: Open Walkthrough…, `welcome.showAllWalkthroughs`). */
export async function pickWalkthrough(): Promise<void> {
  const walkthroughs = currentWalkthroughs();
  if (!walkthroughs.length) {
    void featureApi?.showMessage("info", "No extension contributes a walkthrough.");
    return;
  }
  // Hidden walkthroughs stay listed here (`welcome.showAllWalkthroughs`), marked so they can be found again.
  const hidden = hiddenWalkthroughs();
  const picked = await featureApi?.showQuickPick(
    walkthroughs.map((walkthrough) => {
      const { done, total } = progressOf(progressStore.get(), walkthrough);
      const suffix = hidden.has(walkthrough.key.toLowerCase()) ? " · Hidden" : "";
      return { label: walkthrough.title, description: `${done}/${total}${suffix}`, detail: walkthrough.description };
    }),
    { title: "Open Walkthrough...", placeholder: "Select a walkthrough to open", matchOnDescription: true, matchOnDetail: true },
  );
  const index = picked?.[0];
  if (index === undefined) return;
  const walkthrough = walkthroughs[index]!;
  // Opening a hidden one from the show-all list puts it back on the Welcome page.
  if (hidden.has(walkthrough.key.toLowerCase())) showWalkthrough(walkthrough);
  await openWalkthrough(walkthrough.key);
}

/* ── newly installed extensions (workbench.welcomePage.walkthroughs.openOnInstall) ── */

const OPEN_ON_INSTALL_KEY = "workbench.welcomePage.walkthroughs.openOnInstall";

function openOnInstallEnabled(): boolean {
  return getSettings()[OPEN_ON_INSTALL_KEY] !== false;
}

/** Extension ids of the first extension list of this session: later new ids were installed in this session. */
let sessionExtensions: Set<string> | null = null;
const autoOpened = new Set<string>();

/**
 * Opens the walkthrough of an extension installed while the window runs, like
 * VS Code (`workbench.welcomePage.walkthroughs.openOnInstall`, default true).
 * The extension host restarts on install, so a new id in an `onHostReady` list
 * is a session install.
 */
export function checkOpenOnInstall(): void {
  const extensions = extensionService.getSnapshot().extensions.filter((extension) => extension.enabled);
  if (!sessionExtensions) {
    // First list of the session: these were installed before, nothing opens.
    sessionExtensions = new Set(extensions.map((extension) => extension.id.toLowerCase()));
    return;
  }
  const fresh = extensions.filter((extension) => !sessionExtensions!.has(extension.id.toLowerCase()));
  for (const extension of fresh) {
    const id = extension.id.toLowerCase();
    sessionExtensions.add(id);
    if (autoOpened.has(id) || !openOnInstallEnabled()) continue;
    const walkthrough = currentWalkthroughs().find((candidate) => candidate.extensionId.toLowerCase() === id);
    if (!walkthrough) continue;
    autoOpened.add(id);
    void openWalkthrough(walkthrough.key);
  }
}

/* ── resource label formatters ───────────────────────────────────────────── */

/** Formatters registered at runtime through `workspace.registerResourceLabelFormatter`. */
let runtimeFormatters: ResourceLabelFormatter[] = [];

export function setRuntimeFormatters(formatters: ResourceLabelFormatter[]): void {
  runtimeFormatters = formatters;
  refreshFeatures();
}

export function allFormatters(): ResourceLabelFormatter[] {
  return [...labelFormattersOf(sourcesOf(extensionService.getSnapshot().extensions)), ...runtimeFormatters];
}

/** Label of a non-file resource (`ssh://host/path` as its formatter says); undefined for files and unknown schemes. */
export function resourceLabel(key: string): string | undefined {
  const resource = parseResourceKey(key);
  return resource ? formatResourceLabel(allFormatters(), resource) : undefined;
}

/** Label of a resource in tabs and breadcrumbs: the formatter's label, else `fallback`. */
export function resourceTabLabel(key: string, fallback: string): string {
  return labelOf(allFormatters(), key, fallback);
}
