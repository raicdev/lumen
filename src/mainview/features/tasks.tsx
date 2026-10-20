import { useEffect, useRef } from "react";
import { CircleCheck, CircleX, Eraser, FileCog, ListChecks, LoaderCircle, Play, RotateCw, Square, SquareCheck } from "lucide-react";
import { TASK_COMMANDS } from "../../shared/tasks-wire";
import type { TaskRunStatus, TasksHostMessage } from "../../shared/tasks-wire";
import { featureApi, refreshFeatures } from "./registry";
import { createStore, useStore } from "./store";
import type { FeaturePickItem, ViewFeature, ViewFeatureApi } from "./types";

/** Window side of the "tasks" area: the Tasks panel (running and finished tasks with their output) and the task commands. Styles: feature-tasks.css. */

const PANEL_TAB = "tasks.output";
const MAX_OUTPUT = 400_000;

type RunView = {
  id: string;
  name: string;
  source: string;
  background: boolean;
  status: TaskRunStatus;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  errors: number;
  warnings: number;
  output: string;
};

type TasksState = { runs: RunView[]; selected: string | null };

const store = createStore<TasksState>({ runs: [], selected: null });

const updateRun = (id: string, change: (run: RunView) => RunView) =>
  store.set((state) => ({ ...state, runs: state.runs.map((run) => (run.id === id ? change(run) : run)) }));

function handleHostMessage(message: TasksHostMessage, api: ViewFeatureApi): void {
  switch (message.kind) {
    case "start":
      store.set((state) => ({
        runs: [...state.runs.slice(-49), { id: message.id, name: message.name, source: message.source, background: message.background, status: "running", startedAt: message.startedAt, errors: 0, warnings: 0, output: "" }],
        selected: message.id,
      }));
      break;
    case "output":
      updateRun(message.id, (run) => ({ ...run, output: (run.output + message.text).slice(-MAX_OUTPUT) }));
      return;
    case "ready":
      updateRun(message.id, (run) => (run.status === "running" ? { ...run, status: "ready" } : run));
      break;
    case "end":
      updateRun(message.id, (run) => ({
        ...run,
        status: message.terminated ? "terminated" : message.exitCode === 0 ? "succeeded" : "failed",
        exitCode: message.exitCode,
        errors: message.errors,
        warnings: message.warnings,
        endedAt: Date.now(),
      }));
      break;
    case "reveal":
      api.revealPanelTab(PANEL_TAB);
      return;
  }
  refreshFeatures();
}

const running = (state: TasksState) => state.runs.filter((run) => run.status === "running" || run.status === "ready");

function StatusIcon({ status }: { status: TaskRunStatus }) {
  const className = `tasks-status-${status}`;
  if (status === "running" || status === "ready") return <LoaderCircle className={className} size={14} />;
  if (status === "succeeded") return <CircleCheck className={className} size={14} />;
  if (status === "terminated") return <Square className={className} size={14} />;
  return <CircleX className={className} size={14} />;
}

function duration(run: RunView): string {
  const seconds = Math.max(0, Math.round(((run.endedAt ?? Date.now()) - run.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function command(id: string): void {
  void featureApi("tasks").requestHost("command", [id]).catch(() => undefined);
}

function TasksPanel() {
  const state = useStore(store);
  const selected = state.runs.find((run) => run.id === state.selected) ?? state.runs[state.runs.length - 1];
  const output = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const element = output.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [selected?.output, selected?.id]);

  const active = running(state);
  const api = featureApi("tasks");
  return (
    <div className="tasks-panel">
      <div className="tasks-toolbar">
        <button type="button" title="Run Task" onClick={() => command(TASK_COMMANDS.runTask)}>
          <Play size={13} /> Run Task
        </button>
        <button type="button" title="Run Build Task" onClick={() => command(TASK_COMMANDS.build)}>
          <SquareCheck size={13} /> Build
        </button>
        <button type="button" title="Run Test Task" onClick={() => command(TASK_COMMANDS.test)}>
          <ListChecks size={13} /> Test
        </button>
        <button type="button" title="Open tasks.json" onClick={() => command(TASK_COMMANDS.configure)}>
          <FileCog size={13} /> Configure
        </button>
        <span className="tasks-spacer" />
        <button type="button" title="Remove finished tasks from the list" disabled={active.length === state.runs.length} onClick={() => store.set((s) => ({ runs: running(s), selected: running(s).some((run) => run.id === s.selected) ? s.selected : null }))}>
          <Eraser size={13} /> Clear
        </button>
      </div>
      {state.runs.length === 0 ? (
        <div className="tasks-empty">
          <ListChecks size={28} strokeWidth={1.25} />
          <div>No tasks have run yet.</div>
          <div>Tasks come from .vscode/tasks.json and from extensions.</div>
        </div>
      ) : (
        <div className="tasks-body">
          <div className="tasks-runs">
            {[...state.runs].reverse().map((run) => (
              <button key={run.id} type="button" className={`tasks-run${run.id === selected?.id ? " selected" : ""}`} onClick={() => store.set((s) => ({ ...s, selected: run.id }))}>
                <span className={`tasks-status-${run.status}`}>
                  <StatusIcon status={run.status} />
                </span>
                <span className="tasks-run-name" title={`${run.name} (${run.source})`}>
                  {run.name}
                </span>
                <span className="tasks-run-meta">{run.status === "ready" ? "ready" : run.status === "running" ? duration(run) : run.errors ? `${run.errors} err` : run.warnings ? `${run.warnings} warn` : duration(run)}</span>
              </button>
            ))}
          </div>
          {selected && (
            <div className="tasks-detail">
              <div className="tasks-run-actions">
                <span className="tasks-run-title">
                  {selected.name}
                  {selected.exitCode !== undefined && selected.exitCode !== null && selected.status !== "terminated" ? ` (exit code ${selected.exitCode})` : ""}
                  {selected.errors || selected.warnings ? ` - ${selected.errors} errors, ${selected.warnings} warnings` : ""}
                </span>
                <button type="button" title="Terminate" disabled={selected.status !== "running" && selected.status !== "ready"} onClick={() => void api.requestHost("terminate", [selected.id]).catch(() => undefined)}>
                  <Square size={13} /> Terminate
                </button>
                <button type="button" title="Run again" disabled={selected.status === "running" || selected.status === "ready"} onClick={() => void api.requestHost("rerun", [selected.id]).catch(() => undefined)}>
                  <RotateCw size={13} /> Run again
                </button>
              </div>
              <pre
                ref={output}
                className="tasks-output"
                onScroll={(event) => {
                  const element = event.currentTarget;
                  stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
                }}
              >
                {selected.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function taskCommand(id: string, title: string, run?: (api: ViewFeatureApi) => unknown) {
  return { id, title, category: "Tasks", run: run ?? (() => command(id)) };
}

export const tasksView: ViewFeature = {
  area: "tasks",

  onHostMessage: (payload, api) => handleHostMessage(payload as TasksHostMessage, api),

  onHostRequest: async (method, args, api) => {
    if (method === "pick") {
      const [items, title] = args as [FeaturePickItem[], string];
      const picked = await api.showQuickPick(items, { title, placeholder: title, matchOnDescription: true, matchOnDetail: true });
      return picked && picked.length ? picked[0] : null;
    }
    if (method === "input") {
      const [options] = args as [{ prompt?: string; value?: string; password?: boolean }];
      return await api.showInputBox({ prompt: options.prompt, value: options.value, password: options.password, title: "Task input" });
    }
    throw new Error(`unknown tasks request '${method}'`);
  },

  commands: [
    taskCommand(TASK_COMMANDS.runTask, "Run Task…"),
    taskCommand(TASK_COMMANDS.build, "Run Build Task"),
    taskCommand(TASK_COMMANDS.test, "Run Test Task"),
    taskCommand(TASK_COMMANDS.reRun, "Rerun Last Task"),
    taskCommand(TASK_COMMANDS.restart, "Restart Running Task…"),
    taskCommand(TASK_COMMANDS.terminate, "Terminate Task…"),
    taskCommand(TASK_COMMANDS.showTasks, "Show Running Tasks", (api) => api.revealPanelTab(PANEL_TAB)),
    taskCommand(TASK_COMMANDS.showLog, "Show Task Log", (api) => api.revealPanelTab(PANEL_TAB)),
    taskCommand(TASK_COMMANDS.configure, "Configure Tasks (open tasks.json)"),
    taskCommand(TASK_COMMANDS.openTasksJson, "Open Workspace Tasks"),
    taskCommand(TASK_COMMANDS.configureDefaultBuild, "Configure Default Build Task…"),
    taskCommand(TASK_COMMANDS.configureDefaultTest, "Configure Default Test Task…"),
  ],

  panelTabs: [{ id: PANEL_TAB, title: "Tasks", render: () => <TasksPanel />, badge: () => running(store.get()).length }],

  statusBarItems: [
    {
      id: "tasks.running",
      side: "left",
      priority: 20,
      text: () => {
        const count = running(store.get()).length;
        return count ? `$(sync~spin) ${count} ${count === 1 ? "task" : "tasks"}` : "";
      },
      tooltip: () => running(store.get()).map((run) => run.name).join("\n") || undefined,
      command: TASK_COMMANDS.showTasks,
    },
  ],
};
