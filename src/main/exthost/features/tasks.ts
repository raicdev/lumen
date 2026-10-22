import type { HostFeature } from "./contract.ts";
import { NOT_HANDLED } from "./contract.ts";
import * as T from "../types.ts";
import { TASK_COMMAND_IDS } from "../../../shared/tasks-wire.ts";
import {
  CustomExecution,
  ProcessExecution,
  ShellExecution,
  ShellQuoting,
  Task,
  TaskGroup,
  TaskPanelKind,
  TaskRevealKind,
  TaskScope,
} from "../../tasks/task-types.ts";
import { allTasks, executeTask, killAllTasks, runTaskCommand, tasksState, terminateRun } from "../../tasks/engine.ts";
import type { TaskProvider } from "../../tasks/engine.ts";

/**
 * Host side of the "tasks" area: the `tasks` namespace, the task classes, the
 * built-in task commands and the Tasks panel's requests. The work is done in
 * src/main/tasks (tasks.json, problem matchers, running processes).
 */

export const tasksFeature: HostFeature = {
  area: "tasks",

  api: ({ host, extensionId }) => {
    const state = tasksState(host);

    function registerTaskProvider(type: string, provider: TaskProvider): T.Disposable {
      if (typeof type !== "string" || !type) throw new Error("illegal argument: type must be a non-empty string");
      if (!provider || typeof provider.provideTasks !== "function") throw new Error("illegal argument: provider.provideTasks is required");
      const id = ++state.providerSeq;
      state.providers.set(id, { type, provider, extensionId });
      return new T.Disposable(() => void state.providers.delete(id));
    }

    return {
      tasks: {
        registerTaskProvider,
        fetchTasks: (filter?: { type?: string }) => allTasks(state, filter?.type),
        executeTask: (task: Task) => {
          if (!(task instanceof Task)) throw new Error("illegal argument: task must be a Task");
          return executeTask(state, task);
        },
        get taskExecutions() {
          return [...state.running.values()].map((run) => run.facade);
        },
        onDidStartTask: state.onDidStartTask.event,
        onDidEndTask: state.onDidEndTask.event,
        onDidStartTaskProcess: state.onDidStartTaskProcess.event,
        onDidEndTaskProcess: state.onDidEndTaskProcess.event,
        onDidStartTaskProblemMatchers: state.onDidStartTaskProblemMatchers.event,
        onDidEndTaskProblemMatchers: state.onDidEndTaskProblemMatchers.event,
      },
      workspace: { registerTaskProvider },
    };
  },

  types: { Task, TaskScope, TaskRevealKind, TaskPanelKind, TaskGroup, ShellExecution, ProcessExecution, CustomExecution, ShellQuoting },

  init: (host) => {
    // Background tasks (watchers, servers) must not outlive the host.
    try {
      process.once("exit", () => killAllTasks(host));
    } catch {
      /* not available */
    }
  },

  onViewRequest: async (host, method, args) => {
    const state = tasksState(host);
    switch (method) {
      case "command":
        return await runTaskCommand(state, String(args[0]), args.slice(1));
      case "terminate": {
        const run = state.running.get(String(args[0]));
        if (run) terminateRun(run);
        return undefined;
      }
      case "rerun": {
        const task = state.history.get(String(args[0]));
        if (task) await executeTask(state, task);
        return undefined;
      }
      default:
        throw new Error(`unknown tasks request '${method}'`);
    }
  },

  executeCommand: async (host, command, args) => {
    if (!TASK_COMMAND_IDS.includes(command)) return NOT_HANDLED;
    return await runTaskCommand(tasksState(host), command, args);
  },
};
