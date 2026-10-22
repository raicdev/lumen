import { useState } from "react";
import type { ReactNode } from "react";
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import {
  Bug,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  FlaskConical,
  ListChecks,
  LoaderCircle,
  Play,
  RefreshCw,
  Repeat,
  ShieldCheck,
  Square,
  X,
} from "lucide-react";
import { STATE_PRIORITY, TEST_ID_SEPARATOR } from "../../shared/testing";
import type {
  TestRunArgs,
  TestState,
  TestWireController,
  TestWireCoverageDetail,
  TestWireCoverageFile,
  TestWireItem,
  TestWireMessage,
  TestWireProfile,
  TestingHostEvent,
} from "../../shared/testing";
import { basename } from "../lib/paths";
import { showContextMenu, type ContextMenuItem } from "../lib/context-menu";
import { MenuActions } from "./menus-walkthroughs/MenuActions";
import { contributedMenuItems, refArg, showContributedMenu } from "./menus-walkthroughs/menus";
import { createStore, refreshFeatures, useStore } from "./store";
import type { ViewFeature, ViewFeatureApi } from "./types";

/**
 * Window side of the "testing" area: the Testing side bar (tree of the test
 * controllers' items with run / debug / coverage buttons), the Test Results
 * panel (failures, coverage, output), status icons in the editor gutter and
 * covered / uncovered lines. The host half is src/main/exthost/features/testing.ts.
 */

const KIND_RUN = 1;
const KIND_DEBUG = 2;
const KIND_COVERAGE = 3;
const RESULTS_TAB = "testing.results";
const SIDEBAR_VIEW = "testing";

type TestResult = { state: TestState; duration?: number; messages?: TestWireMessage[]; runId: string };

type RunInfo = {
  id: string;
  name: string;
  controllerId: string;
  profile?: string;
  kind?: number;
  ended: boolean;
  output: string;
  coverage: TestWireCoverageFile[];
};

/** An active continuous run (host event `continuous`): one per profile and set of included items. */
type ContinuousInfo = {
  key: string;
  profileId: string;
  controllerId: string;
  label: string;
  kind: number;
  testIds: string[];
  running: boolean;
  runId?: string;
};

type ContinuousEvent = { kind: "continuous"; runs: ContinuousInfo[] };

type TestingState = {
  controllers: TestWireController[];
  results: Record<string, TestResult>;
  runs: RunInfo[];
  /** Active continuous runs, as last sent by the host. */
  continuous: ContinuousInfo[];
  expanded: Record<string, true>;
  selected: string | null;
  /** Detailed coverage of files (by normalised path) of the shown coverage run. */
  coverage: Record<string, TestWireCoverageDetail[]>;
};

const store = createStore<TestingState>({ controllers: [], results: {}, runs: [], continuous: [], expanded: {}, selected: null, coverage: {} });
let featureApi: ViewFeatureApi | undefined;

const MAX_RUNS = 20;
const MAX_OUTPUT = 400_000;

/* ── state helpers ───────────────────────────────────────────────────────── */

const normPath = (path: string) => path.replace(/\\/g, "/").toLowerCase();

function walk(items: TestWireItem[], visit: (item: TestWireItem, depth: number) => void, depth = 0): void {
  for (const item of items) {
    visit(item, depth);
    walk(item.children, visit, depth + 1);
  }
}

function leaves(controllers: TestWireController[]): TestWireItem[] {
  const out: TestWireItem[] = [];
  for (const controller of controllers) walk(controller.items, (item) => void (item.children.length === 0 && out.push(item)));
  return out;
}

/** State of an item: its own result for leaves, the most significant one of its descendants otherwise. */
function stateOf(item: TestWireItem, results: Record<string, TestResult>): TestState | undefined {
  if (item.children.length === 0) return results[item.id]?.state;
  let best: TestState | undefined = results[item.id]?.state;
  for (const child of item.children) {
    const state = stateOf(child, results);
    if (state && (!best || STATE_PRIORITY[state] > STATE_PRIORITY[best])) best = state;
  }
  return best;
}

function counts(state: TestingState): Record<TestState, number> & { total: number } {
  const tally = { queued: 0, running: 0, passed: 0, failed: 0, errored: 0, skipped: 0, total: 0 };
  for (const leaf of leaves(state.controllers)) {
    tally.total++;
    const result = state.results[leaf.id];
    if (result) tally[result.state]++;
  }
  return tally;
}

function findItem(controllers: TestWireController[], id: string): TestWireItem | undefined {
  let found: TestWireItem | undefined;
  for (const controller of controllers) walk(controller.items, (item) => void (item.id === id && (found = item)));
  return found;
}

const controllerOf = (id: string) => id.split(TEST_ID_SEPARATOR)[0]!;

function applyEvent(event: TestingHostEvent | ContinuousEvent): void {
  switch (event.kind) {
    case "tree":
      store.set((state) => ({ ...state, controllers: event.controllers }));
      break;
    case "continuous":
      store.set((state) => ({ ...state, continuous: event.runs }));
      break;
    case "runStart":
      store.set((state) => ({
        ...state,
        runs: [
          {
            id: event.runId,
            name: event.name,
            controllerId: event.controllerId,
            profile: event.profile,
            kind: event.profileKind,
            ended: false,
            output: "",
            coverage: [],
          },
          ...state.runs,
        ].slice(0, MAX_RUNS),
        coverage: event.profileKind === KIND_COVERAGE ? {} : state.coverage,
      }));
      break;
    case "state":
      store.set((state) => ({
        ...state,
        results: { ...state.results, [event.testId]: { state: event.state, duration: event.duration, messages: event.messages, runId: event.runId } },
      }));
      break;
    case "output":
      store.set((state) => ({
        ...state,
        runs: state.runs.map((run) =>
          run.id === event.runId ? { ...run, output: (run.output + event.text.replace(/\r?\n/g, "\n")).slice(-MAX_OUTPUT) } : run,
        ),
      }));
      break;
    case "coverage":
      store.set((state) => ({ ...state, runs: state.runs.map((run) => (run.id === event.runId ? { ...run, coverage: [...run.coverage, event.file] } : run)) }));
      break;
    case "runEnd":
      store.set((state) => {
        // Tests that never reported a final state in this run do not keep a spinner.
        const results = { ...state.results };
        for (const [id, result] of Object.entries(results)) {
          if (result.runId === event.runId && (result.state === "running" || result.state === "queued")) delete results[id];
        }
        return { ...state, results, runs: state.runs.map((run) => (run.id === event.runId ? { ...run, ended: true } : run)) };
      });
      break;
    case "invalidate":
      store.set((state) => {
        if (!event.ids) return { ...state, results: {} };
        const results = { ...state.results };
        for (const id of Object.keys(results)) {
          if (event.ids.some((prefix) => id === prefix || id.startsWith(prefix + TEST_ID_SEPARATOR))) delete results[id];
        }
        return { ...state, results };
      });
      break;
    case "error":
      void featureApi?.showMessage("error", event.message);
      break;
  }
  refreshFeatures();
}

/* ── actions ─────────────────────────────────────────────────────────────── */

function profilesFor(controller: TestWireController, kind: number, items: TestWireItem[]): TestWireProfile[] {
  return controller.profiles.filter((profile) => profile.kind === kind && (!profile.tag || items.every((item) => item.tags.includes(profile.tag!))));
}

/** Run (or debug, or cover) tests; no ids means everything. Asks which profile when there is no default one. */
async function runTests(kind: number, ids: string[] = []): Promise<void> {
  const api = featureApi;
  if (!api) return;
  const { controllers } = store.get();
  const items = ids.map((id) => findItem(controllers, id)).filter((item): item is TestWireItem => !!item);
  const wanted = ids.length ? new Set(ids.map(controllerOf)) : null;
  const profileIds: string[] = [];
  for (const controller of controllers) {
    if (wanted && !wanted.has(controller.id)) continue;
    const mine = items.filter((item) => controllerOf(item.id) === controller.id);
    const candidates = profilesFor(controller, kind, mine);
    if (!candidates.length) continue;
    const defaults = candidates.filter((profile) => profile.isDefault);
    if (defaults.length || candidates.length === 1) {
      profileIds.push(...(defaults.length ? defaults : candidates).map((profile) => profile.id));
      continue;
    }
    const picked = await api.showQuickPick(
      candidates.map((profile) => ({ label: profile.label, description: controller.label })),
      { title: "Select a test profile to use", placeholder: controller.label },
    );
    if (!picked?.length) return;
    profileIds.push(candidates[picked[0]!]!.id);
  }
  if (!profileIds.length) {
    void api.showMessage(
      "info",
      kind === KIND_DEBUG
        ? "No test profile can debug these tests."
        : kind === KIND_COVERAGE
          ? "No test profile can run these tests with coverage."
          : "No tests can be run here.",
    );
    return;
  }
  const args: TestRunArgs = { kind, include: ids, profileIds };
  try {
    const result = await api.requestHost<{ started: number; error?: string }>("run", [args]);
    if (result.error) void api.showMessage("warning", result.error);
    else if (result.started) api.revealPanelTab(RESULTS_TAB);
  } catch (error) {
    void api.showMessage("error", error instanceof Error ? error.message : String(error));
  }
}

function failedLeafIds(): string[] {
  const { controllers, results } = store.get();
  return leaves(controllers)
    .filter((leaf) => {
      const state = results[leaf.id]?.state;
      return state === "failed" || state === "errored";
    })
    .map((leaf) => leaf.id);
}

/** Profiles that can continuously run these items (empty items = the whole controller). */
function continuousProfilesFor(controller: TestWireController, items: TestWireItem[]): TestWireProfile[] {
  return controller.profiles.filter((profile) => profile.supportsContinuousRun && (!profile.tag || items.every((item) => item.tags.includes(profile.tag!))));
}

/** Active continuous runs covering an item: runs of everything and runs that include it. */
function continuousCovering(state: TestingState, id: string): ContinuousInfo[] {
  return state.continuous.filter((run) => run.testIds.length === 0 || run.testIds.includes(id));
}

function hasContinuousAvailable(state: TestingState): boolean {
  return state.controllers.some((controller) => controller.profiles.some((profile) => profile.supportsContinuousRun));
}

function anyRunning(state: TestingState): boolean {
  return state.runs.some((run) => !run.ended);
}

/**
 * Start a continuous run (VS Code's "Start Continuous Run"): the profile's
 * handler is called once with `continuous: true` and runs until stopped. An
 * empty `ids` covers the whole controller; `onlyController` limits the start to
 * one controller (its header button).
 */
async function startContinuous(ids: string[] = [], onlyController?: string): Promise<void> {
  const api = featureApi;
  if (!api) return;
  const { controllers } = store.get();
  const items = ids.map((id) => findItem(controllers, id)).filter((item): item is TestWireItem => !!item);
  const wanted = ids.length ? new Set(ids.map(controllerOf)) : onlyController ? new Set([onlyController]) : null;
  let started = 0;
  for (const controller of controllers) {
    if (wanted && !wanted.has(controller.id)) continue;
    const mine = items.filter((item) => controllerOf(item.id) === controller.id);
    const candidates = continuousProfilesFor(controller, mine);
    if (!candidates.length) continue;
    const defaults = candidates.filter((profile) => profile.isDefault);
    let profile: TestWireProfile | undefined = defaults[0] ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!profile) {
      const picked = await api.showQuickPick(
        candidates.map((candidate) => ({
          label: candidate.label,
          description: `${controller.label} (${["", "Run", "Debug", "Coverage"][candidate.kind] ?? candidate.kind})`,
          picked: candidate.isDefault,
        })),
        { title: "Start Continuous Run", placeholder: controller.label },
      );
      if (!picked?.length) continue;
      profile = candidates[picked[0]!]!;
    }
    api.sendToHost({ kind: "startContinuous", profileId: profile.id, ids: mine.map((item) => item.id) });
    started++;
  }
  if (!started) void api.showMessage("info", "No test profile supports continuous runs here.");
}

/** Stop the given continuous runs (default: all of them). */
function stopContinuous(runs?: ContinuousInfo[]): void {
  const api = featureApi;
  if (!api) return;
  for (const run of runs ?? store.get().continuous) api.sendToHost({ kind: "stopContinuous", key: run.key });
}

async function selectDefaultProfiles(api: ViewFeatureApi): Promise<void> {
  const profiles = store.get().controllers.flatMap((controller) => controller.profiles.map((profile) => ({ controller, profile })));
  if (!profiles.length) return void api.showMessage("info", "No test profiles are registered.");
  const picked = await api.showQuickPick(
    profiles.map(({ controller, profile }) => ({
      label: profile.label,
      description: `${controller.label} (${["", "Run", "Debug", "Coverage"][profile.kind] ?? profile.kind})`,
      picked: profile.isDefault,
    })),
    { title: "Select Default Profiles", canPickMany: true },
  );
  if (!picked) return;
  api.sendToHost({ kind: "setDefaults", profileIds: picked.map((index) => profiles[index]!.profile.id) });
}

function openAt(path: string, range?: { startLine: number; startCharacter: number }): void {
  void featureApi?.openFile(path, { line: range?.startLine, character: range?.startCharacter, preview: true });
}

function selectTest(item: TestWireItem): void {
  store.set((state) => ({ ...state, selected: item.id }));
  const result = store.get().results[item.id];
  const failure = result?.messages?.find((message) => message.path);
  if (failure?.path) openAt(failure.path, failure.range);
  else if (item.path) openAt(item.path, item.range);
  if (result?.state === "failed" || result?.state === "errored") featureApi?.revealPanelTab(RESULTS_TAB);
}

function toggleExpanded(item: TestWireItem): void {
  const open = !!store.get().expanded[item.id];
  store.set((state) => {
    const expanded = { ...state.expanded };
    if (open) delete expanded[item.id];
    else expanded[item.id] = true;
    return { ...state, expanded };
  });
  if (!open && item.canResolve && item.children.length === 0) featureApi?.sendToHost({ kind: "resolve", id: item.id });
}

async function showCoverage(runId: string, file: TestWireCoverageFile): Promise<void> {
  openAt(file.path);
  try {
    const details = await featureApi!.requestHost<TestWireCoverageDetail[]>("detailedCoverage", [runId, file.index]);
    store.set((state) => ({ ...state, coverage: { ...state.coverage, [normPath(file.path)]: details } }));
  } catch {
    // The profile may not provide detailed coverage.
  }
}

/* ── components ──────────────────────────────────────────────────────────── */

function StateIcon({ state, size = 14 }: { state: TestState | undefined; size?: number }): ReactNode {
  switch (state) {
    case "passed":
      return <CircleCheck size={size} className="tst-icon tst-passed" />;
    case "failed":
      return <CircleX size={size} className="tst-icon tst-failed" />;
    case "errored":
      return <CircleAlert size={size} className="tst-icon tst-errored" />;
    case "skipped":
      return <CircleMinus size={size} className="tst-icon tst-skipped" />;
    case "running":
      return <LoaderCircle size={size} className="tst-icon tst-running tst-spin" />;
    case "queued":
      return <Clock size={size} className="tst-icon tst-queued" />;
    default:
      return <Circle size={size} className="tst-icon tst-unset" />;
  }
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/* ── contributed menus (testing/*) ───────────────────────────────────────── */

/** Context keys of the testing/* menus for a test (VS Code's testId is the extension's own item id). */
function testLookup(id: string, extra: Record<string, unknown> = {}): (key: string) => unknown {
  const item = findItem(store.get().controllers, id);
  const result = store.get().results[id];
  return (key) => {
    if (key in extra) return extra[key];
    switch (key) {
      case "testId":
        return id.split(TEST_ID_SEPARATOR).pop();
      case "controllerId":
        return controllerOf(id);
      case "testing.testItemHasUri":
        return !!item?.path;
      case "testing.testItemIsHidden":
        return false;
      case "testResultState":
        return result?.state;
      case "testResultOutdated":
        return false;
      default:
        return undefined;
    }
  };
}

/** Commands of testing/item/* get the `TestItem`. */
const testArgs = (id: string) => [refArg("testing", { item: id })];

/** testing/message/*: `{ test, message }` of a failure message of a run. */
const messageArgs = (id: string, runId: string, index: number) => [refArg("testing", { item: id, run: runId, message: index })];

/** Right click on a run / debug / coverage button: the profiles of that kind with their testing/profiles/context entries. */
function profilesMenu(event: React.MouseEvent, kind: number): void {
  const items: ContextMenuItem[] = [];
  for (const controller of store.get().controllers) {
    for (const profile of controller.profiles.filter((candidate) => candidate.kind === kind)) {
      const lookup = (key: string) =>
        key === "controllerId" ? controller.id : key === "testing.profile.context.group" ? ["", "run", "debug", "coverage"][kind] : undefined;
      const entries = contributedMenuItems("testing/profiles/context", lookup, [refArg("testing", { profile: profile.id })]);
      if (entries.length) items.push({ type: "submenu", label: `${profile.label} (${controller.label})`, items: entries });
    }
  }
  if (!items.length) return;
  event.preventDefault();
  void showContextMenu(event.clientX, event.clientY, items);
}

function RowButton({ title, onClick, children, active }: { title: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      className={`icon-btn tst-row-btn${active ? " tst-continuous-on" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function TestRow({ item, depth, controller, state }: { item: TestWireItem; depth: number; controller: TestWireController; state: TestingState }) {
  const open = !!state.expanded[item.id];
  const expandable = item.children.length > 0 || item.canResolve;
  const result = stateOf(item, state.results);
  const duration = state.results[item.id]?.duration;
  const has = (kind: number) => profilesFor(controller, kind, [item]).length > 0;
  const continuous = continuousCovering(state, item.id).filter((run) => run.controllerId === controller.id);
  return (
    <>
      <div
        className={`tst-row${state.selected === item.id ? " selected" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        role="treeitem"
        aria-expanded={expandable ? open : undefined}
        onClick={() => selectTest(item)}
        onDoubleClick={() => expandable && toggleExpanded(item)}
        onContextMenu={(event) => showContributedMenu(event, "testing/item/context", testLookup(item.id), testArgs(item.id))}
        title={item.error ?? item.label}
      >
        <span
          className="tst-chevron"
          onClick={(event) => {
            event.stopPropagation();
            if (expandable) toggleExpanded(item);
          }}
        >
          {expandable ? open ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
        </span>
        {item.busy ? <LoaderCircle size={14} className="tst-icon tst-running tst-spin" /> : <StateIcon state={result} />}
        <span className="tst-label">{item.label}</span>
        {item.description ? <span className="tst-desc">{item.description}</span> : null}
        {item.error ? <CircleAlert size={12} className="tst-icon tst-errored" /> : null}
        {duration !== undefined && item.children.length === 0 ? <span className="tst-duration">{formatDuration(duration)}</span> : null}
        <span className="tst-row-actions">
          <MenuActions menuId="testing/item/context" lookup={testLookup(item.id)} args={testArgs(item.id)} inline={["inline"]} overflow={false} />
          {has(KIND_RUN) ? (
            <RowButton title="Run Test" onClick={() => void runTests(KIND_RUN, [item.id])}>
              <Play size={13} />
            </RowButton>
          ) : null}
          {has(KIND_DEBUG) ? (
            <RowButton title="Debug Test" onClick={() => void runTests(KIND_DEBUG, [item.id])}>
              <Bug size={13} />
            </RowButton>
          ) : null}
          {has(KIND_COVERAGE) ? (
            <RowButton title="Run Test with Coverage" onClick={() => void runTests(KIND_COVERAGE, [item.id])}>
              <ShieldCheck size={13} />
            </RowButton>
          ) : null}
          {continuous.length ? (
            <RowButton title="Stop Continuous Run" active onClick={() => stopContinuous(continuous)}>
              <Repeat size={13} />
            </RowButton>
          ) : continuousProfilesFor(controller, [item]).length ? (
            <RowButton title="Start Continuous Run" onClick={() => void startContinuous([item.id])}>
              <Repeat size={13} />
            </RowButton>
          ) : null}
        </span>
      </div>
      {open ? item.children.map((child) => <TestRow key={child.id} item={child} depth={depth + 1} controller={controller} state={state} />) : null}
    </>
  );
}

function SummaryLine({ state }: { state: TestingState }) {
  const tally = counts(state);
  const ran = tally.passed + tally.failed + tally.errored + tally.skipped;
  if (!ran && !tally.running && !tally.queued) return null;
  return (
    <div className="tst-summary">
      {tally.passed ? <span className="tst-passed">{tally.passed} passed</span> : null}
      {tally.failed ? <span className="tst-failed">{tally.failed} failed</span> : null}
      {tally.errored ? <span className="tst-errored">{tally.errored} errored</span> : null}
      {tally.skipped ? <span className="tst-skipped">{tally.skipped} skipped</span> : null}
      {tally.running + tally.queued ? <span className="tst-running">{tally.running + tally.queued} running</span> : null}
      <span className="tst-total">of {tally.total}</span>
    </div>
  );
}

function continuousScope(state: TestingState, run: ContinuousInfo): string {
  const controller = state.controllers.find((candidate) => candidate.id === run.controllerId);
  if (!run.testIds.length) return `${controller?.label ?? run.controllerId}: all tests`;
  if (run.testIds.length === 1) return findItem(state.controllers, run.testIds[0]!)?.label ?? "1 test";
  return `${run.testIds.length} tests`;
}

/** The active continuous runs under the summary: click the stop button to end one. */
function ContinuousBar({ state }: { state: TestingState }) {
  if (!state.continuous.length) return null;
  return (
    <div className="tst-continuous">
      {state.continuous.map((run) => (
        <div key={run.key} className="tst-continuous-row" title={`Continuous run of ${run.label}`}>
          <Repeat size={12} className="tst-continuous-icon" />
          <span className="tst-label">{run.label}</span>
          <span className="tst-desc">{continuousScope(state, run)}</span>
          <RowButton title="Stop Continuous Run" onClick={() => stopContinuous([run])}>
            <Square size={11} />
          </RowButton>
        </div>
      ))}
    </div>
  );
}

function TestingSidebar() {
  const state = useStore(store);
  const api = featureApi;
  const running = anyRunning(state);
  const hasKind = (kind: number) => state.controllers.some((controller) => controller.profiles.some((profile) => profile.kind === kind));
  return (
    <>
      <div className="sidebar-header">
        <span>Testing</span>
        <span className="sidebar-actions">
          {hasKind(KIND_RUN) ? (
            <button
              type="button"
              className="icon-btn"
              title="Run All Tests"
              aria-label="Run All Tests"
              onClick={() => void runTests(KIND_RUN)}
              onContextMenu={(event) => profilesMenu(event, KIND_RUN)}
            >
              <Play size={15} />
            </button>
          ) : null}
          {hasKind(KIND_DEBUG) ? (
            <button
              type="button"
              className="icon-btn"
              title="Debug All Tests"
              aria-label="Debug All Tests"
              onClick={() => void runTests(KIND_DEBUG)}
              onContextMenu={(event) => profilesMenu(event, KIND_DEBUG)}
            >
              <Bug size={15} />
            </button>
          ) : null}
          {hasKind(KIND_COVERAGE) ? (
            <button
              type="button"
              className="icon-btn"
              title="Run All Tests with Coverage"
              aria-label="Run All Tests with Coverage"
              onClick={() => void runTests(KIND_COVERAGE)}
              onContextMenu={(event) => profilesMenu(event, KIND_COVERAGE)}
            >
              <ShieldCheck size={15} />
            </button>
          ) : null}
          {hasContinuousAvailable(state) || state.continuous.length ? (
            <button
              type="button"
              className={`icon-btn${state.continuous.length ? " tst-continuous-on" : ""}`}
              title={state.continuous.length ? "Stop Continuous Run" : "Start Continuous Run"}
              aria-label={state.continuous.length ? "Stop Continuous Run" : "Start Continuous Run"}
              aria-pressed={state.continuous.length > 0}
              onClick={() => (state.continuous.length ? stopContinuous() : void startContinuous())}
            >
              <Repeat size={15} />
            </button>
          ) : null}
          {running ? (
            <button type="button" className="icon-btn" title="Cancel Test Run" aria-label="Cancel Test Run" onClick={() => api?.sendToHost({ kind: "cancel" })}>
              <Square size={14} />
            </button>
          ) : null}
          <button
            type="button"
            className="icon-btn"
            title="Clear All Results"
            aria-label="Clear All Results"
            onClick={() => store.set((s) => ({ ...s, results: {}, coverage: {} }))}
          >
            <X size={15} />
          </button>
          {api ? (
            <button
              type="button"
              className="icon-btn"
              title="Select Default Profiles"
              aria-label="Select Default Profiles"
              onClick={() => void selectDefaultProfiles(api)}
            >
              <ListChecks size={15} />
            </button>
          ) : null}
        </span>
      </div>
      <SummaryLine state={state} />
      <ContinuousBar state={state} />
      <div className="tst-tree" role="tree">
        {state.controllers.length === 0 ? (
          <div className="tst-empty">No tests have been found. Extensions that provide tests (for example language test runners) show them here.</div>
        ) : (
          state.controllers.map((controller) => {
            return (
              <div key={controller.id} className="tst-controller">
                <div className="tst-controller-head">
                  <FlaskConical size={13} />
                  <span className="tst-label">{controller.label}</span>
                  {controller.canRefresh ? (
                    <RowButton title="Refresh Tests" onClick={() => api?.sendToHost({ kind: "refresh", controllerId: controller.id })}>
                      <RefreshCw size={13} className={controller.refreshing ? "tst-spin" : undefined} />
                    </RowButton>
                  ) : null}
                  {(() => {
                    const active = state.continuous.filter((run) => run.controllerId === controller.id);
                    if (!active.length && !controller.profiles.some((profile) => profile.supportsContinuousRun)) return null;
                    return (
                      <RowButton
                        title={active.length ? "Stop Continuous Run" : "Start Continuous Run"}
                        active={active.length > 0}
                        onClick={() => (active.length ? stopContinuous(active) : void startContinuous([], controller.id))}
                      >
                        <Repeat size={13} />
                      </RowButton>
                    );
                  })()}
                </div>
                {controller.items.map((item) => (
                  <TestRow key={item.id} item={item} depth={0} controller={controller} state={state} />
                ))}
                {controller.items.length === 0 ? (
                  <div className="tst-empty tst-empty-small">No tests discovered{controller.refreshing ? " yet..." : "."}</div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

function pct(count: { covered: number; total: number } | undefined): string {
  if (!count) return "-";
  if (count.total === 0) return "100%";
  return `${Math.round((count.covered / count.total) * 100)}%`;
}

function MessageView({ message, testId, runId, index }: { message: TestWireMessage; testId: string; runId: string; index: number }) {
  // testing/message/context on right click, testing/message/content as buttons over the message.
  const lookup = testLookup(testId, { testMessage: message.contextValue });
  const args = messageArgs(testId, runId, index);
  return (
    <div className="tst-message" onContextMenu={(event) => showContributedMenu(event, "testing/message/context", lookup, args)}>
      <MenuActions menuId="testing/message/content" lookup={lookup} args={args} inline={() => true} className="tst-message-actions" />
      <pre className="tst-message-text">{message.message}</pre>
      {message.expected !== undefined || message.actual !== undefined ? (
        <div className="tst-diff">
          <div>
            <div className="tst-diff-title">Expected</div>
            <pre className="tst-diff-expected">{message.expected ?? ""}</pre>
          </div>
          <div>
            <div className="tst-diff-title">Actual</div>
            <pre className="tst-diff-actual">{message.actual ?? ""}</pre>
          </div>
        </div>
      ) : null}
      {message.path ? (
        <button type="button" className="tst-link" onClick={() => openAt(message.path!, message.range)}>
          {basename(message.path)}
          {message.range ? `:${message.range.startLine + 1}` : ""}
        </button>
      ) : null}
      {message.stack?.length ? (
        <div className="tst-stack">
          {message.stack.map((frame, index) => (
            <button
              key={index}
              type="button"
              className="tst-link"
              disabled={!frame.path}
              onClick={() => frame.path && openAt(frame.path, { startLine: frame.line ?? 0, startCharacter: frame.character ?? 0 })}
            >
              at {frame.label}
              {frame.path ? ` (${basename(frame.path)}${frame.line !== undefined ? `:${frame.line + 1}` : ""})` : ""}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ResultsPanel() {
  const state = useStore(store);
  const [runIndex, setRunIndex] = useState(0);
  const run = state.runs[Math.min(runIndex, Math.max(0, state.runs.length - 1))];
  if (!run) return <div className="tst-panel tst-empty">No test results yet. Run tests from the Testing view.</div>;
  const failures = leaves(state.controllers)
    .map((leaf) => ({ leaf, result: state.results[leaf.id] }))
    .filter(({ result }) => result && result.runId === run.id && (result.state === "failed" || result.state === "errored"));
  const tally = counts(state);
  return (
    <div className="tst-panel">
      <div className="tst-panel-head">
        <select className="tst-run-select" value={state.runs.indexOf(run)} onChange={(event) => setRunIndex(Number(event.target.value))} aria-label="Test run">
          {state.runs.map((candidate, index) => (
            <option key={candidate.id} value={index}>
              {candidate.name}
              {state.continuous.some((run) => run.runId === candidate.id) ? " (continuous)" : ""}
              {candidate.ended || state.continuous.some((run) => run.runId === candidate.id) ? "" : " (running)"}
            </option>
          ))}
        </select>
        {!run.ended ? (
          <button
            type="button"
            className="icon-btn"
            title="Cancel Test Run"
            aria-label="Cancel Test Run"
            onClick={() => featureApi?.sendToHost({ kind: "cancel" })}
          >
            <Square size={14} />
          </button>
        ) : null}
        <span className="tst-panel-counts">
          <span className="tst-passed">{tally.passed} passed</span> <span className="tst-failed">{tally.failed + tally.errored} failed</span>{" "}
          <span className="tst-skipped">{tally.skipped} skipped</span>
        </span>
      </div>
      {failures.length ? (
        <section className="tst-section">
          <h4>Failures</h4>
          {failures.map(({ leaf, result }) => (
            <div key={leaf.id} className="tst-failure">
              <div
                className="tst-failure-title"
                onClick={() => selectTest(leaf)}
                onContextMenu={(event) => showContributedMenu(event, "testing/item/result", testLookup(leaf.id), testArgs(leaf.id))}
              >
                <StateIcon state={result!.state} /> {leaf.label}
                <MenuActions
                  menuId="testing/item/result"
                  lookup={testLookup(leaf.id)}
                  args={testArgs(leaf.id)}
                  inline={["inline"]}
                  overflow={false}
                  className="tst-result-actions"
                />
              </div>
              {result!.messages?.map((message, index) => (
                <MessageView key={index} message={message} testId={leaf.id} runId={result!.runId} index={index} />
              ))}
            </div>
          ))}
        </section>
      ) : null}
      {run.coverage.length ? (
        <section className="tst-section">
          <h4>Coverage</h4>
          <table className="tst-coverage">
            <thead>
              <tr>
                <th>File</th>
                <th>Statements</th>
                <th>Branches</th>
                <th>Functions</th>
              </tr>
            </thead>
            <tbody>
              {run.coverage.map((file) => (
                <tr key={file.index} onClick={() => void showCoverage(run.id, file)}>
                  <td title={file.path}>{basename(file.path)}</td>
                  <td>{pct(file.statements)}</td>
                  <td>{pct(file.branches)}</td>
                  <td>{pct(file.declarations)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      <section className="tst-section">
        <h4>Output</h4>
        <pre className="tst-output">{run.output || (run.ended ? "(no output)" : "")}</pre>
      </section>
    </div>
  );
}

/* ── editor: gutter icons and coverage lines ─────────────────────────────── */

type GutterEntry = { item: TestWireItem; state: TestState | undefined };

let gutterCache: { state: TestingState; byPath: Map<string, Map<number, GutterEntry>> } | undefined;

function gutterEntries(path: string): Map<number, GutterEntry> | undefined {
  const state = store.get();
  if (gutterCache?.state !== state) {
    const byPath = new Map<string, Map<number, GutterEntry>>();
    for (const controller of state.controllers) {
      if (!controller.profiles.some((profile) => profile.kind === KIND_RUN)) continue;
      walk(controller.items, (item) => {
        if (!item.path || !item.range) return;
        const key = normPath(item.path);
        const lines = byPath.get(key) ?? new Map<number, GutterEntry>();
        if (!lines.has(item.range.startLine)) lines.set(item.range.startLine, { item, state: stateOf(item, state.results) });
        byPath.set(key, lines);
      });
    }
    gutterCache = { state, byPath };
  }
  return gutterCache.byPath.get(normPath(path));
}

class TestGutterMarker extends GutterMarker {
  readonly entry: GutterEntry;
  constructor(entry: GutterEntry) {
    super();
    this.entry = entry;
  }
  eq(other: GutterMarker): boolean {
    return other instanceof TestGutterMarker && other.entry.item.id === this.entry.item.id && other.entry.state === this.entry.state;
  }
  toDOM(): Node {
    const span = document.createElement("span");
    span.className = `tst-gutter-icon tst-gutter-${this.entry.state ?? "unset"}`;
    span.title = this.entry.state ? `${this.entry.item.label}: ${this.entry.state}. Click to run.` : `Run ${this.entry.item.label}`;
    span.textContent =
      ({ passed: "✓", failed: "✕", errored: "!", skipped: "-", running: "↻", queued: "…" } as Record<string, string>)[this.entry.state ?? ""] ?? "▶";
    return span;
  }
}

const COVERED = Decoration.line({ class: "tst-line-covered" });
const UNCOVERED = Decoration.line({ class: "tst-line-uncovered" });

function coverageDecorations(view: EditorView, path: string): DecorationSet {
  const details = store.get().coverage[normPath(path)];
  const builder = new RangeSetBuilder<Decoration>();
  if (!details?.length) return builder.finish();
  const lineState = new Map<number, boolean>();
  for (const detail of details) {
    if (detail.kind !== "statement") continue;
    const executed = typeof detail.executed === "number" ? detail.executed > 0 : detail.executed;
    const line = detail.range.startLine;
    lineState.set(line, (lineState.get(line) ?? true) && executed);
  }
  for (const line of [...lineState.keys()].sort((a, b) => a - b)) {
    if (line + 1 > view.state.doc.lines) continue;
    builder.add(view.state.doc.line(line + 1).from, view.state.doc.line(line + 1).from, lineState.get(line) ? COVERED : UNCOVERED);
  }
  return builder.finish();
}

function testEditorExtensions(path: string): Extension[] {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      #unsubscribe: () => void;
      #view: EditorView;
      #dirty = false;
      constructor(view: EditorView) {
        this.#view = view;
        this.decorations = coverageDecorations(view, path);
        // The store changed: rebuild on the next update, which a no-op dispatch triggers.
        this.#unsubscribe = store.subscribe(() => {
          this.#dirty = true;
          queueMicrotask(() => {
            try {
              this.#view.dispatch({});
            } catch {
              // The view was destroyed or is updating.
            }
          });
        });
      }
      update(update: ViewUpdate) {
        if (this.#dirty || update.docChanged || update.viewportChanged) {
          this.#dirty = false;
          this.decorations = coverageDecorations(update.view, path);
        }
      }
      destroy() {
        this.#unsubscribe();
      }
    },
    { decorations: (value) => value.decorations },
  );
  return [
    plugin,
    gutter({
      class: "cm-test-gutter",
      lineMarker(view, line) {
        const entries = gutterEntries(path);
        if (!entries) return null;
        const entry = entries.get(view.state.doc.lineAt(line.from).number - 1);
        return entry ? new TestGutterMarker(entry) : null;
      },
      lineMarkerChange: () => true,
      domEventHandlers: {
        mousedown(view, line) {
          const entry = gutterEntries(path)?.get(view.state.doc.lineAt(line.from).number - 1);
          if (!entry) return false;
          void runTests(KIND_RUN, [entry.item.id]);
          return true;
        },
        // Run / Debug and the extensions' testing/item/gutter entries.
        contextmenu(view, line, event) {
          const entry = gutterEntries(path)?.get(view.state.doc.lineAt(line.from).number - 1);
          if (!entry) return false;
          const id = entry.item.id;
          const controller = store.get().controllers.find((candidate) => candidate.id === controllerOf(id));
          const has = (kind: number) => !!controller && profilesFor(controller, kind, [entry.item]).length > 0;
          const own: ContextMenuItem[] = [
            ...(has(KIND_RUN) ? [{ type: "item" as const, label: "Run Test", action: "run", run: () => void runTests(KIND_RUN, [id]) }] : []),
            ...(has(KIND_DEBUG) ? [{ type: "item" as const, label: "Debug Test", action: "debug", run: () => void runTests(KIND_DEBUG, [id]) }] : []),
            ...(has(KIND_COVERAGE)
              ? [{ type: "item" as const, label: "Run Test with Coverage", action: "coverage", run: () => void runTests(KIND_COVERAGE, [id]) }]
              : []),
            { type: "item", label: "Reveal in Test Explorer", action: "reveal", run: () => selectTest(entry.item) },
          ];
          return showContributedMenu(event as MouseEvent, "testing/item/gutter", testLookup(id), testArgs(id), own);
        },
      },
    }),
  ];
}

/* ── the feature ─────────────────────────────────────────────────────────── */

function loadSnapshot(api: ViewFeatureApi): void {
  api.requestHost<TestWireController[]>("snapshot").then(
    (controllers) => {
      store.set((state) => ({ ...state, controllers }));
      refreshFeatures();
    },
    () => {
      // The host is not ready (yet); it sends the tree when something changes.
    },
  );
}

export const testingView: ViewFeature = {
  area: "testing",

  init(api) {
    featureApi = api;
  },

  onHostReady(api) {
    featureApi = api;
    // A restarted host forgets every controller and run.
    store.set((state) => ({ ...state, controllers: [], results: {}, runs: state.runs.map((run) => ({ ...run, ended: true })), continuous: [], coverage: {} }));
    loadSnapshot(api);
  },

  onHostMessage(payload, api) {
    featureApi = api;
    applyEvent(payload as TestingHostEvent);
  },

  commands: [
    { id: "workbench.action.testing.runAll", title: "Run All Tests", category: "Test", run: () => runTests(KIND_RUN) },
    { id: "workbench.action.testing.debugAll", title: "Debug All Tests", category: "Test", run: () => runTests(KIND_DEBUG) },
    { id: "workbench.action.testing.coverageAll", title: "Run All Tests with Coverage", category: "Test", run: () => runTests(KIND_COVERAGE) },
    {
      id: "workbench.action.testing.reRunFailed",
      title: "Re-run Failed Tests",
      category: "Test",
      run: () => runTests(KIND_RUN, failedLeafIds()),
      enabled: () => failedLeafIds().length > 0,
    },
    {
      id: "workbench.action.testing.cancelRun",
      title: "Cancel Test Run",
      category: "Test",
      run: (api) => api.sendToHost({ kind: "cancel" }),
      enabled: () => anyRunning(store.get()),
    },
    {
      id: "workbench.action.testing.startContinuousRun",
      title: "Start Continuous Run",
      category: "Test",
      run: () => startContinuous(),
      enabled: () => hasContinuousAvailable(store.get()) && store.get().continuous.length === 0,
    },
    {
      id: "workbench.action.testing.stopContinuousRun",
      title: "Stop Continuous Run",
      category: "Test",
      run: () => stopContinuous(),
      enabled: () => store.get().continuous.length > 0,
    },
    {
      id: "workbench.action.testing.refresh",
      title: "Refresh Tests",
      category: "Test",
      run: (api) => {
        for (const controller of store.get().controllers) if (controller.canRefresh) api.sendToHost({ kind: "refresh", controllerId: controller.id });
      },
    },
    {
      id: "workbench.action.testing.clearResults",
      title: "Clear All Results",
      category: "Test",
      run: () => store.set((state) => ({ ...state, results: {}, coverage: {} })),
    },
    { id: "workbench.action.testing.selectDefaultProfiles", title: "Select Default Profiles", category: "Test", run: (api) => selectDefaultProfiles(api) },
  ],

  sidebarViews: [
    {
      id: SIDEBAR_VIEW,
      title: "Testing",
      icon: FlaskConical,
      render: () => <TestingSidebar />,
      badge: () => {
        const tally = counts(store.get());
        return tally.failed + tally.errored;
      },
    },
  ],

  panelTabs: [
    {
      id: RESULTS_TAB,
      title: "Test Results",
      render: () => <ResultsPanel />,
      badge: () => {
        const tally = counts(store.get());
        return tally.failed + tally.errored;
      },
    },
  ],

  editorExtensions: (path) => testEditorExtensions(path),

  statusBarItems: [
    {
      id: "testing.summary",
      side: "left",
      priority: 5,
      text: () => {
        const state = store.get();
        const tally = counts(state);
        const done = tally.passed + tally.failed + tally.errored + tally.skipped;
        if (!done && !tally.running) return "";
        const bad = tally.failed + tally.errored;
        return `$(beaker) ${tally.passed}/${tally.total}${bad ? ` ${bad} failed` : ""}`;
      },
      tooltip: () => {
        const tally = counts(store.get());
        return `${tally.passed} passed, ${tally.failed + tally.errored} failed, ${tally.skipped} skipped of ${tally.total} tests`;
      },
      command: "workbench.view.feature.testing",
      color: () => {
        const tally = counts(store.get());
        return tally.failed + tally.errored ? "var(--danger)" : undefined;
      },
    },
    {
      id: "testing.continuous",
      side: "left",
      priority: 6,
      text: () => {
        const continuous = store.get().continuous;
        return continuous.length ? `$(sync~spin) ${continuous.length === 1 ? continuous[0]!.label : `${continuous.length} continuous`}` : "";
      },
      tooltip: () => {
        const continuous = store.get().continuous;
        if (!continuous.length) return "";
        return `Continuous test run: ${continuous.map((run) => run.label).join(", ")}. Click to stop.`;
      },
      command: "workbench.action.testing.stopContinuousRun",
    },
  ],
};
