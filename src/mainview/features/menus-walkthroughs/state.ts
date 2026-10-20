import { useMemo } from "react";
import type { ExtensionDescription } from "../../../shared/extensions";
import {
  completesOnSelect,
  findWalkthrough,
  formatResourceLabel,
  labelFormattersOf,
  parseCommandLink,
  parseCompletionEvent,
  parseResourceKey,
  parseWalkthroughs,
  type ResourceLabelFormatter,
  type Walkthrough,
  type WalkthroughStep,
} from "../../../shared/menus-walkthroughs";
import { extensionService, useExtensions } from "../../lib/extensions";
import { getSettings, onSettingsChange } from "../../lib/settings";
import { treeService } from "../../lib/trees";
import { createStore, refreshFeatures, useStore } from "../store";
import type { ViewFeatureApi } from "../types";

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

/** A step was selected: remembered, and completed when it has no completion events (or `onStepSelected`). */
export function selectStep(walkthrough: Walkthrough, step: WalkthroughStep): void {
  progressStore.set((progress) => (progress.selected[walkthrough.key] === step.id ? progress : { ...progress, selected: { ...progress.selected, [walkthrough.key]: step.id } }));
  if (completesOnSelect(step)) setStepDone(walkthrough, step, true);
}

export function progressOf(progress: Progress, walkthrough: Walkthrough): { done: number; total: number } {
  return { done: walkthrough.steps.filter((step) => isStepDone(progress, walkthrough, step)).length, total: walkthrough.steps.length };
}

export function useWalkthroughProgress(): Progress {
  return useStore(progressStore);
}

/* ── the walkthroughs of the enabled extensions ──────────────────────────── */

function sourcesOf(extensions: ExtensionDescription[]) {
  return extensions.filter((extension) => extension.enabled).map((extension) => ({ id: extension.id, manifest: extension.manifest, commandIcons: extension.commandIcons }));
}

const noKeys = () => undefined;

export function currentWalkthroughs(): Walkthrough[] {
  return parseWalkthroughs(sourcesOf(extensionService.getSnapshot().extensions), (clause) => extensionService.when(clause, noKeys));
}

export function useWalkthroughs(): Walkthrough[] {
  const snapshot = useExtensions();
  return useMemo(() => parseWalkthroughs(sourcesOf(snapshot.extensions), (clause) => extensionService.when(clause, noKeys)), [snapshot]);
}

export function lookupWalkthrough(key: string): Walkthrough | undefined {
  return findWalkthrough(currentWalkthroughs(), key);
}

/* ── completion events ───────────────────────────────────────────────────── */

const settingBaseline = new Map<string, string>();

function settingValue(key: string): string {
  const own = (getSettings() as unknown as Record<string, unknown>)[key];
  return JSON.stringify(own !== undefined ? own : (featureApi?.getExtensionSetting(key) ?? null));
}

/** Re-checks the state-based events (context, setting changes, installed extensions, shown views) of all open steps. */
export function evaluateCompletion(): void {
  const progress = progressStore.get();
  const installed = new Set(extensionService.getSnapshot().extensions.map((extension) => extension.id.toLowerCase()));
  for (const walkthrough of currentWalkthroughs()) {
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
          else if (before !== now && !done) setStepDone(walkthrough, step, true);
        } else if (done) continue;
        else if (event.kind === "extensionInstalled" && installed.has(event.arg.toLowerCase())) setStepDone(walkthrough, step, true);
        else if (event.kind === "context" && extensionService.when(event.arg, noKeys)) setStepDone(walkthrough, step, true);
        else if (event.kind === "view" && treeService.state(event.arg).visible) setStepDone(walkthrough, step, true);
      }
    }
  }
}

/** A command ran (a link of a step, or the extension host reported it): completes the steps waiting for `onCommand:<id>`. */
export function commandExecuted(command: string): void {
  for (const walkthrough of currentWalkthroughs()) {
    for (const step of walkthrough.steps) {
      const waits = step.completionEvents.some((raw) => {
        const event = parseCompletionEvent(raw);
        return event?.kind === "command" && event.arg === command;
      });
      if (waits) setStepDone(walkthrough, step, true);
    }
  }
}

/** A link of a step description was followed (`onLink:<url>`). */
export function linkFollowed(walkthrough: Walkthrough, step: WalkthroughStep, url: string): void {
  const waits = step.completionEvents.some((raw) => {
    const event = parseCompletionEvent(raw);
    return event?.kind === "link" && event.arg === url;
  });
  if (waits) setStepDone(walkthrough, step, true);
}

/** Runs the command of a `command:` link in a step description. */
export function runCommandLink(href: string): void {
  const link = parseCommandLink(href);
  if (!link) return;
  featureApi?.executeCommand(link.command, ...link.args);
  commandExecuted(link.command);
}

let watching = false;

/** Starts watching settings and extension changes (once). */
export function startCompletionWatch(): void {
  if (watching) return;
  watching = true;
  extensionService.subscribe(evaluateCompletion);
  onSettingsChange(evaluateCompletion);
  evaluateCompletion();
}

/* ── opening ─────────────────────────────────────────────────────────────── */

/** Opens a walkthrough in an editor tab; `step` selects one of its steps. */
export async function openWalkthrough(key: string, step?: string): Promise<boolean> {
  const walkthrough = lookupWalkthrough(key);
  if (!walkthrough) {
    void featureApi?.showMessage("error", `Walkthrough '${key}' not found.`);
    return false;
  }
  const target = step ? walkthrough.steps.find((candidate) => candidate.id === step) : undefined;
  if (target) selectStep(walkthrough, target);
  featureApi?.sendToHost({ type: "opened", key: walkthrough.key });
  return (await featureApi?.openFile(`${WALKTHROUGH_PATH_PREFIX}${walkthrough.key}`, { preview: false, focus: true })) ?? false;
}

/** Asks which walkthrough to open (Welcome: Open Walkthrough…). */
export async function pickWalkthrough(): Promise<void> {
  const walkthroughs = currentWalkthroughs();
  if (!walkthroughs.length) {
    void featureApi?.showMessage("info", "No extension contributes a walkthrough.");
    return;
  }
  const picked = await featureApi?.showQuickPick(
    walkthroughs.map((walkthrough) => {
      const { done, total } = progressOf(progressStore.get(), walkthrough);
      return { label: walkthrough.title, description: `${done}/${total}`, detail: walkthrough.description };
    }),
    { title: "Open Walkthrough…", placeholder: "Select a walkthrough", matchOnDetail: true },
  );
  const index = picked?.[0];
  if (index !== undefined) await openWalkthrough(walkthroughs[index]!.key);
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
