/** Messages between the tasks host feature (extension host) and its window view. */

export type TaskRunStatus = "running" | "ready" | "succeeded" | "failed" | "terminated";

/** Host to window (`host.postFeature("tasks", ...)`). */
export type TasksHostMessage =
  | { kind: "start"; id: string; name: string; source: string; background: boolean; startedAt: number }
  | { kind: "output"; id: string; text: string }
  /** A background task printed its end marker: it is ready (dependent tasks continue). */
  | { kind: "ready"; id: string }
  | { kind: "end"; id: string; exitCode: number | null | undefined; terminated: boolean; errors: number; warnings: number }
  /** Show the Tasks panel. */
  | { kind: "reveal" };

/** Window to host (`api.requestHost("tasks", method, args)`): `command` runs one of the built-in task commands. */
export type TasksViewMethod = "command" | "terminate" | "rerun";

/** Ids of the built-in task commands (palette entries of the window, handled by the host). */
export const TASK_COMMANDS = {
  runTask: "workbench.action.tasks.runTask",
  build: "workbench.action.tasks.build",
  test: "workbench.action.tasks.test",
  terminate: "workbench.action.tasks.terminate",
  restart: "workbench.action.tasks.restartTask",
  reRun: "workbench.action.tasks.reRunTask",
  showTasks: "workbench.action.tasks.showTasks",
  showLog: "workbench.action.tasks.showLog",
  configure: "workbench.action.tasks.configureTaskRunner",
  openTasksJson: "workbench.action.tasks.openWorkspaceFileTasks",
  configureDefaultBuild: "workbench.action.tasks.configureDefaultBuildTask",
  configureDefaultTest: "workbench.action.tasks.configureDefaultTestTask",
} as const;

export const TASK_COMMAND_IDS: readonly string[] = Object.values(TASK_COMMANDS);
