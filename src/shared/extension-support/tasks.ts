import type { AreaSupport } from "./types.ts";

/** Support table changes of the "tasks" area. */
export const tasksSupport: AreaSupport = {
  api: {
    "tasks.*": null,
    "tasks.registerTaskProvider": "supported",
    "workspace.registerTaskProvider": "supported",
    "tasks.fetchTasks": ["supported", "tasks.json tasks plus provider tasks (custom types resolved by their provider)"],
    "tasks.executeTask": [
      "partial",
      "shell, process and custom (pseudoterminal) executions run as extension host processes with output in the Tasks panel, not in a terminal; only presentation.reveal is honoured",
    ],
    "tasks.taskExecutions": "supported",
    "tasks.onDidStartTask": "supported",
    "tasks.onDidEndTask": "supported",
    "tasks.onDidStartTaskProcess": "supported",
    "tasks.onDidEndTaskProcess": "supported",
    "tasks.onDidStartTaskProblemMatchers": "supported",
    "tasks.onDidEndTaskProblemMatchers": "supported",
  },
  types: ["Task", "TaskScope", "TaskRevealKind", "TaskPanelKind", "TaskGroup", "ShellExecution", "ProcessExecution", "CustomExecution", "ShellQuoting"],
  contributions: {
    taskDefinitions: [
      "partial",
      "the type activates the contributing extension and routes tasks.json tasks of that type to its provider; required and property types are checked before a task runs; no tasks.json completion from the definition",
    ],
    problemMatchers: ["partial", 'patterns, base, fileLocation, severity, background patterns and applyTo; fileLocation "search" falls back to relative'],
    problemPatterns: "supported",
  },
};
